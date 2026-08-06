const crypto = require('crypto');
const express = require('express');
const { db, save, uid } = require('../db');
const { config } = require('../config');
const { authRequired, publicUser } = require('./auth');
const { recordTxn, recordPlatformRevenue, debitWallet } = require('../payments');
const {
  FOOD_SERVICE_FEE,
  FOOD_DELIVERY_FREE_KM,
  FOOD_DELIVERY_PER_KM,
  FOOD_DELIVERY_MAX_EXTRA,
  deliveryFeeFor
} = require('../fees');
const { withStatus, refundOrder, isLive, applyRating, addReview, reviewsFor } = require('../orderLogic');
const { resolveLocation } = require('../geo');
const events = require('../events');

const router = express.Router();

// Cart bounds. These keep a single order — and therefore every cut, payout and
// ledger entry derived from it — inside sane limits no matter what a client sends.
const MAX_ORDER_LINES = 20;      // distinct menu items in one order
const MAX_ITEM_QTY = 20;         // per menu item, counted AFTER de-duplication
const MAX_ORDER_SUBTOTAL = 100000;

// Seeded restaurants have no partner owner and are fulfilled by a timer only.
// Hide them in production so a real customer can never pay for food nobody cooks.
function orderable(r) {
  return isLive(r) && r.menu.length > 0 && (config.allowSimFulfillment || !!r.ownerId);
}

router.get('/restaurants', authRequired, (req, res) => {
  const featured = (r) => (r.promotedUntil > Date.now() ? 1 : 0);
  res.json({
    restaurants: db.restaurants
      .filter(orderable)
      .sort((a, b) => featured(b) - featured(a)),
    serviceFee: FOOD_SERVICE_FEE,
    // So the cart can preview the distance fee with the same formula the
    // server uses at checkout.
    deliveryFreeKm: FOOD_DELIVERY_FREE_KM,
    deliveryPerKm: FOOD_DELIVERY_PER_KM,
    deliveryMaxExtra: FOOD_DELIVERY_MAX_EXTRA
  });
});

router.get('/restaurants/:id', authRequired, (req, res) => {
  const restaurant = db.restaurants.find((r) => r.id === req.params.id && orderable(r));
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found.' });
  res.json({ restaurant });
});

// How far ahead an order can be scheduled — and how far "behind": a couple of
// minutes of clock skew must not reject a phone that says "now".
const SCHEDULE_PAST_GRACE_MS = 2 * 60 * 1000;
const SCHEDULE_MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

