// Kirana / general-store vertical: inventory, voice entry, stock correctness,
// customer ordering, subscriber pricing and helper attribution.
//
// The thing that has to be right above all else is THE STOCK NUMBER — a
// shopkeeper stops using this the moment the screen disagrees with the shelf.
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

// A KYC-approved shopkeeper with an approved shop.
async function openShop(name = 'Ram Kirana') {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const reg = await api('/partner/register', {
    method: 'POST',
    body: {
      name, email: `shop-${stamp}@test.local`, password: 'partner-secret',
      phone: `+9779${stamp.slice(-9)}`, regNo: `PAN-${stamp.slice(-6)}`
    }
  });
  const token = reg.data.token;
  const partnerId = reg.data.partner.id;
  const otp = await api('/partner/phone/request-otp', { method: 'POST', token, body: {} });
  await api('/partner/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  await api(`/admin/partners/${partnerId}/kyc/approve`, { method: 'POST', token: adminToken });
  const store = await api('/partner/stores', {
    method: 'POST', token, body: { name, area: 'Thamel', icon: '🏪', deliveryFee: 30 }
  });
  assert.equal(store.status, 200, JSON.stringify(store.data));
  // Staff approve the shop the same way they approve any listing.
  const storeId = store.data.store.id;
  await api(`/admin/stores/${storeId}/approve`, { method: 'POST', token: adminToken });
  return { token, partnerId, storeId };
}

before(async () => {
  PORT = await freePort();
  BASE = `http://localhost:${PORT}/api`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-stores-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATA_STORE: 'json', DATA_DIR: dataDir,
      ADMIN_EMAIL, ADMIN_PASSWORD, OTP_PROVIDER: 'sandbox', EMAIL_PROVIDER: 'sandbox',
      STORE_COMMISSION_PCT: '8', STORE_SERVICE_FEE: '5', LOG_LEVEL: 'error'
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

test('voice entry turns spoken Nepali and English into stocked items', async () => {
  const shop = await openShop();

  const parsed = await api('/stores/voice/parse', {
    method: 'POST', token: shop.token,
    body: { lines: ['2 kg sugar 100 rupees', 'दुई किलो चिनी सय रुपैयाँ', 'wai wai 5 packet 20 rupees'] }
  });
  assert.equal(parsed.status, 200, JSON.stringify(parsed.data));
  const [english, nepali, mixed] = parsed.data.items;
  assert.deepEqual(
    { name: english.name, qty: english.qty, unit: english.unit, price: english.price },
    { name: 'Sugar', qty: 2, unit: 'kg', price: 100 }
  );
  assert.equal(nepali.qty, 2);
  assert.equal(nepali.unit, 'kg');
  assert.equal(nepali.price, 100);
  assert.equal(mixed.name, 'Wai Wai');
  assert.equal(mixed.qty, 5);
  assert.equal(mixed.unit, 'packet');

  // The confirmed rows post straight back as inventory.
  const bulk = await api(`/partner/stores/${shop.storeId}/items/bulk`, {
    method: 'POST', token: shop.token,
    body: { items: [english, mixed] }
  });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
  assert.equal(bulk.data.added.length, 2);
  assert.equal(bulk.data.failed.length, 0);

  const inv = await api(`/partner/stores/${shop.storeId}/inventory`, { token: shop.token });
  const sugar = inv.data.items.find((i) => i.name === 'Sugar');
  assert.equal(sugar.stock, 2, 'the spoken quantity becomes the opening stock');
  assert.equal(sugar.price, 100);
  assert.equal(sugar.unitLabel, 'kg');
});

test('saying an item you already stock restocks it instead of duplicating the line', async () => {
  const shop = await openShop();
  await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Rice', unit: 'kg', price: 95, stock: 10 }
  });
  const again = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'rice', unit: 'kg', price: 95, stock: 15 }
  });
  assert.equal(again.status, 200);
  assert.equal(again.data.restocked, true, 'a repeat during a shelf count is a restock');

  const inv = await api(`/partner/stores/${shop.storeId}/inventory`, { token: shop.token });
  const rice = inv.data.items.filter((i) => i.name.toLowerCase() === 'rice');
  assert.equal(rice.length, 1, 'no duplicate line');
  assert.equal(rice[0].stock, 25, 'quantities add up');
});

