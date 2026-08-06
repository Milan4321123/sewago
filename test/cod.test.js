// Cash on delivery for food: the customer orders with an empty wallet, the
// courier collects the total at the door, keeps their delivery payout and owes
// SewaGo the rest (collected through the same cash-settlement flow as cash
// rides). Asserts money conservation across the whole lifecycle.
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
    body: { name: 'COD Kitchen', email: `cod-${stamp}@test.local`, password: 'partner-secret', phone: `+9778${stamp.slice(-9)}`, regNo: `PAN-${stamp.slice(-6)}` }
  });
  const token = reg.data.token;
  const otp = await api('/partner/phone/request-otp', { method: 'POST', token, body: {} });
  await api('/partner/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  await api(`/admin/partners/${reg.data.partner.id}/kyc/approve`, { method: 'POST', token: adminToken });
  const rest = await api('/partner/restaurants', {
    method: 'POST', token,
    body: { name: 'COD Thamel', cuisine: 'Test', area: 'Thamel', etaMinutes: 20, deliveryFee: 100 }
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
      name: 'COD Courier', email: `cc-${stamp}@test.local`, password: 'driver-secret',
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-cod-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, EXIT_WHEN_STDIN_CLOSES: '1', NODE_ENV: 'development', PORT: String(PORT), DATA_STORE: 'json', DATA_DIR: dataDir,
      ADMIN_EMAIL, ADMIN_PASSWORD, OTP_PROVIDER: 'sandbox', EMAIL_PROVIDER: 'sandbox',
      DRIVER_LICENSE_DEMO_CODE: '123456', FOOD_SERVICE_FEE: '15',
      // Small float so a single ordinary order can exceed it — this is what the
      // exposure-bound tests below exercise.
      CASH_CREDIT_LIMIT: '2000',
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

test('COD: a customer with an empty wallet can order, and the money conserves end to end', async () => {
  const shop = await onboardPartnerRestaurant(500);
  const courier = await onboardCourier(27.7152, 85.3123);
  const { token: cust, user } = await registerUser('codeater');

  // Drain the wallet so we prove COD needs no balance at all.
  await api('/admin/wallet-adjust', { method: 'POST', token: adminToken, body: { userId: user.id, amount: -user.wallet, reason: 'empty wallet for COD test' } });
  const startWallet = (await api('/auth/me', { token: cust })).data.user.wallet;
  assert.equal(startWallet, 0, 'wallet must be empty for this test to mean anything');

  const order = await api('/orders', {
    method: 'POST', token: cust,
    body: {
      restaurantId: shop.restaurantId, items: [{ id: shop.menuItemId, qty: 1 }],
      deliveryTo: { lat: 27.6893, lng: 85.3436, name: 'New Baneshwor' },
      payment: 'cash'
    }
  });
  assert.equal(order.status, 200, `COD order with an empty wallet must succeed: ${JSON.stringify(order.data)}`);
  const o = order.data.order;
  assert.equal(o.payment, 'cash');
  assert.equal((await api('/auth/me', { token: cust })).data.user.wallet, 0, 'COD must not debit the wallet');

  // Restaurant confirms; courier delivers.
  assert.equal((await api(`/partner/orders/${o.id}/accept`, { method: 'POST', token: shop.token })).status, 200);
  const take = await api(`/driver/deliveries/${o.id}/accept`, { method: 'POST', token: courier.token });
  assert.equal(take.status, 200, JSON.stringify(take.data));
  assert.equal(take.data.delivery.collectCash, o.total, 'the courier is told exactly how much cash to collect');
  await api(`/driver/deliveries/${o.id}/pickup`, { method: 'POST', token: courier.token });
  const delivered = await api(`/driver/deliveries/${o.id}/deliver`, { method: 'POST', token: courier.token });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.data));

  // Money conservation. The courier physically holds `total`; they keep their
  // payout and owe the rest. The partner is paid their cut. The platform's books
  // show total - partnerCut - courierPayout.
  const payout = delivered.data.payout;
  const courierBalance = delivered.data.driver.earnings;
  assert.equal(delivered.data.collectCash, o.total);
  assert.equal(courierBalance, payout - o.total, 'courier keeps their payout and owes the remainder of the collected cash');
  assert.ok(courierBalance < 0, 'holding the customer cash makes the courier a net debtor to SewaGo');

  const partner = await api('/partner/me', { token: shop.token });
  const partnerCut = Math.round(500 * 0.85);
  assert.equal(partner.data.partner.earnings, partnerCut, 'partner is paid their cut on delivery');
  assert.equal(partner.data.partner.pendingEarnings, 0, 'nothing left pending after delivery');

  // Everyone's position sums back to the cash the customer handed over.
  const platform = (await api('/admin/payments', { token: adminToken })).data.revenue.total;
  assert.equal(
    partnerCut + payout + platform,
    o.total,
    `partner (${partnerCut}) + courier (${payout}) + platform (${platform}) must equal the cash collected (${o.total})`
  );

  // The debt is collectable through the same cash-settlement flow as cash rides.
  const owed = -courierBalance;
  const settled = await api(`/admin/drivers/${courier.id}/settle-cash`, { method: 'POST', token: adminToken });
  assert.equal(settled.status, 200, JSON.stringify(settled.data));
  assert.equal(settled.data.settled, owed, 'the full collected-cash debt is settled');
  assert.equal(settled.data.driver.commissionOwed, 0);
});

test('COD: cancelling before confirmation refunds nothing and books no revenue', async () => {
  const shop = await onboardPartnerRestaurant(400);
  const { token: cust, user } = await registerUser('codcanceller');
  await api('/admin/wallet-adjust', { method: 'POST', token: adminToken, body: { userId: user.id, amount: -user.wallet, reason: 'empty wallet' } });

  const before = (await api('/admin/payments', { token: adminToken })).data.revenue.total;
  const order = await api('/orders', {
    method: 'POST', token: cust,
    body: {
      restaurantId: shop.restaurantId, items: [{ id: shop.menuItemId, qty: 1 }],
      deliveryTo: { lat: 27.6893, lng: 85.3436, name: 'New Baneshwor' }, payment: 'cash'
    }
  });
  assert.equal(order.status, 200);
  const cancelled = await api(`/orders/${order.data.order.id}/cancel`, { method: 'POST', token: cust });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));

  // Nothing was ever charged, so the wallet stays at zero (no phantom refund)
  // and platform revenue is untouched (no booking, so no reversal).
  assert.equal((await api('/auth/me', { token: cust })).data.user.wallet, 0, 'a cancelled COD order must not credit the wallet');
  const after = (await api('/admin/payments', { token: adminToken })).data.revenue.total;
  assert.equal(after, before, 'no revenue booked or reversed for an unpaid COD order');
  const partner = await api('/partner/me', { token: shop.token });
  assert.equal(partner.data.partner.pendingEarnings, 0, 'partner pending unwinds to zero, never negative');
});