router.post('/orders', authRequired, (req, res) => {
  const { restaurantId, items, deliveryTo, payment } = req.body || {};
  // Order-ahead: 'pickup' (take it away) and 'dinein' (eat there) skip the
  // courier entirely — the customer walks to the counter with a code. Anything
  // else is a plain delivery, exactly as before.
  const mode = ['pickup', 'dinein'].includes((req.body || {}).mode) ? req.body.mode : 'delivery';
  const restaurant = db.restaurants.find((r) => r.id === restaurantId && orderable(r));
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found.' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Your cart is empty.' });
  }
  // Partner-run restaurants are fulfilled for real: the restaurant confirms and
  // a courier delivers, so a delivery address is required. Seeded demo
  // restaurants keep the simulated timeline.
  const fulfillment = restaurant.ownerId ? 'live' : 'sim';
  // Only real partner kitchens can do order-ahead — a sim restaurant has no
  // counter to walk up to and nobody to check the code.
  if (mode !== 'delivery' && fulfillment !== 'live') {
    return res.status(400).json({ error: 'Pickup and eat-there work at partner restaurants only — this one delivers.' });
  }
  // Paid up front is the whole point: the kitchen starts cooking on money that
  // is already in hand, and the counter handover is just a code check.
  if (mode !== 'delivery' && payment === 'cash') {
    return res.status(400).json({ error: 'Order-ahead is paid from your wallet so the kitchen can start cooking.' });
  }
  // "When?" — absent means ASAP; anything else must be a real timestamp inside
  // the schedulable window.
  let scheduledFor = null;
  if ((req.body || {}).scheduledFor !== undefined && (req.body || {}).scheduledFor !== null) {
    scheduledFor = Math.round(Number(req.body.scheduledFor));
    if (!Number.isFinite(scheduledFor) ||
        scheduledFor < Date.now() - SCHEDULE_PAST_GRACE_MS ||
        scheduledFor > Date.now() + SCHEDULE_MAX_AHEAD_MS) {
      return res.status(400).json({ error: 'Pick a time between now and 7 days from now.' });
    }
  }
  let deliveryLoc = null;
  if (fulfillment === 'live' && mode === 'delivery') {
    const resolved = resolveLocation(deliveryTo);
    if (resolved.error === 'outside') {
      return res.status(400).json({ error: 'That delivery point is outside the Kathmandu valley.' });
    }
    if (resolved.error) {
      return res.status(400).json({ error: 'A delivery location is required so the courier knows where to go.' });
    }
    deliveryLoc = { name: resolved.name, lat: resolved.lat, lng: resolved.lng };
  }

  // Bound the cart before pricing. Without this a client can send thousands of
  // lines — or repeat the same menu id to defeat the per-item cap — and drive
  // the order total (and every downstream cut, payout and ledger entry) to an
  // arbitrary size. Quantities must be whole numbers so no fractional rupees
  // enter the books.
  if (items.length > MAX_ORDER_LINES) {
    return res.status(400).json({ error: `An order can contain at most ${MAX_ORDER_LINES} different items.` });
  }
  const qtyById = new Map();
  for (const { id, qty } of items) {
    const quantity = Number(qty);
    if (!restaurant.menu.some((m) => m.id === id) || !Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: 'Invalid item in cart.' });
    }
    qtyById.set(id, (qtyById.get(id) || 0) + quantity);
  }
  let subtotal = 0;
  const lines = [];
  for (const [id, quantity] of qtyById) {
    if (quantity > MAX_ITEM_QTY) {
      return res.status(400).json({ error: `You can order at most ${MAX_ITEM_QTY} of the same item.` });
    }
    const menuItem = restaurant.menu.find((m) => m.id === id);
    subtotal += menuItem.price * quantity;
    lines.push({ id: menuItem.id, name: menuItem.name, price: menuItem.price, qty: quantity });
  }
  if (subtotal > MAX_ORDER_SUBTOTAL) {
    return res.status(400).json({ error: `Orders are limited to ${MAX_ORDER_SUBTOTAL} in food value — please split large orders.` });
  }
  // Live orders price delivery by road distance; sim orders keep the flat fee.
  // Order-ahead has no courier leg at all, so there is nothing to price — no
  // delivery fee, no service fee, total = the food.
  const delivery = mode !== 'delivery'
    ? { fee: 0, distanceKm: null }
    : fulfillment === 'live'
      ? deliveryFeeFor(restaurant, deliveryLoc)
      : { fee: restaurant.deliveryFee, distanceKm: null };
  const serviceFee = mode !== 'delivery' ? 0 : FOOD_SERVICE_FEE;
  const total = subtotal + delivery.fee + serviceFee;
  // Cash on delivery: the courier collects the total at the door, so nothing is
  // debited now and the customer needs no wallet balance to order. Only real
  // (live) orders can be COD — a simulated order has no courier to collect.
  const payMethod = payment === 'cash' && fulfillment === 'live' ? 'cash' : 'wallet';
  if (payment === 'cash' && fulfillment !== 'live') {
    return res.status(400).json({ error: 'Cash on delivery is only available from partner restaurants.' });
  }
  // A COD order must fit inside a courier's cash float, or no courier could ever
  // legitimately carry it. Bigger baskets have to be paid from the wallet.
  if (payMethod === 'cash' && total > config.codMaxOrderTotal) {
    return res.status(400).json({
      error: `Cash on delivery is limited to Rs ${config.codMaxOrderTotal} per order — please pay from your wallet for this order.`
    });
  }
  if (payMethod === 'wallet' && req.user.wallet < total) {
    return res.status(402).json({ error: 'Not enough wallet balance. Top up in Profile, or pay cash on delivery.' });
  }

  const order = {
    id: uid(),
    userId: req.user.id,
    customerName: req.user.name,
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    restaurantIcon: restaurant.icon,
    items: lines,
    subtotal,
    deliveryFee: delivery.fee,
    deliveryDistanceKm: delivery.distanceKm,
    serviceFee,
    total,
    payment: payMethod,
    fulfillment,
    mode,
    scheduledFor,
    // The customer's proof at the counter — same 4-digit shape as store
    // pickups. Only they see it; the kitchen hears it from their mouth.
    collectCode: mode !== 'delivery' ? String(crypto.randomInt(1000, 10000)) : null,
    collectedAt: null,
    restaurantLoc: restaurant.loc || null,
    deliveryLoc,
    courierId: null,
    courier: null,
    // Partner income settles from pending -> earnings only on delivery; the flag
    // is always explicit so the migration's "settled?" check is never ambiguous.
    partnerSettled: false,
    status: fulfillment === 'live' ? 'placed' : 'active',
    createdAt: Date.now()
  };
  if (payMethod === 'wallet') {
    debitWallet(req.user, total);
    recordTxn('user', req.user, {
      type: 'food',
      label: `Food order: ${restaurant.name}`,
      amount: total,
      sign: -1,
      refId: order.id
    });
  }
  // Partner-owned restaurants earn 85% of the food subtotal (SewaGo keeps
  // 15% plus the delivery fee); reversed if the order is cancelled.
  const owner = restaurant.ownerId && db.partners.find((p) => p.id === restaurant.ownerId);
  if (owner) {
    order.partnerId = owner.id;
    order.partnerCut = Math.round(subtotal * 0.85);
    // Credit to PENDING, not withdrawable earnings: the money only becomes the
    // partner's once the order is actually delivered. Until then it can still be
    // refunded to the customer, so it must not be cashable out. Settled in the
    // courier deliver handler.
    owner.pendingEarnings = (owner.pendingEarnings || 0) + order.partnerCut;
    recordTxn('partner', owner, {
      type: 'order_income_pending',
      label: `Order placed (pending delivery): ${restaurant.name}`,
      amount: order.partnerCut,
      sign: 1,
      refId: order.id
    });
    // Wallet orders are paid up front, so the platform's cut is earned now (and
    // reversed if the order is refunded). COD earns nothing yet — the money is
    // still in the customer's pocket — so its revenue is booked at delivery,
    // when the courier actually collects it.
    if (payMethod === 'wallet') {
      recordPlatformRevenue({
        source: 'food_commission',
        label: mode === 'delivery'
          ? `Food commission + delivery: ${restaurant.name}`
          : `Food commission: ${restaurant.name}`,
        amount: total - order.partnerCut - order.serviceFee,
        refId: order.id
      });
    }
  }
  // Service fee is its own revenue line so commissions and fees stay separable.
  // Order-ahead charges none, so there is nothing to book.
  if (payMethod === 'wallet' && order.serviceFee > 0) {
    recordPlatformRevenue({
      source: 'service_fee',
      label: `Order service fee: ${restaurant.name}`,
      amount: order.serviceFee,
      refId: order.id
    });
  }
  db.orders.push(order);
  save();
  events.publish('admin', { topic: 'orders' });
  // Ring the restaurant's order queue the moment the order lands.
  if (order.partnerId) events.publish(`partner:${order.partnerId}`, { topic: 'orders' });
  res.json({ order: withStatus(order), user: publicUser(req.user) });
});

