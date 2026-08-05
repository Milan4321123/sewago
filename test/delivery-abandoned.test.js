// What happens to the MONEY when a rider collects bags from the shops and then
// vanishes — the 'courier_abandoned' recovery branch.
//
// Separate file because it needs knobs the other delivery suites cannot share:
// the dropoff deadline turned down to seconds AND a batch target of two — the
// stale-courier fix needs a run that is only HALF collected, which the recovery
// suite's target-1 runs can never produce.
//
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { freePort } = require('./freePort');

// Assigned in before(): the OS picks a free port, so parallel checkouts
// (agent worktrees, a second clone) can run this suite at the same time.
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

async function registerUser(name) {
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const { data } = await api('/auth/register', { method: 'POST', body: { name, email, password: 'secret1' } });
  return { token: data.token, user: data.user };
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
      name: 'Vanishing Rider', email: `rr-${stamp}@test.local`, password: 'driver-secret',
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

async function waitFor(fn, tries = 75, gap = 400) {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, gap));
  }
  return null;
}

// Accept the offered run from the named shop, tick its first pickup, then go
// silent forever. Runs left in the pool by earlier tests (a released order gets
// re-batched into a fresh run nobody works) can be offered first — decline
// those so the vanish is provably about THIS test's orders.
async function collectFirstStopAndVanish(riderToken, shopName) {
  const offer = await waitFor(async () => {
    const r = await api('/driver/run', { token: riderToken });
    const run = r.data.run;
    if (run && run.stops.some((s) => s.type === 'pickup' && s.name === shopName)) return run;
    if (run && r.data.offered) await api(`/driver/runs/${run.id}/decline`, { method: 'POST', token: riderToken });
    return null;
  });
  assert.ok(offer, 'the packed orders are offered to the only rider around');
  assert.equal(offer.stops[0].name, shopName, 'the first stop is the shop whose bag will be taken');
  assert.equal((await api(`/driver/runs/${offer.id}/accept`, { method: 'POST', token: riderToken })).status, 200);
  const tick = await api(`/driver/runs/${offer.id}/stops/0/done`, { method: 'POST', token: riderToken });
  assert.equal(tick.status, 200, JSON.stringify(tick.data));
  // ...and then nothing, until the dropoff deadline declares the run abandoned.
  const freed = await waitFor(async () => {
    const r = await api('/driver/run', { token: riderToken });
    return r.data.run === null ? true : null;
  });
  assert.ok(freed, 'the abandoned run is taken off the rider');
  return offer;
}

