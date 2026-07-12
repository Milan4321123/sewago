// Self-service account deletion for customers, drivers and partners.
// Required for app-store listings (Google Play mandates in-app account deletion
// for any app with account creation) and basic data-privacy hygiene.
//
// Records are anonymized in place rather than removed: rides, orders, ledger
// entries and the platform revenue trail keep their integrity, but nothing
// personally identifiable stays behind and the account can never log in again.
const crypto = require('crypto');
const { db } = require('./db');
const { hashPassword } = require('./passwords');
const { logAudit } = require('./audit');

const ACTIVE_RIDE_STATES = ['searching', 'driver_en_route', 'in_progress'];
const FOOD_DELIVERY_WINDOW_MS = 75 * 1000; // matches DELIVERY_UNTIL in routes/food.js

function rideActive(ride) {
  return ACTIVE_RIDE_STATES.includes(ride.status);
}

function orderActive(order) {
  if (order.status === 'delivered' || order.status === 'cancelled') return false;
  return Date.now() - order.createdAt < FOOD_DELIVERY_WINDOW_MS;
}

function bookingActive(booking) {
  return booking.status === 'active' && new Date(booking.checkOut).getTime() > Date.now();
}

// Everything that must be finished or cancelled before the account can go.
// Money in flight is never forfeited silently.
function deletionBlockers(kind, entity) {
  const blockers = [];
  const id = entity.id;

  if ((db.withdrawals || []).some((w) => w.ownerKind === kind && w.ownerId === id && w.status === 'processing')) {
    blockers.push('a withdrawal is still being processed — wait for it to be paid or rejected');
  }

  if (kind === 'user') {
    if (db.rides.some((r) => r.userId === id && rideActive(r))) {
      blockers.push('you have an active ride — finish or cancel it first');
    }
    if (db.orders.some((o) => o.userId === id && orderActive(o))) {
      blockers.push('you have a food order on the way — wait for delivery');
    }
    if (db.bookings.some((b) => b.userId === id && bookingActive(b))) {
      blockers.push('you have an upcoming stay — cancel the booking first');
    }
    if ((db.tasks || []).some((t) => t.posterId === id && ['open', 'assigned', 'done'].includes(t.status))) {
      blockers.push('you have posted tasks with money in escrow — cancel or confirm them first');
    }
    if ((db.tasks || []).some((t) => t.workerId === id && ['assigned', 'done'].includes(t.status))) {
      blockers.push('you are working on a task — finish it and get paid first');
    }
  }

  if (kind === 'driver') {
    if (entity.online) blockers.push('go offline first');
    if (db.rides.some((r) => (r.driverId === id || (r.driver && r.driver.id === id)) && rideActive(r))) {
      blockers.push('you have an active trip — complete it first');
    }
    if ((entity.earnings || 0) > 0) {
      blockers.push(`withdraw your Rs ${entity.earnings} earnings first so you do not lose them`);
    }
  }

  if (kind === 'partner') {
    const myListingIds = new Set(
      [...db.restaurants, ...db.hotels].filter((l) => l.ownerId === id).map((l) => l.id)
    );
    if (db.bookings.some((b) => myListingIds.has(b.hotelId) && bookingActive(b))) {
      blockers.push('your hotel has upcoming guest bookings — honour or cancel them first');
    }
    if (db.orders.some((o) => myListingIds.has(o.restaurantId) && orderActive(o))) {
      blockers.push('your restaurant has orders being delivered — wait for them to finish');
    }
    if ((entity.earnings || 0) > 0) {
      blockers.push(`withdraw your Rs ${entity.earnings} earnings first so you do not lose them`);
    }
  }

  return blockers;
}

const TOKEN_MAPS = { user: 'tokens', driver: 'driverTokens', partner: 'partnerTokens' };

function revokeSessions(kind, ownerId) {
  const map = db[TOKEN_MAPS[kind]] || {};
  for (const [token, rec] of Object.entries(map)) {
    const owner = typeof rec === 'string' ? rec : rec && rec.id;
    if (owner === ownerId) delete map[token];
  }
}

// Blank every personal field but keep the row so historical rides, orders and
// ledger entries other people are part of stay consistent.
function anonymize(kind, entity) {
  entity.name = 'Deleted account';
  entity.email = `deleted-${entity.id}@deleted.sewago.local`;
  entity.phone = '';
  entity.phoneVerified = false;
  entity.password = hashPassword(crypto.randomBytes(24).toString('hex'));
  entity.deletedAt = Date.now();

  if (kind === 'user') {
    entity.wallet = 0;
  }
  if (kind === 'driver') {
    entity.online = false;
    entity.earnings = 0;
    delete entity.lat;
    delete entity.lng;
    delete entity.locationAt;
    if (entity.kyc) entity.kyc = { licenseLast4: '', vehicle: '', plate: '', submittedAt: null, reviewedAt: null, note: '' };
    entity.licenseLast4 = '';
    entity.vehicle = 'Removed';
    entity.plate = '';
  }
  if (kind === 'partner') {
    entity.earnings = 0;
    if (entity.businessKyc) {
      entity.businessKyc = { legalName: '', regNo: '', documentRef: '', submittedAt: null, reviewedAt: null, note: '' };
    }
    entity.regNo = '';
    // Take their listings off the marketplace for good.
    for (const listing of [...db.restaurants, ...db.hotels]) {
      if (listing.ownerId === entity.id && listing.status !== 'removed') {
        listing.status = 'removed';
        listing.reviewNote = 'Owner account deleted.';
      }
    }
  }

  // Drop anything that could still authenticate or re-identify the account.
  revokeSessions(kind, entity.id);
  db.otpCodes = (db.otpCodes || []).filter((o) => !(o.ownerKind === kind && o.ownerId === entity.id));
  db.passwordResetTokens = (db.passwordResetTokens || []).filter(
    (r) => !(r.ownerKind === kind && r.ownerId === entity.id)
  );
}

function deleteAccount(kind, entity, { ip = null } = {}) {
  const blockers = deletionBlockers(kind, entity);
  if (blockers.length) return { error: `Cannot delete the account yet: ${blockers[0]}.`, blockers };
  const forfeited = kind === 'user' ? entity.wallet : 0;
  anonymize(kind, entity);
  logAudit({
    actor: `${kind}:${entity.id}`,
    action: 'account_deleted',
    targetType: kind,
    targetId: entity.id,
    meta: { forfeitedWallet: forfeited },
    ip
  });
  return { ok: true };
}

module.exports = { deleteAccount, deletionBlockers };