test('counter sales and restocks keep the number on screen matching the shelf', async () => {
  const shop = await openShop();
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Dal', unit: 'kg', price: 180, stock: 8 }
  });
  const itemId = created.data.item.id;

  const sold = await api(`/partner/stores/${shop.storeId}/items/${itemId}/sold`, {
    method: 'POST', token: shop.token, body: { qty: 3 }
  });
  assert.equal(sold.status, 200);
  assert.equal(sold.data.item.stock, 5);

  const restock = await api(`/partner/stores/${shop.storeId}/items/${itemId}/restock`, {
    method: 'POST', token: shop.token, body: { qty: 10 }
  });
  assert.equal(restock.data.item.stock, 15);

  // Selling more than is on the shelf must be refused, not go negative.
  const tooMany = await api(`/partner/stores/${shop.storeId}/items/${itemId}/sold`, {
    method: 'POST', token: shop.token, body: { qty: 99 }
  });
  assert.equal(tooMany.status, 400);

  // Every movement is on the record with a reason.
  const moves = await api(`/partner/stores/${shop.storeId}/moves`, { token: shop.token });
  const reasons = moves.data.moves.map((m) => m.reason);
  assert.ok(reasons.includes('sale_counter'));
  assert.ok(reasons.includes('restock'));
  assert.ok(reasons.includes('initial_count'));
});

test('a customer orders, stock is reserved, and cancelling puts it back', async () => {
  const shop = await openShop();
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Oil', unit: 'l', price: 200, stock: 6 }
  });
  const itemId = created.data.item.id;
  const { token: cust } = await registerUser('shopper');

  const browse = await api(`/stores/${shop.storeId}`, { token: cust });
  assert.equal(browse.status, 200);
  assert.equal(browse.data.items[0].name, 'Oil');
  assert.equal(browse.data.items[0].inStock, true);
  assert.equal(browse.data.items[0].price, 200);

  const order = await api('/store-orders', {
    method: 'POST', token: cust,
    body: { storeId: shop.storeId, items: [{ itemId, qty: 2 }], payment: 'wallet' }
  });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  // 2 x 200 + Rs 30 delivery + Rs 5 service fee
  assert.equal(order.data.order.total, 435);

  const afterOrder = await api(`/partner/stores/${shop.storeId}/inventory`, { token: shop.token });
  assert.equal(afterOrder.data.items[0].stock, 4, 'stock is reserved the moment the order is placed');

  const cancelled = await api(`/store-orders/${order.data.order.id}/cancel`, { method: 'POST', token: cust });
  assert.equal(cancelled.status, 200);
  const afterCancel = await api(`/partner/stores/${shop.storeId}/inventory`, { token: shop.token });
  assert.equal(afterCancel.data.items[0].stock, 6, 'cancelling puts the goods back on the shelf');
});

test('two customers cannot buy the same last bag', async () => {
  const shop = await openShop();
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Salt', unit: 'packet', price: 25, stock: 1 }
  });
  const itemId = created.data.item.id;
  const a = await registerUser('first');
  const b = await registerUser('second');

  const first = await api('/store-orders', {
    method: 'POST', token: a.token, body: { storeId: shop.storeId, items: [{ itemId, qty: 1 }], payment: 'wallet' }
  });
  assert.equal(first.status, 200);
  const second = await api('/store-orders', {
    method: 'POST', token: b.token, body: { storeId: shop.storeId, items: [{ itemId, qty: 1 }], payment: 'wallet' }
  });
  assert.equal(second.status, 409, 'the second customer is told it is gone, not oversold');
});

test('subscribers get the cheaper price, enforced server-side', async () => {
  const shop = await openShop();
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token,
    body: { name: 'Milk', unit: 'l', price: 100, stock: 50, subscribePrice: 85 }
  });
  const itemId = created.data.item.id;
  const { token: cust } = await registerUser('subscriber');

  // Before subscribing: full price.
  const before = await api(`/stores/${shop.storeId}`, { token: cust });
  assert.equal(before.data.items[0].price, 100);
  assert.equal(before.data.items[0].subscribed, false);

  const sub = await api(`/stores/${shop.storeId}/items/${itemId}/subscribe`, {
    method: 'POST', token: cust, body: { everyDays: 7 }
  });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));

  const after = await api(`/stores/${shop.storeId}`, { token: cust });
  assert.equal(after.data.items[0].price, 85, 'subscriber sees the cheaper price');
  assert.equal(after.data.items[0].subscribed, true);

  // And the discount is applied by the server at checkout, not taken on trust.
  const order = await api('/store-orders', {
    method: 'POST', token: cust,
    body: { storeId: shop.storeId, items: [{ itemId, qty: 2 }], payment: 'wallet' }
  });
  assert.equal(order.data.order.subtotal, 170, '2 x Rs 85 subscriber price');
  assert.equal(order.data.order.items[0].subscribed, true);

  // A non-subscriber still pays list price for the same item.
  const { token: other } = await registerUser('nonsub');
  const plain = await api('/store-orders', {
    method: 'POST', token: other,
    body: { storeId: shop.storeId, items: [{ itemId, qty: 2 }], payment: 'wallet' }
  });
  assert.equal(plain.data.order.subtotal, 200, 'non-subscriber pays the shelf price');
});