router.get('/orders', authRequired, (req, res) => {
  const orders = db.orders
    .filter((o) => o.userId === req.user.id)
    .map(withStatus)
    .reverse();
  res.json({ orders });
});

router.post('/orders/:id/cancel', authRequired, (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id && o.userId === req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (withStatus(order).status !== 'placed') {
    return res.status(400).json({ error: 'The restaurant already started preparing — too late to cancel.' });
  }
  order.status = 'cancelled';
  order.cancelReason = 'customer';
  order.cancelledAt = Date.now();
  refundOrder(order, { label: `Order cancelled — refund: ${order.restaurantName}` });
  save();
  if (order.partnerId) events.publish(`partner:${order.partnerId}`, { topic: 'orders' });
  events.publish('admin', { topic: 'orders' });
  res.json({ order: { ...order }, user: publicUser(req.user) });
});

router.post('/orders/:id/rate', authRequired, (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id && o.userId === req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const stars = Number((req.body || {}).stars);
  if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'Rating must be 1-5 stars.' });
  // 'delivered' for courier orders, 'completed' for collected order-ahead.
  if (!['delivered', 'completed'].includes(withStatus(order).status)) {
    return res.status(400).json({ error: 'You can rate an order after it arrives.' });
  }
  if (order.ratingStars) return res.status(409).json({ error: 'You already rated this order.' });
  order.ratingStars = stars;
  order.ratedAt = Date.now();
  const restaurant = db.restaurants.find((r) => r.id === order.restaurantId);
  if (restaurant) {
    applyRating(restaurant, stars);
    // The rating doubles as a public review other customers can read.
    addReview({
      kind: 'restaurant',
      listingId: restaurant.id,
      user: req.user,
      stars,
      text: (req.body || {}).text,
      refId: order.id
    });
  }
  save();
  res.json({ order: { ...order } });
});

