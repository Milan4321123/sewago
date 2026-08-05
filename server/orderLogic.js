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
  // Cash-on-delivery orders were never charged (the courier collects at the
  // door), so there is nothing to refund and no booked revenue to reverse —
  // only the partner's pending income unwinds.
  const wasPrepaid = order.payment !== 'cash';
  const user = db.users.find((u) => u.id === order.userId);
  if (wasPrepaid && order.group && Array.isArray(order.group.perMember)) {
    // A group order was paid share-by-share, so it refunds share-by-share —
    // crediting the whole total to the host would hand them their friends' money.
    for (const share of order.group.perMember) {
      const member = db.users.find((u) => u.id === share.userId);
      if (member && share.paid) {
        member.wallet += share.paid;
        recordTxn('user', member, { type: txnType, label, amount: share.paid, sign: 1, refId: order.id });
      }
    }
  } else if (user && wasPrepaid) {
    user.wallet += order.total;
    recordTxn('user', user, { type: txnType, label, amount: order.total, sign: 1, refId: order.id });
  }
  if (order.partnerCut && order.partnerId) {
    const owner = db.partners.find((p) => p.id === order.partnerId);
    if (owner) {
      // Un-delivered orders only ever credited PENDING earnings (never
      // withdrawable earnings), so reverse from there — this is what stops a
      // partner cashing out income and then having the order refunded.
      owner.pendingEarnings = (owner.pendingEarnings || 0) - order.partnerCut;
      recordTxn('partner', owner, {
        type: 'order_reversal',
        label: `Order cancelled: ${order.restaurantName}`,
        amount: order.partnerCut,
        sign: -1,
        refId: order.id
      });
    }
    if (wasPrepaid) {
      recordPlatformRevenue({
        source: 'food_commission',
        label: `Order cancelled — commission reversed: ${order.restaurantName}`,
        amount: -(order.total - order.partnerCut - (order.serviceFee || 0)),
        refId: order.id
      });
    }
  }
  if (order.serviceFee > 0 && wasPrepaid) {
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
// A courier who accepts a delivery and then goes silent used to strand it
// forever: the order never reached a terminal state, the partner's income stayed
// frozen in pendingEarnings, a prepaid customer got no refund, and the courier
// stayed pinned to a job they abandoned. Recover both cases on a timer.
const PICKUP_DEADLINE_MS = 25 * 60 * 1000;   // accepted but never collected
const DROPOFF_DEADLINE_MS = 90 * 60 * 1000;  // collected but never delivered

function recoverAbandonedDeliveries() {
  const now = Date.now();
  let changed = 0;
  for (const order of db.orders) {
    if (order.fulfillment !== 'live' || !order.courierId) continue;
    if (order.status === 'delivered' || order.status === 'cancelled') continue;

    // Not picked up in time: release the courier and return it to the pool so
    // another rider can take it. Nothing financial has happened yet.
    if (order.status === 'preparing' && now - (order.courierAcceptedAt || 0) > PICKUP_DEADLINE_MS) {
      order.courierId = null;
      order.courier = null;
      order.courierAcceptedAt = null;
      order.reofferedAt = now;
      changed += 1;
      continue;
    }
    // Food collected but never delivered: this needs a human. Flag it for the
    // admin queue and unpin the courier so they aren't blocked from other work,
    // but keep the assignment recorded for the investigation.
    if (order.status === 'out_for_delivery' && now - (order.pickedUpAt || 0) > DROPOFF_DEADLINE_MS && !order.abandonedAt) {
      order.abandonedAt = now;
      order.abandonedBy = order.courierId;
      changed += 1;
    }
  }
  return changed;
}

function currentDelivery(driverId) {
  const order = db.orders.find(
    (o) => o.courierId === driverId &&
      !o.abandonedAt && // an abandoned job no longer blocks the courier
      (o.status === 'preparing' || o.status === 'out_for_delivery')
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
  recoverAbandonedDeliveries,
  applyRating,
  addReview,
  reviewsFor,
  isLive,
  ACCEPT_TIMEOUT_MS,
  COURIER_SHARE
};
