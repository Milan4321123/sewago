const express = require('express');
const crypto = require('crypto');
const { db, save } = require('../db');
const sessionTokens = require('../sessionTokens');
const metrics = require('../metrics');
const { payoutFor, withStatus, driverIsAvailable, driverHasFreshLocation, driverLocation } = require('../rideLogic');
const { recordTxn, recordPlatformRevenue, platformRevenueTotals, WITHDRAW_CHANNELS } = require('../payments');
const events = require('../events');
const { logAudit } = require('../audit');

const router = express.Router();

// Actor identity for the audit trail (single staff account for now).
function adminActor() {
  return { role: 'admin', id: 'admin', email: ADMIN_EMAIL };
}

// Platform staff credentials come from the environment in production.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@sewago.app').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function authAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (sessionTokens.tokenOwner(db.adminTokens, token) !== 'admin') {
    return res.status(401).json({ error: 'Admin session expired — please log in again.' });
  }
  next();
}

function partnerInfo(ownerId) {
  const p = db.partners.find((x) => x.id === ownerId);
  return p
    ? {
      name: p.name,
      email: p.email,
      phone: p.phone || '—',
      phoneVerified: !!p.phoneVerified,
      regNo: p.regNo || '—',
      businessKycStatus: p.businessKycStatus || 'pending',
      businessKycDocumentRef: p.businessKyc && p.businessKyc.documentRef ? p.businessKyc.documentRef : '—'
    }
    : { name: 'SewaGo (seeded)', email: '—', phone: '—', regNo: '—' };
}

router.post('/admin/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!safeEqual(String(email || '').toLowerCase(), ADMIN_EMAIL) || !safeEqual(String(password || ''), ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Wrong admin credentials.' });
  }
  const token = sessionTokens.issueToken(db.adminTokens, 'admin');
  save();
  res.json({ token });
});

router.post('/admin/logout', authAdmin, (req, res) => {
  const header = req.headers.authorization || '';
  delete db.adminTokens[header.slice(7)];
  save();
  res.json({ ok: true });
});

router.get('/admin/overview', authAdmin, (req, res) => {
  const completedRides = db.rides.filter((r) => r.status === 'completed');
  const rideCommission = completedRides.reduce((sum, r) => sum + (r.fare - (r.payout ?? payoutFor(r))), 0);
  const taskFees = db.tasks.filter((t) => t.status === 'completed').reduce((sum, t) => sum + t.fee, 0);
  const withdrawalFees = db.withdrawals.filter((w) => w.status !== 'rejected').reduce((sum, w) => sum + w.fee, 0);
  // Commission on partner-owned listings (seeded demo listings have no partner to pay).
  // Service fees and courier payouts have their own lines, so the commission
  // here is what's left of the order after the partner, fees, and the courier.
  const foodCommission = db.orders
    .filter((o) => o.partnerCut && o.status !== 'cancelled')
    .reduce((sum, o) => sum + (o.total - o.partnerCut - (o.serviceFee || 0) - (o.courierPayout || 0)), 0);
  const stayCommission = db.bookings
    .filter((b) => b.partnerCut && b.status !== 'cancelled')
    .reduce((sum, b) => sum + (b.total - b.partnerCut), 0);
  // Per-booking service fees are earned unless the booking was cancelled
  // (cancellation reverses them); late-cancel fees keep only the platform half.
  const serviceFees =
    db.rides.filter((r) => r.status !== 'cancelled').reduce((sum, r) => sum + (r.serviceFee || 0), 0) +
    db.orders.filter((o) => o.status !== 'cancelled').reduce((sum, o) => sum + (o.serviceFee || 0), 0);
  const cancelFees = db.rides.reduce((sum, r) => sum + (r.cancelFeePlatform || 0), 0);
  // Featured-placement purchases live only in the platform ledger.
  const promotionFees = db.platformLedger
    .filter((e) => e.source === 'promotion_fee')
    .reduce((sum, e) => sum + e.amount, 0);
  const count = (arr, fn) => arr.filter(fn).length;
  res.json({
    stats: {
      users: db.users.length,
      drivers: db.drivers.length,
      driversOnline: count(db.drivers, (d) => d.online),
      partners: db.partners.length,
      restaurantsLive: count(db.restaurants, (r) => r.status === 'approved'),
      restaurantsPending: count(db.restaurants, (r) => r.status === 'pending'),
      hotelsLive: count(db.hotels, (h) => h.status === 'approved'),
      hotelsPending: count(db.hotels, (h) => h.status === 'pending'),
      rides: db.rides.length,
      ridesCompleted: completedRides.length,
      orders: db.orders.length,
      bookings: db.bookings.length,
      tasksOpen: count(db.tasks, (t) => t.status === 'open'),
      tasksActive: count(db.tasks, (t) => t.status === 'assigned' || t.status === 'done'),
      tasksCompleted: count(db.tasks, (t) => t.status === 'completed'),
      revenue: rideCommission + taskFees + withdrawalFees + foodCommission + stayCommission + serviceFees + cancelFees + promotionFees,
      rideCommission,
      taskFees,
      withdrawalFees,
      foodCommission,
      stayCommission,
      serviceFees,
      cancelFees,
      promotionFees,
      withdrawalsPending: count(db.withdrawals, (w) => w.status === 'processing')
    }
  });
});