/* ---------------- group orders (eat together) ---------------- */
// Friends pool one pickup / dine-in order and unlock the restaurant's group
// discount. The group is a lobby: everyone picks their own items and confirms,
// then the host places ONE order — each participant's wallet pays their own
// (discounted) share at that moment, all-or-nothing.

const GROUP_MAX_MEMBERS = 12;
function envNum(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
// A group needs runway for friends to join, and the same one-week horizon as
// any scheduled order. Lead time is tunable so the "slot already passed" guard
// on place can be exercised in seconds.
const GROUP_MIN_LEAD_MS = envNum('GROUP_MIN_LEAD_MIN', 30, 0.01, 720) * 60 * 1000;
const GROUP_MAX_LEAD_MS = SCHEDULE_MAX_AHEAD_MS;
// A confirmation is a promise to pay a specific amount, made against the menu
// and head count at that moment. Past this window the host must not be able to
// quietly debit a member who has long moved on — they re-confirm at the current
// price. Generous by default so same-day groups are never nagged; tunable low
// for tests.
const GROUP_CONFIRM_TTL_MS = envNum('GROUP_CONFIRM_TTL_MIN', 24 * 60, 0.01, 14 * 24 * 60) * 60 * 1000;
// One account opening lobbies without limit grows the (blob-persisted) state
// until it is unusable. A host rarely runs more than a couple of live lobbies
// at once, so this ceiling is invisible to real use and fatal to a flood.
const GROUP_MAX_OPEN_PER_USER = envNum('GROUP_MAX_OPEN_PER_USER', 5, 1, 100);

// 6-digit join code, unique among OPEN groups so a code always finds one lobby.
function groupCode() {
  let code;
  do {
    code = String(crypto.randomInt(100000, 1000000));
  } while (db.groupOrders.some((g) => g.status === 'open' && g.code === code));
  return code;
}

// Resolve the group and check the caller is actually in it.
function myGroup(req, res) {
  const group = db.groupOrders.find((g) => g.id === req.params.id);
  if (!group) {
    res.status(404).json({ error: 'Group order not found.' });
    return null;
  }
  if (!group.members.some((m) => m.userId === req.user.id)) {
    res.status(403).json({ error: 'You are not in this group.' });
    return null;
  }
  return group;
}

// Price one member's picks from the CURRENT menu — an item that vanished from
// the menu since it was picked simply stops counting.
function memberSubtotal(restaurant, member) {
  return member.items.reduce((sum, line) => {
    const menuItem = restaurant && restaurant.menu.find((m) => m.id === line.id);
    return sum + (menuItem ? menuItem.price * line.qty : 0);
  }, 0);
}

// What every member's screen shows: who's in, who confirmed, what the discount
// is doing right now, and (after place) the shared counter code.
function groupView(group, userId) {
  const restaurant = db.restaurants.find((r) => r.id === group.restaurantId);
  const discount = (restaurant && restaurant.groupDiscount) || null;
  const members = group.members.map((m) => ({
    userId: m.userId,
    name: m.name,
    itemCount: m.items.reduce((sum, line) => sum + line.qty, 0),
    subtotal: memberSubtotal(restaurant, m),
    confirmed: !!m.confirmed
  }));
  const participants = group.members.filter((m) => m.confirmed && m.items.length > 0);
  const confirmedCount = participants.length;
  const currentPct = discount && confirmedCount >= discount.minPeople ? discount.pct : 0;
  // What the group is saving at the current head count.
  const savings = currentPct
    ? participants.reduce((sum, m) => {
      const sub = memberSubtotal(restaurant, m);
      return sum + (sub - Math.round(sub * (1 - currentPct / 100)));
    }, 0)
    : 0;
  const me = group.members.find((m) => m.userId === userId);
  const order = group.orderId ? db.orders.find((o) => o.id === group.orderId) : null;
  // The counter code is the whole order's settlement key, so it reaches only the
  // people with money in it — the host and everyone who paid a share. A lobby
  // member who never confirmed must not be able to collect (and walk off with)
  // food they did not pay for.
  const mayCollect = !!order && !!order.group
    && (userId === group.hostUserId || order.group.perMember.some((p) => p.userId === userId));
  return {
    id: group.id,
    code: group.code,
    restaurantId: group.restaurantId,
    restaurantName: group.restaurantName,
    restaurantIcon: restaurant ? restaurant.icon : '🍽️',
    hostUserId: group.hostUserId,
    hostName: (group.members.find((m) => m.userId === group.hostUserId) || {}).name || 'Host',
    mode: group.mode,
    scheduledFor: group.scheduledFor,
    status: group.status,
    createdAt: group.createdAt,
    discount,
    members,
    confirmedCount,
    currentPct,
    savings,
    // "N more people for X% off" — null once unlocked (or with no offer at all).
    needMore: discount && !currentPct
      ? { people: discount.minPeople - confirmedCount, pct: discount.pct }
      : null,
    myItems: me ? me.items : [],
    myConfirmed: me ? !!me.confirmed : false,
    // After the host places, every member shows the shared counter code.
    order: order
      ? {
        id: order.id,
        status: withStatus(order).status,
        collectCode: mayCollect ? order.collectCode : null,
        total: order.total,
        scheduledFor: order.scheduledFor
      }
      : null
  };
}

// Everyone's screen stays live: nudge each member's app after any change.
function publishGroup(group) {
  for (const m of group.members) events.publish(`user:${m.userId}`, { topic: 'group' });
}

// Host opens the lobby. Live partner restaurants only, pickup or eat-there
// only — a group feast has no courier.
router.post('/group-orders', authRequired, (req, res) => {
  const { restaurantId, mode, scheduledFor } = req.body || {};
  const restaurant = db.restaurants.find((r) => r.id === restaurantId && orderable(r));
  if (!restaurant || !restaurant.ownerId) {
    return res.status(404).json({ error: 'Group orders work at partner restaurants only.' });
  }
  if (mode !== 'pickup' && mode !== 'dinein') {
    return res.status(400).json({ error: 'Choose pickup or eat-there for the group.' });
  }
  const when = Math.round(Number(scheduledFor));
  if (!Number.isFinite(when) || when < Date.now() + GROUP_MIN_LEAD_MS || when > Date.now() + GROUP_MAX_LEAD_MS) {
    return res.status(400).json({ error: 'Pick a time at least 30 minutes from now (and within a week) so everyone can join.' });
  }
  // Only live lobbies count — a slot that has already passed is dead weight, not
  // a lobby anyone can still use, so it never blocks opening a fresh one.
  const liveHosted = db.groupOrders.filter(
    (g) => g.hostUserId === req.user.id && g.status === 'open' && g.scheduledFor > Date.now()
  ).length;
  if (liveHosted >= GROUP_MAX_OPEN_PER_USER) {
    return res.status(429).json({ error: `You already have ${GROUP_MAX_OPEN_PER_USER} open group orders — place or cancel one before starting another.` });
  }
  const group = {
    id: uid(),
    code: groupCode(),
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    hostUserId: req.user.id,
    mode,
    scheduledFor: when,
    status: 'open',
    members: [{ userId: req.user.id, name: req.user.name, items: [], confirmed: false }],
    orderId: null,
    createdAt: Date.now()
  };
  db.groupOrders.push(group);
  save();
  res.json({ group: groupView(group, req.user.id) });
});

// Join with the 6-digit code the host shared. Joining twice just returns the
// group — a re-tapped invite link must not error.
router.post('/group-orders/join', authRequired, (req, res) => {
  const code = String((req.body || {}).code || '').trim();
  const group = db.groupOrders.find((g) => g.status === 'open' && g.code === code);
  if (!group) return res.status(404).json({ error: 'No open group with that code — check the 6 digits with your host.' });
  if (!group.members.some((m) => m.userId === req.user.id)) {
    if (group.members.length >= GROUP_MAX_MEMBERS) {
      return res.status(409).json({ error: `This group is full (${GROUP_MAX_MEMBERS} people max).` });
    }
    group.members.push({ userId: req.user.id, name: req.user.name, items: [], confirmed: false });
    save();
    publishGroup(group);
  }
  res.json({ group: groupView(group, req.user.id) });
});

// My active groups: open lobbies plus placed ones whose order is still cooking.
router.get('/group-orders', authRequired, (req, res) => {
  const groups = db.groupOrders
    .filter((g) => g.members.some((m) => m.userId === req.user.id))
    .filter((g) => {
      if (g.status === 'open') return true;
      if (g.status !== 'placed') return false;
      const order = db.orders.find((o) => o.id === g.orderId);
      return order && !['completed', 'delivered', 'cancelled'].includes(withStatus(order).status);
    })
    .map((g) => groupView(g, req.user.id))
    .reverse();
  res.json({ groups });
});

// Set MY plate. Editing after confirming un-confirms it — what you locked in
// is what everyone else planned around. Same bounds as a normal order, per
// member, de-duplicated first so a repeated id cannot defeat the per-item cap.
router.post('/group-orders/:id/items', authRequired, (req, res) => {
  const group = myGroup(req, res);
  if (!group) return;
  if (group.status !== 'open') return res.status(400).json({ error: 'This group order is closed.' });
  const restaurant = db.restaurants.find((r) => r.id === group.restaurantId);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found.' });
  const items = (req.body || {}).items;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Send your items as a list.' });
  if (items.length > MAX_ORDER_LINES) {
    return res.status(400).json({ error: `You can pick at most ${MAX_ORDER_LINES} different items.` });
  }
  const qtyById = new Map();
  for (const { id, qty } of items) {
    const quantity = Number(qty);
    if (!restaurant.menu.some((m) => m.id === id) || !Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: 'Invalid item in your picks.' });
    }
    qtyById.set(id, (qtyById.get(id) || 0) + quantity);
  }
  let subtotal = 0;
  const lines = [];
  for (const [id, quantity] of qtyById) {
    if (quantity > MAX_ITEM_QTY) {
      return res.status(400).json({ error: `You can order at most ${MAX_ITEM_QTY} of the same item.` });
    }
    subtotal += restaurant.menu.find((m) => m.id === id).price * quantity;
    lines.push({ id, qty: quantity });
  }
  if (subtotal > MAX_ORDER_SUBTOTAL) {
    return res.status(400).json({ error: `Orders are limited to ${MAX_ORDER_SUBTOTAL} in food value — please split large orders.` });
  }
  const me = group.members.find((m) => m.userId === req.user.id);
  me.items = lines;
  me.confirmed = false;
  me.confirmedSubtotal = null;
  me.confirmedAt = null;
  save();
  publishGroup(group);
  res.json({ group: groupView(group, req.user.id) });
});

