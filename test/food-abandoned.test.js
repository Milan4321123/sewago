// What happens to the MONEY when a food courier collects an order from the
// restaurant and then vanishes — the 'courier_abandoned' branch of
// recoverAbandonedDeliveries, mirroring the shop-run version in deliveryRuns.
//
// Separate file because it needs the food dropoff deadline turned down to
// seconds (FOOD_DROPOFF_DEADLINE_MIN) so the recovery sweep fires mid-test.
//
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 4997;
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

// A KYC-approved partner with an approved Thamel restaurant and one dish.
async function onboardRestaurant(name, price) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
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
  const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const reg = await api('/driver/register', {
    method: 'POST',
    body: {
      name: 'Vanishing Courier', email: `vc-${stamp}@test.local`, password: 'driver-secret',
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

// Place an order, have the restaurant confirm it, and have the courier collect
// it — then the courier goes silent forever.
async function collectAndVanish(shop, courier, custToken, payment = 'wallet') {
  const placed = await api('/orders', {
    method: 'POST', token: custToken,
    body: {
      restaurantId: shop.restaurantId, items: [{ id: shop.menuItemId, qty: 1 }],
      deliveryTo: { lat: 27.6893, lng: 85.3436, name: 'New Baneshwor' },
      payment
    }
  });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  const order = placed.data.order;
  assert.equal((await api(`/partner/orders/${order.id}/accept`, { method: 'POST', token: shop.token })).status, 200);
  const take = await api(`/driver/deliveries/${order.id}/accept`, { method: 'POST', token: courier.token });
  assert.equal(take.status, 200, JSON.stringify(take.data));
  const pick = await api(`/driver/deliveries/${order.id}/pickup`, { method: 'POST', token: courier.token });
  assert.equal(pick.status, 200, JSON.stringify(pick.data));
  // ...and then nothing, until the dropoff deadline declares it abandoned.
  return order;
}

async function waitFor(fn, tries = 75, gap = 400) {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, gap));
  }
  return null;
}

