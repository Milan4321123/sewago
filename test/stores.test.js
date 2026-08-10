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

// A KYC-approved shopkeeper with an approved shop.
// `area` decides where the shop lands on the map. Tests that care about
// distance pin their own coordinates; tests that do not should pass an area
// away from Thamel so they don't crowd the capped "nearby" list there.
async function openShop(name = 'Ram Kirana', area = 'Thamel') {
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
    method: 'POST', token, body: { name, area, icon: '🏪', deliveryFee: 30 }
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
      ...process.env, EXIT_WHEN_STDIN_CLOSES: '1', NODE_ENV: 'development', PORT: String(PORT), DATA_STORE: 'json', DATA_DIR: dataDir,
      ADMIN_EMAIL, ADMIN_PASSWORD, OTP_PROVIDER: 'sandbox',
      RATE_LIMIT_API_PER_MIN: '100000', EMAIL_PROVIDER: 'sandbox',
      STORE_COMMISSION_PCT: '8', STORE_SERVICE_FEE: '5', LOG_LEVEL: 'error',
      // The suite drives one server from one IP; the default strict budget
      // (60 per 10 min across auth+money paths) would trip as tests grow.
      RATE_LIMIT_STRICT_PER_10MIN: '1000',
      // 12s invite lifetime: generous for the join right below an invite,
      // short enough that the expiry test doesn't stall the suite.
      HELPER_INVITE_TTL_MIN: '0.2'
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

test("a customer's order view carries the receipt, never the shop's economics", async () => {
  const shop = await openShop();
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Ghee', unit: 'kg', price: 900, stock: 10 }
  });
  const { token: cust } = await registerUser('receipt-shopper');
  const placed = await api('/store-orders', {
    method: 'POST', token: cust,
    body: { storeId: shop.storeId, items: [{ itemId: created.data.item.id, qty: 2 }], payment: 'wallet', fulfilment: 'pickup' }
  });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));

  const list = await api('/store-orders', { token: cust });
  for (const [label, o] of [['creation response', placed.data.order], ['list response', list.data.orders[0]]]) {
    // Everything a receipt needs…
    assert.ok(o.items[0].price === 900 && o.items[0].qty === 2, `${label} keeps itemised lines`);
    assert.ok(o.subtotal === 1800 && o.total > 0 && o.payment === 'wallet', `${label} keeps the money breakdown`);
    assert.ok(o.pickupCode, `${label} keeps the customer's own pickup code`);
    // …and none of the platform↔shop split or internal bookkeeping.
    for (const secret of ['commission', 'partnerCut', 'partnerSettled', 'codeTries', 'partnerId', 'courierId']) {
      assert.ok(!(secret in o), `${label} must not expose ${secret}`);
    }
  }
});

