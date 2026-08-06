// Group orders (eat together): friends pool one pickup / dine-in order and
// unlock the restaurant's group discount. The money rule that must hold above
// all else: each participant pays exactly their own discounted share, and if
// ANY participant can't pay, NOBODY is charged.
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

async function wallet(token) {
  return (await api('/auth/me', { token })).data.user.wallet;
}

// A KYC-approved partner with an approved restaurant, one Rs `price` item and
// a group discount of `pct`% from `minPeople` people.
async function onboardGroupRestaurant({ price = 400, pct = 10, minPeople = 2 } = {}) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const reg = await api('/partner/register', {
    method: 'POST',
    body: { name: 'Group Kitchen', email: `grp-${stamp}@test.local`, password: 'partner-secret', phone: `+9778${stamp.slice(-9)}`, regNo: `PAN-${stamp.slice(-6)}` }
  });
  const token = reg.data.token;
  const otp = await api('/partner/phone/request-otp', { method: 'POST', token, body: {} });
  await api('/partner/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  await api(`/admin/partners/${reg.data.partner.id}/kyc/approve`, { method: 'POST', token: adminToken });
  const rest = await api('/partner/restaurants', {
    method: 'POST', token,
    body: { name: 'Group Thamel', cuisine: 'Test', area: 'Thamel', etaMinutes: 20, deliveryFee: 100 }
  });
  const restaurantId = rest.data.restaurant.id;
  const menu = await api(`/partner/restaurants/${restaurantId}/menu`, { method: 'POST', token, body: { name: 'Set', price, desc: 't' } });
  await api(`/admin/restaurants/${restaurantId}/approve`, { method: 'POST', token: adminToken });
  const disc = await api(`/partner/restaurants/${restaurantId}/group-discount`, {
    method: 'POST', token, body: { pct, minPeople }
  });
  assert.equal(disc.status, 200, JSON.stringify(disc.data));
  assert.deepEqual(disc.data.restaurant.groupDiscount, { pct, minPeople });
  return { token, partnerId: reg.data.partner.id, restaurantId, menuItemId: menu.data.restaurant.menu[0].id };
}

