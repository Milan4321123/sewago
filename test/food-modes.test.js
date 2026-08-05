// Order-ahead (pickup / eat-there): paid from the wallet up front, no courier,
// no delivery or service fee, and a 4-digit collect code the customer reads out
// at the counter. Delivery orders must behave exactly as before.
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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function registerUser(name) {
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const { data } = await api('/auth/register', { method: 'POST', body: { name, email, password: 'secret1' } });
  return { token: data.token, user: data.user };
}

// A KYC-approved partner with an approved restaurant and one menu item.
async function onboardPartnerRestaurant(price) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const reg = await api('/partner/register', {
    method: 'POST',
    body: { name: 'Counter Kitchen', email: `mode-${stamp}@test.local`, password: 'partner-secret', phone: `+9778${stamp.slice(-9)}`, regNo: `PAN-${stamp.slice(-6)}` }
  });
  const token = reg.data.token;
  const otp = await api('/partner/phone/request-otp', { method: 'POST', token, body: {} });
  await api('/partner/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  await api(`/admin/partners/${reg.data.partner.id}/kyc/approve`, { method: 'POST', token: adminToken });
  const rest = await api('/partner/restaurants', {
    method: 'POST', token,
    body: { name: 'Counter Thamel', cuisine: 'Test', area: 'Thamel', etaMinutes: 20, deliveryFee: 100 }
  });
  const restaurantId = rest.data.restaurant.id;
  const menu = await api(`/partner/restaurants/${restaurantId}/menu`, { method: 'POST', token, body: { name: 'Set', price, desc: 't' } });
  await api(`/admin/restaurants/${restaurantId}/approve`, { method: 'POST', token: adminToken });
  return { token, partnerId: reg.data.partner.id, restaurantId, menuItemId: menu.data.restaurant.menu[0].id };
}

async function onboardCourier(lat, lng) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const reg = await api('/driver/register', {
    method: 'POST',
    body: {
      name: 'Mode Courier', email: `mc-${stamp}@test.local`, password: 'driver-secret',
      phone: `+9779${stamp.slice(-9)}`, tier: 'bike', vehicle: 'Bike', plate: `TE ${stamp.slice(-4)}`,
      licenseId: `LIC-${stamp.slice(-8)}`, licenseCode: '123456'
    }
  });
  const token = reg.data.token;
  const otp = await api('/driver/phone/request-otp', { method: 'POST', token, body: {} });
  await api('/driver/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  await api('/driver/location', { method: 'POST', token, body: { lat, lng, accuracy: 10 } });
  await api('/driver/online', { method: 'POST', token, body: { online: true } });
  return { token, id: reg.data.driver.id };
}

