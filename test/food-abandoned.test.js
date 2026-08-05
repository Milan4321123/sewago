// What happens to the MONEY when a food courier picks up the order and then
// vanishes — the food-side twin of test/delivery-abandoned.test.js.
//
// The old behaviour only flagged the order (abandonedAt) and left every rupee
// stranded: the prepaid customer was never refunded, the restaurant's cut sat
// frozen in pendingEarnings forever, the courier owed nothing, and no admin
// surface ever listed the incident.
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

// A KYC-approved partner with an approved restaurant and one menu item.
async function onboardPartnerRestaurant(name, price) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const reg = await api('/partner/register', {
    method: 'POST',
    body: { name, email: `fa-${stamp}@test.local`, password: 'partner-secret', phone: `+9778${stamp.slice(-9)}`, regNo: `PAN-${stamp.slice(-6)}` }
  });
  const token = reg.data.token;
  const otp = await api('/partner/phone/request-otp', { method: 'POST', token, body: {} });
  await api('/partner/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  await api(`/admin/partners/${reg.data.partner.id}/kyc/approve`, { method: 'POST', token: adminToken });
  const rest = await api('/partner/restaurants', {
    method: 'POST', token,
    body: { name, cuisine: 'Test', area: 'Thamel', etaMinutes: 20, deliveryFee: 100 }
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
      name: 'Vanishing Foodie', email: `vf-${stamp}@test.local`, password: 'driver-secret',
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

// Order, restaurant accepts, courier takes it, collects the food — then silence.
async function pickUpAndVanish(shop, custToken, courier, payment) {
  const order = await api('/orders', {
    method: 'POST', token: custToken,
    body: {
      restaurantId: shop.restaurantId, items: [{ id: shop.menuItemId, qty: 1 }],
      deliveryTo: { lat: 27.6893, lng: 85.3436, name: 'New Baneshwor' }, payment
    }
  });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  const o = order.data.order;
  assert.equal((await api(`/partner/orders/${o.id}/accept`, { method: 'POST', token: shop.token })).status, 200);
  const take = await api(`/driver/deliveries/${o.id}/accept`, { method: 'POST', token: courier.token });
  assert.equal(take.status, 200, JSON.stringify(take.data));
  assert.equal((await api(`/driver/deliveries/${o.id}/pickup`, { method: 'POST', token: courier.token })).status, 200);
  // ...and then nothing, until the dropoff deadline declares it abandoned.
  const gone = await waitFor(async () => {
    const r = await api('/orders', { token: custToken });
    const mine = r.data.orders.find((x) => x.id === o.id);
    return mine && mine.status === 'cancelled' ? mine : null;
  });
  assert.ok(gone, 'the abandoned order reaches a terminal state on its own');
  assert.equal(gone.cancelReason, 'courier_abandoned');
  return o;
}

async function waitFor(fn, tries = 75, gap = 400) {
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-food-abandoned-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATA_STORE: 'json', DATA_DIR: dataDir,
      ADMIN_EMAIL, ADMIN_PASSWORD, OTP_PROVIDER: 'sandbox', EMAIL_PROVIDER: 'sandbox',
      DRIVER_LICENSE_DEMO_CODE: '123456', FOOD_SERVICE_FEE: '15',
      FOOD_PICKUP_DEADLINE_MIN: '5',    // must never fire here — only the dropoff branch is under test
      FOOD_DROPOFF_DEADLINE_MIN: '0.1', // 6s of post-pickup silence = abandoned
      CASH_CREDIT_LIMIT: '2000',
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

test('a prepaid order the courier ran off with refunds the customer and bills the courier', async () => {
  const shop = await onboardPartnerRestaurant('Momo Ghar', 500);
  const courier = await onboardCourier(27.7152, 85.3123);
  const { token: cust } = await registerUser('foodie');

  const o = await pickUpAndVanish(shop, cust, courier, 'wallet');
  const partnerCut = Math.round(500 * 0.85);

  // The customer gets every rupee back — they paid and got nothing.
  assert.equal((await api('/auth/me', { token: cust })).data.user.wallet, 5000, 'full refund');

  // The restaurant keeps the sale: it cooked real food and handed it to our courier.
  const partner = await api('/partner/me', { token: shop.token });
  assert.equal(partner.data.partner.pendingEarnings, 0, 'nothing frozen in pending');
  assert.equal(partner.data.partner.earnings, partnerCut, 'income honoured, withdrawable');

  // The courier absorbs the loss on the same ledger COD debts live on.
  const rider = await api('/driver/me', { token: courier.token });
  assert.equal(rider.data.driver.commissionOwed, o.total, 'billed the order they walked off with');

  // The incident is queued for staff, naming the courier.
  const queue = await api('/admin/attention', { token: adminToken });
  const flagged = queue.data.orders.find((x) => x.id === o.id);
  assert.ok(flagged, 'the abandoned food order is listed for staff');
  assert.equal(flagged.kind, 'food');
  assert.equal(flagged.refunded, true);
  assert.equal(flagged.courier.id, courier.id);

  // Staff close the loop through the same endpoint as shop incidents.
  const resolve = await api(`/admin/attention/${o.id}/resolve`, {
    method: 'POST', token: adminToken, body: { note: 'courier suspended' }
  });
  assert.equal(resolve.status, 200, JSON.stringify(resolve.data));
  assert.ok(
    !(await api('/admin/attention', { token: adminToken })).data.orders.find((x) => x.id === o.id),
    'resolved incidents leave the queue'
  );

  // The books still check themselves: commission and service fee stay booked
  // (the courier's debit funds the refund), and the recompute knows it.
  const overview = await api('/admin/overview', { token: adminToken });
  assert.equal(
    overview.data.reconciliation.drift, 0,
    `ledger (${overview.data.reconciliation.ledgerTotal}) vs recomputed ` +
    `(${overview.data.reconciliation.derivedTotal}) after a prepaid abandonment`
  );
});

test('a COD order the courier ran off with pays the restaurant from the courier debt', async () => {
  const shop = await onboardPartnerRestaurant('Sekuwa Corner', 500);
  const courier = await onboardCourier(27.7152, 85.3123);
  const { token: cust, user } = await registerUser('codfoodie');
  await api('/admin/wallet-adjust', {
    method: 'POST', token: adminToken, body: { userId: user.id, amount: -user.wallet, reason: 'empty wallet for COD test' }
  });

  const o = await pickUpAndVanish(shop, cust, courier, 'cash');
  const partnerCut = Math.round(500 * 0.85);

  // Nothing was ever charged, so there is nothing to refund.
  assert.equal((await api('/auth/me', { token: cust })).data.user.wallet, 0, 'no phantom refund');

  // The restaurant is made whole; the courier is billed as if they had
  // collected the cash at the door.
  const partner = await api('/partner/me', { token: shop.token });
  assert.equal(partner.data.partner.earnings, partnerCut);
  assert.equal(partner.data.partner.pendingEarnings, 0);
  const rider = await api('/driver/me', { token: courier.token });
  assert.equal(rider.data.driver.commissionOwed, o.total);

  // The platform's cut is booked from that debt, like any COD delivery...
  const pay = await api('/admin/payments', { token: adminToken });
  assert.ok(
    pay.data.ledger.some((e) => e.refId === o.id && e.source === 'food_commission'),
    'commission on the abandoned COD order reaches the platform ledger'
  );

  // ...and staff can see no refund was involved.
  const queue = await api('/admin/attention', { token: adminToken });
  const flagged = queue.data.orders.find((x) => x.id === o.id);
  assert.ok(flagged);
  assert.equal(flagged.refunded, false);

  const overview = await api('/admin/overview', { token: adminToken });
  assert.equal(overview.data.reconciliation.drift, 0, 'books reconcile after a COD abandonment');
});