// Ops view: process health + request/error counters since last restart.
router.get('/admin/metrics', authAdmin, (req, res) => {
  res.json({
    process: metrics.snapshot(),
    state: {
      users: db.users.length,
      rides: db.rides.length,
      orders: db.orders.length,
      bookings: db.bookings.length,
      tasks: db.tasks.length,
      transactions: db.transactions.length,
      platformLedger: db.platformLedger.length,
      sessions: Object.keys(db.tokens).length + Object.keys(db.driverTokens).length +
        Object.keys(db.partnerTokens).length + Object.keys(db.adminTokens).length
    }
  });
});

// Live operations / dispatch view: what is happening on the platform right now.
// Auto-refreshed by the admin UI so staff can watch rides, drivers and orders.
router.get('/admin/live', authAdmin, (req, res) => {
  const now = Date.now();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dayStart = startOfDay.getTime();
  const since = (ts) => ts && ts >= dayStart;

  const liveRides = db.rides.map(withStatus);
  const activeRides = liveRides
    .filter((r) => r.status === 'searching' || r.status === 'driver_en_route' || r.status === 'in_progress')
    .map((r) => ({
      id: r.id,
      status: r.status,
      mode: r.mode,
      customer: r.customerName,
      driver: r.driver ? r.driver.name : null,
      tier: r.tierLabel || r.tier,
      icon: r.icon || '🚗',
      pickup: r.pickup,
      dropoff: r.dropoff,
      fare: r.fare,
      distanceKm: r.distanceKm,
      payment: r.payment,
      driverEtaMin: r.driverEtaMin || null,
      waitingSec: Math.round((now - r.createdAt) / 1000),
      // Coordinates so the admin can plot the ride on the live map.
      pickupLoc: r.pickupLoc || null,
      dropoffLoc: r.dropoffLoc || null,
      driverCoords: r.driverCoords || null
    }))
    .sort((a, b) => b.waitingSec - a.waitingSec);

  const drivers = db.drivers
    .filter((d) => d.online)
    .map((d) => {
      const loc = driverLocation(d); // fresh GPS, else base location, else null
      return {
        id: d.id,
        name: d.name,
        tier: d.tier,
        plate: d.plate,
        rating: d.rating,
        verified: d.licenseVerified === true || d.verificationStatus === 'verified',
        hasFreshLocation: driverHasFreshLocation(d),
        available: driverIsAvailable(d),
        onTrip: liveRides.some((r) => r.driverId === d.id &&
          (r.status === 'driver_en_route' || r.status === 'in_progress')),
        lat: loc ? loc.lat : null,
        lng: loc ? loc.lng : null
      };
    })
    .sort((a, b) => Number(b.available) - Number(a.available));

  const recentOrders = db.orders
    .slice(-12).reverse()
    .map((o) => ({ id: o.id, customer: o.customerName, restaurant: o.restaurantName, total: o.total, status: o.status, createdAt: o.createdAt }));
  const recentBookings = db.bookings
    .slice(-12).reverse()
    .map((b) => ({ id: b.id, customer: b.customerName, hotel: b.hotelName, nights: b.nights, total: b.total, status: b.status, createdAt: b.createdAt }));

  const completedToday = db.rides.filter((r) => r.status === 'completed' && since(r.completedAt));
  const ridesRevenueToday = completedToday.reduce((s, r) => s + (r.fare - (r.payout ?? payoutFor(r))), 0);

  res.json({
    serverTime: new Date(now).toISOString(),
    kpis: {
      activeRides: activeRides.length,
      driversOnline: drivers.length,
      driversAvailable: drivers.filter((d) => d.available).length,
      ridesToday: db.rides.filter((r) => since(r.createdAt)).length,
      ridesCompletedToday: completedToday.length,
      ordersToday: db.orders.filter((o) => since(o.createdAt)).length,
      bookingsToday: db.bookings.filter((b) => since(b.createdAt)).length,
      newUsersToday: db.users.filter((u) => since(u.createdAt)).length,
      rideRevenueToday: ridesRevenueToday
    },
    activeRides,
    drivers,
    recentOrders,
    recentBookings
  });
});