test('insights add up: walk-ins at current price, orders at charged price, cancels excluded', async () => {
  const shop = await openShop();
  const chiura = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Chiura', unit: 'kg', price: 90, stock: 20 }
  });
  const waiwai = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Wai Wai', unit: 'packet', price: 20, stock: 50 }
  });

  // Three sold at the counter, five sold through an app order…
  await api(`/partner/stores/${shop.storeId}/items/${chiura.data.item.id}/sold`, {
    method: 'POST', token: shop.token, body: { qty: 3 }
  });
  const { token: cust } = await registerUser('insight-shopper');
  const order = await api('/store-orders', {
    method: 'POST', token: cust,
    body: { storeId: shop.storeId, items: [{ itemId: waiwai.data.item.id, qty: 5 }], payment: 'wallet' }
  });
  assert.equal(order.status, 200, JSON.stringify(order.data));

  // …and two more that were ordered but cancelled — refunded money is not a sale.
  const gone = await api('/store-orders', {
    method: 'POST', token: cust,
    body: { storeId: shop.storeId, items: [{ itemId: waiwai.data.item.id, qty: 2 }], payment: 'wallet' }
  });
  await api(`/store-orders/${gone.data.order.id}/cancel`, { method: 'POST', token: cust });

  const since = Date.now() - 3600000; // "midnight" as far as this test day goes
  const res = await api(`/partner/stores/${shop.storeId}/insights?since=${since}`, { token: shop.token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const { totals, topItems, events, daily, items } = res.data;

  assert.equal(totals.units, 8, 'three walk-in + five ordered; the cancelled two do not count');
  assert.equal(totals.walkinUnits, 3);
  assert.equal(totals.orderUnits, 5);
  assert.equal(totals.orders, 1, 'the cancelled order is not an order');
  // Walk-ins at the current price (3 × 90), the order at its charged line price
  // (5 × 20) — fees are the platform's money, not the shop's sales.
  assert.equal(totals.revenue, 3 * 90 + 5 * 20);

  assert.equal(topItems.length, 2);
  assert.equal(topItems[0].name, 'Chiura', 'ranked by revenue');
  assert.equal(topItems[0].walkinQty, 3);
  assert.equal(topItems[1].name, 'Wai Wai');
  assert.equal(topItems[1].orderQty, 5);
  assert.equal(topItems[1].revenue, 100);

  // One event per sale, timestamped so the client can draw the day's rhythm.
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.at >= since && e.qty > 0));

  // The 30-day trend uses the daily counters, which deliberately stay gross of
  // cancellations — so today shows all ten units that left the shelf. The
  // buckets are UTC-dated, so allow the sale to land in "yesterday" when the
  // suite happens to straddle a UTC midnight.
  assert.equal(daily.length, 30);
  assert.equal(daily[28].units + daily[29].units, 10);

  // Per-item week/month totals, same gross convention, valued at the current
  // shelf price — the shopkeeper's "what did rice earn this month".
  const waiwaiRow = items.find((x) => x.name === 'Wai Wai');
  assert.equal(waiwaiRow.qty7, 7, 'five ordered + two cancelled leave the daily counters at seven');
  assert.equal(waiwaiRow.revenue7, 7 * 20);
  assert.equal(waiwaiRow.qty30, 7);
  const chiuraRow = items.find((x) => x.name === 'Chiura');
  assert.equal(chiuraRow.qty7, 3);
  assert.equal(chiuraRow.revenue30, 3 * 90);

  // Another partner cannot read this shop's money.
  const rival = await openShop();
  const denied = await api(`/partner/stores/${shop.storeId}/insights`, { token: rival.token });
  assert.equal(denied.status, 403);
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
  // The split is the shop's business, so it lives on the PARTNER's view of the
  // order — the customer response deliberately no longer carries it.
  const pview = await api(`/partner/stores/${shop.storeId}/orders`, { token: shop.token });
  const po = pview.data.orders.find((x) => x.id === o.id);
  assert.equal(po.commission, 40);
  assert.equal(po.partnerCut, 490, 'shopkeeper keeps goods + delivery minus commission');

  const walletAfter = (await api('/auth/me', { token: cust })).data.user.wallet;
  assert.equal(walletBefore - walletAfter, 535, 'exactly the order total leaves the wallet');

  // Income is pending until the goods actually change hands.
  const pending = await api('/partner/me', { token: shop.token });
  assert.equal(pending.data.partner.pendingEarnings, 490);
  assert.equal(pending.data.partner.earnings, 0, 'nothing withdrawable before handover');

  await api(`/partner/store-orders/${o.id}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/store-orders/${o.id}/ready`, { method: 'POST', token: shop.token });

  // This is a DELIVERY order: the customer paid Rs 30 to have it brought to
  // them, and nothing has travelled yet. The shop cannot settle it on its own
  // word — the courier's dropoff does that (see delivery-runs.test.js).
  const done = await api(`/partner/store-orders/${o.id}/handover`, { method: 'POST', token: shop.token });
  assert.equal(done.status, 409, JSON.stringify(done.data));

  const stillPending = await api('/partner/me', { token: shop.token });
  assert.equal(stillPending.data.partner.earnings, 0, 'nothing withdrawable until it is delivered');
  assert.equal(stillPending.data.partner.pendingEarnings, 490, 'the income is still held');

  // Customer paid 535 = shopkeeper 490 + platform 45 (40 commission + 5 fee).
  assert.equal(po.partnerCut + po.commission + po.serviceFee, o.total);
});