test('a wallet order conserves money from customer to shopkeeper to platform', async () => {
  const shop = await openShop();
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Tea', unit: 'packet', price: 500, stock: 10 }
  });
  const itemId = created.data.item.id;
  const { token: cust } = await registerUser('teabuyer');
  const walletBefore = (await api('/auth/me', { token: cust })).data.user.wallet;

  const order = await api('/store-orders', {
    method: 'POST', token: cust,
    body: { storeId: shop.storeId, items: [{ itemId, qty: 1 }], payment: 'wallet' }
  });
  const o = order.data.order;
  // 500 goods + 30 delivery + 5 service = 535; commission is 8% of goods = 40.
  assert.equal(o.total, 535);
  assert.equal(o.commission, 40);
  assert.equal(o.partnerCut, 490, 'shopkeeper keeps goods + delivery minus commission');

  const walletAfter = (await api('/auth/me', { token: cust })).data.user.wallet;
  assert.equal(walletBefore - walletAfter, 535, 'exactly the order total leaves the wallet');

  // Income is pending until the goods actually change hands.
  const pending = await api('/partner/me', { token: shop.token });
  assert.equal(pending.data.partner.pendingEarnings, 490);
  assert.equal(pending.data.partner.earnings, 0, 'nothing withdrawable before handover');

  await api(`/partner/store-orders/${o.id}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/store-orders/${o.id}/ready`, { method: 'POST', token: shop.token });
  const done = await api(`/partner/store-orders/${o.id}/handover`, { method: 'POST', token: shop.token });
  assert.equal(done.status, 200, JSON.stringify(done.data));

  const settled = await api('/partner/me', { token: shop.token });
  assert.equal(settled.data.partner.earnings, 490, 'income settles on handover');
  assert.equal(settled.data.partner.pendingEarnings, 0);

  // Customer paid 535 = shopkeeper 490 + platform 45 (40 commission + 5 fee).
  assert.equal(o.partnerCut + o.commission + o.serviceFee, o.total);
});

test('click & collect: no delivery fee, and handover needs the customer\'s code', async () => {
  const shop = await openShop();
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Sugar', unit: 'kg', price: 200, stock: 10 }
  });
  const itemId = created.data.item.id;
  const { token: cust } = await registerUser('collector');

  // deliverTo is sent on purpose: a pickup order must ignore it, or the
  // courier sweep would mistake the order for a delivery job.
  const placed = await api('/store-orders', {
    method: 'POST', token: cust,
    body: { storeId: shop.storeId, items: [{ itemId, qty: 2 }], payment: 'wallet', fulfilment: 'pickup', deliverTo: 'Thamel' }
  });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  const o = placed.data.order;
  // 400 goods + 0 delivery (they collect it themselves) + 5 service = 405.
  assert.equal(o.total, 405);
  assert.equal(o.deliveryFee, 0);
  assert.equal(o.deliveryLoc, null, 'a pickup order must never look like a courier job');
  assert.match(o.pickupCode, /^\d{4}$/, 'the customer gets a 4-digit code');

  // The shopkeeper must never see the code through the API, or the check at
  // the counter proves nothing.
  const list = await api(`/partner/stores/${shop.storeId}/orders`, { token: shop.token });
  const seen = list.data.orders.find((x) => x.id === o.id);
  assert.equal(seen.fulfilment, 'pickup');
  assert.equal(seen.pickupCode, undefined, 'order list hides the code from the shopkeeper');

  await api(`/partner/store-orders/${o.id}/accept`, { method: 'POST', token: shop.token });
  const readied = await api(`/partner/store-orders/${o.id}/ready`, { method: 'POST', token: shop.token });
  assert.equal(readied.data.order.pickupCode, undefined, 'action responses hide the code too');

  const noCode = await api(`/partner/store-orders/${o.id}/handover`, { method: 'POST', token: shop.token });
  assert.equal(noCode.status, 400, 'handover without a code is refused');
  const wrongCode = await api(`/partner/store-orders/${o.id}/handover`, {
    method: 'POST', token: shop.token, body: { code: '0000' } // randomInt(1000, 10000) can never produce 0000
  });
  assert.equal(wrongCode.status, 400, 'handover with the wrong code is refused');

  const done = await api(`/partner/store-orders/${o.id}/handover`, {
    method: 'POST', token: shop.token, body: { code: o.pickupCode }
  });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.order.status, 'delivered');

  // Money: goods minus commission, and no delivery cut on a pickup order.
  // commission = 8% of 400 = 32; shopkeeper keeps 400 - 32 = 368.
  const me = await api('/partner/me', { token: shop.token });
  assert.equal(me.data.partner.earnings, 368);
  assert.equal(me.data.partner.pendingEarnings, 0);
});