router.get('/admin/payments', authAdmin, (req, res) => {
  const pendingWithdrawals = db.withdrawals
    .filter((w) => w.status === 'processing')
    .map((w) => ({ ...w, channelLabel: WITHDRAW_CHANNELS[w.channel] || w.channel }));
  res.json({
    pendingWithdrawals,
    stats: {
      topupVolume: db.payments.filter((p) => p.status === 'succeeded').reduce((s, p) => s + p.amount, 0),
      topupCount: db.payments.filter((p) => p.status === 'succeeded').length,
      withdrawalsPaid: db.withdrawals.filter((w) => w.status === 'paid').reduce((s, w) => s + w.amount, 0),
      withdrawalFees: db.withdrawals.filter((w) => w.status !== 'rejected').reduce((s, w) => s + w.fee, 0),
      transactions: db.transactions.length
    },
    // Audit trail of everything SewaGo has earned (negative = reversal).
    revenue: platformRevenueTotals(),
    ledger: db.platformLedger.slice(-50).reverse()
  });
});

router.post('/admin/withdrawals/:id/:action(approve|reject)', authAdmin, (req, res) => {
  const withdrawal = db.withdrawals.find((w) => w.id === req.params.id);
  if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found.' });
  if (withdrawal.status !== 'processing') return res.status(400).json({ error: 'This withdrawal was already processed.' });
  if (req.params.action === 'approve') {
    withdrawal.status = 'paid';
    withdrawal.paidAt = Date.now();
  } else {
    withdrawal.status = 'rejected';
    withdrawal.rejectedAt = Date.now();
    withdrawal.note = String((req.body || {}).note || '').slice(0, 200);
    const owner = withdrawal.ownerKind === 'driver'
      ? db.drivers.find((d) => d.id === withdrawal.ownerId)
      : withdrawal.ownerKind === 'partner'
        ? db.partners.find((p) => p.id === withdrawal.ownerId)
        : db.users.find((u) => u.id === withdrawal.ownerId);
    if (owner) {
      const total = withdrawal.amount + withdrawal.fee;
      if (withdrawal.ownerKind === 'user') owner.wallet += total;
      else owner.earnings = (owner.earnings || 0) + total;
      recordTxn(withdrawal.ownerKind, owner, {
        type: 'withdrawal_refund',
        label: 'Withdrawal rejected — amount returned',
        amount: total,
        sign: 1,
        refId: withdrawal.id
      });
    }
    recordPlatformRevenue({
      source: 'withdraw_fee',
      label: `Withdrawal rejected — fee reversed (${withdrawal.ownerName})`,
      amount: -withdrawal.fee,
      refId: withdrawal.id
    });
  }
  save();
  logAudit({
    actor: adminActor(),
    action: `withdrawal_${req.params.action}`,
    targetType: 'withdrawal',
    targetId: withdrawal.id,
    meta: { ownerKind: withdrawal.ownerKind, ownerId: withdrawal.ownerId, amount: withdrawal.amount, channel: withdrawal.channel },
    ip: req.ip
  });
  // Nudge the owner's app so the decision shows up instantly (topic only — the
  // client refetches its own data; no amounts ride the stream).
  events.publish(`${withdrawal.ownerKind}:${withdrawal.ownerId}`, {
    topic: 'wallet',
    event: req.params.action === 'approve' ? 'withdrawal_paid' : 'withdrawal_rejected'
  });
  res.json({ withdrawal });
});