test('a shop cannot pocket a prepaid delivery order by declaring it handed over', async () => {
  // The handover code check only guarded pickup. For a delivery order the shop
  // could POST an empty body, flip the order to 'delivered' and move the whole
  // prepaid total — delivery fee included — into withdrawable earnings, for
  // goods that never left the counter. Neither cancel nor reject survives
  // 'delivered', so the customer's money was simply gone.
  const shop = await openShop('Pocket Kirana');
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Ghee', unit: 'l', price: 800, stock: 5 }
  });
  const { token: cust } = await registerUser('pocket-victim');
  const walletBefore = (await api('/auth/me', { token: cust })).data.user.wallet;

  const order = await api('/store-orders', {
    method: 'POST', token: cust,
    body: { storeId: shop.storeId, items: [{ itemId: created.data.item.id, qty: 1 }], payment: 'wallet' }
  });
  const o = order.data.order;
  assert.equal(o.fulfilment, 'delivery');
  await api(`/partner/store-orders/${o.id}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/store-orders/${o.id}/ready`, { method: 'POST', token: shop.token });

  const grab = await api(`/partner/store-orders/${o.id}/handover`, { method: 'POST', token: shop.token });
  assert.equal(grab.status, 409, 'declaring a delivery handed over is refused');
  assert.match(grab.data.error, /courier/i);
  // A guessed code must not work either — delivery orders have no code at all.
  const withCode = await api(`/partner/store-orders/${o.id}/handover`, {
    method: 'POST', token: shop.token, body: { code: '1234' }
  });
  assert.equal(withCode.status, 409);

  const mine = await api('/store-orders', { token: cust });
  assert.equal(mine.data.orders.find((x) => x.id === o.id).status, 'ready', 'still waiting for a rider');
  assert.equal((await api('/partner/me', { token: shop.token })).data.partner.earnings, 0);

  // And the shop is not stuck with it: with no rider available, rejecting the
  // order refunds the customer in full.
  const refund = await api(`/partner/store-orders/${o.id}/reject`, { method: 'POST', token: shop.token });
  assert.equal(refund.status, 200, JSON.stringify(refund.data));
  const walletAfter = (await api('/auth/me', { token: cust })).data.user.wallet;
  assert.equal(walletAfter, walletBefore, 'every rupee comes back');
  const after = await api('/partner/me', { token: shop.token });
  assert.equal(after.data.partner.pendingEarnings, 0, 'nothing dangling in pending income');
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

