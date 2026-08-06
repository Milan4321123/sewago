// Admin operations tests: people search, suspension enforcement, driver
// license decisions, and support wallet adjustments (with their guard rails
// and receipt lines). Boots the real server on a throwaway JSON store, same
// as money.test.js, so assertions cover real request paths.
//
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { freePort } = require('./net');
let PORT; // OS-assigned in before() — hardcoded ports collide across parallel checkouts
let BASE;
const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'test-admin-pass';

let server;
let dataDir;
let adminToken;

async function api(pathname, { method = 'GET', token = null, body = null } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function registerUser(name) {
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const { status, data } = await api('/auth/register', {
    method: 'POST',
    body: { name, email, password: 'secret1' }
  });
  assert.equal(status, 200, `register failed: ${JSON.stringify(data)}`);
  return { token: data.token, user: data.user, email };
}

before(async () => {
  PORT = await freePort();
  BASE = `http://localhost:${PORT}/api`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-admin-test-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, EXIT_WHEN_STDIN_CLOSES: '1',
      NODE_ENV: 'development',
      PORT: String(PORT),
      DATA_STORE: 'json',
      DATA_DIR: dataDir,
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      OTP_PROVIDER: 'sandbox',
      RATE_LIMIT_API_PER_MIN: '100000',
      EMAIL_PROVIDER: 'sandbox',
      LOG_LEVEL: 'error'
    },
    stdio: ['pipe', 'ignore', 'inherit']
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) break;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const login = await api('/admin/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.equal(login.status, 200, 'admin login failed');
  adminToken = login.data.token;
});