router.get('/admin/queue', authAdmin, (req, res) => {
  const restaurants = db.restaurants
    .filter((r) => r.status === 'pending')
    .map((r) => ({ ...r, partner: partnerInfo(r.ownerId) }));
  const hotels = db.hotels
    .filter((h) => h.status === 'pending')
    .map((h) => ({ ...h, partner: partnerInfo(h.ownerId) }));
  res.json({ restaurants, hotels });
});

router.get('/admin/partners', authAdmin, (req, res) => {
  const partners = db.partners.map((p) => ({
    id: p.id,
    name: p.name,
    email: p.email,
    phone: p.phone || '—',
    phoneVerified: !!p.phoneVerified,
    regNo: p.regNo || '—',
    businessKycStatus: p.businessKycStatus || 'pending',
    businessKycDocumentRef: p.businessKyc && p.businessKyc.documentRef ? p.businessKyc.documentRef : '—',
    businessKycNote: p.businessKyc && p.businessKyc.note ? p.businessKyc.note : '',
    restaurants: db.restaurants.filter((r) => r.ownerId === p.id).length,
    hotels: db.hotels.filter((h) => h.ownerId === p.id).length
  }));
  res.json({ partners });
});

router.post('/admin/partners/:id/kyc/:action(approve|reject)', authAdmin, (req, res) => {
  const partner = db.partners.find((p) => p.id === req.params.id);
  if (!partner) return res.status(404).json({ error: 'Partner not found.' });
  if (!partner.businessKyc) {
    return res.status(400).json({ error: 'Partner has not submitted business KYC.' });
  }
  if (req.params.action === 'approve') {
    if (!partner.phoneVerified) {
      return res.status(400).json({ error: 'Phone must be verified before approving business KYC.' });
    }
    partner.businessKycStatus = 'approved';
    partner.businessKyc.note = '';
  } else {
    const note = String((req.body || {}).note || '').trim();
    if (!note) return res.status(400).json({ error: 'Add a rejection note.' });
    partner.businessKycStatus = 'rejected';
    partner.businessKyc.note = note.slice(0, 300);
  }
  partner.businessKyc.reviewedAt = Date.now();
  save();
  logAudit({
    actor: adminActor(),
    action: `partner_kyc_${req.params.action}`,
    targetType: 'partner',
    targetId: partner.id,
    meta: { regNo: partner.regNo || '' },
    ip: req.ip
  });
  // Tell the partner portal the review landed; it refetches and notifies.
  events.publish(`partner:${partner.id}`, { topic: 'kyc' });
  res.json({ partner });
});

function reviewListing(collection, id, action, note) {
  const listing = collection.find((x) => x.id === id);
  if (!listing) return { error: 'Listing not found.', code: 404 };
  if (listing.status !== 'pending') return { error: 'This listing is not awaiting review.', code: 400 };
  listing.status = action === 'approve' ? 'approved' : 'rejected';
  listing.reviewNote = action === 'approve'
    ? ''
    : String(note || 'Does not meet our listing requirements.').slice(0, 300);
  listing.reviewedAt = Date.now();
  save();
  return { listing };
}

router.post('/admin/restaurants/:id/:action(approve|reject)', authAdmin, (req, res) => {
  const result = reviewListing(db.restaurants, req.params.id, req.params.action, (req.body || {}).note);
  if (result.error) return res.status(result.code).json({ error: result.error });
  res.json({ restaurant: result.listing });
});

router.post('/admin/hotels/:id/:action(approve|reject)', authAdmin, (req, res) => {
  const result = reviewListing(db.hotels, req.params.id, req.params.action, (req.body || {}).note);
  if (result.error) return res.status(result.code).json({ error: result.error });
  res.json({ hotel: result.listing });
});

module.exports = router;