before(async () => {
  PORT = await freePort();
  BASE = `http://localhost:${PORT}/api`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-groups-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATA_STORE: 'json', DATA_DIR: dataDir,
      ADMIN_EMAIL, ADMIN_PASSWORD, OTP_PROVIDER: 'sandbox', EMAIL_PROVIDER: 'sandbox',
      FOOD_SERVICE_FEE: '15', LOG_LEVEL: 'error'
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

test('happy path: create, join, pick, confirm, place — everyone pays their discounted share', async () => {
  const shop = await onboardGroupRestaurant({ price: 400, pct: 10, minPeople: 2 });
  const host = await registerUser('host');
  const friend = await registerUser('friend');

  const when = Date.now() + 2 * 60 * 60 * 1000;
  const created = await api('/group-orders', {
    method: 'POST', token: host.token,
    body: { restaurantId: shop.restaurantId, mode: 'dinein', scheduledFor: when }
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const group = created.data.group;
  assert.match(group.code, /^\d{6}$/, 'the host gets a 6-digit share code');
  assert.equal(group.status, 'open');
  assert.deepEqual(group.needMore, { people: 2, pct: 10 }, 'nobody has confirmed yet');

  const joined = await api('/group-orders/join', { method: 'POST', token: friend.token, body: { code: group.code } });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  assert.equal(joined.data.group.members.length, 2);

  // Confirming an empty plate is meaningless — refused.
  const empty = await api(`/group-orders/${group.id}/confirm`, { method: 'POST', token: host.token });
  assert.equal(empty.status, 400);

  // Host takes 2 sets (Rs 800), friend takes 1 (Rs 400); both confirm.
  await api(`/group-orders/${group.id}/items`, { method: 'POST', token: host.token, body: { items: [{ id: shop.menuItemId, qty: 2 }] } });
  await api(`/group-orders/${group.id}/items`, { method: 'POST', token: friend.token, body: { items: [{ id: shop.menuItemId, qty: 1 }] } });
  await api(`/group-orders/${group.id}/confirm`, { method: 'POST', token: host.token });
  const confirmed = await api(`/group-orders/${group.id}/confirm`, { method: 'POST', token: friend.token });
  assert.equal(confirmed.data.group.currentPct, 10, '2 confirmed people unlock the 10%');
  assert.equal(confirmed.data.group.savings, 120, '80 + 40 rupees stay in their pockets');

  // Only the host can pull the trigger.
  const notHost = await api(`/group-orders/${group.id}/place`, { method: 'POST', token: friend.token });
  assert.equal(notHost.status, 403);

  const hostBefore = await wallet(host.token);
  const friendBefore = await wallet(friend.token);
  const placed = await api(`/group-orders/${group.id}/place`, { method: 'POST', token: host.token });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));

  // Each pays round(share * 0.9) — host 720, friend 360.
  assert.equal(hostBefore - await wallet(host.token), 720);
  assert.equal(friendBefore - await wallet(friend.token), 360);

  const order = placed.data.order;
  assert.equal(order.mode, 'dinein');
  assert.equal(order.scheduledFor, when);
  assert.equal(order.subtotal, 1080, 'order subtotal is the sum of discounted shares');
  assert.equal(order.total, 1080, 'no delivery or service fee on a group order');
  assert.match(order.collectCode, /^\d{4}$/, 'the group gets one shared counter code');
  assert.equal(order.group.size, 2);
  assert.equal(order.group.pct, 10);
  assert.deepEqual(
    order.group.perMember.map((m) => m.paid).sort((a, b) => a - b),
    [360, 720]
  );

  // The kitchen sees ONE order with the group badge and everyone's plates.
  const queue = await api('/partner/orders', { token: shop.token });
  const seen = queue.data.orders.find((x) => x.id === order.id);
  assert.ok(seen, 'the group order lands in the restaurant queue');
  assert.equal(seen.group.size, 2);
  assert.equal(seen.items[0].qty, 3, 'plates are merged for the kitchen');
  assert.equal(seen.collectCode, undefined, 'the code never crosses the partner API');

  // Partner income: 85% of 1080 = 918, pending until collected.
  const me = await api('/partner/me', { token: shop.token });
  assert.equal(me.data.partner.pendingEarnings, 918);

  // Both members see the shared code on their group card.
  const friendView = await api('/group-orders', { token: friend.token });
  const fg = friendView.data.groups.find((g) => g.id === group.id);
  assert.equal(fg.status, 'placed');
  assert.equal(fg.order.collectCode, order.collectCode, 'every member can show the code');

  // Collection completes the order and settles the income (full counter flow
  // covered in food-modes.test.js).
  await api(`/partner/orders/${order.id}/accept`, { method: 'POST', token: shop.token });
  await api(`/partner/orders/${order.id}/ready`, { method: 'POST', token: shop.token });
  const done = await api(`/partner/orders/${order.id}/collected`, { method: 'POST', token: shop.token, body: { code: order.collectCode } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const settled = await api('/partner/me', { token: shop.token });
  assert.equal(settled.data.partner.earnings, 918);
  assert.equal(settled.data.partner.pendingEarnings, 0);
});

test('below minPeople the group still orders — at full price', async () => {
  const shop = await onboardGroupRestaurant({ price: 300, pct: 10, minPeople: 3 });
  const host = await registerUser('smallhost');
  const friend = await registerUser('smallfriend');

  const created = await api('/group-orders', {
    method: 'POST', token: host.token,
    body: { restaurantId: shop.restaurantId, mode: 'pickup', scheduledFor: Date.now() + 60 * 60 * 1000 }
  });
  const group = created.data.group;
  await api('/group-orders/join', { method: 'POST', token: friend.token, body: { code: group.code } });
  await api(`/group-orders/${group.id}/items`, { method: 'POST', token: host.token, body: { items: [{ id: shop.menuItemId, qty: 1 }] } });
  await api(`/group-orders/${group.id}/items`, { method: 'POST', token: friend.token, body: { items: [{ id: shop.menuItemId, qty: 1 }] } });
  await api(`/group-orders/${group.id}/confirm`, { method: 'POST', token: host.token });
  const view = await api(`/group-orders/${group.id}/confirm`, { method: 'POST', token: friend.token });
  assert.equal(view.data.group.currentPct, 0, 'two people do not unlock a 3-person discount');
  assert.deepEqual(view.data.group.needMore, { people: 1, pct: 10 }, 'one more person would');

  const hostBefore = await wallet(host.token);
  const placed = await api(`/group-orders/${group.id}/place`, { method: 'POST', token: host.token });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  assert.equal(placed.data.order.group.pct, 0);
  assert.equal(hostBefore - await wallet(host.token), 300, 'full price, no discount');
  assert.equal(placed.data.order.subtotal, 600);
});

test('one broke friend blocks the whole place — and nobody is charged', async () => {
  const shop = await onboardGroupRestaurant({ price: 400, pct: 10, minPeople: 2 });
  const host = await registerUser('richhost');
  const broke = await registerUser('brokefriend');

  const created = await api('/group-orders', {
    method: 'POST', token: host.token,
    body: { restaurantId: shop.restaurantId, mode: 'dinein', scheduledFor: Date.now() + 60 * 60 * 1000 }
  });
  const group = created.data.group;
  await api('/group-orders/join', { method: 'POST', token: broke.token, body: { code: group.code } });
  await api(`/group-orders/${group.id}/items`, { method: 'POST', token: host.token, body: { items: [{ id: shop.menuItemId, qty: 1 }] } });
  await api(`/group-orders/${group.id}/items`, { method: 'POST', token: broke.token, body: { items: [{ id: shop.menuItemId, qty: 1 }] } });
  await api(`/group-orders/${group.id}/confirm`, { method: 'POST', token: host.token });
  await api(`/group-orders/${group.id}/confirm`, { method: 'POST', token: broke.token });

  // Drain the friend's wallet AFTER they confirmed.
  await api('/admin/wallet-adjust', {
    method: 'POST', token: adminToken,
    body: { userId: broke.user.id, amount: -(await wallet(broke.token)), reason: 'broke friend for group test' }
  });

  const hostBefore = await wallet(host.token);
  const placed = await api(`/group-orders/${group.id}/place`, { method: 'POST', token: host.token });
  assert.equal(placed.status, 402, JSON.stringify(placed.data));
  assert.match(placed.data.error, /brokefriend/, 'the host is told exactly who is short');
  assert.equal(await wallet(host.token), hostBefore, 'the host was NOT charged');
  assert.equal(await wallet(broke.token), 0, 'and neither was the friend');

  // The lobby survives: top up and place again.
  await api('/admin/wallet-adjust', {
    method: 'POST', token: adminToken,
    body: { userId: broke.user.id, amount: 1000, reason: 'top up for group test' }
  });
  const retry = await api(`/group-orders/${group.id}/place`, { method: 'POST', token: host.token });
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(await wallet(broke.token), 1000 - 360, 'the friend pays their discounted share');
});

test('lobby rules: bad codes, leaving, host cancel, closed groups', async () => {
  const shop = await onboardGroupRestaurant({ price: 200, pct: 20, minPeople: 2 });
  const host = await registerUser('lobbyhost');
  const friend = await registerUser('lobbyfriend');
  const stranger = await registerUser('stranger');

  // A group needs a real future time.
  const soon = await api('/group-orders', {
    method: 'POST', token: host.token,
    body: { restaurantId: shop.restaurantId, mode: 'dinein', scheduledFor: Date.now() + 5 * 60 * 1000 }
  });
  assert.equal(soon.status, 400, '5 minutes is not enough runway for friends to join');

  const created = await api('/group-orders', {
    method: 'POST', token: host.token,
    body: { restaurantId: shop.restaurantId, mode: 'dinein', scheduledFor: Date.now() + 60 * 60 * 1000 }
  });
  const group = created.data.group;

  const badCode = await api('/group-orders/join', { method: 'POST', token: friend.token, body: { code: '000000' } });
  assert.equal(badCode.status, 404, 'a wrong code finds nothing');

  await api('/group-orders/join', { method: 'POST', token: friend.token, body: { code: group.code } });
  // Joining twice is harmless — the invite link just reopens the group.
  const rejoin = await api('/group-orders/join', { method: 'POST', token: friend.token, body: { code: group.code } });
  assert.equal(rejoin.data.group.members.length, 2, 'no duplicate members');

  // A stranger who never joined can see nothing and touch nothing.
  const spy = await api(`/group-orders/${group.id}/items`, { method: 'POST', token: stranger.token, body: { items: [] } });
  assert.equal(spy.status, 403);

  // The host cannot leave; a friend can.
  const hostLeave = await api(`/group-orders/${group.id}/leave`, { method: 'POST', token: host.token });
  assert.equal(hostLeave.status, 400);
  const left = await api(`/group-orders/${group.id}/leave`, { method: 'POST', token: friend.token });
  assert.equal(left.status, 200);

  // Only the host cancels; after that the lobby is dead to everyone.
  await api('/group-orders/join', { method: 'POST', token: friend.token, body: { code: group.code } });
  const friendCancel = await api(`/group-orders/${group.id}/cancel`, { method: 'POST', token: friend.token });
  assert.equal(friendCancel.status, 403);
  const cancelled = await api(`/group-orders/${group.id}/cancel`, { method: 'POST', token: host.token });
  assert.equal(cancelled.status, 200);
  const late = await api(`/group-orders/${group.id}/items`, {
    method: 'POST', token: friend.token, body: { items: [{ id: shop.menuItemId, qty: 1 }] }
  });
  assert.equal(late.status, 400, 'a cancelled group takes no more picks');
  const gone = await api('/group-orders', { token: friend.token });
  assert.ok(!gone.data.groups.some((g) => g.id === group.id), 'cancelled groups leave the active list');
});

test('a plate whose price drifts after confirm is refused, not silently charged', async () => {
  const shop = await onboardGroupRestaurant({ price: 400, pct: 10, minPeople: 2 });
  const host = await registerUser('drift-host');
  const friend = await registerUser('drift-friend');
  // A second dish we can pull off the menu out from under a confirmed member.
  const extra = await api(`/partner/restaurants/${shop.restaurantId}/menu`, {
    method: 'POST', token: shop.token, body: { name: 'Momo', price: 300, desc: 't' }
  });
  const momoId = extra.data.restaurant.menu.find((m) => m.name === 'Momo').id;

  const when = Date.now() + 2 * 60 * 60 * 1000;
  const group = (await api('/group-orders', {
    method: 'POST', token: host.token, body: { restaurantId: shop.restaurantId, mode: 'pickup', scheduledFor: when }
  })).data.group;
  await api('/group-orders/join', { method: 'POST', token: friend.token, body: { code: group.code } });
  await api(`/group-orders/${group.id}/items`, { method: 'POST', token: host.token, body: { items: [{ id: shop.menuItemId, qty: 1 }] } });
  await api(`/group-orders/${group.id}/items`, { method: 'POST', token: friend.token, body: { items: [{ id: momoId, qty: 1 }] } });
  await api(`/group-orders/${group.id}/confirm`, { method: 'POST', token: host.token });
  await api(`/group-orders/${group.id}/confirm`, { method: 'POST', token: friend.token });

  const hostBefore = await wallet(host.token);
  const friendBefore = await wallet(friend.token);

  // The restaurant pulls the momo after the friend locked it in.
  await api(`/partner/restaurants/${shop.restaurantId}/menu/${momoId}`, { method: 'DELETE', token: shop.token });

  const placed = await api(`/group-orders/${group.id}/place`, { method: 'POST', token: host.token });
  assert.equal(placed.status, 409, JSON.stringify(placed.data));
  assert.match(placed.data.error, /confirm again/i);
  assert.equal(await wallet(host.token), hostBefore, 'no wallet is touched when a plate drifted');
  assert.equal(await wallet(friend.token), friendBefore);

  // The drifted member is un-confirmed and must look again; the other is untouched.
  const members = (await api('/group-orders', { token: host.token })).data.groups.find((g) => g.id === group.id).members;
  assert.equal(members.find((m) => m.name === 'drift-friend').confirmed, false, 'friend must reconfirm at the new plate');
  assert.equal(members.find((m) => m.name === 'drift-host').confirmed, true, 'host, unaffected, stays confirmed');
});

test('the counter code reaches only the host and members who paid', async () => {
  const shop = await onboardGroupRestaurant({ price: 400, pct: 10, minPeople: 2 });
  const host = await registerUser('code-host');
  const payer = await registerUser('code-payer');
  const freeloader = await registerUser('code-freeloader');

  const when = Date.now() + 2 * 60 * 60 * 1000;
  const group = (await api('/group-orders', {
    method: 'POST', token: host.token, body: { restaurantId: shop.restaurantId, mode: 'pickup', scheduledFor: when }
  })).data.group;
  await api('/group-orders/join', { method: 'POST', token: payer.token, body: { code: group.code } });
  await api('/group-orders/join', { method: 'POST', token: freeloader.token, body: { code: group.code } });

  // Host and payer order and confirm; the freeloader just lurks in the lobby.
  await api(`/group-orders/${group.id}/items`, { method: 'POST', token: host.token, body: { items: [{ id: shop.menuItemId, qty: 1 }] } });
  await api(`/group-orders/${group.id}/items`, { method: 'POST', token: payer.token, body: { items: [{ id: shop.menuItemId, qty: 1 }] } });
  await api(`/group-orders/${group.id}/confirm`, { method: 'POST', token: host.token });
  await api(`/group-orders/${group.id}/confirm`, { method: 'POST', token: payer.token });

  const placed = await api(`/group-orders/${group.id}/place`, { method: 'POST', token: host.token });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  const realCode = placed.data.order.collectCode;
  assert.match(realCode, /^\d{4}$/);

  const codeFor = async (tok) => {
    const g = (await api('/group-orders', { token: tok })).data.groups.find((x) => x.id === group.id);
    return g.order.collectCode;
  };
  assert.equal(await codeFor(host.token), realCode, 'the host can show the code');
  assert.equal(await codeFor(payer.token), realCode, 'a paying member can show the code');
  assert.equal(await codeFor(freeloader.token), null, 'a lobby member who paid nothing cannot collect the food');
});

test('a host cannot hoard open lobbies past the cap', async () => {
  const shop = await onboardGroupRestaurant({ price: 400, pct: 10, minPeople: 2 });
  const host = await registerUser('hoarder');
  const when = Date.now() + 2 * 60 * 60 * 1000;
  const open = () => api('/group-orders', {
    method: 'POST', token: host.token, body: { restaurantId: shop.restaurantId, mode: 'pickup', scheduledFor: when }
  });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await open()).status, 200, `lobby ${i + 1} opens (default cap is 5)`);
  }
  const sixth = await open();
  assert.equal(sixth.status, 429, 'the sixth open lobby is refused');
  assert.match(sixth.data.error, /place or cancel one/i);

  // Cancelling one frees a slot — the cap is on LIVE lobbies, not lifetime.
  const mine = (await api('/group-orders', { token: host.token })).data.groups.filter((g) => g.status === 'open');
  await api(`/group-orders/${mine[0].id}/cancel`, { method: 'POST', token: host.token });
  assert.equal((await open()).status, 200, 'a freed slot lets a new lobby open');
});