test('a delivery order still charges the fee and hands over without a code', async () => {
  const shop = await openShop();
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Salt', unit: 'packet', price: 50, stock: 5 }
  });
  const { token: cust } = await registerUser('homebody');

  // Paying for delivery without saying where would charge for a courier the
  // run sweep can never dispatch — refuse it up front.
  const nowhere = await api('/store-orders', {
    method: 'POST', token: cust,
    body: { storeId: shop.storeId, items: [{ itemId: created.data.item.id, qty: 1 }], payment: 'wallet', fulfilment: 'delivery' }
  });
  assert.equal(nowhere.status, 400, 'choosing delivery demands an address');

  const placed = await api('/store-orders', {
    method: 'POST', token: cust,
    body: {
      storeId: shop.storeId, items: [{ itemId: created.data.item.id, qty: 1 }],
      payment: 'wallet', fulfilment: 'delivery', deliverTo: 'Thamel'
    }
  });
  const o = placed.data.order;
  assert.equal(o.deliveryFee, 30, 'delivery keeps paying the shop\'s fee');
  assert.ok(o.deliveryLoc, 'the courier has somewhere to go');
  assert.equal(o.pickupCode, null);

  await api(`/partner/store-orders/${o.id}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/store-orders/${o.id}/ready`, { method: 'POST', token: shop.token });
  const done = await api(`/partner/store-orders/${o.id}/handover`, { method: 'POST', token: shop.token });
  assert.equal(done.status, 200, 'no code demanded when there is no pickup');
});

test('an uncollected pickup order can be refunded by the shop, never stranded', async () => {
  const shop = await openShop();
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Momo masala', unit: 'packet', price: 100, stock: 5 }
  });
  const itemId = created.data.item.id;
  const { token: cust } = await registerUser('noshow');
  const walletBefore = (await api('/auth/me', { token: cust })).data.user.wallet;

  const placed = await api('/store-orders', {
    method: 'POST', token: cust,
    body: { storeId: shop.storeId, items: [{ itemId, qty: 2 }], payment: 'wallet', fulfilment: 'pickup' }
  });
  const o = placed.data.order;
  await api(`/partner/store-orders/${o.id}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/store-orders/${o.id}/ready`, { method: 'POST', token: shop.token });

  // The customer cannot cancel a packed order — but the shop must be able to
  // give up on a no-show, or the money and the shelf stock are stuck forever.
  const custCancel = await api(`/store-orders/${o.id}/cancel`, { method: 'POST', token: cust });
  assert.equal(custCancel.status, 400);
  const refund = await api(`/partner/store-orders/${o.id}/reject`, { method: 'POST', token: shop.token });
  assert.equal(refund.status, 200, JSON.stringify(refund.data));
  assert.equal(refund.data.order.status, 'cancelled');

  const walletAfter = (await api('/auth/me', { token: cust })).data.user.wallet;
  assert.equal(walletAfter, walletBefore, 'every rupee comes back');
  const inv = await api(`/partner/stores/${shop.storeId}/inventory`, { token: shop.token });
  assert.equal(inv.data.items.find((i) => i.id === itemId).stock, 5, 'the goods go back on the shelf');
  const me = await api('/partner/me', { token: shop.token });
  assert.equal(me.data.partner.pendingEarnings, 0, 'nothing left dangling in pending income');
  assert.equal(me.data.partner.earnings, 0);
});

test('five wrong pickup codes lock the order — guessing is not a settlement path', async () => {
  const shop = await openShop();
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Chiura', unit: 'kg', price: 80, stock: 6 }
  });
  const { token: cust } = await registerUser('guessed');
  const placed = await api('/store-orders', {
    method: 'POST', token: cust,
    body: { storeId: shop.storeId, items: [{ itemId: created.data.item.id, qty: 1 }], payment: 'wallet', fulfilment: 'pickup' }
  });
  const o = placed.data.order;
  await api(`/partner/store-orders/${o.id}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/store-orders/${o.id}/ready`, { method: 'POST', token: shop.token });

  // '0000' is always wrong: the codes run 1000-9999.
  for (let i = 1; i <= 4; i += 1) {
    const wrong = await api(`/partner/store-orders/${o.id}/handover`, {
      method: 'POST', token: shop.token, body: { code: '0000' }
    });
    assert.equal(wrong.status, 400, `attempt ${i} is refused but not yet locked`);
  }
  const fifth = await api(`/partner/store-orders/${o.id}/handover`, {
    method: 'POST', token: shop.token, body: { code: '0000' }
  });
  assert.equal(fifth.status, 409, 'the fifth failure locks the order');

  // Even the right code is dead now — the lock is the point.
  const late = await api(`/partner/store-orders/${o.id}/handover`, {
    method: 'POST', token: shop.token, body: { code: o.pickupCode }
  });
  assert.equal(late.status, 409, 'a locked order cannot be settled, only refunded');

  // The exit still works: refund the customer.
  const refund = await api(`/partner/store-orders/${o.id}/reject`, { method: 'POST', token: shop.token });
  assert.equal(refund.status, 200, JSON.stringify(refund.data));
});

