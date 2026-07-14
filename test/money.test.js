// Money-path integration tests: wallet debits/refunds, task escrow, the
// withdrawal fee, admin rejection refunds, and the account-deletion guards.
// Boots the real server on a throwaway JSON store and talks to it over HTTP,
// so every assertion covers the same code path production traffic uses.
//
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 4979;
const BASE = `http://localhost:${PORT}/api`;
const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'test-admin-pass';

let server;
let dataDir;

async function api(pathname, { method = 'GET', token = null, body = null } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function registerUser(name) {
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const { status, data } = await api('/auth/register', {
    method: 'POST',
    body: { name, email, password: 'secret1' }
  });
  assert.equal(status, 200, `register failed: ${JSON.stringify(data)}`);
  return { token: data.token, user: data.user, email };
}

async function wallet(token) {
  const { data } = await api('/auth/me', { token });
  return data.user.wallet;
}

// Withdrawals are only sent from phone-verified accounts.
async function verifyPhone(token) {
  const phone = `+9779${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
  const otp = await api('/auth/phone/request-otp', { method: 'POST', token, body: { phone } });
  assert.equal(otp.status, 200, JSON.stringify(otp.data));
  const verified = await api('/auth/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-test-'));
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
      OTP_SANDBOX_CODE: '123456',
      EMAIL_PROVIDER: 'sandbox',
      DRIVER_LICENSE_DEMO_CODE: '123456',
      RIDE_SERVICE_FEE: '5',
      FOOD_SERVICE_FEE: '15',
      RIDE_CANCEL_FEE: '40',
      PROMOTE_WEEK_PRICE: '300',
      RIDE_OFFER_SECONDS: '5', // shortest allowed, so lapse-recycling is testable
      RIDE_SEARCH_TIMEOUT_SECONDS: '60',
      LOG_LEVEL: 'error'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  // Wait for the server to answer health checks.
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Server did not start within 10s');
});

after(async () => {
  if (server) {
    // Let the graceful-shutdown flush finish before removing its data dir.
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('welcome bonus lands in the wallet and the ledger', async () => {
  const { token } = await registerUser('bonus');
  assert.equal(await wallet(token), 5000);
  const { data } = await api('/payments/transactions', { token });
  assert.equal(data.transactions.length, 1);
  assert.equal(data.transactions[0].type, 'bonus');
  assert.equal(data.transactions[0].balanceAfter, 5000);
});

test('ride debits fare + service fee; early cancel refunds everything', async () => {
  const { token } = await registerUser('rider');
  const booked = await api('/rides', {
    method: 'POST',
    token,
    body: { pickup: 'Thamel', dropoff: 'Patan Durbar Square', tier: 'bike', payment: 'wallet' }
  });
  assert.equal(booked.status, 200, JSON.stringify(booked.data));
  const { fare, serviceFee, total } = booked.data.ride;
  assert.ok(fare > 0);
  assert.equal(serviceFee, 5);
  assert.equal(total, fare + 5);
  assert.equal(booked.data.user.wallet, 5000 - total);

  // Cancelled while still searching — everything comes back, including the fee.
  const cancelled = await api(`/rides/${booked.data.ride.id}/cancel`, { method: 'POST', token });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.ride.status, 'cancelled');
  assert.equal(cancelled.data.user.wallet, 5000);

  const { data } = await api('/payments/transactions', { token });
  const types = data.transactions.map((t) => t.type);
  assert.ok(types.includes('ride'), 'debit entry missing');
  assert.ok(types.includes('ride_refund'), 'refund entry missing');
});

test('cash rides do not touch the wallet', async () => {
  const { token } = await registerUser('cash-rider');
  const booked = await api('/rides', {
    method: 'POST',
    token,
    body: { pickup: 'Thamel', dropoff: 'Bhaktapur Durbar Square', tier: 'car', payment: 'cash' }
  });
  assert.equal(booked.status, 200, JSON.stringify(booked.data));
  assert.equal(booked.data.user.wallet, 5000);
  await api(`/rides/${booked.data.ride.id}/cancel`, { method: 'POST', token });
  assert.equal(await wallet(token), 5000);
});

test('task budget is held in escrow and returned on cancel', async () => {
  const { token } = await registerUser('poster');
  const posted = await api('/tasks', {
    method: 'POST',
    token,
    body: { title: 'Grocery run to Asan', category: 'shopping', budget: 800, place: 'Asan' }
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.data));
  assert.equal(posted.data.user.wallet, 4200);

  const cancelled = await api(`/tasks/${posted.data.task.id}/cancel`, { method: 'POST', token });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(await wallet(token), 5000);
});

test('task beyond the wallet balance is refused', async () => {
  const { token } = await registerUser('overspender');
  const posted = await api('/tasks', {
    method: 'POST',
    token,
    body: { title: 'Impossible job', category: 'other', budget: 50000 }
  });
  assert.equal(posted.status, 402);
  assert.equal(await wallet(token), 5000);
});

test('withdrawal requires a verified phone', async () => {
  const { token } = await registerUser('unverified-withdrawer');
  const wd = await api('/payments/withdraw', {
    method: 'POST',
    token,
    body: { amount: 1000, channel: 'esewa', account: '9841000000' }
  });
  assert.equal(wd.status, 400);
  assert.match(wd.data.error, /verify/i);
  assert.equal(await wallet(token), 5000);
});

test('withdrawal charges amount plus fee; admin rejection refunds both', async () => {
  const { token } = await registerUser('withdrawer');
  await verifyPhone(token);
  const wd = await api('/payments/withdraw', {
    method: 'POST',
    token,
    body: { amount: 1000, channel: 'esewa', account: '9841000000' }
  });
  assert.equal(wd.status, 200, JSON.stringify(wd.data));
  assert.equal(wd.data.withdrawal.status, 'processing');
  assert.equal(wd.data.user.wallet, 5000 - 1000 - 10);

  const admin = await api('/admin/login', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
  });
  assert.equal(admin.status, 200, 'admin login failed');

  const rejected = await api(`/admin/withdrawals/${wd.data.withdrawal.id}/reject`, {
    method: 'POST',
    token: admin.data.token,
    body: { note: 'test rejection' }
  });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
  assert.equal(rejected.data.withdrawal.status, 'rejected');
  assert.equal(await wallet(token), 5000);
});

test('withdrawal larger than the balance is refused', async () => {
  const { token } = await registerUser('overdrawer');
  await verifyPhone(token);
  const wd = await api('/payments/withdraw', {
    method: 'POST',
    token,
    body: { amount: 5000, channel: 'khalti', account: '9841000001' }
  });
  assert.equal(wd.status, 400);
  assert.equal(await wallet(token), 5000);
});

test('withdrawal requests are capped per day', async () => {
  const { token } = await registerUser('serial-withdrawer');
  await verifyPhone(token);
  for (let i = 0; i < 5; i += 1) {
    const wd = await api('/payments/withdraw', {
      method: 'POST',
      token,
      body: { amount: 100, channel: 'esewa', account: '9841000002' }
    });
    assert.equal(wd.status, 200, JSON.stringify(wd.data));
  }
  const sixth = await api('/payments/withdraw', {
    method: 'POST',
    token,
    body: { amount: 100, channel: 'esewa', account: '9841000002' }
  });
  assert.equal(sixth.status, 400);
  assert.match(sixth.data.error, /limit/i);
});

test('account deletion is blocked while money is in escrow, allowed after', async () => {
  const { token } = await registerUser('leaver');
  const posted = await api('/tasks', {
    method: 'POST',
    token,
    body: { title: 'Fix my fence gate', category: 'repair', budget: 300 }
  });
  assert.equal(posted.status, 200);

  const blocked = await api('/auth/account/delete', {
    method: 'POST',
    token,
    body: { password: 'secret1' }
  });
  assert.equal(blocked.status, 400, JSON.stringify(blocked.data));
  assert.match(blocked.data.error, /escrow/i);

  await api(`/tasks/${posted.data.task.id}/cancel`, { method: 'POST', token });
  const deleted = await api('/auth/account/delete', {
    method: 'POST',
    token,
    body: { password: 'secret1' }
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));

  // The session must be dead afterwards.
  const me = await api('/auth/me', { token });
  assert.equal(me.status, 401);
});

test('account deletion requires the correct password', async () => {
  const { token } = await registerUser('safe-user');
  const denied = await api('/auth/account/delete', {
    method: 'POST',
    token,
    body: { password: 'wrong-password' }
  });
  assert.equal(denied.status, 401);
  const me = await api('/auth/me', { token });
  assert.equal(me.status, 200, 'account must survive a failed deletion attempt');
});

test('food order charges the service fee and cancel refunds it', async () => {
  const { token } = await registerUser('eater');
  // Seeded restaurant: Momo Ghar, mg-1 = Rs 180, delivery Rs 60.
  const placed = await api('/orders', {
    method: 'POST',
    token,
    body: { restaurantId: 'res-momo-ghar', items: [{ id: 'mg-1', qty: 1 }] }
  });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  assert.equal(placed.data.order.serviceFee, 15);
  assert.equal(placed.data.order.total, 180 + 60 + 15);
  assert.equal(placed.data.user.wallet, 5000 - 255);

  const cancelled = await api(`/orders/${placed.data.order.id}/cancel`, { method: 'POST', token });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(await wallet(token), 5000);
});

// Full live-ride flow: onboard a real driver over the API, let them accept the
// ride, then cancel as the customer — the late-cancel fee must split between
// the driver and the platform.
async function onboardDriver(tier, lat, lng) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const reg = await api('/driver/register', {
    method: 'POST',
    body: {
      name: 'Test Driver',
      email: `driver-${stamp}@test.local`,
      password: 'driver-secret',
      phone: `+9779${stamp.slice(-9)}`,
      tier,
      vehicle: 'Test Bike',
      plate: `TE ${stamp.slice(-4)}`,
      licenseId: `LIC-${stamp.slice(-8)}`,
      licenseCode: '123456'
    }
  });
  assert.equal(reg.status, 200, `driver register failed: ${JSON.stringify(reg.data)}`);
  const token = reg.data.token;

  const otp = await api('/driver/phone/request-otp', { method: 'POST', token, body: {} });
  assert.equal(otp.status, 200, JSON.stringify(otp.data));
  const verified = await api('/driver/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));

  const loc = await api('/driver/location', { method: 'POST', token, body: { lat, lng, accuracy: 10 } });
  assert.equal(loc.status, 200, JSON.stringify(loc.data));
  const online = await api('/driver/online', { method: 'POST', token, body: { online: true } });
  assert.equal(online.status, 200, JSON.stringify(online.data));
  return token;
}

// Shared with the surge test below, which retires this driver when done.
let firstDriverToken = null;

test('late cancel after driver accepts: fee charged, driver compensated', async () => {
  const driverToken = firstDriverToken = await onboardDriver('bike', 27.7152, 85.3123); // Thamel
  const { token } = await registerUser('late-canceller');

  const booked = await api('/rides', {
    method: 'POST',
    token,
    body: { pickup: 'Thamel', dropoff: 'Patan Durbar Square', tier: 'bike', payment: 'wallet' }
  });
  assert.equal(booked.status, 200, JSON.stringify(booked.data));
  assert.equal(booked.data.ride.mode, 'live', 'a real online driver must make the ride live');
  const total = booked.data.ride.total;

  const requests = await api('/driver/requests', { token: driverToken });
  const request = requests.data.requests.find((r) => r.id === booked.data.ride.id);
  assert.ok(request, 'driver must see the live request');
  const accepted = await api(`/driver/rides/${booked.data.ride.id}/accept`, { method: 'POST', token: driverToken });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));

  const beforeEarnings = (await api('/driver/me', { token: driverToken })).data.driver.earnings;
  const cancelled = await api(`/rides/${booked.data.ride.id}/cancel`, { method: 'POST', token });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  // Refund is everything paid minus the Rs 40 fee.
  assert.equal(cancelled.data.user.wallet, 5000 - total + (total - 40));
  assert.equal(cancelled.data.ride.cancelFee, 40);

  const afterEarnings = (await api('/driver/me', { token: driverToken })).data.driver.earnings;
  assert.equal(afterEarnings - beforeEarnings, 20, 'driver gets half the cancellation fee');
});

// Real food fulfillment, end to end: partner onboarding → live order →
// restaurant accept → courier accept/pickup/deliver → every balance checked.
test('live food order: restaurant confirms, courier delivers, everyone is paid', async () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

  // Partner onboarding: register, verify phone, get KYC approved by admin.
  const partnerReg = await api('/partner/register', {
    method: 'POST',
    body: {
      name: 'Test Kitchen',
      email: `kitchen-${stamp}@test.local`,
      password: 'partner-secret',
      phone: `+9778${stamp.slice(-9)}`,
      regNo: `PAN-${stamp.slice(-6)}`
    }
  });
  assert.equal(partnerReg.status, 200, JSON.stringify(partnerReg.data));
  const partnerToken = partnerReg.data.token;
  const partnerId = partnerReg.data.partner.id;

  const pOtp = await api('/partner/phone/request-otp', { method: 'POST', token: partnerToken, body: {} });
  assert.equal(pOtp.status, 200, JSON.stringify(pOtp.data));
  const pVerify = await api('/partner/phone/verify', { method: 'POST', token: partnerToken, body: { code: pOtp.data.devCode } });
  assert.equal(pVerify.status, 200, JSON.stringify(pVerify.data));

  const admin = await api('/admin/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  const kyc = await api(`/admin/partners/${partnerId}/kyc/approve`, { method: 'POST', token: admin.data.token });
  assert.equal(kyc.status, 200, JSON.stringify(kyc.data));

  // Restaurant with a pickup area + one menu item; staff approve the listing.
  const rest = await api('/partner/restaurants', {
    method: 'POST',
    token: partnerToken,
    body: { name: 'Test Kitchen Thamel', cuisine: 'Test · Momo', area: 'Thamel', etaMinutes: 20, deliveryFee: 100 }
  });
  assert.equal(rest.status, 200, JSON.stringify(rest.data));
  const restaurantId = rest.data.restaurant.id;
  assert.equal(rest.data.restaurant.loc.name, 'Thamel', 'area must resolve to gazetteer coords');

  const menu = await api(`/partner/restaurants/${restaurantId}/menu`, {
    method: 'POST',
    token: partnerToken,
    body: { name: 'Test Momo Set', price: 500, desc: 'test' }
  });
  const menuItemId = menu.data.restaurant.menu[0].id;
  await api(`/admin/restaurants/${restaurantId}/approve`, { method: 'POST', token: admin.data.token });

  // Customer orders: 2× Rs 500 + distance-priced delivery + Rs 15 service fee.
  // Thamel → New Baneshwor is ~5.5 road-km: Rs 100 base covers 3 km, then
  // 3 extra km × Rs 15 = Rs 145 delivery. Total 1000 + 145 + 15 = 1160.
  const { token: customerToken } = await registerUser('foodie');
  const noAddress = await api('/orders', {
    method: 'POST',
    token: customerToken,
    body: { restaurantId, items: [{ id: menuItemId, qty: 2 }] }
  });
  assert.equal(noAddress.status, 400, 'live orders must require a delivery location');

  const placed = await api('/orders', {
    method: 'POST',
    token: customerToken,
    body: { restaurantId, items: [{ id: menuItemId, qty: 2 }], deliveryTo: 'New Baneshwor' }
  });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  const order = placed.data.order;
  assert.equal(order.fulfillment, 'live');
  assert.equal(order.status, 'placed');
  assert.equal(order.deliveryFee, 145, 'delivery must be priced by road distance');
  assert.equal(order.total, 1160);
  assert.equal(placed.data.user.wallet, 5000 - 1160);
  assert.equal(order.deliveryLoc.name, 'New Baneshwor');

  // Partner sees it and accepts; customer sees "preparing".
  const queue = await api('/partner/orders', { token: partnerToken });
  assert.equal(queue.data.orders[0].id, order.id);
  assert.equal(queue.data.orders[0].partnerCut, 850, 'partner earns 85% of the Rs 1000 subtotal');
  const accepted = await api(`/partner/orders/${order.id}/accept`, { method: 'POST', token: partnerToken });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.order.status, 'preparing');

  // A bike courier picks up the job: payout is 80% of the Rs 145 delivery fee.
  const courierToken = await onboardDriver('bike', 27.7154, 85.3123);
  const jobs = await api('/driver/deliveries', { token: courierToken });
  const job = jobs.data.deliveries.find((d) => d.id === order.id);
  assert.ok(job, 'courier must see the accepted order as a delivery job');
  assert.equal(job.payout, 116);

  const take = await api(`/driver/deliveries/${order.id}/accept`, { method: 'POST', token: courierToken });
  assert.equal(take.status, 200, JSON.stringify(take.data));

  // A courier mid-delivery cannot delete their account (even after going
  // offline) — the order would be stranded.
  await api('/driver/online', { method: 'POST', token: courierToken, body: { online: false } });
  const strandedDelete = await api('/driver/account/delete', {
    method: 'POST',
    token: courierToken,
    body: { password: 'driver-secret' }
  });
  assert.equal(strandedDelete.status, 400);
  assert.match(strandedDelete.data.error, /delivery/i, 'deletion must be blocked by the active delivery');
  await api('/driver/online', { method: 'POST', token: courierToken, body: { online: true } });

  const pickup = await api(`/driver/deliveries/${order.id}/pickup`, { method: 'POST', token: courierToken });
  assert.equal(pickup.status, 200, JSON.stringify(pickup.data));
  assert.equal(pickup.data.delivery.status, 'out_for_delivery');

  const beforeEarnings = (await api('/driver/me', { token: courierToken })).data.driver.earnings;
  const done = await api(`/driver/deliveries/${order.id}/deliver`, { method: 'POST', token: courierToken });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.payout, 116);
  assert.equal(done.data.driver.earnings - beforeEarnings, 116);

  // Customer sees delivered + who couriered it.
  const myOrders = await api('/orders', { token: customerToken });
  const finished = myOrders.data.orders.find((o) => o.id === order.id);
  assert.equal(finished.status, 'delivered');
  assert.ok(finished.courier && finished.courier.name, 'courier identity must be on the order');

  // Reject path: a second order is refunded in full and the partner cut reversed.
  const partnerBefore = (await api('/partner/me', { token: partnerToken })).data.partner.earnings;
  const placed2 = await api('/orders', {
    method: 'POST',
    token: customerToken,
    body: { restaurantId, items: [{ id: menuItemId, qty: 1 }], deliveryTo: 'Jawalakhel' }
  });
  assert.equal(placed2.status, 200, JSON.stringify(placed2.data));
  const rejected = await api(`/partner/orders/${placed2.data.order.id}/reject`, {
    method: 'POST',
    token: partnerToken,
    body: { note: 'out of stock' }
  });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
  assert.equal(await wallet(customerToken), 5000 - 1160, 'rejected order must be refunded in full');
  const partnerAfter = (await api('/partner/me', { token: partnerToken })).data.partner.earnings;
  assert.equal(partnerAfter - partnerBefore, 0, 'partner cut for the rejected order must be reversed');

  // Rating: the delivered order gives the brand-new restaurant its first stars.
  const rated = await api(`/orders/${order.id}/rate`, { method: 'POST', token: customerToken, body: { stars: 5 } });
  assert.equal(rated.status, 200, JSON.stringify(rated.data));
  const listing = (await api('/restaurants', { token: customerToken })).data.restaurants
    .find((r) => r.id === restaurantId);
  assert.equal(listing.rating, 5, 'first real rating must replace the NEW badge');
  const again = await api(`/orders/${order.id}/rate`, { method: 'POST', token: customerToken, body: { stars: 1 } });
  assert.equal(again.status, 409, 'an order can only be rated once');

  // Promoted listing: the partner spends earnings (Rs 850 accrued) to feature
  // the restaurant — it must jump to the top of the customer list.
  const promo = await api(`/partner/restaurants/${restaurantId}/promote`, { method: 'POST', token: partnerToken });
  assert.equal(promo.status, 200, JSON.stringify(promo.data));
  assert.equal(promo.data.partner.earnings, 850 - 300);
  assert.ok(promo.data.promotedUntil > Date.now() + 6 * 24 * 60 * 60 * 1000, 'promotion must last ~7 days');

  const list = (await api('/restaurants', { token: customerToken })).data.restaurants;
  assert.equal(list[0].id, restaurantId, 'featured listing must sort first for customers');
  assert.ok(list[0].promotedUntil > Date.now(), 'customers must see the featured window');

  // Buying again extends the window; a third attempt exceeds the balance.
  const extend = await api(`/partner/restaurants/${restaurantId}/promote`, { method: 'POST', token: partnerToken });
  assert.equal(extend.status, 200, JSON.stringify(extend.data));
  assert.ok(extend.data.promotedUntil > Date.now() + 13 * 24 * 60 * 60 * 1000, 'second week must stack on the first');
  assert.equal(extend.data.partner.earnings, 850 - 600);
  const broke = await api(`/partner/restaurants/${restaurantId}/promote`, { method: 'POST', token: partnerToken });
  assert.equal(broke.status, 402, 'promotion must refuse when earnings cannot cover it');

  // Leave no extra bike supply behind — the surge test below counts online drivers.
  await api('/driver/online', { method: 'POST', token: courierToken, body: { online: false } });
});

test('task hiring: workers apply, poster hires one, payment flows on confirm', async () => {
  const poster = await registerUser('contractor');
  const worker1 = await registerUser('worker-one');
  const worker2 = await registerUser('worker-two');

  const posted = await api('/tasks', {
    method: 'POST',
    token: poster.token,
    body: { title: 'Fix a leaking tap', category: 'repair', budget: 1000, place: 'Patan', when: 'Today before 6pm' }
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.data));
  const taskId = posted.data.task.id;
  assert.equal(posted.data.task.when, 'Today before 6pm');
  assert.equal(posted.data.user.wallet, 4000, 'budget held in escrow');

  // Two workers apply; the board shows each their own applied state.
  const apply1 = await api(`/tasks/${taskId}/apply`, {
    method: 'POST', token: worker1.token, body: { note: 'Plumber, live nearby' }
  });
  assert.equal(apply1.status, 200, JSON.stringify(apply1.data));
  assert.equal(apply1.data.task.applied, true);
  const apply2 = await api(`/tasks/${taskId}/apply`, { method: 'POST', token: worker2.token, body: {} });
  assert.equal(apply2.status, 200);
  const again = await api(`/tasks/${taskId}/apply`, { method: 'POST', token: worker1.token, body: {} });
  assert.equal(again.status, 409, 'no double applications');

  // Applicant pitches are only visible to the poster.
  const board = await api('/tasks/board', { token: worker2.token });
  const boardTask = board.data.tasks.find((t) => t.id === taskId);
  assert.equal(boardTask.applicantCount, 2);
  assert.equal(boardTask.applicants, undefined, 'applicant details must not leak to other workers');
  const mine = await api('/tasks/mine', { token: poster.token });
  const posterView = mine.data.posted.find((t) => t.id === taskId);
  assert.equal(posterView.applicants.length, 2);
  assert.equal(posterView.applicants[0].note, 'Plumber, live nearby');

  // Hiring requires picking an actual applicant.
  const badHire = await api(`/tasks/${taskId}/hire`, { method: 'POST', token: poster.token, body: { userId: 'nobody' } });
  assert.equal(badHire.status, 400);
  const hired = await api(`/tasks/${taskId}/hire`, { method: 'POST', token: poster.token, body: { userId: worker1.user.id } });
  assert.equal(hired.status, 200, JSON.stringify(hired.data));
  assert.equal(hired.data.task.status, 'assigned');
  assert.equal(hired.data.task.workerName, 'worker-one');

  // Late applications bounce; the hired worker completes and is paid 90%.
  const lateApply = await api(`/tasks/${taskId}/apply`, { method: 'POST', token: worker2.token, body: {} });
  assert.equal(lateApply.status, 409);
  const done = await api(`/tasks/${taskId}/done`, { method: 'POST', token: worker1.token });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const confirmed = await api(`/tasks/${taskId}/confirm`, { method: 'POST', token: poster.token });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.equal(await wallet(worker1.token), 5000 + 900, 'worker receives budget minus the 10% fee');
});

test('partner photo upload: validated, served, and attached to listings', async () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const reg = await api('/partner/register', {
    method: 'POST',
    body: {
      name: 'Photo Kitchen', email: `photo-${stamp}@test.local`, password: 'partner-secret',
      phone: `+9777${stamp.slice(-9)}`, regNo: `PAN-${stamp.slice(-6)}`
    }
  });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const token = reg.data.token;
  const pOtp = await api('/partner/phone/request-otp', { method: 'POST', token, body: {} });
  await api('/partner/phone/verify', { method: 'POST', token, body: { code: pOtp.data.devCode } });
  const admin = await api('/admin/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  await api(`/admin/partners/${reg.data.partner.id}/kyc/approve`, { method: 'POST', token: admin.data.token });

  const upload = async (body, type = 'image/png') => {
    const res = await fetch(`${BASE}/partner/photos`, {
      method: 'POST',
      headers: { 'Content-Type': type, Authorization: `Bearer ${token}` },
      body
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  // Junk that merely claims to be an image is rejected by magic-byte sniffing.
  const junk = await upload(Buffer.from('<script>alert(1)</script>'));
  assert.equal(junk.status, 400);

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const ok = await upload(png);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(ok.data.url, /^\/uploads\/[\w.-]+\.png$/);

  // The stored file is publicly served with the right type.
  const served = await fetch(`http://localhost:${PORT}${ok.data.url}`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type') || '', /image\/png/);

  // Attach to a new restaurant + menu item; a foreign path is silently dropped.
  const rest = await api('/partner/restaurants', {
    method: 'POST', token,
    body: { name: 'Photo Diner', cuisine: 'Test', area: 'Thamel', photo: ok.data.url }
  });
  assert.equal(rest.status, 200, JSON.stringify(rest.data));
  assert.equal(rest.data.restaurant.photo, ok.data.url);
  const item = await api(`/partner/restaurants/${rest.data.restaurant.id}/menu`, {
    method: 'POST', token,
    body: { name: 'Momo', price: 200, photo: '/uploads/not-mine.png' }
  });
  assert.equal(item.status, 200);
  assert.equal(item.data.restaurant.menu[0].photo, '', 'unowned photo refs must be dropped');

  // Customers see the photo once the listing is approved.
  await api(`/admin/restaurants/${rest.data.restaurant.id}/approve`, { method: 'POST', token: admin.data.token });
  const { token: customerToken } = await registerUser('photo-viewer');
  const list = await api('/restaurants', { token: customerToken });
  const seen = list.data.restaurants.find((r) => r.id === rest.data.restaurant.id);
  assert.ok(seen, 'approved restaurant must be listed');
  assert.equal(seen.photo, ok.data.url);
});

