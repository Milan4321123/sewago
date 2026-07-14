// Food-order state shared by the customer, partner and courier routes.
//
// Two fulfillment modes, mirroring how rides work:
//   'live' — partner-owned restaurant. The restaurant accepts/rejects, a real
//            bike driver couriers it, and every status is an explicit action.
//   'sim'  — seeded demo restaurant with no partner behind it. Status advances
//            on the original timers so the demo stays alive with zero staff.
const { db, save } = require('./db');

// Demo timings (seconds) for simulated orders.
const PLACED_UNTIL = 8;
const PREPARING_UNTIL = 45;
const DELIVERY_UNTIL = 75;

// Live orders a restaurant hasn't accepted in time are auto-cancelled and
// refunded — money must never sit on an order nobody is cooking.
const ACCEPT_TIMEOUT_MS = 10 * 60 * 1000;

// Courier keeps 80% of the delivery fee; the platform keeps the rest.
const COURIER_SHARE = 0.8;

function courierPayoutFor(order) {
  return Math.round((order.deliveryFee || 0) * COURIER_SHARE);
}

// Only listings approved by SewaGo staff are visible / orderable.
function isLive(listing) {
  return !listing.status || listing.status === 'approved';
}

// Undo every money movement an order made at placement: customer refund,
// partner-cut reversal, and platform-ledger reversals. Used by customer
// cancel, restaurant reject, and the accept timeout.
function refundOrder(order, { label, txnType = 'food_refund' }) {
  // Lazy require to avoid a circular import at module load time.
  const { recordTxn, recordPlatformRevenue } = require('./payments');
  const user = db.users.find((u) => u.id === order.userId);
  if (user) {
    user.wallet += order.total;
    recordTxn('user', user, { type: txnType, label, amount: order.total, sign: 1, refId: order.id });
  }
  if (order.partnerCut && order.partnerId) {
    const owner = db.partners.find((p) => p.id === order.partnerId);
    if (owner) {
      owner.earnings = (owner.earnings || 0) - order.partnerCut;
      recordTxn('partner', owner, {
        type: 'order_reversal',
        label: `Order cancelled: ${order.restaurantName}`,
        amount: order.partnerCut,
        sign: -1,
        refId: order.id
      });
    }
    recordPlatformRevenue({
      source: 'food_commission',
      label: `Order cancelled — commission reversed: ${order.restaurantName}`,
      amount: -(order.total - order.partnerCut - (order.serviceFee || 0)),
      refId: order.id
    });
  }
  if (order.serviceFee > 0) {
    recordPlatformRevenue({
      source: 'service_fee',
      label: `Order cancelled — service fee reversed: ${order.restaurantName}`,
      amount: -order.serviceFee,
      refId: order.id
    });
  }
  return user;
}

function withStatus(order) {
  if (order.status === 'delivered' || order.status === 'cancelled') return { ...order };

  if (order.fulfillment === 'live') {
    if (order.status === 'placed' && Date.now() - order.createdAt > ACCEPT_TIMEOUT_MS) {
      order.status = 'cancelled';
      order.cancelReason = 'restaurant_timeout';
      order.cancelledAt = Date.now();
      refundOrder(order, { label: `Restaurant did not confirm — refund: ${order.restaurantName}` });
      save();
    }
    return { ...order };
  }

  // Simulated order: status advances on a timer.
  const t = (Date.now() - order.createdAt) / 1000;
  let status;
  if (t < PLACED_UNTIL) status = 'placed';
  else if (t < PREPARING_UNTIL) status = 'preparing';
  else if (t < DELIVERY_UNTIL) status = 'out_for_delivery';
  else {
    order.status = 'delivered';
    order.deliveredAt = Date.now();
    save();
    return { ...order };
  }
  return { ...order, status };
}

// The courier's current job, if any — assigned at 'preparing', done after
// 'delivered'. A driver can hold one delivery OR one ride, never both.
function currentDelivery(driverId) {
  const order = db.orders.find(
    (o) => o.courierId === driverId && (o.status === 'preparing' || o.status === 'out_for_delivery')
  );
  return order ? withStatus(order) : null;
}

// Incremental average rating, shared by restaurants and drivers. Seeded
// entities start with a weighted count (set in db.js migrate) so a single
// early one-star can't tank a listing that "arrived" with a reputation.
function applyRating(entity, stars) {
  const count = entity.ratingCount || 0;
  const current = entity.rating == null ? 0 : entity.rating;
  entity.rating = Math.round(((current * count + stars) / (count + 1)) * 10) / 10;
  entity.ratingCount = count + 1;
}

// "Milan Adhikari" -> "Milan A." — reviews show who wrote them without
// exposing full customer names to every other guest.
function reviewerName(name) {
  const parts = String(name || 'Customer').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}

// One review per delivered order / finished stay: written at rating time,
// readable by every customer on the listing page.
function addReview({ kind, listingId, user, stars, text, refId }) {
  const { uid } = require('./db');
  const review = {
    id: uid(),
    kind, // 'restaurant' | 'hotel'
    listingId,
    userId: user.id,
    userName: reviewerName(user.name),
    stars,
    text: String(text || '').trim().slice(0, 300),
    refId,
    createdAt: Date.now()
  };
  db.reviews = db.reviews || [];
  db.reviews.push(review);
  return review;
}

function reviewsFor(kind, listingId, limit = 20) {
  return (db.reviews || [])
    .filter((r) => r.kind === kind && r.listingId === listingId)
    .slice(-limit)
    .reverse()
    .map((r) => ({ userName: r.userName, stars: r.stars, text: r.text, createdAt: r.createdAt }));
}

module.exports = {
  withStatus,
  refundOrder,
  courierPayoutFor,
  currentDelivery,
  applyRating,
  addReview,
  reviewsFor,
  isLive,
  ACCEPT_TIMEOUT_MS,
  COURIER_SHARE
};