// "I'm in" / "let me change something" — the discount counts CONFIRMED people,
// so a confirm needs something on the plate.
router.post('/group-orders/:id/:action(confirm|unconfirm)', authRequired, (req, res) => {
  const group = myGroup(req, res);
  if (!group) return;
  if (group.status !== 'open') return res.status(400).json({ error: 'This group order is closed.' });
  const me = group.members.find((m) => m.userId === req.user.id);
  if (req.params.action === 'confirm') {
    if (me.items.length === 0) {
      return res.status(400).json({ error: 'Pick at least one item before confirming your part.' });
    }
    const restaurant = db.restaurants.find((r) => r.id === group.restaurantId);
    // Freeze exactly what this member is agreeing to pay for. place() refuses to
    // charge more than this, so a menu price bumped after they confirmed cannot
    // ride through on the host's tap.
    me.confirmed = true;
    me.confirmedSubtotal = memberSubtotal(restaurant, me);
    me.confirmedAt = Date.now();
  } else {
    me.confirmed = false;
    me.confirmedSubtotal = null;
    me.confirmedAt = null;
  }
  save();
  publishGroup(group);
  res.json({ group: groupView(group, req.user.id) });
});

// The host places ONE order for everyone who confirmed. Each participant's
// wallet pays their own share at this moment — all-or-nothing, so nobody's
// dinner rides on a friend who can't pay.
router.post('/group-orders/:id/place', authRequired, (req, res) => {
  const group = myGroup(req, res);
  if (!group) return;
  if (group.hostUserId !== req.user.id) return res.status(403).json({ error: 'Only the host can place the group order.' });
  if (group.status !== 'open') return res.status(400).json({ error: 'This group order is closed.' });
  const restaurant = db.restaurants.find((r) => r.id === group.restaurantId && orderable(r));
  if (!restaurant || !restaurant.ownerId) return res.status(404).json({ error: 'Restaurant not found.' });

  // The meal slot itself has passed — there is nothing left to place.
  if (Date.now() > group.scheduledFor) {
    return res.status(400).json({ error: "This group's time has passed — start a new one." });
  }

  // A confirmation is a promise to pay a specific amount. Before any wallet is
  // touched, re-check every confirmed member against what they actually agreed:
  // the same plate price (a menu bump since is not theirs to swallow) and a
  // recent enough confirmation (not one they made and forgot). Anyone who no
  // longer matches is un-confirmed and the place is refused, so the host nudges
  // them to look again instead of money moving behind their back.
  const now = Date.now();
  const needReconfirm = [];
  for (const m of group.members) {
    if (!m.confirmed || m.items.length === 0) continue;
    const priceMoved = memberSubtotal(restaurant, m) !== m.confirmedSubtotal;
    const tooOld = !m.confirmedAt || now - m.confirmedAt > GROUP_CONFIRM_TTL_MS;
    if (priceMoved || tooOld) {
      m.confirmed = false;
      m.confirmedSubtotal = null;
      m.confirmedAt = null;
      needReconfirm.push(m.name);
    }
  }
  if (needReconfirm.length) {
    save();
    publishGroup(group);
    return res.status(409).json({
      error: `Prices or plans changed for ${needReconfirm.join(', ')} — they need to confirm again before you place.`
    });
  }

  const participants = group.members.filter((m) => m.confirmed && m.items.length > 0);
  const shares = participants
    .map((m) => ({ member: m, user: db.users.find((u) => u.id === m.userId), subtotal: memberSubtotal(restaurant, m) }))
    .filter((s) => s.user && s.subtotal > 0);
  if (shares.length === 0) return res.status(400).json({ error: 'Nobody has confirmed items yet.' });

  const discount = restaurant.groupDiscount || null;
  const pct = discount && shares.length >= discount.minPeople ? discount.pct : 0;
  for (const s of shares) s.paid = Math.round(s.subtotal * (1 - pct / 100));

  // All-or-nothing: if anyone is short, charge NOBODY and name names so the
  // host knows exactly who to nudge.
  const short = shares.filter((s) => s.user.wallet < s.paid);
  if (short.length) {
    return res.status(402).json({
      error: `Not enough wallet balance: ${short.map((s) => s.member.name).join(', ')}. Everyone tops up, then place again.`
    });
  }
  const orderId = uid();
  for (const s of shares) {
    debitWallet(s.user, s.paid);
    recordTxn('user', s.user, {
      type: 'food',
      label: `Group order: ${restaurant.name}`,
      amount: s.paid,
      sign: -1,
      refId: orderId
    });
  }

  // One order lands in the kitchen queue with everyone's plates merged. Its
  // subtotal is the sum of the DISCOUNTED shares — the money that actually
  // moved — and the partner's 85% is cut from that.
  const qtyById = new Map();
  for (const s of shares) {
    for (const line of s.member.items) qtyById.set(line.id, (qtyById.get(line.id) || 0) + line.qty);
  }
  const lines = [];
  for (const [id, quantity] of qtyById) {
    const menuItem = restaurant.menu.find((m) => m.id === id);
    if (menuItem) lines.push({ id: menuItem.id, name: menuItem.name, price: menuItem.price, qty: quantity });
  }
  const subtotal = shares.reduce((sum, s) => sum + s.paid, 0);
  const order = {
    id: orderId,
    userId: req.user.id,
    customerName: shares.length > 1 ? `${req.user.name} + ${shares.length - 1}` : req.user.name,
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    restaurantIcon: restaurant.icon,
    items: lines,
    subtotal,
    deliveryFee: 0,
    deliveryDistanceKm: null,
    serviceFee: 0,
    total: subtotal,
    payment: 'wallet',
    fulfillment: 'live',
    mode: group.mode,
    scheduledFor: group.scheduledFor,
    collectCode: String(crypto.randomInt(1000, 10000)),
    collectedAt: null,
    // Who paid what — userId included so a refund can send each share home.
    group: {
      id: group.id,
      size: shares.length,
      pct,
      perMember: shares.map((s) => ({ userId: s.member.userId, name: s.member.name, subtotal: s.subtotal, paid: s.paid }))
    },
    restaurantLoc: restaurant.loc || null,
    deliveryLoc: null,
    courierId: null,
    courier: null,
    partnerSettled: false,
    status: 'placed',
    createdAt: Date.now()
  };
  const owner = db.partners.find((p) => p.id === restaurant.ownerId);
  if (owner) {
    order.partnerId = owner.id;
    order.partnerCut = Math.round(subtotal * 0.85);
    // Pending until collected at the counter, same as every other live order.
    owner.pendingEarnings = (owner.pendingEarnings || 0) + order.partnerCut;
    recordTxn('partner', owner, {
      type: 'order_income_pending',
      label: `Group order placed (pending collection): ${restaurant.name}`,
      amount: order.partnerCut,
      sign: 1,
      refId: order.id
    });
    recordPlatformRevenue({
      source: 'food_commission',
      label: `Food commission (group): ${restaurant.name}`,
      amount: order.total - order.partnerCut,
      refId: order.id
    });
  }
  db.orders.push(order);
  group.status = 'placed';
  group.orderId = order.id;
  save();
  publishGroup(group);
  if (order.partnerId) events.publish(`partner:${order.partnerId}`, { topic: 'orders' });
  events.publish('admin', { topic: 'orders' });
  res.json({ group: groupView(group, req.user.id), order: withStatus(order), user: publicUser(req.user) });
});

