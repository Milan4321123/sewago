// Regression tests for the Tier-0 money-safety fixes from the adversarial
// audit. Each test reproduces the exact exploit the audit confirmed and asserts
// it is now closed. Boots the real server on a throwaway JSON store over HTTP,
// same harness as money.test.js.
//
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 4983;
const BASE = `http://localhost:${PORT}/api`;
const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'test-admin-pass';
const LICENSE_CODE = '123456';

let server;
let dataDir;
let adminToken;

async function api(pathname, { method = 'GET', token = null, body = null } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function registerUser(name) {
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const { status, data } = await api('/auth/register', { method: 'POST', body: { name, email, password: 'secret1' } });
  assert.equal(status, 200, `register failed: ${JSON.stringify(data)}`);
  return { token: data.token, user: data.user, email };
}

async function verifyPhone(token) {
  const phone = `+9779${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
  const otp = await api('/auth/phone/request-otp', { method: 'POST', token, body: { phone } });
  assert.equal(otp.status, 200, JSON.stringify(otp.data));
  const verified = await api('/auth/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-safety-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      DATA_STORE: 'json',
      DATA_DIR: dataDir,
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      OTP_PROVIDER: 'sandbox',
      RATE_LIMIT_API_PER_MIN: '100000',
      EMAIL_PROVIDER: 'sandbox',
      DRIVER_LICENSE_DEMO_CODE: LICENSE_CODE,
      // Force the production money guards ON even though NODE_ENV=development,
      // so we can exercise them without a full prod boot.
      ALLOW_SIM_FULFILLMENT: 'false',
      WITHDRAW_HOLD_HOURS: '12',
      LOG_LEVEL: 'error'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (e) { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const login = await api('/admin/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  adminToken = login.data.token;
});

after(async () => {
  if (server) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    await exited;
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// --- 0.1 gateway lockdown --------------------------------------------------

test('in production, unconfigured methods (incl. card) never resolve to the free sandbox', async () => {
  // Unit-test the gateway resolver with config flipped to production, without a
  // full prod boot. In prod, a method with no real processor must be null
  // (unavailable) — never the PIN sandbox that would mint free wallet balance.
  const config = require('../server/config').config;
  const { gatewayFor } = require('../server/routes/payments');
  const saved = { prod: config.isProduction, esewaCode: config.esewaProductCode, esewaSecret: config.esewaSecret, khalti: config.khaltiSecretKey };
  try {
    // Simulate a production deploy whose real gateway keys aren't set yet.
    config.isProduction = true;
    config.esewaProductCode = '';
    config.esewaSecret = '';
    config.khaltiSecretKey = '';
    assert.equal(gatewayFor('card'), null, 'card has no processor — must be unavailable in prod');
    assert.equal(gatewayFor('khalti'), null, 'khalti without keys must be unavailable in prod (not sandbox)');
    assert.equal(gatewayFor('esewa'), null, 'esewa without keys must be unavailable in prod (not sandbox)');
    config.isProduction = false;
    assert.equal(gatewayFor('card'), 'sandbox', 'card falls back to sandbox only outside production');
  } finally {
    config.isProduction = saved.prod;
    config.esewaProductCode = saved.esewaCode;
    config.esewaSecret = saved.esewaSecret;
    config.khaltiSecretKey = saved.khalti;
  }
});

// --- 0.2 no charge for simulated fulfillment -------------------------------

test('a wallet ride is refused (not charged) when no real driver is available', async () => {
  const { token } = await registerUser('simride');
  // Give them balance via an admin credit (top-ups are off in this config).
  const me = await api('/auth/me', { token });
  await api('/admin/wallet-adjust', { method: 'POST', token: adminToken, body: { userId: me.data.user.id, amount: 5000, reason: 'seed balance for test' } });
  const before = (await api('/auth/me', { token })).data.user.wallet;
  const ride = await api('/rides', {
    method: 'POST', token,
    body: { pickup: { lat: 27.7154, lng: 85.3123, name: 'Thamel' }, dropoff: { lat: 27.6893, lng: 85.3436, name: 'New Baneshwor' }, tier: 'bike', payment: 'wallet' }
  });
  assert.equal(ride.status, 503, 'ride with no real driver must be refused');
  const after = (await api('/auth/me', { token })).data.user.wallet;
  assert.equal(after, before, 'wallet must not be debited for an unfulfilled ride');
});

test('seeded (ownerless) restaurants are hidden when sim fulfillment is off', async () => {
  const { token } = await registerUser('simfood');
  const list = await api('/restaurants', { token });
  assert.equal(list.status, 200);
  assert.equal(list.data.restaurants.length, 0, 'no ownerless seed restaurants should be orderable in prod mode');
});

// --- 0.3 deletion blocked while commission owed ----------------------------

test('deletion is blocked while a driver or partner owes SewaGo money', async () => {
  // The negative-earnings blocker is a pure guard. Ensure the db arrays it reads
  // exist (a synthetic account matches none of them), then assert the contract.
  const { db } = require('../server/db');
  for (const k of ['rides', 'tasks', 'orders', 'restaurants', 'hotels', 'bookings', 'withdrawals']) {
    db[k] = db[k] || [];
  }
  const { deletionBlockers } = require('../server/accountDeletion');

  const owedDriver = deletionBlockers('driver', { id: 'owe-drv', online: false, earnings: -250 });
  assert.ok(owedDriver.some((b) => /settle the Rs 250/.test(b)), 'owed driver must be blocked');

  const owedPartner = deletionBlockers('partner', { id: 'owe-ptr', earnings: -400 });
  assert.ok(owedPartner.some((b) => /settle the Rs 400/.test(b)), 'owed partner must be blocked');

  // A settled driver (earnings 0) is not blocked by the owe-rule.
  const clear = deletionBlockers('driver', { id: 'clear-drv', online: false, earnings: 0 });
  assert.ok(!clear.some((b) => /settle/.test(b)), 'a driver who owes nothing is not blocked by the owe-rule');
});

// --- 0.5 fresh-funds withdrawal hold ---------------------------------------

test('freshly topped-up funds are held before they can be withdrawn (anti cash-out)', async () => {
  // Real end-to-end: sandbox top-up (dev) sets the 12h hold from WITHDRAW_HOLD_HOURS.
  const { token } = await registerUser('holdme');
  await verifyPhone(token);
  // 'card' has no real processor, so it uses the PIN sandbox in dev regardless
  // of any eSewa/Khalti keys in .env — a deterministic way to make a fresh top-up.
  const init = await api('/payments/topup/initiate', { method: 'POST', token, body: { amount: 5000, method: 'card' } });
  assert.equal(init.status, 200, JSON.stringify(init.data));
  const confirm = await api('/payments/topup/confirm', { method: 'POST', token, body: { paymentId: init.data.payment.id, pin: '1234' } });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.data));
  assert.equal(confirm.data.user.wallet, 10000, 'welcome bonus 5000 + top-up 5000');

  // The topped-up 5000 is held; only the pre-existing 5000 bonus is withdrawable.
  const overReach = await api('/payments/withdraw', { method: 'POST', token, body: { amount: 6000, channel: 'esewa', account: '9800000000' } });
  assert.equal(overReach.status, 400, 'cannot withdraw into freshly-topped-up funds');
  assert.match(overReach.data.error, /held/i);

  // Withdrawing within the un-held (bonus) balance still works.
  const ok = await api('/payments/withdraw', { method: 'POST', token, body: { amount: 4000, channel: 'esewa', account: '9800000000' } });
  assert.equal(ok.status, 200, `un-held funds should withdraw: ${JSON.stringify(ok.data)}`);
});

// --- 0.4 the confirmed collusion drain is closed ---------------------------

test('partner CANNOT withdraw food income until the order is delivered', async () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  // Onboard a KYC-approved partner with an approved restaurant.
  const preg = await api('/partner/register', {
    method: 'POST',
    body: { name: 'Collude Kitchen', email: `ck-${stamp}@test.local`, password: 'partner-secret', phone: `+9778${stamp.slice(-9)}`, regNo: `PAN-${stamp.slice(-6)}` }
  });
  assert.equal(preg.status, 200, JSON.stringify(preg.data));
  const partnerToken = preg.data.token;
  const partnerId = preg.data.partner.id;
  const pOtp = await api('/partner/phone/request-otp', { method: 'POST', token: partnerToken, body: {} });
  await api('/partner/phone/verify', { method: 'POST', token: partnerToken, body: { code: pOtp.data.devCode } });
  await api(`/admin/partners/${partnerId}/kyc/approve`, { method: 'POST', token: adminToken });
  const rest = await api('/partner/restaurants', {
    method: 'POST', token: partnerToken,
    body: { name: 'Collude Thamel', cuisine: 'Test', area: 'Thamel', etaMinutes: 20, deliveryFee: 100 }
  });
  const restaurantId = rest.data.restaurant.id;
  const menu = await api(`/partner/restaurants/${restaurantId}/menu`, { method: 'POST', token: partnerToken, body: { name: 'Set', price: 500, desc: 't' } });
  const menuItemId = menu.data.restaurant.menu[0].id;
  await api(`/admin/restaurants/${restaurantId}/approve`, { method: 'POST', token: adminToken });

  // Colluding customer with seeded balance places an order (credits PENDING).
  const { token: custToken, user: cust } = await registerUser('colluder');
  await api('/admin/wallet-adjust', { method: 'POST', token: adminToken, body: { userId: cust.id, amount: 5000, reason: 'seed for collusion test' } });
  const order = await api('/orders', {
    method: 'POST', token: custToken,
    body: { restaurantId, items: [{ id: menuItemId, qty: 1 }], deliveryTo: { lat: 27.6893, lng: 85.3436, name: 'New Baneshwor' } }
  });
  assert.equal(order.status, 200, JSON.stringify(order.data));

  // The exploit was: withdraw the 85% cut now, then have the order refunded.
  // After the fix the income sits in pendingEarnings; withdrawable earnings is 0.
  const me = await api('/partner/me', { token: partnerToken });
  assert.equal(me.data.partner.earnings, 0, 'placement income must NOT be withdrawable');
  assert.equal(me.data.partner.pendingEarnings, 425, 'income is pending until delivery (85% of Rs 500)');
  await verifyPhone(partnerToken).catch(() => {}); // ensure phone-verified for withdraw
  const drain = await api('/partner/withdraw', { method: 'POST', token: partnerToken, body: { amount: 425, channel: 'esewa', account: '9800000000' } });
  assert.equal(drain.status, 400, 'withdrawing un-delivered income must be refused');

  // And when the customer cancels, the refund reverses PENDING (not withdrawable
  // earnings), so nothing was double-paid.
  const cancel = await api(`/orders/${order.data.order.id}/cancel`, { method: 'POST', token: custToken });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  const after = await api('/partner/me', { token: partnerToken });
  assert.equal(after.data.partner.earnings, 0);
  assert.equal(after.data.partner.pendingEarnings, 0, 'cancel must return pending to zero, not drive it negative');
});

// --- review fix #1: legacy earnings->pending migration (no double-credit) ----

test('migrate() moves in-flight legacy partner income to pending without double-counting, and is idempotent', async () => {
  const { migrate } = require('../server/db');
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  // Legacy partner: all three cuts were credited to withdrawable earnings under
  // the old model (425 + 300 + 2880 = 3605).
  const data = {
    users: [], drivers: [], restaurants: [], hotels: [], rides: [], tasks: [],
    partners: [{ id: 'p1', name: 'Legacy Partner', earnings: 3605 }],
    orders: [
      { id: 'o-done', partnerId: 'p1', partnerCut: 425, status: 'delivered' },      // final
      { id: 'o-flight', partnerId: 'p1', partnerCut: 300, status: 'out_for_delivery' } // refundable
    ],
    bookings: [
      { id: 'b-future', partnerId: 'p1', partnerCut: 2880, status: 'active', checkIn: future }, // refundable
      { id: 'b-past', partnerId: 'p1', partnerCut: 900, status: 'active', checkIn: past }        // already stayed -> final
    ]
  };
  // Note b-past's 900 is NOT in the 3605 above (kept the math simple); adjust:
  data.partners[0].earnings = 3605 + 900;

  migrate(data);
  const p = data.partners[0];
  // Refundable in-flight cuts moved to pending; finals stay in earnings.
  assert.equal(p.pendingEarnings, 300 + 2880, 'refundable order + future booking move to pending');
  assert.equal(p.earnings, 425 + 900, 'delivered order + past-checkin booking stay settled in earnings');
  assert.equal(p.earnings + p.pendingEarnings, 4505, 'total credited value is conserved');
  assert.equal(data.orders.find((o) => o.id === 'o-done').partnerSettled, true);
  assert.equal(data.orders.find((o) => o.id === 'o-flight').partnerSettled, false);
  assert.equal(data.bookings.find((b) => b.id === 'b-future').settled, false);
  assert.equal(data.bookings.find((b) => b.id === 'b-past').settled, true);
  assert.equal(data.schemaVersion, 2);

  // Idempotent: running migrate again (as it does on every load) changes nothing.
  migrate(data);
  assert.equal(p.earnings, 425 + 900, 'earnings unchanged on second migrate');
  assert.equal(p.pendingEarnings, 300 + 2880, 'pending unchanged on second migrate');
});

// --- review fix #2: spending fresh funds frees the withdrawal hold -----------

test('spending topped-up money releases the hold on the rest of the balance', async () => {
  const { token } = await registerUser('holdspend');
  await verifyPhone(token);
  // Top up 5000 (held) on top of the 5000 welcome bonus.
  const init = await api('/payments/topup/initiate', { method: 'POST', token, body: { amount: 5000, method: 'card' } });
  await api('/payments/topup/confirm', { method: 'POST', token, body: { paymentId: init.data.payment.id, pin: '1234' } });
  // Fresh 5000 is held: withdrawing 6000 (into held funds) is blocked.
  const blocked = await api('/payments/withdraw', { method: 'POST', token, body: { amount: 6000, channel: 'esewa', account: '9800000000' } });
  assert.equal(blocked.status, 400);

  // Spend the fresh 5000 by posting a task (escrows budget from the wallet).
  const task = await api('/tasks', { method: 'POST', token, body: { title: 'Deliver a parcel please', category: 'delivery', desc: 'x', place: 'Thamel', budget: 5000 } });
  assert.equal(task.status, 200, JSON.stringify(task.data));

  // Now the held portion is gone; the remaining 5000 (old bonus) is withdrawable.
  const ok = await api('/payments/withdraw', { method: 'POST', token, body: { amount: 4000, channel: 'esewa', account: '9800000000' } });
  assert.equal(ok.status, 200, `spending fresh funds should free the old balance: ${JSON.stringify(ok.data)}`);
});