test('surge applies when riders outnumber online drivers', async () => {
  // One bike driver is online (from the previous test); one searching live ride
  // makes demand/supply >= 1, which prices bikes at 1.2x.
  const rider = await registerUser('surge-rider');
  const booked = await api('/rides', {
    method: 'POST',
    token: rider.token,
    body: { pickup: 'Thamel', dropoff: 'Boudhanath Stupa', tier: 'bike', payment: 'wallet' }
  });
  assert.equal(booked.status, 200, JSON.stringify(booked.data));
  assert.equal(booked.data.ride.mode, 'live');

  const other = await registerUser('surge-checker');
  const est = await api('/rides/estimate', {
    method: 'POST',
    token: other.token,
    body: { pickup: 'Thamel', dropoff: 'Patan Durbar Square' }
  });
  assert.equal(est.status, 200, JSON.stringify(est.data));
  const bike = est.data.options.find((o) => o.tier === 'bike');
  assert.equal(bike.surge, 1.2, 'bike tier must surge with 1 searching ride per online driver');
  const car = est.data.options.find((o) => o.tier === 'car');
  assert.equal(car.surge, 1, 'tiers without online drivers never surge');
  assert.equal(est.data.serviceFee, 5);

  await api(`/rides/${booked.data.ride.id}/cancel`, { method: 'POST', token: rider.token });
  // Retire the first driver so later tests control exactly who is online.
  await api('/driver/online', { method: 'POST', token: firstDriverToken, body: { online: false } });
});

