// The nearby-offer radius gate for batched courier runs: a run is only ever
// offered to a rider within DELIVERY_OFFER_RADIUS_KM of its first pickup.
// Offering "the nearest rider in the whole city" meant a rider 26 km out could
// be handed a Thamel run and burn the offer window getting nowhere.
//
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 4996;
const BASE = `http://localhost:${PORT}/api`;
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

async function openShop(name, lat, lng) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const reg = await api('/partner/register', {
    method: 'POST',
    body: {
      name, email: `sh-${stamp}@test.local`, password: 'partner-secret',
      phone: `+9779${stamp.slice(-9)}`, regNo: `PAN-${stamp.slice(-6)}`
    }
  });
  const token = reg.data.token;
  const otp = await api('/partner/phone/request-otp', { method: 'POST', token, body: {} });
  await api('/partner/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  await api(`/admin/partners/${reg.data.partner.id}/kyc/approve`, { method: 'POST', token: adminToken });
  const store = await api('/partner/stores', {
    method: 'POST', token, body: { name, area: 'Thamel', deliveryFee: 30 }
  });
  const storeId = store.data.store.id;
  await api(`/admin/stores/${storeId}/approve`, { method: 'POST', token: adminToken });
  // Drop the shop's real pin so the offer gate measures a real distance.
  await api(`/partner/stores/${storeId}`, { method: 'PATCH', token, body: { lat, lng, locName: name } });
  const item = await api(`/partner/stores/${storeId}/items`, {
    method: 'POST', token, body: { name: `Rice ${stamp.slice(-4)}`, unit: 'kg', price: 100, stock: 500 }
  });
  return { token, storeId, itemId: item.data.item.id };
}

async function onboardCourier(lat, lng) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const reg = await api('/driver/register', {
    method: 'POST',
    body: {
      name: 'Radius Rider', email: `rad-${stamp}@test.local`, password: 'driver-secret',
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

// Place an order and walk the shopkeeper's side until it is packed and waiting.
async function orderAndPack(shop, custToken, deliverTo) {
  const order = await api('/store-orders', {
    method: 'POST', token: custToken,
    body: { storeId: shop.storeId, items: [{ itemId: shop.itemId, qty: 1 }], payment: 'wallet', deliverTo }
  });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  const id = order.data.order.id;
  await api(`/partner/store-orders/${id}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/store-orders/${id}/ready`, { method: 'POST', token: shop.token });
  return order.data.order;
}

// The batching sweep runs on a 5s timer; return the moment a run shows up.
async function waitForRun(courierToken, tries = 45) {
  for (let i = 0; i < tries; i += 1) {
    const r = await api('/driver/run', { token: courierToken });
    if (r.data.run) return r.data;
    await new Promise((res) => setTimeout(res, 400));
  }
  return { run: null };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-radius-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, EXIT_WHEN_STDIN_CLOSES: '1', NODE_ENV: 'development', PORT: String(PORT), DATA_STORE: 'json', DATA_DIR: dataDir,
      ADMIN_EMAIL, ADMIN_PASSWORD, OTP_PROVIDER: 'sandbox', EMAIL_PROVIDER: 'sandbox',
      DRIVER_LICENSE_DEMO_CODE: '123456',
      DELIVERY_BATCH_TARGET: '3',
      DELIVERY_MAX_WAIT_MIN: '0.02', // ~1s, so a lone order becomes a run at once
      DELIVERY_OFFER_SECONDS: '60',  // long window: this test is about WHO is offered, not lapses
      DELIVERY_OFFER_RADIUS_KM: '6',
      STORE_COMMISSION_PCT: '8', STORE_SERVICE_FEE: '5',
      LOG_LEVEL: 'error'
    },
    stdio: ['pipe', 'ignore', 'inherit']
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

test('a run is only offered to riders near its first pickup', async () => {
  const shop = await openShop('Radius Kirana', 27.7154, 85.3123);
  // The only rider online is ~26 km north — far outside the 6 km offer radius.
  const farRider = await onboardCourier(27.9500, 85.3123);
  const c = await registerUser('radius-c');
  await orderAndPack(shop, c.token, { lat: 27.7100, lng: 85.3100, name: 'Chhetrapati' });

  // The run forms (max wait ~1s), but the faraway rider must never see it.
  const nothing = await waitForRun(farRider.token, 20);
  assert.equal(nothing.run, null, 'a rider 26 km out must not be offered the run');

  // A rider actually near the shop comes online and gets the same run.
  const nearRider = await onboardCourier(27.7160, 85.3130);
  const offered = await waitForRun(nearRider.token);
  assert.ok(offered.run, 'the nearby rider is offered the waiting run');
  assert.equal(offered.offered, true);

  // The far rider still has nothing — distance, not queue order, decides.
  const still = await api('/driver/run', { token: farRider.token });
  assert.equal(still.data.run, null);

  // Claim it so the run does not linger in the pool.
  const accepted = await api(`/driver/runs/${offered.run.id}/accept`, { method: 'POST', token: nearRider.token });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
});