test('a hired helper can count stock, and their work is attributed to them', async () => {
  const shop = await openShop();
  const invite = await api(`/partner/stores/${shop.storeId}/helpers`, {
    method: 'POST', token: shop.token, body: { name: 'Sita' }
  });
  assert.equal(invite.status, 200);
  const code = invite.data.invite.code;
  assert.match(code, /^\d{6}$/);

  const helper = await registerUser('sita-helper');
  const joined = await api('/stores/helper/join', { method: 'POST', token: helper.token, body: { code } });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));

  // The helper adds a line found on the shelf.
  const added = await api(`/stores/${shop.storeId}/helper/items`, {
    method: 'POST', token: helper.token, body: { name: 'Soap', unit: 'each', price: 45, stock: 20 }
  });
  assert.equal(added.status, 200, JSON.stringify(added.data));

  // And corrects a miscount.
  const counted = await api(`/stores/${shop.storeId}/helper/items/${added.data.item.id}/count`, {
    method: 'POST', token: helper.token, body: { stock: 18 }
  });
  assert.equal(counted.data.item.stock, 18);

  const moves = await api(`/partner/stores/${shop.storeId}/moves`, { token: shop.token });
  const byHelper = moves.data.moves.filter((m) => m.actorKind === 'helper');
  assert.ok(byHelper.length >= 2, 'helper actions are attributed');
  assert.ok(byHelper.every((m) => m.actorName));
  assert.ok(moves.data.moves.some((m) => m.reason === 'stock_take'));

  // A helper must not be able to change prices.
  const priceAttempt = await api(`/partner/stores/${shop.storeId}/items/${added.data.item.id}`, {
    method: 'PATCH', token: helper.token, body: { price: 1 }
  });
  assert.equal(priceAttempt.status, 401, 'a customer token cannot reach shopkeeper-only routes');

  // ...including the back way in. Re-adding a line that already exists merges
  // into it, and that merge used to carry the helper's price with it — a hired
  // counter could reprice the whole shop by "adding" Soap at Rs 1.
  const reAdd = await api(`/stores/${shop.storeId}/helper/items`, {
    method: 'POST', token: helper.token, body: { name: 'Soap', unit: 'each', price: 1, stock: 5 }
  });
  assert.equal(reAdd.status, 200, JSON.stringify(reAdd.data));
  const shelf = await api(`/partner/stores/${shop.storeId}/inventory`, { token: shop.token });
  const soap = shelf.data.items.find((i) => i.id === added.data.item.id);
  assert.equal(soap.price, 45, 'the shopkeeper’s price stands');
  assert.equal(soap.stock, 23, 'but the count the helper made still lands');
});

test('a shopkeeper cannot delete their account on top of live orders', async () => {
  // Account deletion only knew about restaurants and hotels. A kirana owner
  // could delete while customers had already paid — the shop vanished from the
  // marketplace with their money still sitting in pendingEarnings.
  const shop = await openShop('Vanishing Kirana');
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Ghee', unit: 'l', price: 900, stock: 4 }
  });
  const { token: cust } = await registerUser('ghee-buyer');
  const order = await api('/store-orders', {
    method: 'POST', token: cust,
    body: { storeId: shop.storeId, items: [{ itemId: created.data.item.id, qty: 1 }], payment: 'wallet' }
  });
  assert.equal(order.status, 200, JSON.stringify(order.data));

  const blocked = await api('/partner/account/delete', {
    method: 'POST', token: shop.token, body: { password: 'partner-secret' }
  });
  assert.equal(blocked.status, 400, JSON.stringify(blocked.data));
  assert.match(blocked.data.error, /orders that are not finished|shop income is still settling/i);

  // The shop is still open for business, not half-removed.
  const stillThere = await api(`/stores/${shop.storeId}`, { token: cust });
  assert.equal(stillThere.status, 200);
});