test('parcel delivery: bike courier carries it, receiver named, driver paid, sender can rate', async () => {
  const courierToken = await onboardDriver('bike', 27.7154, 85.3123);
  const { token } = await registerUser('sender');

  // Receiver details are mandatory.
  const missing = await api('/rides', {
    method: 'POST',
    token,
    body: { pickup: 'Thamel', dropoff: 'Jawalakhel', tier: 'bike', payment: 'wallet', kind: 'parcel' }
  });
  assert.equal(missing.status, 400, 'parcels must name a receiver');

  const booked = await api('/rides', {
    method: 'POST',
    token,
    body: {
      pickup: 'Thamel',
      dropoff: 'Jawalakhel',
      tier: 'bike',
      payment: 'wallet',
      kind: 'parcel',
      recipient: { name: 'Sita Didi', phone: '9841222333' },
      parcelNote: 'house keys'
    }
  });
  assert.equal(booked.status, 200, JSON.stringify(booked.data));
  assert.equal(booked.data.ride.kind, 'parcel');
  assert.equal(booked.data.ride.icon, '📦');
  assert.equal(booked.data.ride.recipient.name, 'Sita Didi');

  // The courier sees it flagged as a parcel with the receiver's name.
  const requests = await api('/driver/requests', { token: courierToken });
  const request = requests.data.requests.find((r) => r.id === booked.data.ride.id);
  assert.ok(request, 'courier must see the parcel request');
  assert.equal(request.kind, 'parcel');
  assert.equal(request.recipientName, 'Sita Didi');

  await api(`/driver/rides/${booked.data.ride.id}/accept`, { method: 'POST', token: courierToken });
  await api(`/driver/rides/${booked.data.ride.id}/start`, { method: 'POST', token: courierToken });
  const done = await api(`/driver/rides/${booked.data.ride.id}/complete`, { method: 'POST', token: courierToken });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.payout, Math.round(booked.data.ride.fare * 0.8), 'courier earns the standard 80%');

  // Rating a live trip now feeds the courier's reputation.
  const before = (await api('/driver/me', { token: courierToken })).data.driver;
  const rate = await api(`/rides/${booked.data.ride.id}/rate`, { method: 'POST', token, body: { stars: 5 } });
  assert.equal(rate.status, 200, JSON.stringify(rate.data));
  const after = (await api('/driver/me', { token: courierToken })).data.driver;
  assert.ok(after.rating >= before.rating, 'a 5-star trip must not lower the driver rating');

  await api('/driver/online', { method: 'POST', token: courierToken, body: { online: false } });
});