before(async () => {
  PORT = await freePort();
  BASE = `http://localhost:${PORT}/api`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-modes-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATA_STORE: 'json', DATA_DIR: dataDir,
      ADMIN_EMAIL, ADMIN_PASSWORD, OTP_PROVIDER: 'sandbox', EMAIL_PROVIDER: 'sandbox',
      DRIVER_LICENSE_DEMO_CODE: '123456', FOOD_SERVICE_FEE: '15', LOG_LEVEL: 'error'
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

test('dine-in order-ahead: place, ready, collect by code, income settles', async () => {
  const shop = await onboardPartnerRestaurant(400);
  const courier = await onboardCourier(27.7152, 85.3123);
  const { token: cust } = await registerUser('diner');
  const walletBefore = (await api('/auth/me', { token: cust })).data.user.wallet;

  const when = Date.now() + 2 * 60 * 60 * 1000;
  const placed = await api('/orders', {
    method: 'POST', token: cust,
    body: { restaurantId: shop.restaurantId, items: [{ id: shop.menuItemId, qty: 2 }], mode: 'dinein', scheduledFor: when }
  });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  const o = placed.data.order;
  assert.equal(o.mode, 'dinein');
  assert.equal(o.scheduledFor, when);
  assert.equal(o.deliveryFee, 0, 'no courier, no delivery fee');
  assert.equal(o.serviceFee, 0, 'no service fee on order-ahead');
  assert.equal(o.total, 800, 'total is just the food');
  assert.equal(o.payment, 'wallet');
  assert.equal(o.deliveryLoc, null, 'nothing to deliver, nowhere to deliver it');
  assert.match(o.collectCode, /^\d{4}$/, 'the customer gets a 4-digit counter code');

  const walletAfter = (await api('/auth/me', { token: cust })).data.user.wallet;
  assert.equal(walletBefore - walletAfter, 800, 'paid up front from the wallet');

  // The kitchen sees the mode and the time, but NEVER the code.
  const queue = await api('/partner/orders', { token: shop.token });
  const seen = queue.data.orders.find((x) => x.id === o.id);
  assert.equal(seen.mode, 'dinein');
  assert.equal(seen.scheduledFor, when);
  assert.equal(seen.collectCode, undefined, 'the code never crosses the partner API');

  await api(`/partner/orders/${o.id}/accept`, { method: 'POST', token: shop.token });

  // Preparing — the moment couriers would normally be offered the job. This
  // order must never appear in their pool.
  const offers = await api('/driver/deliveries', { token: courier.token });
  assert.ok(!offers.data.deliveries.some((d) => d.id === o.id), 'order-ahead never reaches the courier pool');
  const grab = await api(`/driver/deliveries/${o.id}/accept`, { method: 'POST', token: courier.token });
  assert.equal(grab.status, 404, 'not even by id');

  const readied = await api(`/partner/orders/${o.id}/ready`, { method: 'POST', token: shop.token });
  assert.equal(readied.status, 200, JSON.stringify(readied.data));
  assert.equal(readied.data.order.status, 'ready');

  // Wrong code: refused, nothing changes, income stays pending.
  const wrong = await api(`/partner/orders/${o.id}/collected`, { method: 'POST', token: shop.token, body: { code: '0000' } });
  assert.equal(wrong.status, 400, 'a wrong code settles nothing');
  const still = await api('/partner/orders', { token: shop.token });
  assert.equal(still.data.orders.find((x) => x.id === o.id).status, 'ready');

  const done = await api(`/partner/orders/${o.id}/collected`, { method: 'POST', token: shop.token, body: { code: o.collectCode } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.order.status, 'completed');
  assert.ok(done.data.order.collectedAt, 'collection moment is recorded');

  // Money: partnerCut = 85% of 800 = 680 settles pending -> earnings.
  const me = await api('/partner/me', { token: shop.token });
  assert.equal(me.data.partner.earnings, 680, 'income settles at the counter');
  assert.equal(me.data.partner.pendingEarnings, 0);

  // Collecting twice cannot settle twice.
  const again = await api(`/partner/orders/${o.id}/collected`, { method: 'POST', token: shop.token, body: { code: o.collectCode } });
  assert.equal(again.status, 409);
});

test('order-ahead refuses cash, sim restaurants, and bad times', async () => {
  const shop = await onboardPartnerRestaurant(300);
  const { token: cust } = await registerUser('rules');

  const cash = await api('/orders', {
    method: 'POST', token: cust,
    body: { restaurantId: shop.restaurantId, items: [{ id: shop.menuItemId, qty: 1 }], mode: 'pickup', payment: 'cash' }
  });
  assert.equal(cash.status, 400);
  assert.match(cash.data.error, /paid from your wallet so the kitchen can start cooking/);

  // Seeded sim restaurants have no counter — pickup there is refused.
  const sim = await api('/orders', {
    method: 'POST', token: cust,
    body: { restaurantId: 'res-momo-ghar', items: [{ id: 'mg-1', qty: 1 }], mode: 'pickup' }
  });
  assert.equal(sim.status, 400, JSON.stringify(sim.data));
  assert.match(sim.data.error, /partner restaurants/i);

  // scheduledFor must sit between now (minus a little skew) and a week out.
  for (const bad of [Date.now() - 10 * 60 * 1000, Date.now() + 8 * 24 * 60 * 60 * 1000, 'tonight']) {
    const res = await api('/orders', {
      method: 'POST', token: cust,
      body: { restaurantId: shop.restaurantId, items: [{ id: shop.menuItemId, qty: 1 }], mode: 'pickup', scheduledFor: bad }
    });
    assert.equal(res.status, 400, `scheduledFor ${bad} must be refused`);
  }

  // Absent scheduledFor = ASAP, and the order goes through.
  const asap = await api('/orders', {
    method: 'POST', token: cust,
    body: { restaurantId: shop.restaurantId, items: [{ id: shop.menuItemId, qty: 1 }], mode: 'pickup' }
  });
  assert.equal(asap.status, 200, JSON.stringify(asap.data));
  assert.equal(asap.data.order.scheduledFor, null);
  assert.equal(asap.data.order.mode, 'pickup');
});

test('delivery orders are untouched: fees, no code, courier flow intact', async () => {
  const shop = await onboardPartnerRestaurant(500);
  const courier = await onboardCourier(27.7152, 85.3123);
  const { token: cust } = await registerUser('classic');

  // No mode field at all — exactly what every existing client sends.
  const placed = await api('/orders', {
    method: 'POST', token: cust,
    body: { restaurantId: shop.restaurantId, items: [{ id: shop.menuItemId, qty: 1 }], deliveryTo: 'Thamel' }
  });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  const o = placed.data.order;
  assert.equal(o.mode, 'delivery', 'mode defaults to delivery');
  assert.ok(o.deliveryFee > 0, 'delivery still pays the courier leg');
  assert.equal(o.serviceFee, 15, 'service fee unchanged');
  assert.equal(o.collectCode, null, 'no counter code on a delivery');
  assert.ok(o.deliveryLoc, 'the courier has somewhere to go');

  // And the courier still sees it once the kitchen accepts.
  await api(`/partner/orders/${o.id}/accept`, { method: 'POST', token: shop.token });
  const offers = await api('/driver/deliveries', { token: courier.token });
  assert.ok(offers.data.deliveries.some((d) => d.id === o.id), 'delivery orders still reach couriers');
});

test('a no-show pickup can be refunded by the kitchen, never stranded', async () => {
  const shop = await onboardPartnerRestaurant(250);
  const { token: cust } = await registerUser('noshow');
  const walletBefore = (await api('/auth/me', { token: cust })).data.user.wallet;

  const placed = await api('/orders', {
    method: 'POST', token: cust,
    body: { restaurantId: shop.restaurantId, items: [{ id: shop.menuItemId, qty: 1 }], mode: 'pickup' }
  });
  const o = placed.data.order;
  await api(`/partner/orders/${o.id}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/orders/${o.id}/ready`, { method: 'POST', token: shop.token });

  const refund = await api(`/partner/orders/${o.id}/reject`, { method: 'POST', token: shop.token });
  assert.equal(refund.status, 200, JSON.stringify(refund.data));
  assert.equal(refund.data.order.status, 'cancelled');

  const walletAfter = (await api('/auth/me', { token: cust })).data.user.wallet;
  assert.equal(walletAfter, walletBefore, 'every rupee comes back');
  const me = await api('/partner/me', { token: shop.token });
  assert.equal(me.data.partner.pendingEarnings, 0, 'nothing dangling in pending income');
  assert.equal(me.data.partner.earnings, 0);
});