// A friend backs out of an open lobby. The host's exit is cancel, below.
router.post('/group-orders/:id/leave', authRequired, (req, res) => {
  const group = myGroup(req, res);
  if (!group) return;
  if (group.status !== 'open') return res.status(400).json({ error: 'This group order is closed.' });
  if (group.hostUserId === req.user.id) {
    return res.status(400).json({ error: 'The host cannot leave — cancel the group instead.' });
  }
  const wasMembers = group.members;
  group.members = group.members.filter((m) => m.userId !== req.user.id);
  save();
  // Tell everyone, including the person who just left.
  for (const m of wasMembers) events.publish(`user:${m.userId}`, { topic: 'group' });
  res.json({ ok: true });
});

// Host closes the lobby. No money has moved before place, so there is nothing
// to unwind — screens just update.
router.post('/group-orders/:id/cancel', authRequired, (req, res) => {
  const group = myGroup(req, res);
  if (!group) return;
  if (group.status !== 'open') return res.status(400).json({ error: 'This group order is closed.' });
  if (group.hostUserId !== req.user.id) return res.status(403).json({ error: 'Only the host can cancel the group.' });
  group.status = 'cancelled';
  group.cancelledAt = Date.now();
  save();
  publishGroup(group);
  res.json({ group: groupView(group, req.user.id) });
});

// Reviews from past diners, newest first — every order rating lands here.
router.get('/restaurants/:id/reviews', authRequired, (req, res) => {
  const restaurant = db.restaurants.find((r) => r.id === req.params.id && isLive(r));
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found.' });
  res.json({
    reviews: reviewsFor('restaurant', restaurant.id),
    rating: restaurant.rating,
    ratingCount: restaurant.ratingCount || 0
  });
});

module.exports = router;
