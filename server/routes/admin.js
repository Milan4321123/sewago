const express = require('express');
const crypto = require('crypto');
const { db, save } = require('../db');
const sessionTokens = require('../sessionTokens');
const metrics = require('../metrics');
const { payoutFor, withStatus, driverIsAvailable, driverHasFreshLocation, driverLocation } = require('../rideLogic');
const { recordTxn, recordPlatformRevenue, platformRevenueTotals, creditWallet, WITHDRAW_CHANNELS } = require('../payments');
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
  // REVENUE COMES FROM THE LEDGER, NOT A RECOMPUTE. The append-only platform
  // ledger is the single source of truth: every rupee SewaGo earns is written
  // there when the money actually moves (and reversed on refunds). Deriving the
  // dashboard from booking rows instead would drift the moment any commission
  // path changes — and would, for example, count a cash-on-delivery order's
  // commission before the courier has collected a single rupee.
  const led = platformRevenueTotals();
  const ledger = (source) => led[source] || 0;
  const rideCommission = ledger('ride_commission');
  const taskFees = ledger('task_fee');
  const withdrawalFees = ledger('withdraw_fee');
  const foodCommission = ledger('food_commission');
  const stayCommission = ledger('stay_commission');
  const serviceFees = ledger('service_fee');
  const cancelFees = ledger('cancel_fee');
  const promotionFees = ledger('promotion_fee');
  const courierPayouts = ledger('courier_payout'); // negative: a cost, not income

  // Independent cross-check recomputed from the booking rows. It should track
  // the ledger; any gap means a money path wrote one but not the other, so the
  // drift is surfaced to staff instead of silently corrupting the books.
  const derivedTotal =
    completedRides.reduce((sum, r) => sum + (r.fare - (r.payout ?? payoutFor(r))), 0) +
    db.tasks.filter((t) => t.status === 'completed').reduce((sum, t) => sum + t.fee, 0) +
    db.withdrawals.filter((w) => w.status !== 'rejected').reduce((sum, w) => sum + w.fee, 0) +
    db.orders
      .filter((o) => o.partnerCut && o.status === 'delivered')
      .reduce((sum, o) => sum + (o.total - o.partnerCut - (o.serviceFee || 0) - (o.courierPayout || 0)), 0) +
    db.bookings
      .filter((b) => b.partnerCut && b.status !== 'cancelled')
      .reduce((sum, b) => sum + (b.total - b.partnerCut), 0) +
    db.rides.filter((r) => r.status !== 'cancelled').reduce((sum, r) => sum + (r.serviceFee || 0), 0) +
    db.orders.filter((o) => o.status === 'delivered').reduce((sum, o) => sum + (o.serviceFee || 0), 0) +
    db.rides.reduce((sum, r) => sum + (r.cancelFeePlatform || 0), 0) +
    promotionFees;

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
      revenue: led.total,
      rideCommission,
      taskFees,
      withdrawalFees,
      foodCommission,
      stayCommission,
      serviceFees,
      cancelFees,
      promotionFees,
      courierPayouts,
      withdrawalsPending: count(db.withdrawals, (w) => w.status === 'processing')
    },
    // Ledger vs. independently-recomputed revenue. drift must be 0; anything
    // else means a money path updated one and not the other.
    reconciliation: {
      ledgerTotal: led.total,
      derivedTotal,
      drift: led.total - derivedTotal
    },
    revenueTrend: revenueTrend(14)
  });
});

