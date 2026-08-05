const express = require('express');
const crypto = require('crypto');
const { db, save, uid } = require('../db');
const sessionTokens = require('../sessionTokens');
const events = require('../events');
const { hashPassword, verifyPassword } = require('../passwords');
const {
  withStatus,
  driverPublic,
  payoutFor,
  etaToPickupMin,
  driverIsVerified,
  driverHasFreshLocation,
  driverLocation,
  driverIsAvailable,
  driverNearPickup,
  driverOwesTooMuch,
  cashHeadroom,
  cashJobFitsFloat
} = require('../rideLogic');

// Net cash a courier ends up owing SewaGo after a COD delivery: they collect the
// whole total at the door and keep their delivery payout.
function codDebtFor(order) {
  return order.payment === 'cash' ? order.total - courierPayoutFor(order) : 0;
}
const { PLACES, haversineKm } = require('../places');
const { recordTxn, recordPlatformRevenue, createWithdrawal } = require('../payments');
const { deleteAccount } = require('../accountDeletion');
const {
  withStatus: orderWithStatus,
  currentDelivery,
  courierPayoutFor
} = require('../orderLogic');
const dispatch = require('../dispatch');
const {
  normalizePhone,
  validPhone,
  requestPhoneOtp,
  verifyPhoneOtp,
  requestLoginOtp,
  verifyLoginOtp,
  requestPasswordReset,
  resetPassword
} = require('../accountSecurity');

const router = express.Router();

const TIER_LABELS = { bike: 'Bike', car: 'Car', xl: 'XL' };
const LICENSE_DEMO_CODE = process.env.DRIVER_LICENSE_DEMO_CODE || '123456';

