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

const PORT = 4991;
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
