// Batched multi-stop courier runs: several shop orders, one rider, several
// pickups and several drops in a single trip.
//
// What has to be true: orders never wait forever to fill a batch, a rider is
// never handed more cash than their float covers, stops complete in order, and
// the money for each order settles exactly once — at the door.
//
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 4993;
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
  // Drop the shop's real pin so the batcher can cluster by geography.
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
      name: 'Run Rider', email: `rr-${stamp}@test.local`, password: 'driver-secret',
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
async function orderAndPack(shop, custToken, deliverTo, payment = 'wallet') {
  const order = await api('/store-orders', {
    method: 'POST', token: custToken,
    body: { storeId: shop.storeId, items: [{ itemId: shop.itemId, qty: 1 }], payment, deliverTo }
  });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  const id = order.data.order.id;
  await api(`/partner/store-orders/${id}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/store-orders/${id}/ready`, { method: 'POST', token: shop.token });
  return order.data.order;
}

// The batching sweep runs on a 5s timer, so the poll window has to comfortably
// clear it. 8s was enough alone but flaked when the whole suite ran in parallel
// and CPU contention pushed the sweep late — this returns the moment a run
// appears, so a longer ceiling costs nothing on a healthy run.
async function waitForRun(courierToken, tries = 45) {
  for (let i = 0; i < tries; i += 1) {
    const r = await api('/driver/run', { token: courierToken });
    if (r.data.run) return r.data;
    await new Promise((res) => setTimeout(res, 400));
  }
  return { run: null };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-runs-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATA_STORE: 'json', DATA_DIR: dataDir,
      ADMIN_EMAIL, ADMIN_PASSWORD, OTP_PROVIDER: 'sandbox', EMAIL_PROVIDER: 'sandbox',
      DRIVER_LICENSE_DEMO_CODE: '123456',
      DELIVERY_BATCH_TARGET: '3',
      DELIVERY_MAX_WAIT_MIN: '0.02', // ~1s, so the "never strand an order" path is testable
      DELIVERY_OFFER_SECONDS: '5',   // shortest allowed, so a lapse is testable
      DELIVERY_LAPSE_COOLDOWN_SEC: '5',
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

test('orders from nearby shops batch into one multi-stop run', async () => {
  // Two shops a few hundred metres apart in Thamel.
  const shopA = await openShop('Thamel Kirana A', 27.7154, 85.3123);
  const shopB = await openShop('Thamel Kirana B', 27.7170, 85.3140);
  const courier = await onboardCourier(27.7160, 85.3130);

  // Three customers, all delivering into the same neighbourhood.
  const c1 = await registerUser('run-c1');
  const c2 = await registerUser('run-c2');
  const c3 = await registerUser('run-c3');
  const o1 = await orderAndPack(shopA, c1.token, { lat: 27.7100, lng: 85.3100, name: 'Chhetrapati' });
  const o2 = await orderAndPack(shopB, c2.token, { lat: 27.7110, lng: 85.3115, name: 'Paknajol' });
  const o3 = await orderAndPack(shopA, c3.token, { lat: 27.7095, lng: 85.3090, name: 'Naya Bazar' });

  const { run, offered } = await waitForRun(courier.token);
  assert.ok(run, 'the batcher should form a run and offer it');
  assert.equal(offered, true);
  assert.equal(run.orders, 3, 'all three nearby orders ride together');
  assert.equal(run.pickups, 2, 'two shops, so two pickup stops — not three');
  assert.equal(run.dropoffs, 3, 'one drop per customer');
  assert.equal(run.stops.length, 5);
  // Pickups are planned before dropoffs — you cannot deliver what you have not collected.
  const types = run.stops.map((s) => s.type);
  assert.deepEqual(types.slice(0, 2), ['pickup', 'pickup']);
  assert.deepEqual(types.slice(2), ['dropoff', 'dropoff', 'dropoff']);
  assert.ok(run.payout > 0, 'the rider is paid for the run');
  assert.ok(run.distanceKm > 0);
  assert.ok([o1.id, o2.id, o3.id].length === 3);

  // Claim it so this run stops being re-offered — otherwise it would surface in
  // a later test's poll and look like that test's own batch.
  await api(`/driver/runs/${run.id}/accept`, { method: 'POST', token: courier.token });
});

test('a rider works the run stop by stop, and each order settles at its own door', async () => {
  const shop = await openShop('Settle Kirana', 27.6893, 85.3436);
  const courier = await onboardCourier(27.6890, 85.3430);
  const c1 = await registerUser('settle-c1');
  const c2 = await registerUser('settle-c2');
  const c3 = await registerUser('settle-c3');
  await orderAndPack(shop, c1.token, { lat: 27.6880, lng: 85.3420, name: 'Baneshwor A' });
  await orderAndPack(shop, c2.token, { lat: 27.6875, lng: 85.3410, name: 'Baneshwor B' });
  await orderAndPack(shop, c3.token, { lat: 27.6870, lng: 85.3400, name: 'Baneshwor C' });

  const { run } = await waitForRun(courier.token);
  assert.ok(run, 'a run should be offered');
  const accepted = await api(`/driver/runs/${run.id}/accept`, { method: 'POST', token: courier.token });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));

  // Skipping ahead is refused — stops are worked in order.
  const skip = await api(`/driver/runs/${run.id}/stops/2/done`, { method: 'POST', token: courier.token });
  assert.equal(skip.status, 400);
  assert.match(skip.data.error, /stop 1 first/i);

  // Shop income is still pending while the goods are in the rider's bag.
  const before = await api('/partner/me', { token: shop.token });
  assert.ok(before.data.partner.pendingEarnings > 0);
  assert.equal(before.data.partner.earnings, 0);

  // Collect from the shop.
  const pickup = await api(`/driver/runs/${run.id}/stops/0/done`, { method: 'POST', token: courier.token });
  assert.equal(pickup.status, 200, JSON.stringify(pickup.data));
  assert.equal(pickup.data.run.status, 'delivering', 'one shop, so collection is done in one stop');

  // Deliver each order; income settles door by door, not all at once.
  let settledAfterFirst = 0;
  for (const seq of [1, 2, 3]) {
    const done = await api(`/driver/runs/${run.id}/stops/${seq}/done`, { method: 'POST', token: courier.token });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    if (seq === 1) {
      const mid = await api('/partner/me', { token: shop.token });
      settledAfterFirst = mid.data.partner.earnings;
      assert.ok(settledAfterFirst > 0, 'the first delivery settles only its own order');
      assert.ok(mid.data.partner.pendingEarnings > 0, 'the other two are still pending');
    }
  }

  const after = await api('/partner/me', { token: shop.token });
  assert.equal(after.data.partner.pendingEarnings, 0, 'everything settles once delivered');
  assert.equal(after.data.partner.earnings, settledAfterFirst * 3, 'three equal orders, three equal settlements');

  const finished = await api('/driver/run', { token: courier.token });
  assert.equal(finished.data.run, null, 'the rider is free again');
  const driver = await api('/driver/me', { token: courier.token });
  assert.ok(driver.data.driver.earnings > 0, 'the rider was paid for the run');
});