test('a delivery order charges the fee, needs an address, and is not the shop\'s to settle', async () => {
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
  // There is no code to demand here because there is no counter handover: the
  // rider settles this one at the customer's door.
  const done = await api(`/partner/store-orders/${o.id}/handover`, { method: 'POST', token: shop.token });
  assert.equal(done.status, 409, 'the shop does not get to declare a delivery delivered');
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

// --- speaking to the shop ---------------------------------------------------

// A kirana owner should not have to find an item and tap buttons. These cover
// the whole spoken path: what the shop hears, what it refuses to guess at, and
// what it does only after being confirmed.
async function shopWithStock(name = 'Bolne Kirana') {
  // Parked in Bhaktapur: these shops are about speech, not geography, and a
  // pile of extra Thamel shops would push others out of the nearby list.
  const shop = await openShop(name, 'Bhaktapur Durbar Square');
  const add = async (body) => {
    const r = await api(`/partner/stores/${shop.storeId}/items`, { method: 'POST', token: shop.token, body });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.item;
  };
  shop.sugar = await add({ name: 'Sugar', unit: 'kg', price: 120, stock: 40 });
  shop.rice = await add({ name: 'Chamal Basmati', unit: 'kg', price: 180, stock: 100 });
  shop.musuro = await add({ name: 'Musuro Dal', unit: 'kg', price: 160, stock: 25 });
  shop.mas = await add({ name: 'Mas Dal', unit: 'kg', price: 210, stock: 12 });
  shop.say = (text) => api(`/partner/stores/${shop.storeId}/voice/command`, {
    method: 'POST', token: shop.token, body: { text }
  });
  shop.apply = (planId, actions) => api(`/partner/stores/${shop.storeId}/voice/apply`, {
    method: 'POST', token: shop.token, body: { planId, actions }
  });
  shop.stockOf = async (itemId) => {
    const inv = await api(`/partner/stores/${shop.storeId}/inventory`, { token: shop.token });
    return inv.data.items.find((i) => i.id === itemId).stock;
  };
  return shop;
}

test('a shopkeeper sells by saying it, and the shelf follows', async () => {
  const shop = await shopWithStock();
  const plan = await shop.say('चिनी दुई किलो बिक्री भयो');
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  assert.equal(plan.data.actions.length, 1);
  const [action] = plan.data.actions;
  assert.equal(action.intent, 'sold');
  assert.equal(action.itemName, 'Sugar', 'चिनी must find the shop’s English "Sugar" line');
  assert.equal(action.qty, 2);
  assert.equal(action.after, 38, 'the shopkeeper sees the result before agreeing to it');

  // Nothing moved on the planning call — speaking is not doing.
  assert.equal(await shop.stockOf(shop.sugar.id), 40);

  const applied = await shop.apply(plan.data.planId, plan.data.actions);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.done.length, 1);
  assert.equal(await shop.stockOf(shop.sugar.id), 38);
});

test('one breath can carry two jobs', async () => {
  const shop = await shopWithStock('Duita Kaam Kirana');
  const plan = await shop.say('चिनी दुई किलो बिक्री भयो र चामल दश किलो आयो');
  assert.equal(plan.data.actions.length, 2, JSON.stringify(plan.data));
  assert.deepEqual(plan.data.actions.map((a) => a.intent), ['sold', 'restock']);

  await shop.apply(plan.data.planId, plan.data.actions);
  assert.equal(await shop.stockOf(shop.sugar.id), 38);
  assert.equal(await shop.stockOf(shop.rice.id), 110);
});

test('it asks which dal rather than guessing between two', async () => {
  // The shop stocks Musuro Dal and Mas Dal. Guessing here would quietly put the
  // count wrong on two items at once, which is how a shopkeeper learns not to
  // trust the feature.
  const shop = await shopWithStock('Dal Dubidha Kirana');
  const plan = await shop.say('दाल दुई किलो बिक्री भयो');
  assert.equal(plan.data.actions.length, 0, 'nothing may be proposed while it is ambiguous');
  assert.equal(plan.data.questions.length, 1, JSON.stringify(plan.data));
  const names = plan.data.questions[0].choices.map((c) => c.name).sort();
  assert.deepEqual(names, ['Mas Dal', 'Musuro Dal']);
  assert.equal(plan.data.questions[0].qty, 2, 'the quantity survives the question');
});

test('saying a new item twice restocks it instead of growing a second line', async () => {
  // Reported from real use: every repeat of a spoken "new item" added another
  // line, so one product ended up split across several the shopkeeper could not
  // see. Two causes — mis-heard filler ("ots", "per piece") landing in the name
  // so the names never matched, and "naya X" always meaning "create".
  const shop = await shopWithStock('Dohoriyeko Kirana');

  const first = await shop.say('naya sabun 20 ots 20 rupees per piece');
  assert.equal(first.data.actions.length, 1, JSON.stringify(first.data));
  assert.equal(first.data.actions[0].intent, 'add');
  assert.equal(first.data.actions[0].name, 'sabun', 'mis-heard words must not become part of the name');
  assert.equal(first.data.actions[0].qty, 20);
  assert.equal(first.data.actions[0].price, 20);
  await shop.apply(first.data.planId, first.data.actions);

  // Said again — and said messily again — it is the same soap.
  const again = await shop.say('naya sabun 10 ota 20 rupees');
  assert.equal(again.data.actions.length, 1, JSON.stringify(again.data));
  assert.equal(again.data.actions[0].intent, 'restock', 'the second time is a restock');
  assert.ok(again.data.actions[0].alreadyStocked, 'and it says so');
  assert.equal(again.data.actions[0].after, 30);
  await shop.apply(again.data.planId, again.data.actions);

  const inv = await api(`/partner/stores/${shop.storeId}/inventory`, { token: shop.token });
  const soaps = inv.data.items.filter((i) => /sabun/i.test(i.name));
  assert.equal(soaps.length, 1, `one soap line, got ${JSON.stringify(soaps.map((s) => s.name))}`);
  assert.equal(soaps[0].stock, 30);

  // A different price said alongside is its own decision, shown separately.
  const repriced = await shop.say('naya sabun 5 ota 25 rupees');
  assert.deepEqual(repriced.data.actions.map((a) => a.intent), ['restock', 'price']);
  assert.equal(repriced.data.actions[1].was, 20);
  assert.equal(repriced.data.actions[1].price, 25);
});

test('a new item close to one already stocked is asked about, not merged', async () => {
  // The flip side of the rule above. Topping up the wrong soap is worse than a
  // duplicate line, so an explicit "new" has to be nearly exact before it
  // counts as something already on the shelves.
  const shop = await shopWithStock('Sabun Kirana');
  const made = await shop.say('naya lifebuoy sabun 10 ota 45 rupees');
  assert.equal(made.data.actions[0].intent, 'add', JSON.stringify(made.data));
  await shop.apply(made.data.planId, made.data.actions);

  // A different soap: close enough to be worth asking about, not to assume.
  const lux = await shop.say('naya lux sabun 10 ota 25 rupees');
  assert.equal(lux.data.actions.length, 0, 'it must not quietly top up the Lifebuoy');
  assert.equal(lux.data.questions.length, 1, JSON.stringify(lux.data));
  assert.ok(lux.data.questions[0].canBeNew, 'and "it is new" has to be one of the answers');
  assert.ok(lux.data.questions[0].choices.some((c) => /lifebuoy/i.test(c.name)));

  // Saying the same soap again still restocks rather than duplicating.
  const same = await shop.say('naya lifebuoy sabun 5 ota 45 rupees');
  assert.equal(same.data.actions[0].intent, 'restock', JSON.stringify(same.data));
  assert.equal(same.data.actions[0].after, 15);
});

test('a question is answered, never acted on', async () => {
  const shop = await shopWithStock('Sodhne Kirana');
  const plan = await shop.say('चिनी कति छ');
  assert.equal(plan.data.actions.length, 0);
  assert.equal(plan.data.answers.length, 1, JSON.stringify(plan.data));
  assert.equal(plan.data.answers[0].intent, 'ask');
  assert.equal(plan.data.answers[0].stock, 40);
  assert.equal(await shop.stockOf(shop.sugar.id), 40);

  const low = await shop.say('के सकिँदै छ');
  assert.equal(low.data.answers.length, 1);
  assert.equal(low.data.answers[0].intent, 'low');
});

test('the same spoken instruction cannot be run twice', async () => {
  // A phone in a shop retries requests and fingers double-tap. Selling the same
  // two kilos twice would be the feature quietly corrupting the count.
  const shop = await shopWithStock('Dohoro Kirana');
  const plan = await shop.say('चिनी दुई किलो बिक्री भयो');
  const first = await shop.apply(plan.data.planId, plan.data.actions);
  assert.equal(first.status, 200);
  const second = await shop.apply(plan.data.planId, plan.data.actions);
  assert.equal(second.status, 409, JSON.stringify(second.data));
  assert.equal(await shop.stockOf(shop.sugar.id), 38, 'the shelf moved exactly once');
});

test('the shop will not sell more than it holds', async () => {
  const shop = await shopWithStock('Sakiyo Kirana');
  const plan = await shop.say('मास दाल पचास किलो बिक्री भयो');
  assert.equal(plan.data.actions.length, 0, 'an impossible sale is never proposed');
  assert.equal(plan.data.problems.length, 1, JSON.stringify(plan.data));
  assert.equal(plan.data.problems[0].reason, 'not_enough');
  assert.equal(plan.data.problems[0].stock, 12);
});

test('a confirmed plan is still re-checked before it touches anything', async () => {
  // The plan is a statement of intent from a browser, not a source of truth.
  const shop = await shopWithStock('Bharpardo Kirana');
  const other = await shopWithStock('Aarko Kirana');
  const plan = await shop.say('चिनी दुई किलो बिक्री भयो');

  // Someone else's item id, smuggled into this shop's plan.
  const crossShop = await shop.apply(plan.data.planId, [
    { intent: 'sold', itemId: other.sugar.id, qty: 2 }
  ]);
  assert.equal(crossShop.status, 200);
  assert.deepEqual(crossShop.data.done, [], 'an item from another shop is not reachable');
  assert.equal(crossShop.data.failed[0].error, 'not_found');
  assert.equal(await other.stockOf(other.sugar.id), 40, "the other shop's shelf is untouched");

  // A quantity the plan never contained, and a price outside the allowed range.
  const plan2 = await shop.say('चिनी दुई किलो बिक्री भयो');
  const tampered = await shop.apply(plan2.data.planId, [
    { intent: 'sold', itemId: shop.sugar.id, qty: -5 },
    { intent: 'price', itemId: shop.rice.id, price: 0 }
  ]);
  assert.equal(tampered.data.done.length, 0, JSON.stringify(tampered.data));
  assert.deepEqual(tampered.data.failed.map((f) => f.error).sort(), ['bad_price', 'bad_qty']);
  assert.equal(await shop.stockOf(shop.sugar.id), 40);
});

test('speaking a new price changes it, and leaves a trace', async () => {
  const shop = await shopWithStock('Bhau Kirana');
  const plan = await shop.say('चिनीको मूल्य एक सय पचास');
  assert.equal(plan.data.actions.length, 1, JSON.stringify(plan.data));
  assert.equal(plan.data.actions[0].intent, 'price');
  assert.equal(plan.data.actions[0].price, 150);
  assert.equal(plan.data.actions[0].was, 120, 'the old price is shown alongside the new one');

  await shop.apply(plan.data.planId, plan.data.actions);
  const inv = await api(`/partner/stores/${shop.storeId}/inventory`, { token: shop.token });
  assert.equal(inv.data.items.find((i) => i.id === shop.sugar.id).price, 150);
});

test('the shop can be closed and opened by voice', async () => {
  const shop = await shopWithStock('Banda Kirana');
  const plan = await shop.say('पसल बन्द गर');
  assert.equal(plan.data.actions.length, 1, JSON.stringify(plan.data));
  assert.equal(plan.data.actions[0].intent, 'close');
  const applied = await shop.apply(plan.data.planId, plan.data.actions);
  assert.equal(applied.data.open, false);

  const back = await shop.say('पसल खोल');
  const reopened = await shop.apply(back.data.planId, back.data.actions);
  assert.equal(reopened.data.open, true);
});

test('voice parsing needs a real session, not just an Authorization header', async () => {
  // The route took either a shopkeeper or a helper, and checked that by asking
  // whether the header existed at all — so any string got in.
  const junk = await api('/stores/voice/parse', {
    method: 'POST', token: 'not-a-real-token', body: { text: 'दुई किलो चिनी सय रुपैयाँ' }
  });
  assert.equal(junk.status, 401, JSON.stringify(junk.data));

  const none = await api('/stores/voice/parse', { method: 'POST', body: { text: 'two kilo sugar' } });
  assert.equal(none.status, 401);

  // Both real sessions still work: the shopkeeper...
  const shop = await openShop('Voice Auth Kirana');
  const asPartner = await api('/stores/voice/parse', {
    method: 'POST', token: shop.token, body: { text: 'two kilo sugar 100 rupees' }
  });
  assert.equal(asPartner.status, 200, JSON.stringify(asPartner.data));
  assert.equal(asPartner.data.item.name.toLowerCase(), 'sugar');

  // ...and the customer, who may be speaking as a hired helper.
  const customer = await registerUser('voice-helper');
  const asUser = await api('/stores/voice/parse', {
    method: 'POST', token: customer.token, body: { text: 'two kilo sugar 100 rupees' }
  });
  assert.equal(asUser.status, 200, JSON.stringify(asUser.data));
});

test('helper invite codes cannot be guessed into a stranger’s inventory', async () => {
  // A helper can add items and rewrite stock counts, and join matches a code
  // against EVERY shop on the platform — so a guesser only has to hit any live
  // invite anywhere. Six digits is 900k codes; the general per-IP budget alone
  // allowed hundreds of tries a minute at it.
  const shop = await openShop('Guess Target Kirana');
  const invite = await api(`/partner/stores/${shop.storeId}/helpers`, {
    method: 'POST', token: shop.token, body: { name: 'Sita' }
  });
  const realCode = invite.data.invite.code;
  assert.ok(invite.data.invite.expiresAt > Date.now(), 'an invite must expire');

  // Codes are unique while live, or join could walk a helper into the wrong shop.
  const second = await api(`/partner/stores/${shop.storeId}/helpers`, {
    method: 'POST', token: shop.token, body: { name: 'Hari' }
  });
  assert.notEqual(second.data.invite.code, realCode);

  const attacker = await registerUser('code-guesser');
  let blockedAt = null;
  for (let i = 0; i < 12; i += 1) {
    // Never accidentally guess the real code: walk codes that cannot be live.
    const guess = String(100000 + i);
    const tried = await api('/stores/helper/join', {
      method: 'POST', token: attacker.token, body: { code: guess }
    });
    if (tried.status === 429) { blockedAt = i; break; }
    assert.equal(tried.status, 404, JSON.stringify(tried.data));
  }
  assert.ok(blockedAt !== null && blockedAt <= 10, `guessing must be cut off, got ${blockedAt}`);

  // Even holding a real code now, the throttled account stays out.
  const stillBlocked = await api('/stores/helper/join', {
    method: 'POST', token: attacker.token, body: { code: realCode }
  });
  assert.equal(stillBlocked.status, 429, 'the lockout is not bypassed by a valid code');

  // And the real helper the shopkeeper actually invited is unaffected.
  const sita = await registerUser('sita-real');
  const joined = await api('/stores/helper/join', {
    method: 'POST', token: sita.token, body: { code: realCode }
  });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
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

/* ---------------- subscription requests (customer asks, shopkeeper answers) ---------------- */

test('a customer asks for a subscriber price and the shop accepts with a real offer', async () => {
  const shop = await openShop();
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Dahi', unit: 'each', price: 90, stock: 12 }
  });
  const itemId = created.data.item.id;
  const { token: cust } = await registerUser('asker');

  // Before asking, the row carries no request flag and no offer.
  const before = await api(`/stores/${shop.storeId}`, { token: cust });
  assert.equal(before.data.items[0].subscribeRequested, false);
  assert.equal(before.data.items[0].subscribePrice, null);

  const asked = await api(`/stores/${shop.storeId}/items/${itemId}/subscribe-request`, {
    method: 'POST', token: cust
  });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  assert.equal(asked.data.request.status, 'pending');

  // Asking twice while the shop has not answered is refused.
  const again = await api(`/stores/${shop.storeId}/items/${itemId}/subscribe-request`, {
    method: 'POST', token: cust
  });
  assert.equal(again.status, 409);

  // The customer's own view shows the pending ask.
  const flagged = await api(`/stores/${shop.storeId}`, { token: cust });
  assert.equal(flagged.data.items[0].subscribeRequested, true);

  // The shopkeeper sees it in the inbox, with a per-item pending count.
  const inbox = await api(`/partner/stores/${shop.storeId}/subscribe-requests`, { token: shop.token });
  assert.equal(inbox.status, 200, JSON.stringify(inbox.data));
  const reqRow = inbox.data.requests.find((r) => r.itemId === itemId);
  assert.ok(reqRow, 'the request reaches the shopkeeper');
  assert.equal(reqRow.status, 'pending');
  assert.ok(reqRow.userName, 'the shopkeeper sees who is asking');
  assert.equal(inbox.data.pendingByItem[itemId], 1);

  // The offered price is validated server-side: zero, negative and >= list are out.
  for (const bad of [0, -5, 90, 120]) {
    const rejected = await api(`/partner/stores/${shop.storeId}/subscribe-requests/${reqRow.id}/accept`, {
      method: 'POST', token: shop.token, body: { subscribePrice: bad }
    });
    assert.equal(rejected.status, 400, `subscribePrice ${bad} must be refused`);
  }

  const accepted = await api(`/partner/stores/${shop.storeId}/subscribe-requests/${reqRow.id}/accept`, {
    method: 'POST', token: shop.token, body: { subscribePrice: 80 }
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.request.status, 'accepted');
  assert.equal(accepted.data.item.subscribePrice, 80);

  // Accepting twice is refused — the request is already decided.
  const twice = await api(`/partner/stores/${shop.storeId}/subscribe-requests/${reqRow.id}/accept`, {
    method: 'POST', token: shop.token, body: { subscribePrice: 70 }
  });
  assert.equal(twice.status, 409);

  // The customer can now actually subscribe, at the offered price.
  const sub = await api(`/stores/${shop.storeId}/items/${itemId}/subscribe`, {
    method: 'POST', token: cust, body: { everyDays: 3 }
  });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  assert.equal(sub.data.subscription.price, 80);

  // Asking for an item that already has an offer is pointless — just subscribe.
  const { token: late } = await registerUser('late-asker');
  const moot = await api(`/stores/${shop.storeId}/items/${itemId}/subscribe-request`, {
    method: 'POST', token: late
  });
  assert.equal(moot.status, 400);
});

test('a declined request can be asked again, and only the owner answers the inbox', async () => {
  const shop = await openShop();
  const created = await api(`/partner/stores/${shop.storeId}/items`, {
    method: 'POST', token: shop.token, body: { name: 'Ghiu', unit: 'l', price: 950, stock: 3 }
  });
  const itemId = created.data.item.id;
  const { token: cust } = await registerUser('hopeful');

  const asked = await api(`/stores/${shop.storeId}/items/${itemId}/subscribe-request`, {
    method: 'POST', token: cust
  });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  const reqId = asked.data.request.id;

  // Another shopkeeper can neither read nor answer this shop's requests.
  const rival = await openShop('Rival Pasal');
  const spy = await api(`/partner/stores/${shop.storeId}/subscribe-requests`, { token: rival.token });
  assert.equal(spy.status, 403);
  const meddle = await api(`/partner/stores/${shop.storeId}/subscribe-requests/${reqId}/decline`, {
    method: 'POST', token: rival.token
  });
  assert.equal(meddle.status, 403);

  const declined = await api(`/partner/stores/${shop.storeId}/subscribe-requests/${reqId}/decline`, {
    method: 'POST', token: shop.token
  });
  assert.equal(declined.status, 200, JSON.stringify(declined.data));
  assert.equal(declined.data.request.status, 'declined');

  // The row no longer shows a pending ask, and the item still has no offer.
  const view = await api(`/stores/${shop.storeId}`, { token: cust });
  assert.equal(view.data.items[0].subscribeRequested, false);
  assert.equal(view.data.items[0].subscribePrice, null);

  // A "no" today is not a "no" forever — the customer may ask again.
  const reAsk = await api(`/stores/${shop.storeId}/items/${itemId}/subscribe-request`, {
    method: 'POST', token: cust
  });
  assert.equal(reAsk.status, 200, JSON.stringify(reAsk.data));
});

test('helper invite codes cannot be brute-forced, and go stale', async () => {
  const shop = await openShop();
  const invite = await api(`/partner/stores/${shop.storeId}/helpers`, {
    method: 'POST', token: shop.token, body: { name: 'Target' }
  });
  const code = invite.data.invite.code;

  // An attacker with a customer account guesses codes. Codes start at 100000,
  // so anything below can never be real — every guess is a guaranteed miss.
  const attacker = await registerUser('code-guesser');
  for (let i = 0; i < 10; i += 1) {
    const guess = await api('/stores/helper/join', {
      method: 'POST', token: attacker.token, body: { code: String(i).padStart(6, '0') }
    });
    assert.equal(guess.status, 404, 'a wrong code reads the same as a missing one');
  }
  const locked = await api('/stores/helper/join', {
    method: 'POST', token: attacker.token, body: { code: '000010' }
  });
  assert.equal(locked.status, 429, 'the 11th wrong code locks the account out');

  // Even the RIGHT code is refused once locked — the lock is checked first,
  // so a lucky last guess buys nothing.
  const luckyLate = await api('/stores/helper/join', {
    method: 'POST', token: attacker.token, body: { code }
  });
  assert.equal(luckyLate.status, 429, 'lockout is not bypassed by a correct code');

  // The lock is per-account: the real helper joins with the same code, first try.
  const legit = await registerUser('legit-helper');
  const joined = await api('/stores/helper/join', { method: 'POST', token: legit.token, body: { code } });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));

  // Invites expire (12s TTL on this server): a code left lying around goes stale.
  const second = await api(`/partner/stores/${shop.storeId}/helpers`, {
    method: 'POST', token: shop.token, body: { name: 'Latecomer' }
  });
  await new Promise((r) => setTimeout(r, 13000));
  const stale = await api('/stores/helper/join', {
    method: 'POST', token: legit.token, body: { code: second.data.invite.code }
  });
  assert.equal(stale.status, 404, 'an expired invite reads the same as a wrong code');
});

// --- the books must check themselves ------------------------------------------

test('the platform ledger reconciles with revenue recomputed from store bookings', async () => {
  // By now the suite has pushed wallet orders, a cancellation, handovers and
  // pickups through this server. Store commissions and service fees land in the
  // platform ledger; the /admin/overview cross-check recomputes revenue from
  // booking rows, and any gap means a money path wrote one but not the other.
  const { data } = await api('/admin/overview', { token: adminToken });
  assert.ok(data.reconciliation, 'overview must expose a reconciliation block');
  assert.equal(
    data.reconciliation.drift,
    0,
    `ledger (${data.reconciliation.ledgerTotal}) and recomputed revenue (${data.reconciliation.derivedTotal}) must agree — ` +
    'a non-zero drift means some money path writes one but not the other'
  );
  // And the store vertical is visible as its own line, not buried in the total.
  assert.ok(data.stats.storeCommission > 0, 'store commission must surface as its own revenue stat');
});
