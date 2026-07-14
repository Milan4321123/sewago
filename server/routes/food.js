const express = require('express');
const { db, save, uid } = require('../db');
const { authRequired, publicUser } = require('./auth');
const { recordTxn, recordPlatformRevenue } = require('../payments');
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

router.get('/restaurants', authRequired, (req, res) => {
  const featured = (r) => (r.promotedUntil > Date.now() ? 1 : 0);
  res.json({
    restaurants: db.restaurants
      .filter((r) => isLive(r) && r.menu.length > 0)
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
  const restaurant = db.restaurants.find((r) => r.id === req.params.id && isLive(r));
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found.' });
  res.json({ restaurant });
});

router.post('/orders', authRequired, (req, res) => {
  const { restaurantId, items, deliveryTo } = req.body || {};
  const restaurant = db.restaurants.find((r) => r.id === restaurantId && isLive(r));
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

  let subtotal = 0;
  const lines = [];
  for (const { id, qty } of items) {
    const menuItem = restaurant.menu.find((m) => m.id === id);
    const quantity = Number(qty);
    if (!menuItem || !(quantity >= 1 && quantity <= 20)) {
      return res.status(400).json({ error: 'Invalid item in cart.' });
    }
    subtotal += menuItem.price * quantity;
    lines.push({ id: menuItem.id, name: menuItem.name, price: menuItem.price, qty: quantity });
  }
  // Live orders price delivery by road distance; sim orders keep the flat fee.
  const delivery = fulfillment === 'live'
    ? deliveryFeeFor(restaurant, deliveryLoc)
    : { fee: restaurant.deliveryFee, distanceKm: null };
  const total = subtotal + delivery.fee + FOOD_SERVICE_FEE;
  if (req.user.wallet < total) {
    return res.status(402).json({ error: 'Not enough wallet balance. Top up in Profile.' });
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
    fulfillment,
    restaurantLoc: restaurant.loc || null,
    deliveryLoc,
    courierId: null,
    courier: null,
    status: fulfillment === 'live' ? 'placed' : 'active',
    createdAt: Date.now()
  };
  req.user.wallet -= total;
  recordTxn('user', req.user, {
    type: 'food',
    label: `Food order: ${restaurant.name}`,
    amount: total,
    sign: -1,
    refId: order.id
  });
  // Partner-owned restaurants earn 85% of the food subtotal (SewaGo keeps
  // 15% plus the delivery fee); reversed if the order is cancelled.
  const owner = restaurant.ownerId && db.partners.find((p) => p.id === restaurant.ownerId);
  if (owner) {
    order.partnerId = owner.id;
    order.partnerCut = Math.round(subtotal * 0.85);
    owner.earnings = (owner.earnings || 0) + order.partnerCut;
    recordTxn('partner', owner, {
      type: 'order_income',
      label: `Order income: ${restaurant.name}`,
      amount: order.partnerCut,
      sign: 1,
      refId: order.id
    });
    recordPlatformRevenue({
      source: 'food_commission',
      label: `Food commission + delivery: ${restaurant.name}`,
      amount: total - order.partnerCut - order.serviceFee,
      refId: order.id
    });
  }
  // Service fee is its own revenue line so commissions and fees stay separable.
  recordPlatformRevenue({
    source: 'service_fee',
    label: `Order service fee: ${restaurant.name}`,
    amount: order.serviceFee,
    refId: order.id
  });
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