test('fare boost: searching customer raises the fare, driver sees the boosted offer', async () => {
  const driverToken = await onboardDriver('bike', 27.7152, 85.3123); // Thamel
  const { token } = await registerUser('booster');

  const booked = await api('/rides', {
    method: 'POST',
    token,
    body: { pickup: 'Thamel', dropoff: 'Patan Durbar Square', tier: 'bike', payment: 'wallet' }
  });
  assert.equal(booked.status, 200, JSON.stringify(booked.data));
  assert.equal(booked.data.ride.mode, 'live');
  const baseFare = booked.data.ride.fare;
  const walletAfterBooking = booked.data.user.wallet;

  // Invalid boost amounts are refused.
  const bad = await api(`/rides/${booked.data.ride.id}/boost`, { method: 'POST', token, body: { amount: 33 } });
  assert.equal(bad.status, 400);

  const boosted = await api(`/rides/${booked.data.ride.id}/boost`, { method: 'POST', token, body: { amount: 50 } });
  assert.equal(boosted.status, 200, JSON.stringify(boosted.data));
  assert.equal(boosted.data.ride.fare, baseFare + 50);
  assert.equal(boosted.data.ride.fareBoost, 50);
  assert.equal(boosted.data.user.wallet, walletAfterBooking - 50, 'wallet boost is charged up-front');

  // The driver's offer carries the boosted fare and the 80% payout of it.
  const requests = await api('/driver/requests', { token: driverToken });
  const offer = requests.data.requests.find((r) => r.id === booked.data.ride.id);
  assert.ok(offer, 'driver must be re-offered the boosted ride');
  assert.equal(offer.fare, baseFare + 50);
  assert.equal(offer.fareBoost, 50);
  assert.equal(offer.payout, Math.round((baseFare + 50) * 0.8));

  // Once accepted, the fare can no longer be raised.
  const accepted = await api(`/driver/rides/${booked.data.ride.id}/accept`, { method: 'POST', token: driverToken });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  const late = await api(`/rides/${booked.data.ride.id}/boost`, { method: 'POST', token, body: { amount: 20 } });
  assert.equal(late.status, 400);

  await api(`/rides/${booked.data.ride.id}/cancel`, { method: 'POST', token });
  await api('/driver/online', { method: 'POST', token: driverToken, body: { online: false } });
});

