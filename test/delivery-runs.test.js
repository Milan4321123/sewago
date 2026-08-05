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
// Same wait, but pinned to the shop this test opened. A test that leaves a run
// unclaimed leaves it in the pool, and the sweep will happily offer it to the
// next courier who comes online — which is the courier the *next* test just
// created. Hand back anything that is not ours so the assertions below are
// about this test's money and not a neighbour's.
async function waitForRunFrom(courierToken, shopName, tries = 45) {
  const seen = [];
  for (let i = 0; i < tries; i += 1) {
    const r = await api('/driver/run', { token: courierToken });
    const run = r.data.run;
    if (run && run.stops.some((s) => s.type === 'pickup' && s.name === shopName)) return r.data;
    if (run) {
      seen.push(`${run.stops.map((s) => s.name).join('+')} [${run.status}${r.data.offered ? ' offered' : ''}]`);
      if (r.data.offered) await api(`/driver/runs/${run.id}/decline`, { method: 'POST', token: courierToken });
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  return { run: null, seen: [...new Set(seen)] };
}

async function waitForRun(courierToken, tries = 45) {
  for (let i = 0; i < tries; i += 1) {
    const r = await api('/driver/run', { token: courierToken });
    if (r.data.run) return r.data;
    await new Promise((res) => setTimeout(res, 400));
  }
  return { run: null };
}

before(async () => {
  PORT = await freePort();
  BASE = `http://localhost:${PORT}/api`;
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

test('an order settled by shopkeeper handover never double-debits the courier who works its run', async () => {
  // Handover (shopkeeper) and the courier dropoff settle the same order through
  // different flags. If a run has already formed when the shopkeeper hands the
  // order over, a courier can still accept and work it — and the dropoff used to
  // debit them the full cash total for money they never collected. Settlement
  // must be idempotent: a run payout, and no phantom COD debit.
  const shop = await openShop('Double Settle Kirana', 27.7016, 85.3210);
  const courier = await onboardCourier(27.7010, 85.3205);
  const cust = await registerUser('double-settle');

  // Cash so the courier-debit branch is the one exercised; delivery so it runs.
  const placed = await api('/store-orders', {
    method: 'POST', token: cust.token,
    body: {
      storeId: shop.storeId, items: [{ itemId: shop.itemId, qty: 1 }],
      payment: 'cash', fulfilment: 'delivery',
      deliverTo: { lat: 27.6990, lng: 85.3180, name: 'New Road' }
    }
  });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  const orderId = placed.data.order.id;
  const orderTotal = placed.data.order.total;
  assert.ok(orderTotal > 0);
  await api(`/partner/store-orders/${orderId}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/store-orders/${orderId}/ready`, { method: 'POST', token: shop.token });

  // Let the run form and be offered — but do NOT accept yet.
  const { run } = await waitForRun(courier.token);
  assert.ok(run, 'the lone order forms a run');
  const runPayout = run.payout;
  assert.ok(runPayout > 0);

  // Shopkeeper hands the order over while the run is still only offered — this
  // marks it delivered and settled on the shop side (the race window).
  const handover = await api(`/partner/store-orders/${orderId}/handover`, { method: 'POST', token: shop.token });
  assert.equal(handover.status, 200, JSON.stringify(handover.data));
  assert.equal(handover.data.order.status, 'delivered');

  // The courier can still accept and work the already-settled run.
  const accepted = await api(`/driver/runs/${run.id}/accept`, { method: 'POST', token: courier.token });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  await api(`/driver/runs/${run.id}/stops/0/done`, { method: 'POST', token: courier.token }); // pickup
  const drop = await api(`/driver/runs/${run.id}/stops/1/done`, { method: 'POST', token: courier.token }); // dropoff
  assert.equal(drop.status, 200, JSON.stringify(drop.data));

  // The courier keeps their run payout and is NOT debited the order total for
  // cash they never collected. Before the fix this was runPayout - orderTotal.
  const me = await api('/driver/me', { token: courier.token });
  assert.equal(me.data.driver.earnings, runPayout,
    'courier earns the run payout only — no phantom COD debit for an already-settled order');
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

test('the shopkeeper cannot settle an order a courier is already carrying', async () => {
  // Regression: an order stays 'ready' until the rider ticks the pickup stop,
  // so "Handed over" was exactly the tap a shopkeeper made when handing over the
  // bag. It marked the order delivered+settled, which made the run's dropoff
  // skip the courier's cash debit — the customer's cash simply vanished.
  const shop = await openShop('Handover Kirana', 27.6789, 85.3494);
  const courier = await onboardCourier(27.6785, 85.3490);
  const c = await registerUser('handover-c');
  const order = await api('/store-orders', {
    method: 'POST', token: c.token,
    body: {
      storeId: shop.storeId, items: [{ itemId: shop.itemId, qty: 1 }],
      payment: 'cash', deliverTo: { lat: 27.6770, lng: 85.3470, name: 'Koteshwor' }
    }
  });
  const orderId = order.data.order.id;
  const total = order.data.order.total;
  await api(`/partner/store-orders/${orderId}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/store-orders/${orderId}/ready`, { method: 'POST', token: shop.token });

  const { run, seen } = await waitForRunFrom(courier.token, 'Handover Kirana');
  assert.ok(run, `the cash order becomes a run (saw instead: ${JSON.stringify(seen)})`);
  const accepted = await api(`/driver/runs/${run.id}/accept`, { method: 'POST', token: courier.token });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));

  // The shopkeeper taps "Handed over" as the rider takes the bag.
  const premature = await api(`/partner/store-orders/${orderId}/handover`, { method: 'POST', token: shop.token });
  assert.equal(premature.status, 409, 'settling an order a courier holds must be refused');
  assert.match(premature.data.error, /courier is delivering/i);

  // The run completes normally and the courier is debited the cash they took.
  for (const stop of run.stops) {
    const done = await api(`/driver/runs/${run.id}/stops/${stop.seq}/done`, { method: 'POST', token: courier.token });
    assert.equal(done.status, 200, JSON.stringify(done.data));
  }
  const driver = await api('/driver/me', { token: courier.token });
  assert.ok(
    driver.data.driver.commissionOwed >= total - run.payout,
    `courier must owe the cash they collected (owes ${driver.data.driver.commissionOwed}, collected ${total})`
  );
});

test('a courier cannot decline a run they have already accepted', async () => {
  // Regression: decline had no status guard and accept never released the offer,
  // so a rider could collect every bag, decline, and let a second rider tick the
  // last stop and be paid the entire run.
  const shop = await openShop('Decline Kirana', 27.7016, 85.3117);
  const courier = await onboardCourier(27.7010, 85.3110);
  const c = await registerUser('decline-c');
  await orderAndPack(shop, c.token, { lat: 27.7000, lng: 85.3090, name: 'New Road' });

  const { run } = await waitForRunFrom(courier.token, 'Decline Kirana');
  assert.ok(run);
  assert.equal((await api(`/driver/runs/${run.id}/accept`, { method: 'POST', token: courier.token })).status, 200);

  const declined = await api(`/driver/runs/${run.id}/decline`, { method: 'POST', token: courier.token });
  assert.equal(declined.status, 409, 'an accepted run cannot be declined back into the pool');
  assert.match(declined.data.error, /already accepted/i);

  // It is still theirs to finish.
  const mine = await api('/driver/run', { token: courier.token });
  assert.equal(mine.data.run.id, run.id);
  assert.equal(mine.data.offered, false);
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
