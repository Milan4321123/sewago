// Group-order confirmations are promises to pay. This file pins the two ways a
// promise goes stale before the host places, so nobody's wallet is charged on
// the strength of an agreement they have mentally moved on from:
//   1. the confirmation is older than GROUP_CONFIRM_TTL_MIN, or
//   2. the meal slot the group was scheduled for has already passed.
// Both knobs are turned down to ~1s here so the timing is testable in seconds.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { freePort } = require('./net');
let PORT;
let BASE;
const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'test-admin-pass';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function registerUser(name) {
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const { data } = await api('/auth/register', { method: 'POST', body: { name, email, password: 'secret1' } });
  return { token: data.token, user: data.user };
}

async function wallet(token) {
  return (await api('/auth/me', { token })).data.user.wallet;
}

async function onboardRestaurant() {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const reg = await api('/partner/register', {
    method: 'POST',
    body: { name: 'Stale Kitchen', email: `stale-${stamp}@test.local`, password: 'partner-secret', phone: `+9778${stamp.slice(-9)}`, regNo: `PAN-${stamp.slice(-6)}` }
  });
  const token = reg.data.token;
  const otp = await api('/partner/phone/request-otp', { method: 'POST', token, body: {} });
  await api('/partner/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  await api(`/admin/partners/${reg.data.partner.id}/kyc/approve`, { method: 'POST', token: adminToken });
  const rest = await api('/partner/restaurants', {
    method: 'POST', token,
    body: { name: 'Stale Thamel', cuisine: 'Test', area: 'Thamel', etaMinutes: 20, deliveryFee: 100 }
  });
  const restaurantId = rest.data.restaurant.id;
  const menu = await api(`/partner/restaurants/${restaurantId}/menu`, { method: 'POST', token, body: { name: 'Set', price: 400, desc: 't' } });
  await api(`/admin/restaurants/${restaurantId}/approve`, { method: 'POST', token: adminToken });
  return { token, restaurantId, menuItemId: menu.data.restaurant.menu[0].id };
}

before(async () => {
  PORT = await freePort();
  BASE = `http://localhost:${PORT}/api`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-stale-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATA_STORE: 'json', DATA_DIR: dataDir,
      ADMIN_EMAIL, ADMIN_PASSWORD, OTP_PROVIDER: 'sandbox', EMAIL_PROVIDER: 'sandbox',
      GROUP_CONFIRM_TTL_MIN: '0.02', // ~1.2s
      GROUP_MIN_LEAD_MIN: '0.02',    // ~1.2s, so a slot can be scheduled seconds out
      LOG_LEVEL: 'error'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (e) { /* not up */ }
    await sleep(100);
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

test('a confirmation that has gone stale is refused, and nobody is charged', async () => {
  const shop = await onboardRestaurant();
  const host = await registerUser('stale-host');

  // Scheduled comfortably far out, so the ONLY thing that expires is the confirmation.
  const when = Date.now() + 2 * 60 * 60 * 1000;
  const group = (await api('/group-orders', {
    method: 'POST', token: host.token, body: { restaurantId: shop.restaurantId, mode: 'pickup', scheduledFor: when }
  })).data.group;
  await api(`/group-orders/${group.id}/items`, { method: 'POST', token: host.token, body: { items: [{ id: shop.menuItemId, qty: 1 }] } });
  await api(`/group-orders/${group.id}/confirm`, { method: 'POST', token: host.token });

  const before = await wallet(host.token);
  await sleep(1500); // past the ~1.2s TTL

  const placed = await api(`/group-orders/${group.id}/place`, { method: 'POST', token: host.token });
  assert.equal(placed.status, 409, JSON.stringify(placed.data));
  assert.match(placed.data.error, /confirm again/i);
  assert.equal(await wallet(host.token), before, 'a stale confirmation charges nothing');

  const view = (await api('/group-orders', { token: host.token })).data.groups.find((g) => g.id === group.id);
  assert.equal(view.members.find((m) => m.name === 'stale-host').confirmed, false, 'the member must confirm afresh');

  // Re-confirming makes it placeable again — the food itself is still on offer.
  await api(`/group-orders/${group.id}/confirm`, { method: 'POST', token: host.token });
  const retry = await api(`/group-orders/${group.id}/place`, { method: 'POST', token: host.token });
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(before - await wallet(host.token), 400, 'a fresh confirmation pays the agreed share');
});

test('a group whose meal slot has already passed cannot be placed', async () => {
  const shop = await onboardRestaurant();
  const host = await registerUser('past-host');

  // Just past the ~1.2s minimum lead, so the slot lapses within the test.
  const when = Date.now() + 2000;
  const created = await api('/group-orders', {
    method: 'POST', token: host.token, body: { restaurantId: shop.restaurantId, mode: 'pickup', scheduledFor: when }
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const group = created.data.group;
  await api(`/group-orders/${group.id}/items`, { method: 'POST', token: host.token, body: { items: [{ id: shop.menuItemId, qty: 1 }] } });
  await api(`/group-orders/${group.id}/confirm`, { method: 'POST', token: host.token });

  const before = await wallet(host.token);
  await sleep(2500); // the scheduled slot is now in the past

  const placed = await api(`/group-orders/${group.id}/place`, { method: 'POST', token: host.token });
  assert.equal(placed.status, 400, JSON.stringify(placed.data));
  assert.match(placed.data.error, /time has passed/i);
  assert.equal(await wallet(host.token), before, 'a lapsed slot charges nothing');
});