test('a lapsed offer cycles back to the lone online driver; a decline is final', async () => {
  const driverToken = await onboardDriver('bike', 27.7152, 85.3123); // Thamel
  const { token } = await registerUser('patient-rider');

  const booked = await api('/rides', {
    method: 'POST',
    token,
    body: { pickup: 'Thamel', dropoff: 'Patan Durbar Square', tier: 'bike', payment: 'wallet' }
  });
  assert.equal(booked.status, 200, JSON.stringify(booked.data));
  assert.equal(booked.data.ride.mode, 'live');
  const rideId = booked.data.ride.id;

  const first = await api('/driver/requests', { token: driverToken });
  assert.equal(first.data.requests.length, 1, 'driver must hold the initial offer');

  // Let the 5s exclusive window lapse (the tester was on another tab). The
  // request must come back to the only online driver instead of dying.
  await new Promise((r) => setTimeout(r, 6500));
  const again = await api('/driver/requests', { token: driverToken });
  assert.equal(again.data.requests.length, 1, 'a lapsed offer must be re-offered to a lone driver');
  assert.equal(again.data.requests[0].id, rideId);

  // An explicit decline is permanent — the ride never comes back to them.
  const declined = await api(`/driver/rides/${rideId}/decline`, { method: 'POST', token: driverToken });
  assert.equal(declined.status, 200, JSON.stringify(declined.data));
  await new Promise((r) => setTimeout(r, 6500));
  const after = await api('/driver/requests', { token: driverToken });
  assert.equal(after.data.requests.length, 0, 'declined rides must never be re-offered');

  await api(`/rides/${rideId}/cancel`, { method: 'POST', token });
  await api('/driver/online', { method: 'POST', token: driverToken, body: { online: false } });
});

