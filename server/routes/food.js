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

router.post('/orders', authRequired, (req, res) => {
  const { restaurantId, items, deliveryTo, payment } = req.body || {};
  const restaurant = db.restaurants.find((r) => r.id === restaurantId && orderable(r));
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found.' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Your cart is empty.' });
  }
  // Partner-run restaurants are fulfilled for real: the restaurant confirms and
  // a courier delivers, so a delivery address is required. Seeded demo
  // restaurants keep the simulated timeline.
  const fulfillment = restaurant.ownerId ? 'live' : 'sim';
  let deliveryLoc = null;
  if (fulfillment === 'live') {
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
  const delivery = fulfillment === 'live'
    ? deliveryFeeFor(restaurant, deliveryLoc)
    : { fee: restaurant.deliveryFee, distanceKm: null };
  const total = subtotal + delivery.fee + FOOD_SERVICE_FEE;
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
    serviceFee: FOOD_SERVICE_FEE,
    total,
    payment: payMethod,
    fulfillment,
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
        label: `Food commission + delivery: ${restaurant.name}`,
        amount: total - order.partnerCut - order.serviceFee,
        refId: order.id
      });
    }
  }
  // Service fee is its own revenue line so commissions and fees stay separable.
  if (payMethod === 'wallet') {
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
  if (withStatus(order).status !== 'delivered') {
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