function normalizePlate(plate) {
  return String(plate || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function normalizeLicenseId(licenseId) {
  return String(licenseId || '').toUpperCase().replace(/[\s_]/g, '').trim();
}

function licenseHash(licenseId) {
  return crypto.createHash('sha256').update(normalizeLicenseId(licenseId)).digest('hex');
}

function licenseLast4(licenseId) {
  const normalized = normalizeLicenseId(licenseId);
  return normalized.slice(-4);
}

function profile(d) {
  const locationFresh = driverHasFreshLocation(d);
  return {
    id: d.id,
    name: d.name,
    email: d.email,
    tier: d.tier,
    vehicle: d.vehicle,
    plate: d.plate,
    phone: d.phone || '',
    phoneVerified: !!d.phoneVerified,
    rating: d.rating,
    online: driverIsAvailable(d),
    verificationStatus: d.verificationStatus || (d.licenseVerified ? 'verified' : 'pending'),
    licenseVerified: driverIsVerified(d),
    licenseLast4: d.licenseLast4 || '',
    kycStatus: d.kycStatus || (d.licenseVerified ? 'approved' : 'pending'),
    kycNote: d.kyc && d.kyc.note ? d.kyc.note : '',
    locationFresh,
    locationUpdatedAt: d.locationUpdatedAt || null,
    locationAccuracy: d.locationAccuracy || null,
    // The driver's own last-sent coordinates, so the app can show that the
    // GPS feed really is being received and where the server thinks they are.
    currentLat: Number.isFinite(d.currentLat) ? d.currentLat : null,
    currentLng: Number.isFinite(d.currentLng) ? d.currentLng : null,
    earnings: d.earnings || 0,
    // Cash-trip commission the driver owes SewaGo (0 unless earnings is negative),
    // and whether they've hit the settle-before-driving limit.
    commissionOwed: Math.max(0, -(d.earnings || 0)),
    mustSettle: driverOwesTooMuch(d),
    tripsCompleted: d.tripsCompleted || 0
  };
}

function authDriver(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const driverId = sessionTokens.tokenOwner(db.driverTokens, token);
  const driver = driverId && db.drivers.find((d) => d.id === driverId);
  if (!driver) return res.status(401).json({ error: 'Please log in again.' });
  if (driver.suspended) {
    return res.status(403).json({ error: 'Your driver account is suspended — contact SewaGo support.' });
  }
  req.driver = driver;
  next();
}

function issueToken(driverId) {
  return sessionTokens.issueToken(db.driverTokens, driverId);
}

function currentJob(driverId) {
  for (const ride of db.rides) {
    if (ride.driverId !== driverId) continue;
    const current = withStatus(ride);
    if (current.status === 'driver_en_route' || current.status === 'in_progress') {
      return { ...current, payout: payoutFor(ride) };
    }
  }
  return null;
}

router.post('/driver/login', (req, res) => {
  const { email, password } = req.body || {};
  const driver = db.drivers.find((d) => (d.email || '').toLowerCase() === String(email || '').toLowerCase());
  if (!driver || !verifyPassword(String(password || ''), driver.password)) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  if (driver.suspended) {
    return res.status(403).json({ error: 'Your driver account is suspended — contact SewaGo support.' });
  }
  const token = issueToken(driver.id);
  save();
  res.json({ token, driver: profile(driver) });
});

router.post('/driver/otp/request', async (req, res, next) => {
  try {
    const result = await requestLoginOtp('driver', (req.body || {}).phone);
    if (result.error) return res.status(400).json({ error: result.error });
    save();
    res.json({
      phone: result.phone,
      devCode: result.devCode,
      expiresAt: result.expiresAt,
      message: result.devCode ? 'Sandbox OTP generated.' : 'If that driver phone exists, a verification code was sent.'
    });
  } catch (err) {
    next(err);
  }
});

router.post('/driver/otp/verify', (req, res) => {
  const result = verifyLoginOtp('driver', (req.body || {}).phone, (req.body || {}).code);
  if (result.error) return res.status(400).json({ error: result.error });
  if (!result.entity) return res.status(401).json({ error: 'No driver account is registered for that phone.' });

  result.entity.phone = result.phone;
  result.entity.phoneVerified = true;
  result.entity.phoneVerifiedAt = Date.now();
  const token = issueToken(result.entity.id);
  save();
  res.json({ token, driver: profile(result.entity) });
});

// Self-service deletion (app-store requirement). Password-confirmed; earnings
// must be withdrawn and any active trip finished first.
router.post('/driver/account/delete', authDriver, (req, res) => {
  if (!verifyPassword(String((req.body || {}).password || ''), req.driver.password)) {
    return res.status(401).json({ error: 'Confirm with your password to delete the account.' });
  }
  const result = deleteAccount('driver', req.driver, { ip: req.ip });
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  res.json({ ok: true, message: 'Your account and personal data have been deleted.' });
});

router.post('/driver/password/request-reset', async (req, res, next) => {
  try {
    const result = await requestPasswordReset('driver', (req.body || {}).email);
    save();
    res.json({
      ok: true,
      devResetToken: result.devResetToken,
      expiresAt: result.expiresAt,
      message: result.devResetToken
        ? 'Sandbox reset token generated. In production this is sent by email.'
        : 'If an account exists, reset instructions were sent.'
    });
  } catch (err) {
    next(err);
  }
});

router.post('/driver/password/reset', (req, res) => {
  const result = resetPassword('driver', (req.body || {}).token, (req.body || {}).password);
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  res.json({ ok: true });
});

router.post('/driver/register', (req, res) => {
  const { name, email, password, phone, tier, vehicle, plate, licenseId, licenseCode } = req.body || {};
  const cleanPlate = normalizePlate(plate);
  const cleanLicenseId = normalizeLicenseId(licenseId);
  const cleanPhone = normalizePhone(phone);
  if (!name || !email || !password || !cleanPhone || !vehicle || !cleanPlate || !cleanLicenseId || !licenseCode) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (!validPhone(cleanPhone)) return res.status(400).json({ error: 'A valid phone number is required.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'That email does not look valid.' });
  if (!TIER_LABELS[tier]) return res.status(400).json({ error: 'Pick a valid vehicle type.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!/^[A-Z0-9 -]{4,20}$/.test(cleanPlate)) {
    return res.status(400).json({ error: 'Plate number must be 4-20 letters, numbers, spaces or dashes.' });
  }
  if (!/^[A-Z0-9-]{5,30}$/.test(cleanLicenseId)) {
    return res.status(400).json({ error: 'License ID must be 5-30 letters, numbers or dashes.' });
  }
  if (String(licenseCode).trim() !== LICENSE_DEMO_CODE) {
    return res.status(400).json({ error: 'License one-time verification code is invalid.' });
  }
  if (db.drivers.some((d) => (d.email || '').toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'A driver with that email already exists.' });
  }
  if (db.drivers.some((d) => normalizePhone(d.phone) === cleanPhone)) {
    return res.status(409).json({ error: 'A driver with that phone already exists.' });
  }
  if (db.drivers.some((d) => normalizePlate(d.plate) === cleanPlate)) {
    return res.status(409).json({ error: 'That plate number is already registered.' });
  }
  const hashedLicense = licenseHash(cleanLicenseId);
  if (db.drivers.some((d) => d.licenseHash && d.licenseHash === hashedLicense)) {
    return res.status(409).json({ error: 'That license ID is already registered.' });
  }
  // New drivers get a random real place in the valley as their base location.
  const base = PLACES[Math.floor(Math.random() * PLACES.length)];
  const driver = {
    id: uid(),
    name: name.trim(),
    email: email.trim(),
    phone: cleanPhone,
    phoneVerified: false,
    password: hashPassword(password),
    tier,
    vehicle: vehicle.trim(),
    plate: cleanPlate,
    licenseHash: hashedLicense,
    licenseLast4: licenseLast4(cleanLicenseId),
    licenseVerified: true,
    verificationStatus: 'verified',
    licenseVerifiedAt: Date.now(),
    kycStatus: 'approved',
    kyc: {
      licenseLast4: licenseLast4(cleanLicenseId),
      vehicle: vehicle.trim(),
      plate: cleanPlate,
      submittedAt: Date.now(),
      reviewedAt: Date.now(),
      note: ''
    },
    rating: 5.0,
    online: false,
    earnings: 0,
    tripsCompleted: 0,
    baseName: base.name,
    baseLat: base.lat,
    baseLng: base.lng
  };
  db.drivers.push(driver);
  const token = issueToken(driver.id);
  save();
  res.json({ token, driver: profile(driver) });
});

router.post('/driver/phone/request-otp', authDriver, async (req, res, next) => {
  try {
    const result = await requestPhoneOtp('driver', req.driver, (req.body || {}).phone);
    if (result.error) return res.status(400).json({ error: result.error });
    save();
    res.json({
      driver: profile(req.driver),
      devCode: result.devCode,
      expiresAt: result.expiresAt,
      message: result.devCode ? 'Sandbox OTP generated.' : 'Verification code sent.'
    });
  } catch (err) {
    next(err);
  }
});

router.post('/driver/phone/verify', authDriver, (req, res) => {
  const result = verifyPhoneOtp('driver', req.driver, (req.body || {}).code);
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  res.json({ driver: profile(req.driver) });
});

router.get('/driver/me', authDriver, (req, res) => {
  const history = db.rides
    .filter((r) => r.driverId === req.driver.id && r.status === 'completed')
    .slice(-5)
    .reverse()
    .map((r) => ({
      id: r.id,
      pickup: r.pickup,
      dropoff: r.dropoff,
      fare: r.fare,
      payout: r.payout ?? payoutFor(r),
      rating: r.rating,
      completedAt: r.completedAt
    }));
  res.json({
    driver: profile(req.driver),
    job: currentJob(req.driver.id),
    delivery: currentDelivery(req.driver.id),
    history
  });
});

router.post('/driver/location', authDriver, (req, res) => {
  const { lat, lng, accuracy } = req.body || {};
  const nextLat = Number(lat);
  const nextLng = Number(lng);
  const nextAccuracy = Number(accuracy);
  if (!Number.isFinite(nextLat) || !Number.isFinite(nextLng) || Math.abs(nextLat) > 90 || Math.abs(nextLng) > 180) {
    return res.status(400).json({ error: 'Valid latitude and longitude are required.' });
  }
  if (Number.isFinite(nextAccuracy) && nextAccuracy > 10000) {
    return res.status(400).json({ error: 'GPS accuracy is too low. Try again outside or near a window.' });
  }
  const loc = {
    lat: Math.round(nextLat * 1e6) / 1e6,
    lng: Math.round(nextLng * 1e6) / 1e6,
    accuracy: Number.isFinite(nextAccuracy) ? Math.round(nextAccuracy) : null,
    updatedAt: Date.now()
  };
  req.driver.currentLat = loc.lat;
  req.driver.currentLng = loc.lng;
  req.driver.locationAccuracy = loc.accuracy;
  req.driver.locationUpdatedAt = loc.updatedAt;

  const activeRide = db.rides.find((ride) => {
    if (ride.driverId !== req.driver.id) return false;
    const current = withStatus(ride);
    return current.status === 'driver_en_route' || current.status === 'in_progress';
  });
  if (activeRide) activeRide.driverLiveLoc = loc;

  save();
  res.json({ driver: profile(req.driver), job: currentJob(req.driver.id) });
});

router.post('/driver/online', authDriver, (req, res) => {
  const wantsOnline = !!(req.body || {}).online;
  if (wantsOnline && !driverIsVerified(req.driver)) {
    return res.status(403).json({ error: 'License verification is required before going online.' });
  }
  if (wantsOnline && !req.driver.phoneVerified) {
    return res.status(403).json({ error: 'Phone verification is required before going online.' });
  }
  if (wantsOnline && !driverHasFreshLocation(req.driver)) {
    return res.status(400).json({ error: 'Share your live GPS location before going online.' });
  }
  if (wantsOnline && driverOwesTooMuch(req.driver)) {
    return res.status(402).json({ error: `You owe Rs ${-req.driver.earnings} in cash-trip commission. Settle it at a SewaGo point to go back online.` });
  }
  req.driver.online = wantsOnline;
  save();
  res.json({ driver: profile(req.driver) });
});

// Sequential dispatch: a driver only ever sees the ride currently OFFERED to
// them — one card, an expiry countdown, accept or decline. No more racing
// every other driver to tap first.
router.get('/driver/requests', authDriver, (req, res) => {
  if (!driverIsAvailable(req.driver)) return res.json({ requests: [] });
  const requests = db.rides
    .filter((r) => r.mode === 'live' && r.tier === req.driver.tier)
    .map((r) => {
      withStatus(r); // settle the 45s search timeout first — never offer a dead ride
      dispatch.refresh(r); // then advance a lapsed offer before deciding whose it is
      return withStatus(r);
    })
    .filter((r) => r.status === 'searching' && r.offer && r.offer.driverId === req.driver.id)
    .map((r) => ({
      id: r.id,
      customerName: r.customerName,
      kind: r.kind || 'ride',
      recipientName: r.recipient ? r.recipient.name : null,
      pickup: r.pickup,
      dropoff: r.dropoff,
      pickupLoc: r.pickupLoc,
      dropoffLoc: r.dropoffLoc,
      distanceKm: r.distanceKm,
      fare: r.fare,
      fareBoost: r.fareBoost || 0,
      payment: r.payment || 'wallet',
      payout: payoutFor(r),
      etaToPickupMin: etaToPickupMin(req.driver, r.pickupLoc, r.tier),
      offerExpiresIn: Math.max(0, Math.round((r.offer.expiresAt - Date.now()) / 1000)),
      secondsAgo: Math.round((Date.now() - r.createdAt) / 1000)
    }));
  res.json({ requests });
});

// Passing sends the offer straight to the next-nearest driver; the decliner is
// never re-offered this ride.
router.post('/driver/rides/:id/decline', authDriver, (req, res) => {
  const ride = db.rides.find((r) => r.id === req.params.id && r.mode === 'live');
  if (!ride) return res.status(404).json({ error: 'Request not found.' });
  if (ride.status !== 'searching' || !ride.offer || ride.offer.driverId !== req.driver.id) {
    return res.status(409).json({ error: 'This offer is no longer yours to decline.' });
  }
  dispatch.declineOffer(ride);
  res.json({ ok: true });
});

router.post('/driver/rides/:id/accept', authDriver, (req, res) => {
  if (!driverIsAvailable(req.driver)) {
    return res.status(403).json({ error: 'Go online with verified license and live GPS before accepting rides.' });
  }
  const ride = db.rides.find((r) => r.id === req.params.id && r.mode === 'live');
  if (!ride) return res.status(404).json({ error: 'Request not found.' });
  if (ride.tier !== req.driver.tier) return res.status(400).json({ error: 'This request is for a different vehicle type.' });
  if (currentJob(req.driver.id)) return res.status(409).json({ error: 'Finish your current trip first.' });
  if (currentDelivery(req.driver.id)) return res.status(409).json({ error: 'Finish your current delivery first.' });
  // Dispatch already skips riders working a run, but an offer made a moment
  // before they accepted one is still sitting on their phone. Taking it would
  // strand a bootful of shop orders halfway across town.
  if (runs.runForCourier(req.driver.id)) {
    return res.status(409).json({ error: 'Finish your delivery run first.' });
  }
  if (withStatus(ride).status !== 'searching') {
    return res.status(409).json({ error: 'This request was already taken or expired.' });
  }
  // Sequential dispatch: only the driver currently holding the offer may take
  // it (a small grace applies — a lapsed offer still counts until it advances).
  if (!ride.offer || ride.offer.driverId !== req.driver.id) {
    return res.status(409).json({ error: 'This request is currently offered to another driver.' });
  }
  ride.offer = null;
  ride.driverId = req.driver.id;
  ride.driver = driverPublic(req.driver);
  const loc = driverLocation(req.driver, false);
  if (loc) {
    ride.driverStart = loc;
    ride.driverLiveLoc = {
      ...loc,
      accuracy: req.driver.locationAccuracy || null,
      updatedAt: req.driver.locationUpdatedAt || Date.now()
    };
  }
  ride.driverEtaToPickupMin = etaToPickupMin(req.driver, ride.pickupLoc, ride.tier);
  ride.status = 'driver_en_route';
  ride.acceptedAt = Date.now();
  save();
  // Customer sees "driver on the way" instantly; other drivers drop the request.
  events.publish(`user:${ride.userId}`, { topic: 'ride' });
  events.publish('admin', { topic: 'rides' });
  res.json({ job: currentJob(req.driver.id) });
});

router.post('/driver/rides/:id/start', authDriver, (req, res) => {
  const ride = db.rides.find((r) => r.id === req.params.id && r.driverId === req.driver.id);
  if (!ride) return res.status(404).json({ error: 'Trip not found.' });
  if (ride.status !== 'driver_en_route') return res.status(400).json({ error: 'This trip cannot be started.' });
  ride.status = 'in_progress';
  ride.startedAt = Date.now();
  save();
  events.publish(`user:${ride.userId}`, { topic: 'ride' });
  events.publish('admin', { topic: 'rides' });
  res.json({ job: currentJob(req.driver.id) });
});

router.post('/driver/rides/:id/complete', authDriver, (req, res) => {
  const ride = db.rides.find((r) => r.id === req.params.id && r.driverId === req.driver.id);
  if (!ride) return res.status(404).json({ error: 'Trip not found.' });
  if (ride.status !== 'in_progress') return res.status(400).json({ error: 'This trip is not in progress.' });
  ride.status = 'completed';
  ride.completedAt = Date.now();
  ride.payout = payoutFor(ride);
  const commission = ride.fare - ride.payout;
  let mustSettle = false;
  if (ride.payment === 'cash') {
    // Driver keeps the full cash fare; SewaGo's 20% commission is deducted from
    // their balance. It may go negative, but once it passes the cash-credit
    // limit the driver is taken offline and must settle before driving again —
    // so the commission is actually collected, not left as phantom revenue.
    req.driver.earnings = (req.driver.earnings || 0) - commission;
    recordTxn('driver', req.driver, {
      type: 'cash_commission',
      label: `Commission on cash trip: ${ride.pickup} → ${ride.dropoff}`,
      amount: commission,
      sign: -1,
      refId: ride.id
    });
    if (driverOwesTooMuch(req.driver)) {
      req.driver.online = false; // can't take more trips until settled
      mustSettle = true;
    }
  } else {
    req.driver.earnings = (req.driver.earnings || 0) + ride.payout;
    recordTxn('driver', req.driver, {
      type: 'trip_payout',
      label: `Trip payout: ${ride.pickup} → ${ride.dropoff}`,
      amount: ride.payout,
      sign: 1,
      refId: ride.id
    });
  }
  req.driver.tripsCompleted = (req.driver.tripsCompleted || 0) + 1;
  recordPlatformRevenue({
    source: 'ride_commission',
    label: `Ride commission (${ride.payment}): ${ride.pickup} → ${ride.dropoff}`,
    amount: commission,
    refId: ride.id
  });
  save();
  events.publish(`user:${ride.userId}`, { topic: 'ride' });
  events.publish('admin', { topic: 'rides' });
  res.json({
    driver: profile(req.driver),
    payout: ride.payout,
    cash: ride.payment === 'cash',
    fare: ride.fare,
    commission,
    mustSettle,
    owed: mustSettle ? -req.driver.earnings : 0
  });
});

/* ---------------- food courier dispatch ---------------- */
// Bike drivers double as food couriers. A driver holds one ride OR one
// delivery at a time; the courier keeps 80% of the delivery fee, paid on
// hand-over to the customer.

const ROAD = 1.3; // straight-line -> realistic road distance

function deliveryView(order, driver) {
  const o = orderWithStatus(order);
  const routeKm = o.restaurantLoc && o.deliveryLoc
    ? Math.round(haversineKm(o.restaurantLoc, o.deliveryLoc) * ROAD * 10) / 10
    : null;
  return {
    id: o.id,
    restaurantName: o.restaurantName,
    restaurantIcon: o.restaurantIcon,
    restaurantLoc: o.restaurantLoc,
    pickupName: o.restaurantLoc ? o.restaurantLoc.name : o.restaurantName,
    deliveryLoc: o.deliveryLoc,
    dropoffName: o.deliveryLoc ? o.deliveryLoc.name : 'Customer location',
    customerName: o.customerName || 'Customer',
    items: o.items.reduce((sum, line) => sum + line.qty, 0),
    routeKm,
    payout: courierPayoutFor(o),
    // COD: how much cash the courier must collect at the door (0 if prepaid).
    collectCash: o.payment === 'cash' ? o.total : 0,
    status: o.status,
    etaToPickupMin: driver && o.restaurantLoc ? etaToPickupMin(driver, o.restaurantLoc, 'bike') : null,
    secondsAgo: Math.round((Date.now() - (o.acceptedAt || o.createdAt)) / 1000)
  };
}

router.get('/driver/deliveries', authDriver, (req, res) => {
  if (!driverIsAvailable(req.driver) || req.driver.tier !== 'bike') return res.json({ deliveries: [] });
  if (currentJob(req.driver.id) || currentDelivery(req.driver.id)) return res.json({ deliveries: [] });
  if (runs.runForCourier(req.driver.id)) return res.json({ deliveries: [] });
  const deliveries = db.orders
    // Pickup / dine-in orders never enter the courier pool — nobody rides.
    .filter((o) => o.fulfillment === 'live' && (!o.mode || o.mode === 'delivery') &&
      !o.courierId && orderWithStatus(o).status === 'preparing')
    // Regional: only restaurants this courier can realistically reach.
    .filter((o) => {
      const restaurant = db.restaurants.find((r) => r.id === o.restaurantId);
      return !restaurant || !restaurant.loc || driverNearPickup(req.driver, restaurant.loc);
    })
    // Don't offer cash orders bigger than this courier's remaining float —
    // otherwise they ride to the pickup only to be refused at accept.
    .filter((o) => o.payment !== 'cash' || cashJobFitsFloat(req.driver, codDebtFor(o)))
    .map((o) => deliveryView(o, req.driver))
    // Nearest restaurant first; long-waiting orders get nudged up (same rule
    // as ride requests).
    .sort((a, b) => ((a.etaToPickupMin ?? 15) - Math.floor(a.secondsAgo / 60)) -
      ((b.etaToPickupMin ?? 15) - Math.floor(b.secondsAgo / 60)));
  res.json({ deliveries });
});

router.post('/driver/deliveries/:id/accept', authDriver, (req, res) => {
  if (!driverIsAvailable(req.driver) || req.driver.tier !== 'bike') {
    return res.status(403).json({ error: 'Go online as a bike driver with live GPS to take deliveries.' });
  }
  if (currentJob(req.driver.id)) return res.status(409).json({ error: 'Finish your current trip first.' });
  if (currentDelivery(req.driver.id)) return res.status(409).json({ error: 'Finish your current delivery first.' });
  if (runs.runForCourier(req.driver.id)) return res.status(409).json({ error: 'Finish your delivery run first.' });
  const order = db.orders.find((o) => o.id === req.params.id && o.fulfillment === 'live' &&
    (!o.mode || o.mode === 'delivery')); // order-ahead is never a courier job
  if (!order) return res.status(404).json({ error: 'Delivery not found.' });
  // Cash float check on the PROJECTED debt: refuse the job before the cash is in
  // the courier's hand, not after. A snapshot check would let a courier at the
  // edge of their limit accept an order of any size.
  if (order.payment === 'cash' && !cashJobFitsFloat(req.driver, codDebtFor(order))) {
    return res.status(402).json({
      error: `This Rs ${order.total} cash order is over your Rs ${cashHeadroom(req.driver)} cash float. Settle up at a SewaGo point first.`
    });
  }
  if (order.courierId || orderWithStatus(order).status !== 'preparing') {
    return res.status(409).json({ error: 'This delivery was already taken or is no longer available.' });
  }
  order.courierId = req.driver.id;
  order.courier = driverPublic(req.driver);
  order.courierAcceptedAt = Date.now();
  save();
  events.publish(`user:${order.userId}`, { topic: 'order' });
  if (order.partnerId) events.publish(`partner:${order.partnerId}`, { topic: 'orders' });
  events.publish('drivers:bike', { topic: 'delivery_taken' });
  events.publish('admin', { topic: 'orders' });
  res.json({ delivery: deliveryView(order, req.driver) });
});

router.post('/driver/deliveries/:id/pickup', authDriver, (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id && o.courierId === req.driver.id);
  if (!order) return res.status(404).json({ error: 'Delivery not found.' });
  if (order.status !== 'preparing') return res.status(400).json({ error: 'This delivery cannot be picked up.' });
  order.status = 'out_for_delivery';
  order.pickedUpAt = Date.now();
  save();
  events.publish(`user:${order.userId}`, { topic: 'order' });
  if (order.partnerId) events.publish(`partner:${order.partnerId}`, { topic: 'orders' });
  events.publish('admin', { topic: 'orders' });
  res.json({ delivery: deliveryView(order, req.driver) });
});

router.post('/driver/deliveries/:id/deliver', authDriver, (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id && o.courierId === req.driver.id);
  if (!order) return res.status(404).json({ error: 'Delivery not found.' });
  if (order.status !== 'out_for_delivery') return res.status(400).json({ error: 'This delivery is not on the way.' });
  order.status = 'delivered';
  order.deliveredAt = Date.now();
  order.courierPayout = courierPayoutFor(order);
  req.driver.earnings = (req.driver.earnings || 0) + order.courierPayout;
  recordTxn('driver', req.driver, {
    type: 'delivery_payout',
    label: `Delivery payout: ${order.restaurantName} → ${order.deliveryLoc ? order.deliveryLoc.name : 'customer'}`,
    amount: order.courierPayout,
    sign: 1,
    refId: order.id
  });
  // Order is delivered — settle the restaurant's pending income into their
  // withdrawable earnings. It can no longer be refunded, so it's truly theirs.
  if (order.partnerCut && order.partnerId && !order.partnerSettled) {
    const owner = db.partners.find((p) => p.id === order.partnerId);
    if (owner) {
      owner.pendingEarnings = (owner.pendingEarnings || 0) - order.partnerCut;
      owner.earnings = (owner.earnings || 0) + order.partnerCut;
      recordTxn('partner', owner, {
        type: 'order_income',
        label: `Order delivered — income: ${order.restaurantName}`,
        amount: order.partnerCut,
        sign: 1,
        refId: order.id
      });
    }
    order.partnerSettled = true;
  }
  // The courier's cut comes out of the delivery fee the platform collected.
  recordPlatformRevenue({
    source: 'courier_payout',
    label: `Courier payout — ${req.driver.name}: ${order.restaurantName}`,
    amount: -order.courierPayout,
    refId: order.id
  });
  // Cash on delivery: the courier just took the customer's cash at the door, so
  // they hold the whole order total. They keep their payout (credited above) and
  // owe SewaGo the rest — recorded as a debt on their balance and collected via
  // the same cash-settlement flow as cash rides. The platform's cut is only
  // booked as revenue now, because this is when the money actually moved.
  let mustSettle = false;
  if (order.payment === 'cash') {
    req.driver.earnings = (req.driver.earnings || 0) - order.total;
    recordTxn('driver', req.driver, {
      type: 'cod_collected',
      label: `Cash collected on delivery: ${order.restaurantName}`,
      amount: order.total,
      sign: -1,
      refId: order.id
    });
    if (order.partnerCut) {
      recordPlatformRevenue({
        source: 'food_commission',
        label: `Food commission + delivery (COD): ${order.restaurantName}`,
        amount: order.total - order.partnerCut - (order.serviceFee || 0),
        refId: order.id
      });
    }
    if (order.serviceFee > 0) {
      recordPlatformRevenue({
        source: 'service_fee',
        label: `Order service fee (COD): ${order.restaurantName}`,
        amount: order.serviceFee,
        refId: order.id
      });
    }
    if (driverOwesTooMuch(req.driver)) {
      req.driver.online = false; // must settle the collected cash before more work
      mustSettle = true;
    }
  }
  save();
  events.publish(`user:${order.userId}`, { topic: 'order' });
  if (order.partnerId) events.publish(`partner:${order.partnerId}`, { topic: 'orders' });
  events.publish('admin', { topic: 'orders' });
  res.json({
    driver: profile(req.driver),
    payout: order.courierPayout,
    collectCash: order.payment === 'cash' ? order.total : 0,
    mustSettle
  });
});

router.post('/driver/withdraw', authDriver, (req, res) => {
  const result = createWithdrawal('driver', req.driver, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  res.json({ withdrawal: result.withdrawal, driver: profile(req.driver) });
});

router.post('/driver/logout', authDriver, (req, res) => {
  const header = req.headers.authorization || '';
  delete db.driverTokens[header.slice(7)];
  save();
  res.json({ ok: true });
});

/* ---------------- batched courier runs (shop deliveries) ---------------- */

const runs = require('../deliveryRuns');

// One endpoint for "what should I be doing?": the run in progress, or the one
// currently being offered to me.
router.get('/driver/run', authDriver, (req, res) => {
  const active = runs.runForCourier(req.driver.id);
  if (active) return res.json({ run: runs.runView(active), offered: false });
  const offered = runs.offeredRunFor(req.driver.id);
  res.json({ run: runs.runView(offered), offered: !!offered });
});

router.post('/driver/runs/:id/accept', authDriver, (req, res) => {
  const run = db.deliveryRuns.find((r) => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: 'That run is no longer available.' });
  if (runs.runForCourier(req.driver.id)) {
    return res.status(409).json({ error: 'Finish your current run first.' });
  }
  // Eligibility was checked when the offer went out; a rider can pick up a trip
  // or a food delivery in the seconds before they tap accept.
  if (runs.courierOtherwiseBusy(req.driver.id)) {
    return res.status(409).json({ error: 'Finish your current job first.' });
  }
  if (run.status !== 'offered' || !run.offer || run.offer.driverId !== req.driver.id) {
    return res.status(409).json({ error: 'That run went to another rider.' });
  }
  if (run.offer.expiresAt <= Date.now()) {
    return res.status(409).json({ error: 'That offer expired.' });
  }
  // Re-check the float at the moment of accepting — the rider may have taken on
  // cash elsewhere since the offer was made.
  if (!cashJobFitsFloat(req.driver, run.cashToCollect)) {
    return res.status(402).json({
      error: `This run collects Rs ${run.cashToCollect} in cash — over your float. Settle up first.`
    });
  }
  run.status = 'collecting';
  run.courierId = req.driver.id;
  run.courier = driverPublic(req.driver);
  run.acceptedAt = Date.now();
  // Release the offer. Leaving it pointed at the accepting rider let them later
  // "decline" a run they were already working. Keep declined/passed — the sweep
  // reads those if the run ever returns to the pool.
  run.offer = { ...run.offer, driverId: null, expiresAt: 0 };
  for (const orderId of run.orderIds) {
    const order = db.storeOrders.find((o) => o.id === orderId);
    if (order) {
      order.courierId = req.driver.id;
      order.courier = run.courier;
      events.publish(`user:${order.userId}`, { topic: 'store_order' });
      events.publish(`partner:${order.partnerId}`, { topic: 'store_orders' });
    }
  }
  save();
  res.json({ run: runs.runView(run) });
});

router.post('/driver/runs/:id/decline', authDriver, (req, res) => {
  const run = db.deliveryRuns.find((r) => r.id === req.params.id);
  // Decline is for an OFFER only. Handing back a run already in progress needs a
  // real abandon path — declining it would push a half-worked run, stops still
  // ticked, back into the pool for someone else to finish and be paid in full for.
  // Check ownership before the offer, or accepting (which releases the offer)
  // makes a rider's own live run look like someone else's and answer 404.
  if (run && run.courierId === req.driver.id) {
    return res.status(409).json({ error: 'You have already accepted this run.' });
  }
  if (!run || !run.offer || run.offer.driverId !== req.driver.id) {
    return res.status(404).json({ error: 'Run not found.' });
  }
  if (run.status !== 'offered') {
    return res.status(409).json({ error: 'That offer is no longer open.' });
  }
  run.offer.declined = [...new Set([...(run.offer.declined || []), req.driver.id])];
  run.offer.driverId = null;
  run.offer.expiresAt = 0;
  run.status = 'forming'; // the sweep offers it to the next rider
  save();
  res.json({ ok: true });
});

// Complete a stop. Pickups just tick off; a dropoff is where the money for that
// order actually settles.
router.post('/driver/runs/:id/stops/:seq/done', authDriver, (req, res) => {
  const run = db.deliveryRuns.find((r) => r.id === req.params.id && r.courierId === req.driver.id);
  if (!run) return res.status(404).json({ error: 'Run not found.' });
  if (run.status !== 'collecting' && run.status !== 'delivering') {
    return res.status(400).json({ error: 'This run is not active.' });
  }
  const seq = Number(req.params.seq);
  const stop = run.stops.find((s) => s.seq === seq);
  if (!stop) return res.status(404).json({ error: 'Stop not found.' });
  if (stop.done) return res.status(400).json({ error: 'That stop is already done.' });
  // Stops are worked in order so the route stays sane and money settles predictably.
  const firstOpen = run.stops.find((s) => !s.done);
  if (firstOpen && firstOpen.seq !== seq) {
    return res.status(400).json({ error: `Do stop ${firstOpen.seq + 1} first.` });
  }

  stop.done = true;
  stop.doneAt = Date.now();

  if (stop.type === 'pickup') {
    for (const orderId of stop.orderIds) {
      const order = db.storeOrders.find((o) => o.id === orderId);
      if (order && order.status === 'ready') {
        order.status = 'collected';
        order.collectedAt = Date.now();
        events.publish(`user:${order.userId}`, { topic: 'store_order' });
        events.publish(`partner:${order.partnerId}`, { topic: 'store_orders' });
      }
    }
    if (run.stops.every((s) => s.type !== 'pickup' || s.done)) run.status = 'delivering';
  } else {
    const order = db.storeOrders.find((o) => o.id === stop.orderId);
    // Drive settlement off its OWN flag rather than the order's status. Status
    // is written by several paths, and gating on it meant another path marking
    // the order delivered silently skipped the courier's cash debit.
    if (order && order.status !== 'cancelled') {
      order.status = 'delivered';
      order.deliveredAt = order.deliveredAt || Date.now();
      if (!order.moneySettledAt) settleStoreOrderOnDelivery(order, req.driver);
      events.publish(`user:${order.userId}`, { topic: 'store_order' });
      events.publish(`partner:${order.partnerId}`, { topic: 'store_orders' });
    }
  }

  let mustSettle = false;
  if (run.stops.every((s) => s.done)) {
    run.status = 'completed';
    run.completedAt = Date.now();
    // The rider is paid for the whole run once, on completion.
    req.driver.earnings = (req.driver.earnings || 0) + run.payout;
    recordTxn('driver', req.driver, {
      type: 'run_payout',
      label: `Delivery run: ${run.orderIds.length} orders, ${run.stops.length} stops`,
      amount: run.payout,
      sign: 1,
      refId: run.id
    });
    recordPlatformRevenue({
      source: 'courier_payout',
      label: `Courier run payout — ${req.driver.name}`,
      amount: -run.payout,
      refId: run.id
    });
    mustSettle = driverOwesTooMuch(req.driver);
    if (mustSettle) req.driver.online = false;
  }
  save();
  events.publish('admin', { topic: 'orders' });
  res.json({ run: runs.runView(run), driver: profile(req.driver), mustSettle });
});

// Money for one shop order, at the moment the customer receives it.
function settleStoreOrderOnDelivery(order, courier) {
  const owner = db.partners.find((p) => p.id === order.partnerId);
  if (order.payment === 'cash') {
    // The courier now holds the customer's cash for this order and owes it in.
    // Gated by !partnerSettled like every other money move below: if the order
    // was already settled another way (e.g. the shopkeeper handed it over before
    // a run had formed), no courier ever collected this cash, so debiting them
    // the full order total would be inventing a debt out of nothing.
    if (!order.partnerSettled) {
      courier.earnings = (courier.earnings || 0) - order.total;
      recordTxn('driver', courier, {
        type: 'cod_collected',
        label: `Cash collected: ${order.storeName}`,
        amount: order.total,
        sign: -1,
        refId: order.id
      });
    }
    if (owner && !order.partnerSettled) {
      owner.earnings = (owner.earnings || 0) + order.partnerCut;
      recordTxn('partner', owner, {
        type: 'store_income',
        label: `Order delivered — income: ${order.storeName}`,
        amount: order.partnerCut,
        sign: 1,
        refId: order.id
      });
    }
    if (!order.partnerSettled) {
      // Inside the settled guard so no future path can double-book the cut.
      recordPlatformRevenue({
        source: 'store_commission',
        label: `Store commission (cash): ${order.storeName}`,
        amount: order.commission,
        refId: order.id
      });
    }
  } else if (owner && !order.partnerSettled) {
    // Prepaid: the shop's pending income becomes withdrawable now.
    owner.pendingEarnings = (owner.pendingEarnings || 0) - order.partnerCut;
    owner.earnings = (owner.earnings || 0) + order.partnerCut;
    recordTxn('partner', owner, {
      type: 'store_income',
      label: `Order delivered — income: ${order.storeName}`,
      amount: order.partnerCut,
      sign: 1,
      refId: order.id
    });
  }
  order.partnerSettled = true;
  order.moneySettledAt = Date.now();
}

module.exports = router;