test('reorder suggestions surface what is running out', async () => {
  const shop = await openShop();
  const fast = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Noodles', unit: 'packet', price: 20, stock: 40 }
  });
  await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Broom', unit: 'each', price: 150, stock: 30 }
  });
  // Noodles sell hard today; the broom does not move.
  await api(`/partner/stores/${shop.storeId}/items/${fast.data.item.id}/sold`, {
    method: 'POST', token: shop.token, body: { qty: 36 }
  });

  const reorder = await api(`/partner/stores/${shop.storeId}/reorder`, { token: shop.token });
  assert.equal(reorder.status, 200);
  const top = reorder.data.suggestions[0];
  assert.equal(top.name, 'Noodles', 'the fast mover running low is ranked first');
  assert.ok(top.suggestedQty > 0);
  assert.ok(top.perDay > 0, 'sales velocity is measured');
  assert.ok(!reorder.data.suggestions.some((s) => s.name === 'Broom'), 'a well-stocked slow mover is not nagged about');
});

test('a closed shop cannot be ordered from', async () => {
  const shop = await openShop();
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Biscuit', unit: 'packet', price: 30, stock: 10 }
  });
  await api(`/partner/stores/${shop.storeId}`, { method: 'PATCH', token: shop.token, body: { open: false } });

  const { token: cust } = await registerUser('latecomer');
  const order = await api('/store-orders', {
    method: 'POST', token: cust,
    body: { storeId: shop.storeId, items: [{ itemId: created.data.item.id, qty: 1 }], payment: 'wallet' }
  });
  assert.equal(order.status, 409);
  assert.match(order.data.error, /closed/i);
});

/* ---------------- marketplace: location, search, browse ---------------- */

// Thamel and Patan are ~5 km apart — far enough to test radius filtering.
const THAMEL = { lat: 27.7154, lng: 85.3123 };
const PATAN = { lat: 27.6727, lng: 85.3255 };

async function shopAt(name, point, items) {
  const shop = await openShop(name);
  await api(`/partner/stores/${shop.storeId}`, {
    method: 'PATCH', token: shop.token, body: { lat: point.lat, lng: point.lng, locName: name }
  });
  for (const it of items) {
    await api(`/partner/stores/${shop.storeId}/items`, { method: 'POST', token: shop.token, body: it });
  }
  return shop;
}

test('a shopkeeper pins the shop location and customers see the real distance', async () => {
  const shop = await shopAt('Pinned Pasal', THAMEL, [{ name: 'Chini', unit: 'kg', price: 100, stock: 10 }]);
  const { token: cust } = await registerUser('locator');

  const near = await api(`/stores?lat=${THAMEL.lat}&lng=${THAMEL.lng}&radiusKm=1`, { token: cust });
  assert.equal(near.status, 200);
  assert.equal(near.data.located, true);
  const mine = near.data.stores.find((s) => s.id === shop.storeId);
  assert.ok(mine, 'a shop pinned at my location is in the nearby list');
  assert.ok(mine.distanceKm <= 0.2, `should be right here, got ${mine.distanceKm} km`);

  // From Patan the same shop is out of a 1 km radius.
  const far = await api(`/stores?lat=${PATAN.lat}&lng=${PATAN.lng}&radiusKm=1`, { token: cust });
  assert.ok(!far.data.stores.some((s) => s.id === shop.storeId), 'a shop 5 km away is not "nearby"');

  // Widen the radius and it comes back, with an honest distance.
  const wide = await api(`/stores?lat=${PATAN.lat}&lng=${PATAN.lng}&radiusKm=10`, { token: cust });
  const found = wide.data.stores.find((s) => s.id === shop.storeId);
  assert.ok(found && found.distanceKm > 3 && found.distanceKm < 8, `expected ~5 km, got ${found && found.distanceKm}`);
});

test('product search finds the same item across different shops, nearest first', async () => {
  const nearShop = await shopAt('Near Pasal', THAMEL, [{ name: 'Surf Excel', unit: 'packet', price: 250, stock: 5, category: 'Household' }]);
  const farShop = await shopAt('Far Pasal', PATAN, [{ name: 'Surf Excel', unit: 'packet', price: 200, stock: 5, category: 'Household' }]);
  const { token: cust } = await registerUser('searcher');

  const res = await api(`/store-search?q=surf&lat=${THAMEL.lat}&lng=${THAMEL.lng}&radiusKm=10`, { token: cust });
  assert.equal(res.status, 200);
  const rows = res.data.results.filter((r) => [nearShop.storeId, farShop.storeId].includes(r.storeId));
  assert.equal(rows.length, 2, 'both shops stocking it are returned');
  assert.equal(rows[0].storeId, nearShop.storeId, 'the closer shop comes first by default');
  assert.ok(rows[0].distanceKm < rows[1].distanceKm);

  // Sorting by price flips the order — the cheaper shop is the far one.
  const cheap = await api(`/store-search?q=surf&lat=${THAMEL.lat}&lng=${THAMEL.lng}&radiusKm=10&sort=cheap`, { token: cust });
  const cheapRows = cheap.data.results.filter((r) => [nearShop.storeId, farShop.storeId].includes(r.storeId));
  assert.equal(cheapRows[0].storeId, farShop.storeId, 'cheapest first when asked');
  assert.equal(cheapRows[0].price, 200);

  // Partial words work as the customer types.
  const partial = await api(`/store-search?q=sur&lat=${THAMEL.lat}&lng=${THAMEL.lng}&radiusKm=10`, { token: cust });
  assert.ok(partial.data.results.some((r) => r.name === 'Surf Excel'), 'prefix search matches');
});