before(async () => {
  PORT = await freePort();
  BASE = `http://localhost:${PORT}/api`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-abandoned-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATA_STORE: 'json', DATA_DIR: dataDir,
      ADMIN_EMAIL, ADMIN_PASSWORD, OTP_PROVIDER: 'sandbox', EMAIL_PROVIDER: 'sandbox',
      DRIVER_LICENSE_DEMO_CODE: '123456',
      DELIVERY_BATCH_TARGET: '2',            // a two-order run can be HALF collected
      DELIVERY_MAX_WAIT_MIN: '0.1',          // ~6s: a lone order still becomes a run
      DELIVERY_OFFER_SECONDS: '5',
      DELIVERY_LAPSE_COOLDOWN_SEC: '5',
      DELIVERY_RUN_PICKUP_DEADLINE_MIN: '5', // must never fire here — only the dropoff branch is under test
      DELIVERY_RUN_DROPOFF_DEADLINE_MIN: '0.1', // 6s of post-pickup silence = abandoned
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

test('a half-collected run resolves the taken order and releases the untouched one', async () => {
  // Two shops a few hundred metres apart, one prepaid order at each, batched
  // into a single run. The rider collects shop A's bag and vanishes. The old
  // behaviour stranded EVERYTHING: order A's money was frozen (every resolution
  // endpoint is status-gated away from 'collected'), and order B — still on
  // shop B's counter — kept pointing at the vanished rider, so the shopkeeper
  // could not even hand it to the customer standing at the till.
  const shopA = await openShop('Vanish Kirana A', 27.7154, 85.3123);
  const shopB = await openShop('Vanish Kirana B', 27.7170, 85.3140);
  const rider = await onboardCourier(27.7160, 85.3130);
  const cA = await registerUser('vanish-a');
  const cB = await registerUser('vanish-b');
  // Order A first: the oldest order seeds the cluster, so stop 0 is shop A.
  const orderA = await orderAndPack(shopA, cA.token, { lat: 27.7100, lng: 85.3100, name: 'Chhetrapati' });
  const orderB = await orderAndPack(shopB, cB.token, { lat: 27.7110, lng: 85.3115, name: 'Paknajol' });

  const run = await collectFirstStopAndVanish(rider.token, 'Vanish Kirana A');
  assert.equal(run.orders, 2, 'both orders ride together');
  assert.equal(run.pickups, 2);

  // Order A: terminal, and every rupee lands where the handshake says.
  const aView = await api('/store-orders', { token: cA.token });
  const a = aView.data.orders.find((o) => o.id === orderA.id);
  assert.equal(a.status, 'cancelled');
  assert.equal(a.cancelReason, 'courier_abandoned');

  const cust = await api('/auth/me', { token: cA.token });
  assert.equal(cust.data.user.wallet, 5000, 'the customer got every rupee back');

  const shop = await api('/partner/me', { token: shopA.token });
  assert.equal(shop.data.partner.pendingEarnings, 0, 'nothing is frozen in pending');
  assert.equal(shop.data.partner.earnings, orderA.partnerCut, 'the shop keeps the sale — it handed real goods to our courier');

  // The goods left the shop in the rider's bag, so the shelf must NOT grow them back.
  const inv = await api(`/partner/stores/${shopA.storeId}/inventory`, { token: shopA.token });
  assert.equal(inv.data.items.find((i) => i.id === shopA.itemId).stock, 499, 'no restock for goods that are physically gone');

  // The rider absorbs the loss, on the same ledger COD debts live on.
  const riderView = await api('/driver/me', { token: rider.token });
  assert.equal(riderView.data.driver.commissionOwed, orderA.total, 'the rider owes the order they walked off with');

  // Order B never left shop B: back to 'ready', no rider pinned to it...
  const bView = await api('/store-orders', { token: cB.token });
  const b = bView.data.orders.find((o) => o.id === orderB.id);
  assert.equal(b.status, 'ready', 'the untouched order is packed and waiting again');
  assert.ok(!b.courierId, 'the vanished rider is no longer pinned to it');

  // ...so the shopkeeper can hand the bag to the customer at the counter.
  const handover = await api(`/partner/store-orders/${orderB.id}/handover`, { method: 'POST', token: shopB.token });
  assert.equal(handover.status, 200, JSON.stringify(handover.data));
  assert.equal(handover.data.order.status, 'delivered');

  // The incident is queued for staff, naming the rider — and only the incident:
  // the released order needs nobody.
  const queue = await api('/admin/attention', { token: adminToken });
  const flagged = queue.data.orders.find((o) => o.id === orderA.id);
  assert.ok(flagged, 'the lost order is listed for staff');
  assert.equal(flagged.courier.id, rider.id);
  assert.equal(flagged.refunded, true);
  assert.ok(!queue.data.orders.find((o) => o.id === orderB.id), 'the released order is not an incident');

  // Staff close the loop; the flag clears and stays cleared.
  const resolve = await api(`/admin/store-orders/${orderA.id}/attention/resolve`, {
    method: 'POST', token: adminToken, body: { note: 'rider suspended, goods written off' }
  });
  assert.equal(resolve.status, 200, JSON.stringify(resolve.data));
  const emptied = await api('/admin/attention', { token: adminToken });
  assert.ok(!emptied.data.orders.find((o) => o.id === orderA.id), 'resolved incidents leave the queue');
  const again = await api(`/admin/store-orders/${orderA.id}/attention/resolve`, { method: 'POST', token: adminToken });
  assert.equal(again.status, 400, 'resolving twice is refused');
});

test('a collected cash order bills the vanished rider and pays the shop', async () => {
  // Cash: the customer never paid, so there is nothing to refund — but the
  // shop handed over real goods and must not eat the loss. The rider is billed
  // the order total exactly as if they had collected at the customer's door.
  const shop = await openShop('Cash Vanish Kirana', 27.6727, 85.3255);
  const rider = await onboardCourier(27.6730, 85.3250);
  const c = await registerUser('cash-vanish');
  const order = await orderAndPack(shop, c.token, { lat: 27.6700, lng: 85.3200, name: 'Patan' }, 'cash');

  await collectFirstStopAndVanish(rider.token, 'Cash Vanish Kirana');

  const orders = await api('/store-orders', { token: c.token });
  assert.equal(orders.data.orders.find((o) => o.id === order.id).status, 'cancelled');

  const cust = await api('/auth/me', { token: c.token });
  assert.equal(cust.data.user.wallet, 5000, 'nothing was charged, so nothing is refunded');

  const shopView = await api('/partner/me', { token: shop.token });
  assert.equal(shopView.data.partner.earnings, order.partnerCut, 'the shop is paid for goods it handed over');
  assert.equal(shopView.data.partner.pendingEarnings, 0);

  const riderView = await api('/driver/me', { token: rider.token });
  assert.equal(riderView.data.driver.commissionOwed, order.total, 'billed as if they had collected at the door');

  // The platform's cut is booked from the rider's debt, like any cash order.
  const pay = await api('/admin/payments', { token: adminToken });
  assert.ok(
    pay.data.ledger.some((e) => e.refId === order.id && e.source === 'store_commission'),
    'commission on the abandoned cash order reaches the platform ledger'
  );

  const queue = await api('/admin/attention', { token: adminToken });
  const flagged = queue.data.orders.find((o) => o.id === order.id);
  assert.ok(flagged, 'the cash incident is queued for staff too');
  assert.equal(flagged.refunded, false, 'staff can see no refund was involved');
});