// --- exposure must actually be bounded (adversarial-review regressions) ------

test('a COD order larger than the cash float is refused outright', async () => {
  // One Rs 5,000 item blows past the Rs 2,000 float — no courier could carry it.
  const shop = await onboardPartnerRestaurant(5000);
  const { token: cust, user } = await registerUser('bigcod');
  await api('/admin/wallet-adjust', { method: 'POST', token: adminToken, body: { userId: user.id, amount: -user.wallet, reason: 'empty wallet' } });
  const big = await api('/orders', {
    method: 'POST', token: cust,
    body: {
      restaurantId: shop.restaurantId, items: [{ id: shop.menuItemId, qty: 1 }],
      deliveryTo: { lat: 27.6893, lng: 85.3436, name: 'New Baneshwor' }, payment: 'cash'
    }
  });
  assert.equal(big.status, 400, 'a COD order above the float cap must be refused');
  assert.match(big.data.error, /Cash on delivery is limited/);
});

test('the cart cannot be inflated by repeated ids, huge line counts or fractional quantities', async () => {
  const shop = await onboardPartnerRestaurant(500);
  const { token: cust } = await registerUser('cartabuse');
  const order = (items) => api('/orders', {
    method: 'POST', token: cust,
    body: { restaurantId: shop.restaurantId, items, deliveryTo: { lat: 27.6893, lng: 85.3436, name: 'New Baneshwor' } }
  });

  // Repeating the same menu id used to bypass the per-item cap by summing lines.
  const dup = await order([{ id: shop.menuItemId, qty: 20 }, { id: shop.menuItemId, qty: 20 }]);
  assert.equal(dup.status, 400, 'duplicate ids must aggregate and hit the per-item cap, not stack');

  // Thousands of lines used to drive the total (and every derived cut) sky-high.
  const many = await order(Array.from({ length: 500 }, () => ({ id: shop.menuItemId, qty: 1 })));
  assert.equal(many.status, 400, 'an order with too many lines must be refused');

  // Fractional quantities used to put fractional rupees into the ledger.
  const frac = await order([{ id: shop.menuItemId, qty: 1.5 }]);
  assert.equal(frac.status, 400, 'quantities must be whole numbers');
});