test('search only shows what is really on the shelf, and updates when it changes', async () => {
  const shop = await shopAt('Stock Pasal', THAMEL, [{ name: 'Rara Noodles', unit: 'packet', price: 25, stock: 2 }]);
  const { token: cust } = await registerUser('stockseeker');
  const find = () => api(`/store-search?q=rara&lat=${THAMEL.lat}&lng=${THAMEL.lng}&radiusKm=2`, { token: cust });

  const inv = await api(`/partner/stores/${shop.storeId}/inventory`, { token: shop.token });
  const itemId = inv.data.items[0].id;

  assert.equal((await find()).data.results.length, 1);

  // Sell the last two over the counter — it must drop out of search.
  await api(`/partner/stores/${shop.storeId}/items/${itemId}/sold`, { method: 'POST', token: shop.token, body: { qty: 2 } });
  assert.equal((await find()).data.results.length, 0, 'sold out means it stops appearing');

  // Restock and it returns, with no re-indexing needed.
  await api(`/partner/stores/${shop.storeId}/items/${itemId}/restock`, { method: 'POST', token: shop.token, body: { qty: 6 } });
  assert.equal((await find()).data.results.length, 1, 'restocked items come straight back');

  // Renaming re-indexes: the old word stops matching, the new one starts.
  await api(`/partner/stores/${shop.storeId}/items/${itemId}`, {
    method: 'PATCH', token: shop.token, body: { name: 'Mayos Noodles' }
  });
  assert.equal((await find()).data.results.length, 0, 'the old name no longer matches');
  const renamed = await api(`/store-search?q=mayos&lat=${THAMEL.lat}&lng=${THAMEL.lng}&radiusKm=2`, { token: cust });
  assert.ok(renamed.data.results.some((r) => r.name === 'Mayos Noodles'), 'the new name is searchable');

  // Removing it takes it out of the market entirely.
  await api(`/partner/stores/${shop.storeId}/items/${itemId}`, { method: 'DELETE', token: shop.token });
  const gone = await api(`/store-search?q=mayos&lat=${THAMEL.lat}&lng=${THAMEL.lng}&radiusKm=2`, { token: cust });
  assert.equal(gone.data.results.length, 0, 'a removed item disappears from search');
});

test('browse by category, and page through results', async () => {
  const items = [];
  for (let i = 0; i < 12; i += 1) items.push({ name: `Snack Item ${i}`, unit: 'packet', price: 20 + i, stock: 5, category: 'Snacks' });
  const shop = await shopAt('Category Pasal', THAMEL, items);
  const { token: cust } = await registerUser('browser');

  const cats = await api(`/store-categories?lat=${THAMEL.lat}&lng=${THAMEL.lng}&radiusKm=2`, { token: cust });
  assert.equal(cats.status, 200);
  const snacks = cats.data.categories.find((c) => c.name === 'Snacks');
  assert.ok(snacks && snacks.count >= 12, 'category chips count what is in stock nearby');

  const page1 = await api(`/store-search?category=Snacks&lat=${THAMEL.lat}&lng=${THAMEL.lng}&radiusKm=2&limit=5`, { token: cust });
  assert.equal(page1.data.results.length, 5);
  assert.equal(page1.data.hasMore, true);
  const page2 = await api(`/store-search?category=Snacks&lat=${THAMEL.lat}&lng=${THAMEL.lng}&radiusKm=2&limit=5&page=2`, { token: cust });
  assert.equal(page2.data.results.length, 5);
  const overlap = page1.data.results.filter((a) => page2.data.results.some((b) => b.itemId === a.itemId));
  assert.equal(overlap.length, 0, 'pages do not repeat items');
  assert.ok(page1.data.results.every((r) => r.storeId === shop.storeId));
});

