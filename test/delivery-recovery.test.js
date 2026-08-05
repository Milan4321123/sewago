// What happens when a rider accepts a run and then vanishes.
//
// This lives in its own file because it needs the abandonment deadlines turned
// down to seconds, and that setting would recover every run in the main
// delivery-runs suite before its rider had a chance to work the stops.
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

async function openShop(name, lat, lng) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const reg = await api('/partner/register', {
    method: 'POST',
    body: { name, email: `sh-${stamp}@test.local`, password: 'partner-secret', phone: `+9779${stamp.slice(-9)}`, regNo: `PAN-${stamp.slice(-6)}` }
  });
  const token = reg.data.token;
  const otp = await api('/partner/phone/request-otp', { method: 'POST', token, body: {} });
  await api('/partner/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  await api(`/admin/partners/${reg.data.partner.id}/kyc/approve`, { method: 'POST', token: adminToken });
  const store = await api('/partner/stores', { method: 'POST', token, body: { name, area: 'Thamel', deliveryFee: 30 } });
  const storeId = store.data.store.id;
  await api(`/admin/stores/${storeId}/approve`, { method: 'POST', token: adminToken });
  await api(`/partner/stores/${storeId}`, { method: 'PATCH', token, body: { lat, lng, locName: name } });
  const item = await api(`/partner/stores/${storeId}/items`, {
    method: 'POST', token, body: { name: `Dal ${stamp.slice(-4)}`, unit: 'kg', price: 100, stock: 500 }
  });
  return { token, storeId, itemId: item.data.item.id };
}

async function onboardCourier(lat, lng) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const reg = await api('/driver/register', {
    method: 'POST',
    body: {
      name: 'Rider', email: `rr-${stamp}@test.local`, password: 'driver-secret',
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

async function waitFor(fn, tries = 60, gap = 400) {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, gap));
  }
  return null;
}