test('a courier is never handed more cash than their float, across repeat orders', async () => {
  const shop = await onboardPartnerRestaurant(900); // ~Rs 1,015 per COD order
  const courier = await onboardCourier(27.7152, 85.3123);
  const { token: cust, user } = await registerUser('repeatcod');
  await api('/admin/wallet-adjust', { method: 'POST', token: adminToken, body: { userId: user.id, amount: -user.wallet, reason: 'empty wallet' } });

  // Keep ordering until the courier's float refuses the next one.
  let refused = false;
  for (let i = 0; i < 6 && !refused; i += 1) {
    const order = await api('/orders', {
      method: 'POST', token: cust,
      body: {
        restaurantId: shop.restaurantId, items: [{ id: shop.menuItemId, qty: 1 }],
        deliveryTo: { lat: 27.6893, lng: 85.3436, name: 'New Baneshwor' }, payment: 'cash'
      }
    });
    assert.equal(order.status, 200, JSON.stringify(order.data));
    const id = order.data.order.id;
    await api(`/partner/orders/${id}/accept`, { method: 'POST', token: shop.token });
    const take = await api(`/driver/deliveries/${id}/accept`, { method: 'POST', token: courier.token });
    if (take.status === 402) { refused = true; break; }
    assert.equal(take.status, 200, JSON.stringify(take.data));
    await api(`/driver/deliveries/${id}/pickup`, { method: 'POST', token: courier.token });
    await api(`/driver/deliveries/${id}/deliver`, { method: 'POST', token: courier.token });
  }
  assert.ok(refused, 'the float must eventually refuse another cash order');

  // The core guarantee: debt never exceeds the configured float.
  const me = await api('/driver/me', { token: courier.token });
  assert.ok(
    me.data.driver.commissionOwed <= 2000,
    `courier debt ${me.data.driver.commissionOwed} must stay within the Rs 2000 float`
  );
});

test('settle-cash rejects a malformed amount instead of writing off the whole debt', async () => {
  const shop = await onboardPartnerRestaurant(900);
  const courier = await onboardCourier(27.7152, 85.3123);
  const { token: cust, user } = await registerUser('settleguard');
  await api('/admin/wallet-adjust', { method: 'POST', token: adminToken, body: { userId: user.id, amount: -user.wallet, reason: 'empty wallet' } });
  const order = await api('/orders', {
    method: 'POST', token: cust,
    body: {
      restaurantId: shop.restaurantId, items: [{ id: shop.menuItemId, qty: 1 }],
      deliveryTo: { lat: 27.6893, lng: 85.3436, name: 'New Baneshwor' }, payment: 'cash'
    }
  });
  const id = order.data.order.id;
  await api(`/partner/orders/${id}/accept`, { method: 'POST', token: shop.token });
  await api(`/driver/deliveries/${id}/accept`, { method: 'POST', token: courier.token });
  await api(`/driver/deliveries/${id}/pickup`, { method: 'POST', token: courier.token });
  await api(`/driver/deliveries/${id}/deliver`, { method: 'POST', token: courier.token });
  const owed = (await api('/driver/me', { token: courier.token })).data.driver.commissionOwed;
  assert.ok(owed > 0);

  // A typo must not clear the entire receivable.
  for (const bad of ['abc', 0, -50]) {
    const r = await api(`/admin/drivers/${courier.id}/settle-cash`, { method: 'POST', token: adminToken, body: { amount: bad } });
    assert.equal(r.status, 400, `amount ${JSON.stringify(bad)} must be rejected`);
  }
  assert.equal((await api('/driver/me', { token: courier.token })).data.driver.commissionOwed, owed, 'debt untouched by rejected settlements');

  // A partial settlement still works and leaves the remainder owing.
  const part = await api(`/admin/drivers/${courier.id}/settle-cash`, { method: 'POST', token: adminToken, body: { amount: 100 } });
  assert.equal(part.status, 200, JSON.stringify(part.data));
  assert.equal(part.data.settled, 100);
  assert.equal(part.data.driver.commissionOwed, owed - 100);
});

// --- the books must check themselves -----------------------------------------

test('the platform ledger reconciles with revenue recomputed from bookings', async () => {
  // By this point the suite has run wallet orders, a COD order, a cancelled COD
  // order, settlements and payouts through this server — a realistic mix.
  const { data } = await api('/admin/overview', { token: adminToken });
  assert.ok(data.reconciliation, 'overview must expose a reconciliation block');
  assert.equal(
    data.reconciliation.drift,
    0,
    `ledger (${data.reconciliation.ledgerTotal}) and recomputed revenue (${data.reconciliation.derivedTotal}) must agree — ` +
    'a non-zero drift means some money path writes one but not the other'
  );
  // And the headline figure is the ledger's, not a recompute.
  assert.equal(data.stats.revenue, data.reconciliation.ledgerTotal);
});