// Daily platform revenue + completed rides for the last N days (ledger-driven),
// oldest day first — feeds the Overview trend chart.
function revenueTrend(days) {
  const out = [];
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const from = startOfToday - i * dayMs;
    out.push({ day: new Date(from).toISOString().slice(0, 10), from, to: from + dayMs, revenue: 0, rides: 0 });
  }
  const first = out[0].from;
  for (const e of db.platformLedger) {
    if (e.createdAt < first) continue;
    const bucket = out[Math.min(out.length - 1, Math.floor((e.createdAt - first) / dayMs))];
    if (bucket) bucket.revenue += e.amount;
  }
  for (const r of db.rides) {
    if (r.status !== 'completed' || !r.completedAt || r.completedAt < first) continue;
    const bucket = out[Math.min(out.length - 1, Math.floor((r.completedAt - first) / dayMs))];
    if (bucket) bucket.rides += 1;
  }
  return out.map(({ day, revenue, rides }) => ({ day, revenue, rides }));
}

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
    // Defense in depth: never disburse if the requester's balance has since gone
    // negative (a reversal clawed the held funds back). Reject and refund so the
    // platform never pays out money it no longer holds.
    const owner = withdrawal.ownerKind === 'driver'
      ? db.drivers.find((d) => d.id === withdrawal.ownerId)
      : withdrawal.ownerKind === 'partner'
        ? db.partners.find((p) => p.id === withdrawal.ownerId)
        : db.users.find((u) => u.id === withdrawal.ownerId);
    const balance = owner ? (withdrawal.ownerKind === 'user' ? owner.wallet : (owner.earnings || 0)) : 0;
    if (!owner || balance < 0) {
      return res.status(409).json({ error: 'Cannot pay out: the account balance no longer backs this withdrawal. Reject it to refund and investigate.' });
    }
    withdrawal.status = 'paid';
    withdrawal.paidAt = Date.now();
    // Record who to actually send the money to and that it awaits real transfer.
    withdrawal.disbursedRef = String((req.body || {}).payoutRef || '').slice(0, 80) || null;
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
      if (withdrawal.ownerKind === 'user') creditWallet(owner, total);
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
  const stores = db.stores
    .filter((s) => s.status === 'pending')
    .map((s) => ({
      id: s.id, name: s.name, area: s.area, icon: s.icon, photo: s.photo,
      itemCount: s.items.length, submittedAt: s.submittedAt,
      partner: partnerInfo(s.ownerId)
    }));
  res.json({ restaurants, hotels, stores });
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

router.post('/admin/stores/:id/:action(approve|reject)', authAdmin, (req, res) => {
  const result = reviewListing(db.stores, req.params.id, req.params.action, (req.body || {}).note);
  if (result.error) return res.status(result.code).json({ error: result.error });
  // Approval is what puts a shop into the customer-facing search and map.
  require('../storeSearch').indexStore(result.listing);
  logAudit({
    actor: adminActor(),
    action: `stores.${req.params.action}`,
    targetType: 'store',
    targetId: result.listing.id,
    meta: { note: result.listing.reviewNote },
    ip: req.ip
  });
  events.publish(`partner:${result.listing.ownerId}`, { topic: 'stores' });
  res.json({ store: result.listing });
});

/* ---------------- people: customer + driver ops ---------------- */

function matchesQuery(q, ...fields) {
  return fields.some((f) => f && String(f).toLowerCase().includes(q));
}

function adminUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone || '—',
    phoneVerified: !!u.phoneVerified,
    wallet: u.wallet,
    suspended: !!u.suspended,
    joined: u.createdAt || null
  };
}

function adminDriver(d) {
  return {
    id: d.id,
    name: d.name,
    email: d.email,
    phone: d.phone || '—',
    tier: d.tier,
    vehicle: d.vehicle,
    plate: d.plate,
    rating: d.rating,
    online: !!d.online,
    locationFresh: driverHasFreshLocation(d),
    verificationStatus: d.verificationStatus || (d.licenseVerified ? 'verified' : 'pending'),
    earnings: d.earnings || 0,
    commissionOwed: Math.max(0, -(d.earnings || 0)),
    tripsCompleted: d.tripsCompleted || 0,
    // Riders who accepted a delivery run and then went dark. Staff need to see
    // the repeat offenders — the system only benches them for a cooling-off
    // period, it does not judge them.
    runNoShows: d.runNoShows || 0,
    benchedUntil: d.runNoShowUntil && d.runNoShowUntil > Date.now() ? d.runNoShowUntil : null,
    suspended: !!d.suspended
  };
}

// Support lookup: search customers and drivers by name / email / phone.
// Without a query, returns the most recent signups so the tab is never blank.
router.get('/admin/people', authAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const pick = (arr) => {
    if (!q) return arr.slice(-20).reverse();
    const out = [];
    for (let i = arr.length - 1; i >= 0 && out.length < 20; i--) {
      const p = arr[i];
      if (matchesQuery(q, p.name, p.email, p.phone, p.plate)) out.push(p);
    }
    return out;
  };
  res.json({
    users: pick(db.users).map(adminUser),
    drivers: pick(db.drivers).map(adminDriver)
  });
});

// Suspend / reinstate a customer or driver. Suspended accounts cannot log in
// or act; suspended drivers also drop out of dispatch immediately.
router.post('/admin/:kind(users|drivers)/:id/:action(suspend|unsuspend)', authAdmin, (req, res) => {
  const list = req.params.kind === 'users' ? db.users : db.drivers;
  const person = list.find((p) => p.id === req.params.id);
  if (!person) return res.status(404).json({ error: 'Account not found.' });
  person.suspended = req.params.action === 'suspend';
  person.suspendedAt = person.suspended ? Date.now() : null;
  person.suspendNote = person.suspended ? String((req.body || {}).note || '').slice(0, 200) : '';
  logAudit({
    actor: adminActor(),
    action: `${req.params.kind}.${req.params.action}`,
    targetType: req.params.kind === 'users' ? 'user' : 'driver',
    targetId: person.id,
    meta: { note: person.suspendNote },
    ip: req.ip
  });
  save();
  res.json(req.params.kind === 'users' ? { user: adminUser(person) } : { driver: adminDriver(person) });
});