test('a lone order is not stranded waiting for a batch to fill', async () => {
  const shop = await openShop('Lonely Kirana', 27.6727, 85.3255);
  const courier = await onboardCourier(27.6730, 85.3250);
  const c = await registerUser('lonely');
  await orderAndPack(shop, c.token, { lat: 27.6700, lng: 85.3200, name: 'Patan' });

  // Batch target is 3, but the max wait is ~1s — it must go out alone.
  const { run } = await waitForRun(courier.token);
  assert.ok(run, 'a single waiting order still becomes a run');
  assert.equal(run.orders, 1);
  assert.equal(run.dropoffs, 1);
});

test('letting an offer lapse does not strand the order forever', async () => {
  // The offer window here is 1s and the lapse cooldown 2s, so the rider is
  // guaranteed to miss the first offer. Silence must not be read as a refusal:
  // when they are the only rider around, the run has to come back to them.
  const shop = await openShop('Lapse Kirana', 27.7359, 85.3009);
  const courier = await onboardCourier(27.7355, 85.3005);
  const c = await registerUser('lapse-c');
  await orderAndPack(shop, c.token, { lat: 27.7340, lng: 85.2990, name: 'Balaju' });

  const first = await waitForRun(courier.token, 20);
  assert.ok(first.run, 'the run is offered once');

  // Ignore it completely and let the window close.
  await new Promise((r) => setTimeout(r, 4000));

  const second = await waitForRun(courier.token, 25);
  assert.ok(second.run, 'the same rider is asked again rather than the order dying');
  const accepted = await api(`/driver/runs/${second.run.id}/accept`, { method: 'POST', token: courier.token });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
});

test('a run is never offered to a rider whose cash float it would blow', async () => {
  // Three Rs 2,030 cash orders = Rs 6,090 of cash, far past the Rs 2,000 float.
  const shop = await openShop('Cash Kirana', 27.7215, 85.3620);
  const courier = await onboardCourier(27.7210, 85.3615);
  const c1 = await registerUser('cash-c1');
  const c2 = await registerUser('cash-c2');
  const c3 = await registerUser('cash-c3');
  const big = { lat: 27.7200, lng: 85.3600, name: 'Boudha' };
  for (const c of [c1, c2, c3]) {
    const order = await api('/store-orders', {
      method: 'POST', token: c.token,
      body: { storeId: shop.storeId, items: [{ itemId: shop.itemId, qty: 20 }], payment: 'cash', deliverTo: big }
    });
    assert.equal(order.status, 200, JSON.stringify(order.data));
    await api(`/partner/store-orders/${order.data.order.id}/accept`, { method: 'POST', token: shop.token });
    await api(`/partner/store-orders/${order.data.order.id}/ready`, { method: 'POST', token: shop.token });
  }

  // The run forms, but no rider may be offered it — their float cannot hold it.
  const offered = await waitForRun(courier.token, 8);
  assert.equal(offered.run, null, 'a rider must never be handed more cash than their float covers');
});