before(async () => {
  PORT = await freePort();
  BASE = `http://localhost:${PORT}/api`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-recovery-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATA_STORE: 'json', DATA_DIR: dataDir,
      ADMIN_EMAIL, ADMIN_PASSWORD, OTP_PROVIDER: 'sandbox', EMAIL_PROVIDER: 'sandbox',
      DRIVER_LICENSE_DEMO_CODE: '123456',
      DELIVERY_BATCH_TARGET: '1',
      DELIVERY_MAX_WAIT_MIN: '0.02',
      DELIVERY_OFFER_SECONDS: '5',
      DELIVERY_LAPSE_COOLDOWN_SEC: '5',
      DELIVERY_RUN_PICKUP_DEADLINE_MIN: '0.05', // 3s: the rider never shows up
      CASH_CREDIT_LIMIT: '2000',
      STORE_COMMISSION_PCT: '8', STORE_SERVICE_FEE: '5',
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

test('a run whose rider never shows up goes back to the pool', async () => {
  // Nothing used to write 'cancelled' to a run. A rider who accepted and then
  // went dark held the orders, the shop's income and the customer's goods
  // indefinitely — and stayed marked busy, so they got no more work either.
  const shop = await openShop('No-show Kirana', 27.7154, 85.3123);
  const ghost = await onboardCourier(27.7160, 85.3130);

  const stamp = Date.now();
  const cust = await api('/auth/register', {
    method: 'POST', body: { name: 'Cust', email: `rec-${stamp}@test.local`, password: 'secret1' }
  });
  const order = await api('/store-orders', {
    method: 'POST', token: cust.data.token,
    body: {
      storeId: shop.storeId, items: [{ itemId: shop.itemId, qty: 1 }], payment: 'wallet',
      deliverTo: { lat: 27.7100, lng: 85.3100, name: 'Chhetrapati' }
    }
  });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  const orderId = order.data.order.id;
  await api(`/partner/store-orders/${orderId}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/store-orders/${orderId}/ready`, { method: 'POST', token: shop.token });

  const offer = await waitFor(async () => {
    const r = await api('/driver/run', { token: ghost.token });
    return r.data.run && r.data.offered ? r.data.run : null;
  });
  assert.ok(offer, 'the packed order is offered to the only rider around');
  assert.equal((await api(`/driver/runs/${offer.id}/accept`, { method: 'POST', token: ghost.token })).status, 200);

  // ...and then nothing. No stop is ever ticked.
  const freed = await waitFor(async () => {
    const r = await api('/driver/run', { token: ghost.token });
    return r.data.run === null ? true : null;
  });
  assert.ok(freed, 'the abandoned run is taken off the rider');

  // The order is unassigned again and waiting for the next rider.
  const custView = await api('/store-orders', { token: cust.data.token });
  const mine = custView.data.orders.find((o) => o.id === orderId);
  assert.equal(mine.status, 'ready', 'the order is packed and waiting again, not lost');
  assert.ok(!mine.courierId, 'no courier is still holding it');

  const second = await onboardCourier(27.7158, 85.3128);
  const reoffer = await waitFor(async () => {
    const r = await api('/driver/run', { token: second.token });
    return r.data.run ? r.data.run : null;
  });
  assert.ok(reoffer, 'the orders return to the pool for another rider');
  assert.ok(
    reoffer.stops.some((s) => s.type === 'pickup' && s.name === 'No-show Kirana'),
    'and it is the same shop that is waiting'
  );
});

test('a rider on a run cannot also take a passenger', async () => {
  // The two verticals share one fleet. Dispatch skips riders working a run, but
  // a ride offer made in the seconds before they accepted the run is still on
  // their phone — taking it would strand a bootful of shop orders.
  const shop = await openShop('Two-jobs Kirana', 27.7016, 85.3117);
  const rider = await onboardCourier(27.7010, 85.3110);

  const stamp = Date.now();
  const cust = await api('/auth/register', {
    method: 'POST', body: { name: 'Cust3', email: `two-${stamp}@test.local`, password: 'secret1' }
  });
  const order = await api('/store-orders', {
    method: 'POST', token: cust.data.token,
    body: {
      storeId: shop.storeId, items: [{ itemId: shop.itemId, qty: 1 }], payment: 'wallet',
      deliverTo: { lat: 27.7000, lng: 85.3090, name: 'New Road' }
    }
  });
  const orderId = order.data.order.id;
  await api(`/partner/store-orders/${orderId}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/store-orders/${orderId}/ready`, { method: 'POST', token: shop.token });

  const offer = await waitFor(async () => {
    const r = await api('/driver/run', { token: rider.token });
    return r.data.run && r.data.offered ? r.data.run : null;
  });
  assert.ok(offer);
  assert.equal((await api(`/driver/runs/${offer.id}/accept`, { method: 'POST', token: rider.token })).status, 200);

  const ride = await api('/rides', {
    method: 'POST', token: cust.data.token,
    body: {
      tier: 'bike', payment: 'cash',
      pickup: { lat: 27.7014, lng: 85.3115, name: 'Ason' },
      dropoff: { lat: 27.6950, lng: 85.3050, name: 'Kalimati' }
    }
  });
  assert.equal(ride.status, 200, JSON.stringify(ride.data));

  const grab = await api(`/driver/rides/${ride.data.ride.id}/accept`, { method: 'POST', token: rider.token });
  assert.equal(grab.status, 409, JSON.stringify(grab.data));
  assert.match(grab.data.error, /delivery run/i);

  // And the shop's goods are still theirs to deliver.
  const mine = await api('/driver/run', { token: rider.token });
  assert.equal(mine.data.run.id, offer.id);
});

test('a rider cannot delete their account mid-run', async () => {
  // Deleting revokes every session, so nobody could finish a run holding a
  // customer's goods — and possibly their cash.
  const shop = await openShop('Blocker Kirana', 27.6893, 85.3436);
  const rider = await onboardCourier(27.6890, 85.3430);

  const stamp = Date.now();
  const cust = await api('/auth/register', {
    method: 'POST', body: { name: 'Cust2', email: `del-${stamp}@test.local`, password: 'secret1' }
  });
  const order = await api('/store-orders', {
    method: 'POST', token: cust.data.token,
    body: {
      storeId: shop.storeId, items: [{ itemId: shop.itemId, qty: 1 }], payment: 'wallet',
      deliverTo: { lat: 27.6880, lng: 85.3420, name: 'Baneshwor' }
    }
  });
  const orderId = order.data.order.id;
  await api(`/partner/store-orders/${orderId}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/store-orders/${orderId}/ready`, { method: 'POST', token: shop.token });

  const offer = await waitFor(async () => {
    const r = await api('/driver/run', { token: rider.token });
    return r.data.run && r.data.offered ? r.data.run : null;
  });
  assert.ok(offer);
  assert.equal((await api(`/driver/runs/${offer.id}/accept`, { method: 'POST', token: rider.token })).status, 200);

  await api('/driver/online', { method: 'POST', token: rider.token, body: { online: false } });
  const del = await api('/driver/account/delete', {
    method: 'POST', token: rider.token, body: { password: 'driver-secret' }
  });
  assert.equal(del.status, 400, JSON.stringify(del.data));
  assert.match(del.data.error, /delivery run in progress/i);
});