// Manually approve / reject a driver's license verification.
router.post('/admin/drivers/:id/verification/:action(approve|reject)', authAdmin, (req, res) => {
  const driver = db.drivers.find((d) => d.id === req.params.id);
  if (!driver) return res.status(404).json({ error: 'Driver not found.' });
  const approve = req.params.action === 'approve';
  driver.licenseVerified = approve;
  driver.verificationStatus = approve ? 'verified' : 'rejected';
  driver.verificationNote = String((req.body || {}).note || '').slice(0, 200);
  if (approve) driver.licenseVerifiedAt = Date.now();
  logAudit({
    actor: adminActor(),
    action: `drivers.verification.${req.params.action}`,
    targetType: 'driver',
    targetId: driver.id,
    meta: { note: driver.verificationNote },
    ip: req.ip
  });
  save();
  res.json({ driver: adminDriver(driver) });
});

// Record a cash commission settlement collected from a driver in person. This
// is how the platform ACTUALLY collects cash-trip commission: the driver hands
// over the owed amount at a SewaGo point, staff record it here, it pays down the
// driver's negative earnings and books the collection so revenue is real, not a
// phantom receivable. Never credits above zero (that would be a payout, not a
// settlement).
router.post('/admin/drivers/:id/settle-cash', authAdmin, (req, res) => {
  const driver = db.drivers.find((d) => d.id === req.params.id);
  if (!driver) return res.status(404).json({ error: 'Driver not found.' });
  const owed = Math.max(0, -(driver.earnings || 0));
  if (owed <= 0) return res.status(400).json({ error: 'This driver owes no cash commission.' });
  // Omitting the amount means "settle it all". But a MALFORMED amount (a typo,
  // zero, negative) must be rejected — silently falling back to the full amount
  // would write off the entire receivable on a slip of the keyboard.
  const raw = (req.body || {}).amount;
  const omitted = raw === undefined || raw === null || raw === '';
  let amount;
  if (omitted) {
    amount = owed;
  } else {
    const requested = Number(raw);
    if (!Number.isFinite(requested) || requested <= 0) {
      return res.status(400).json({ error: 'Enter a positive amount of cash collected, or leave it blank to settle the full balance.' });
    }
    amount = Math.min(Math.round(requested), owed); // never credit past zero
  }
  driver.earnings = (driver.earnings || 0) + amount;
  recordTxn('driver', driver, {
    type: 'cash_settlement',
    label: `Cash commission settled at SewaGo point`,
    amount,
    sign: 1,
    refId: null
  });
  logAudit({
    actor: adminActor(),
    action: 'drivers.settle_cash',
    targetType: 'driver',
    targetId: driver.id,
    meta: { amount, owedBefore: owed, owedAfter: Math.max(0, -driver.earnings) },
    ip: req.ip
  });
  save();
  res.json({ driver: adminDriver(driver), settled: amount });
});

// Support wallet adjustment (goodwill credit / correction debit). Guard-railed:
// bounded amount, mandatory reason, never below zero, fully audit-trailed.
router.post('/admin/wallet-adjust', authAdmin, (req, res) => {
  const { userId, amount, reason } = req.body || {};
  const amt = Math.round(Number(amount));
  const why = String(reason || '').trim();
  if (!Number.isFinite(amt) || amt === 0 || Math.abs(amt) > 10000) {
    return res.status(400).json({ error: 'Amount must be between Rs -10,000 and Rs 10,000 (not zero).' });
  }
  if (why.length < 5) return res.status(400).json({ error: 'A reason (min 5 characters) is required — it goes on the audit trail.' });
  const user = db.users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Customer not found.' });
  if (user.wallet + amt < 0) {
    return res.status(400).json({ error: `Debit too large — the wallet only has Rs ${user.wallet}.` });
  }
  user.wallet += amt;
  recordTxn('user', user, {
    type: 'adjustment',
    label: amt > 0 ? `SewaGo support credit: ${why}` : `SewaGo support correction: ${why}`,
    amount: Math.abs(amt),
    sign: amt > 0 ? 1 : -1,
    refId: null
  });
  logAudit({
    actor: adminActor(),
    action: 'users.wallet_adjust',
    targetType: 'user',
    targetId: user.id,
    meta: { amount: amt, reason: why },
    ip: req.ip
  });
  save();
  res.json({ user: adminUser(user) });
});

module.exports = router;