test('sequential dispatch: nearest driver gets an exclusive offer, decline cascades', async () => {
  // Near driver waits in Thamel (the pickup), far driver in Kalanki.
  const nearToken = await onboardDriver('bike', 27.7154, 85.3123);
  const farToken = await onboardDriver('bike', 27.6933, 85.2817);
  const { token } = await registerUser('dispatch-rider');

  const booked = await api('/rides', {
    method: 'POST',
    token,
    body: { pickup: 'Thamel', dropoff: 'Patan Durbar Square', tier: 'bike', payment: 'wallet' }
  });
  assert.equal(booked.status, 200, JSON.stringify(booked.data));
  const rideId = booked.data.ride.id;

  // Only the nearest driver holds the offer.
  const nearSees = await api('/driver/requests', { token: nearToken });
  assert.equal(nearSees.data.requests.length, 1, 'nearest driver must hold the offer');
  assert.ok(nearSees.data.requests[0].offerExpiresIn > 0, 'offer must carry a countdown');
  const farSees = await api('/driver/requests', { token: farToken });
  assert.equal(farSees.data.requests.length, 0, 'far driver must not see an offer held by another');

  // The far driver cannot snipe a ride offered to someone else.
  const snipe = await api(`/driver/rides/${rideId}/accept`, { method: 'POST', token: farToken });
  assert.equal(snipe.status, 409, 'accept must require holding the offer');

  // Nearest declines — the offer cascades to the far driver, and never returns.
  const declined = await api(`/driver/rides/${rideId}/decline`, { method: 'POST', token: nearToken });
  assert.equal(declined.status, 200, JSON.stringify(declined.data));
  const nearAfter = await api('/driver/requests', { token: nearToken });
  assert.equal(nearAfter.data.requests.length, 0, 'decliner must not be re-offered the ride');
  const farAfter = await api('/driver/requests', { token: farToken });
  assert.equal(farAfter.data.requests.length, 1, 'offer must cascade to the next-nearest driver');

  const accepted = await api(`/driver/rides/${rideId}/accept`, { method: 'POST', token: farToken });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));

  await api(`/rides/${rideId}/cancel`, { method: 'POST', token });
  await api('/driver/online', { method: 'POST', token: nearToken, body: { online: false } });
  await api('/driver/online', { method: 'POST', token: farToken, body: { online: false } });
});