async function waitForCancelled(custToken, orderId) {
  const cancelled = await waitFor(async () => {
    const view = await api('/orders', { token: custToken });
    const o = view.data.orders.find((x) => x.id === orderId);
    return o && o.status === 'cancelled' ? o : null;
  });
  assert.ok(cancelled, 'the abandoned order must reach a terminal state on its own');
  return cancelled;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-food-abandoned-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATA_STORE: 'json', DATA_DIR: dataDir,
      ADMIN_EMAIL, ADMIN_PASSWORD, OTP_PROVIDER: 'sandbox', EMAIL_PROVIDER: 'sandbox',
      DRIVER_LICENSE_DEMO_CODE: '123456', FOOD_SERVICE_FEE: '15',
      FOOD_PICKUP_DEADLINE_MIN: '5',  // must never fire here — only the dropoff branch is under test
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

test('a prepaid order whose courier vanishes refunds the customer, pays the restaurant and bills the courier', async () => {
  const shop = await onboardRestaurant('Vanish Kitchen', 500);
  const courier = await onboardCourier(27.7152, 85.3123);
  const { token: cust, user } = await registerUser('vanish-eater');
  const startWallet = user.wallet;

  const order = await collectAndVanish(shop, courier, cust);
  assert.equal((await api('/auth/me', { token: cust })).data.user.wallet, startWallet - order.total, 'prepaid: charged at placement');

  const cancelled = await waitForCancelled(cust, order.id);
  assert.equal(cancelled.cancelReason, 'courier_abandoned');

  // The customer got nothing, so every rupee comes back.
  assert.equal((await api('/auth/me', { token: cust })).data.user.wallet, startWallet, 'the customer got every rupee back');

  // The restaurant cooked a real meal and handed it to our courier — the sale
  // is honoured, moved out of pending exactly as a delivery would have.
  const partner = await api('/partner/me', { token: shop.token });
  assert.equal(partner.data.partner.pendingEarnings, 0, 'nothing left frozen in pending');
  assert.equal(partner.data.partner.earnings, order.partnerCut, 'the restaurant keeps the sale');

  // The courier absorbs the loss on the same ledger COD debts live on, and is
  // no longer pinned to the dead job.
  const me = await api('/driver/me', { token: courier.token });
  assert.equal(me.data.driver.commissionOwed, order.total, 'the courier owes the order they walked off with');
  assert.equal(me.data.delivery, null, 'the abandoned job no longer blocks the courier');

  // The incident is queued for staff, naming everyone involved.
  const queue = await api('/admin/attention', { token: adminToken });
  const flagged = queue.data.orders.find((o) => o.id === order.id);
  assert.ok(flagged, 'the lost order is listed for staff');
  assert.equal(flagged.courier.id, courier.id);
  assert.equal(flagged.courier.owes, order.total);
  assert.equal(flagged.refunded, true);

  // The books still balance: commission + service fee stay booked, funded by
  // the courier's debt rather than the (refunded) customer.
  const overview = await api('/admin/overview', { token: adminToken });
  assert.equal(overview.data.reconciliation.drift, 0, 'ledger and recomputed revenue must still agree');

  // Staff close the loop; the flag clears and stays cleared.
  const resolve = await api(`/admin/orders/${order.id}/attention/resolve`, {
    method: 'POST', token: adminToken, body: { note: 'courier suspended, meal written off' }
  });
  assert.equal(resolve.status, 200, JSON.stringify(resolve.data));
  const emptied = await api('/admin/attention', { token: adminToken });
  assert.ok(!emptied.data.orders.find((o) => o.id === order.id), 'resolved incidents leave the queue');
  const again = await api(`/admin/orders/${order.id}/attention/resolve`, { method: 'POST', token: adminToken });
  assert.equal(again.status, 400, 'resolving twice is refused');
});

test('a COD order whose courier vanishes bills the courier and books the platform cut', async () => {
  // Cash: the customer never paid, so there is nothing to refund — but the
  // restaurant handed over a real meal and must not eat the loss. The courier
  // is billed the order total exactly as if they had collected at the door.
  const shop = await onboardRestaurant('Cash Vanish Kitchen', 400);
  const courier = await onboardCourier(27.7152, 85.3123);
  const { token: cust, user } = await registerUser('cash-vanish-eater');
  await api('/admin/wallet-adjust', { method: 'POST', token: adminToken, body: { userId: user.id, amount: -user.wallet, reason: 'empty wallet for COD test' } });

  const order = await collectAndVanish(shop, courier, cust, 'cash');
  const cancelled = await waitForCancelled(cust, order.id);
  assert.equal(cancelled.cancelReason, 'courier_abandoned');

  // Nothing was charged, so nothing is refunded.
  assert.equal((await api('/auth/me', { token: cust })).data.user.wallet, 0, 'no phantom refund for unpaid cash');

  const partner = await api('/partner/me', { token: shop.token });
  assert.equal(partner.data.partner.earnings, order.partnerCut, 'the restaurant is paid for food it handed over');
  assert.equal(partner.data.partner.pendingEarnings, 0);

  const me = await api('/driver/me', { token: courier.token });
  assert.equal(me.data.driver.commissionOwed, order.total, 'billed as if they had collected at the door');

  // The platform's cut is booked from the courier's debt, like any cash order.
  const pay = await api('/admin/payments', { token: adminToken });
  assert.ok(
    pay.data.ledger.some((e) => e.refId === order.id && e.source === 'food_commission'),
    'commission on the abandoned cash order reaches the platform ledger'
  );
  assert.ok(
    pay.data.ledger.some((e) => e.refId === order.id && e.source === 'service_fee'),
    'so does the service fee'
  );

  const queue = await api('/admin/attention', { token: adminToken });
  const flagged = queue.data.orders.find((o) => o.id === order.id);
  assert.ok(flagged, 'the cash incident is queued for staff too');
  assert.equal(flagged.refunded, false, 'staff can see no refund was involved');

  // After a prepaid and a cash abandonment, the books still balance.
  const overview = await api('/admin/overview', { token: adminToken });
  assert.equal(overview.data.reconciliation.drift, 0, 'ledger and recomputed revenue must still agree');
});