test('a shop awaiting review is invisible to customers until it is approved', async () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const reg = await api('/partner/register', {
    method: 'POST',
    body: { name: 'Hidden Pasal', email: `hid-${stamp}@test.local`, password: 'partner-secret', phone: `+9779${stamp.slice(-9)}`, regNo: `PAN-${stamp.slice(-6)}` }
  });
  const token = reg.data.token;
  const otp = await api('/partner/phone/request-otp', { method: 'POST', token, body: {} });
  await api('/partner/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  await api(`/admin/partners/${reg.data.partner.id}/kyc/approve`, { method: 'POST', token: adminToken });
  const store = await api('/partner/stores', { method: 'POST', token, body: { name: 'Hidden Pasal', area: 'Thamel' } });
  const storeId = store.data.store.id;
  await api(`/partner/stores/${storeId}`, { method: 'PATCH', token, body: { lat: THAMEL.lat, lng: THAMEL.lng } });
  await api(`/partner/stores/${storeId}/items`, { method: 'POST', token, body: { name: 'Secret Masala', unit: 'packet', price: 60, stock: 9 } });

  const { token: cust } = await registerUser('nosy');
  const before = await api(`/store-search?q=secret masala&lat=${THAMEL.lat}&lng=${THAMEL.lng}&radiusKm=2`, { token: cust });
  assert.equal(before.data.results.length, 0, 'unreviewed shops are not in the marketplace');

  await api(`/admin/stores/${storeId}/approve`, { method: 'POST', token: adminToken });
  const after = await api(`/store-search?q=secret masala&lat=${THAMEL.lat}&lng=${THAMEL.lng}&radiusKm=2`, { token: cust });
  assert.equal(after.data.results.length, 1, 'approval puts the shop into search immediately');
});

/* --- adversarial-security regressions ---------------------------------- */

test('helper-join codes cannot be brute-forced', async () => {
  // A 6-digit invite code is checked against EVERY store's open invites at
  // once, so free guessing would eventually put an attacker inside somebody's
  // stock room with count-editing rights. Wrong guesses now lock the account
  // for a cooldown, the same discipline as pickup codes.
  const shop = await openShop('Bruteforce Kirana');
  const invite = await api(`/partner/stores/${shop.storeId}/helpers`, {
    method: 'POST', token: shop.token, body: { name: 'Real Helper' }
  });
  const realCode = invite.data.invite.code;
  const attacker = await registerUser('guesser');

  const guesses = [];
  for (let n = 111111; guesses.length < 8; n += 1) {
    const c = String(n);
    if (c !== realCode) guesses.push(c);
  }
  for (const g of guesses) {
    const r = await api('/stores/helper/join', { method: 'POST', token: attacker.token, body: { code: g } });
    assert.equal(r.status, 404, 'a wrong code reads as invalid');
  }
  const blocked = await api('/stores/helper/join', { method: 'POST', token: attacker.token, body: { code: realCode } });
  assert.equal(blocked.status, 429, 'after too many wrong guesses even the right code must wait');

  // The invited helper, on their own account, still joins normally.
  const helper = await registerUser('legit-helper');
  const joined = await api('/stores/helper/join', { method: 'POST', token: helper.token, body: { code: realCode } });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
});

test('the voice parser only answers real sessions', async () => {
  // Regression: it accepted ANY non-empty Authorization header — free
  // anonymous compute behind a fake token.
  const fake = await api('/stores/voice/parse', {
    method: 'POST', token: 'not-a-real-token', body: { text: '2 kg sugar 100' }
  });
  assert.equal(fake.status, 401, 'a made-up token must be rejected');

  const { token } = await registerUser('speaker');
  const real = await api('/stores/voice/parse', { method: 'POST', token, body: { text: '2 kg sugar 100' } });
  assert.equal(real.status, 200, 'a real customer (helper) session parses fine');
});

test('order quantities must be whole numbers — no fractional rupees in the books', async () => {
  // The app only sends integers; a hand-rolled qty of 0.5 used to put
  // fractional rupees into the wallet debit, the shop's pending income and
  // the platform ledger (the food route already enforced this).
  const shop = await openShop('Fraction Kirana');
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Dal', unit: 'kg', price: 101, stock: 10 }
  });
  const itemId = created.data.item.id;
  const { token: cust } = await registerUser('fraction');

  for (const qty of [0.5, 1.5, 0.0001]) {
    const r = await api('/store-orders', {
      method: 'POST', token: cust, body: { storeId: shop.storeId, items: [{ itemId, qty }], payment: 'wallet' }
    });
    assert.equal(r.status, 400, `qty ${qty} must be refused`);
  }
  const ok = await api('/store-orders', {
    method: 'POST', token: cust, body: { storeId: shop.storeId, items: [{ itemId, qty: 2 }], payment: 'wallet' }
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.order.total, 101 * 2 + 30 + 5, 'whole-rupee total: 2×101 + delivery 30 + service 5');
});