after(async () => {
  if (server) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('people search finds a customer by email fragment', async () => {
  const { user, email } = await registerUser('findme');
  const q = email.split('@')[0].slice(0, 10);
  const { status, data } = await api(`/admin/people?q=${encodeURIComponent(q)}`, { token: adminToken });
  assert.equal(status, 200);
  assert.ok(data.users.some((u) => u.id === user.id), 'registered user should match the search');
  assert.ok(Array.isArray(data.drivers));
});

test('support credit lands in the wallet with a receipt line', async () => {
  const { token, user } = await registerUser('credited');
  const before = (await api('/auth/me', { token })).data.user.wallet;
  const adj = await api('/admin/wallet-adjust', {
    method: 'POST',
    token: adminToken,
    body: { userId: user.id, amount: 250, reason: 'Goodwill for late delivery' }
  });
  assert.equal(adj.status, 200, JSON.stringify(adj.data));
  assert.equal(adj.data.user.wallet, before + 250);
  const txns = (await api('/payments/transactions', { token })).data.transactions;
  assert.equal(txns[0].type, 'adjustment');
  assert.match(txns[0].label, /Goodwill/);
  assert.equal(txns[0].sign, 1);
  assert.equal(txns[0].amount, 250);
});

test('wallet adjustment guard rails: zero, huge, unreasoned, overdraft', async () => {
  const { user } = await registerUser('guarded');
  const cases = [
    { body: { userId: user.id, amount: 0, reason: 'valid reason' }, why: 'zero amount' },
    { body: { userId: user.id, amount: 50000, reason: 'valid reason' }, why: 'above cap' },
    { body: { userId: user.id, amount: 100, reason: 'ok' }, why: 'reason too short' },
    { body: { userId: user.id, amount: -999999, reason: 'valid reason' }, why: 'overdraft' }
  ];
  for (const c of cases) {
    const { status } = await api('/admin/wallet-adjust', { method: 'POST', token: adminToken, body: c.body });
    assert.equal(status, 400, `expected 400 for ${c.why}`);
  }
  const missing = await api('/admin/wallet-adjust', {
    method: 'POST',
    token: adminToken,
    body: { userId: 'nope', amount: 100, reason: 'valid reason' }
  });
  assert.equal(missing.status, 404);
});

test('suspended customer is locked out everywhere until reinstated', async () => {
  const { token, user, email } = await registerUser('suspendme');
  const sus = await api(`/admin/users/${user.id}/suspend`, {
    method: 'POST',
    token: adminToken,
    body: { note: 'fraud review' }
  });
  assert.equal(sus.status, 200);
  assert.equal(sus.data.user.suspended, true);

  // Existing session is refused, and a fresh login is refused too.
  const me = await api('/auth/me', { token });
  assert.equal(me.status, 403);
  const relog = await api('/auth/login', { method: 'POST', body: { email, password: 'secret1' } });
  assert.equal(relog.status, 403);

  const back = await api(`/admin/users/${user.id}/unsuspend`, { method: 'POST', token: adminToken });
  assert.equal(back.status, 200);
  assert.equal(back.data.user.suspended, false);
  const meAgain = await api('/auth/me', { token });
  assert.equal(meAgain.status, 200, 'reinstated account should work with its old session');
});

test('driver license decisions and suspension flow', async () => {
  // Seeded demo drivers exist on a fresh store; act on the first one.
  const { data: people } = await api('/admin/people', { token: adminToken });
  assert.ok(people.drivers.length > 0, 'seeded drivers expected');
  const d = people.drivers[0];

  const rej = await api(`/admin/drivers/${d.id}/verification/reject`, {
    method: 'POST',
    token: adminToken,
    body: { note: 'license photo unreadable' }
  });
  assert.equal(rej.status, 200);
  assert.equal(rej.data.driver.verificationStatus, 'rejected');

  const ok = await api(`/admin/drivers/${d.id}/verification/approve`, { method: 'POST', token: adminToken });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.driver.verificationStatus, 'verified');

  const sus = await api(`/admin/drivers/${d.id}/suspend`, {
    method: 'POST',
    token: adminToken,
    body: { note: 'too many complaints' }
  });
  assert.equal(sus.status, 200);
  assert.equal(sus.data.driver.suspended, true);
  const back = await api(`/admin/drivers/${d.id}/unsuspend`, { method: 'POST', token: adminToken });
  assert.equal(back.data.driver.suspended, false);
});

test('admin endpoints refuse non-admin tokens', async () => {
  const { token, user } = await registerUser('sneaky');
  for (const call of [
    api('/admin/people', { token }),
    api('/admin/wallet-adjust', { method: 'POST', token, body: { userId: user.id, amount: 9999, reason: 'self serve' } }),
    api(`/admin/users/${user.id}/unsuspend`, { method: 'POST', token })
  ]) {
    const { status } = await call;
    assert.equal(status, 401);
  }
});

test('a legit withdrawal approval pays out; a negative-balance one is refused', async () => {
  const { token, user } = await registerUser('payout');
  // Verify phone (required to withdraw), then request a withdrawal of the bonus.
  const phone = `+9779${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
  const otp = await api('/auth/phone/request-otp', { method: 'POST', token, body: { phone } });
  await api('/auth/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  const wd = await api('/payments/withdraw', { method: 'POST', token, body: { amount: 1000, channel: 'esewa', account: '9800000000' } });
  assert.equal(wd.status, 200, JSON.stringify(wd.data));
  const id = wd.data.withdrawal.id;

  // Happy path: the account still backs it, so approval pays out and records the
  // external payout reference.
  const ok = await api(`/admin/withdrawals/${id}/approve`, { method: 'POST', token: adminToken, body: { payoutRef: 'ESW-TEST-1' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.withdrawal.status, 'paid');
  assert.equal(ok.data.withdrawal.disbursedRef, 'ESW-TEST-1');

  // Idempotency: re-approving the same withdrawal must not pay a second time.
  const again = await api(`/admin/withdrawals/${id}/approve`, { method: 'POST', token: adminToken });
  assert.equal(again.status, 400, 'an already-paid withdrawal cannot be paid again');
});
