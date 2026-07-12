const express = require('express');
const { db, save, uid } = require('../db');
const { authRequired, publicUser } = require('./auth');
const { withStatus, driverPublic, etaToPickupMin, driverIsAvailable, ROAD_FACTOR, SEARCH_TIMEOUT_SECONDS } = require('../rideLogic');
const { PLACES, haversineKm } = require('../places');
const { searchPlaces, reverseGeocode, insideServiceArea, resolveLocation } = require('../geo');
const { recordTxn, recordPlatformRevenue } = require('../payments');
const { RIDE_SERVICE_FEE, surgeFor, cancelFeeSplit } = require('../fees');
const { normalizePhone, validPhone } = require('../accountSecurity');
const { applyRating } = require('../orderLogic');
const dispatch = require('../dispatch');
const events = require('../events');

const router = express.Router();

const TIERS = {
  bike: { label: 'SewaGo Bike', icon: '🏍️', base: 50, perKm: 25, speedKmh: 28, seats: 1 },
  car: { label: 'SewaGo Car', icon: '🚗', base: 100, perKm: 45, speedKmh: 24, seats: 4 },
  xl: { label: 'SewaGo XL', icon: '🚐', base: 150, perKm: 60, speedKmh: 22, seats: 6 }
};

function locationKey(loc) {
  return `${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}`;
}

function estimateFor(pickup, dropoff) {
  const pickupPlace = resolveLocation(pickup);
  const dropoffPlace = resolveLocation(dropoff);
  const distanceKm = Math.max(0.8, Math.round(haversineKm(pickupPlace, dropoffPlace) * ROAD_FACTOR * 10) / 10);
  const options = Object.entries(TIERS).map(([tier, t]) => {
    const surge = surgeFor(tier);
    return {
      tier,
      label: t.label,
      icon: t.icon,
      seats: t.seats,
      surge,
      fare: Math.round((t.base + t.perKm * distanceKm) * surge),
      etaMin: Math.max(2, Math.round((distanceKm / t.speedKmh) * 60)),
      // Real online drivers of this tier right now — tells the customer (and a
      // tester) whether booking will go live or fall back to a simulated trip.
      liveDrivers: db.drivers.filter((d) => driverIsAvailable(d, tier)).length
    };
  });
  return { distanceKm, pickupPlace, dropoffPlace, options, serviceFee: RIDE_SERVICE_FEE };
}

router.get('/places', authRequired, (req, res) => {
  res.json({ places: PLACES });
});

// Real address search (OpenStreetMap, Kathmandu-bounded, server-cached).
router.get('/geo/search', authRequired, async (req, res) => {
  try {
    res.json({ results: await searchPlaces(req.query.q) });
  } catch (err) {
    console.error('Geo search failed:', err.message);
    res.status(502).json({ error: 'Address search is unavailable right now — pick from popular places.' });
  }
});

// GPS coords -> human-readable label ("Use my location").
router.get('/geo/reverse', authRequired, async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'lat and lng are required.' });
  }
  if (!insideServiceArea(lat, lng)) {
    return res.status(400).json({ error: 'You appear to be outside the Kathmandu valley — SewaGo rides run there for now.' });
  }
  try {
    res.json({ place: await reverseGeocode(lat, lng) });
  } catch (err) {
    console.error('Reverse geocode failed:', err.message);
    res.json({ place: { name: 'Pinned location', lat, lng } });
  }
});

function validateEndpoints(pickup, dropoff, res) {
  const a = resolveLocation(pickup);
  const b = resolveLocation(dropoff);
  for (const loc of [a, b]) {
    if (loc.error === 'outside') {
      res.status(400).json({ error: 'That point is outside the Kathmandu valley — SewaGo rides run there for now.' });
      return null;
    }
    if (loc.error) {
      res.status(400).json({ error: 'Pickup and dropoff are required.' });
      return null;
    }
  }
  if (locationKey(a) === locationKey(b)) {
    res.status(400).json({ error: 'Pickup and dropoff must be different places.' });
    return null;
  }
  return { pickup: a, dropoff: b };
}

router.post('/rides/estimate', authRequired, (req, res) => {
  const { pickup, dropoff } = req.body || {};
  const ends = validateEndpoints(pickup, dropoff, res);
  if (!ends) return;
  res.json(estimateFor(ends.pickup, ends.dropoff));
});

router.post('/rides', authRequired, (req, res) => {
  const { pickup, dropoff, tier, payment, kind, recipient, parcelNote } = req.body || {};
  const payMethod = payment === 'cash' ? 'cash' : 'wallet';
  if (!TIERS[tier]) {
    return res.status(400).json({ error: 'Pickup, dropoff and a valid ride type are required.' });
  }
  // Parcels ride the bike network: same dispatch, fare and payout — the driver
  // just hands a package to a named receiver instead of carrying a passenger.
  const isParcel = kind === 'parcel';
  let parcelRecipient = null;
  if (isParcel) {
    if (tier !== 'bike') return res.status(400).json({ error: 'Parcels are delivered by bike couriers.' });
    const rName = String((recipient || {}).name || '').trim();
    const rPhone = normalizePhone((recipient || {}).phone);
    if (rName.length < 2 || !validPhone(rPhone)) {
      return res.status(400).json({ error: "Receiver's name and a valid phone number are required." });
    }
    parcelRecipient = { name: rName.slice(0, 60), phone: rPhone };
  }
  const ends = validateEndpoints(pickup, dropoff, res);
  if (!ends) return;
  const existing = db.rides
    .filter((r) => r.userId === req.user.id)
    .map(withStatus)
    .find((r) => r.status !== 'completed' && r.status !== 'cancelled');
  if (existing) return res.status(409).json({ error: 'You already have a ride in progress.' });

  const { distanceKm, pickupPlace, dropoffPlace, options } = estimateFor(ends.pickup, ends.dropoff);
  const option = options.find((o) => o.tier === tier);
  // Service fee rides on wallet bookings only — cash fares are collected by the
  // driver and there is nothing extra to collect from.
  const serviceFee = payMethod === 'wallet' ? RIDE_SERVICE_FEE : 0;
  if (payMethod === 'wallet' && req.user.wallet < option.fare + serviceFee) {
    return res.status(402).json({ error: 'Not enough wallet balance. Top up in Profile, or pay cash.' });
  }

  // If a real driver of this tier is online, wait for them to accept ("live").
  // Otherwise fall back to the nearest simulated driver so the demo always works.
  const anyOnline = db.drivers.some((d) => driverIsAvailable(d, tier));
  const mode = anyOnline ? 'live' : 'sim';
  let driver = null;
  let driverStart = null;
  let driverEta = null;
  if (mode === 'sim') {
    const candidates = db.drivers.filter((d) => d.tier === tier);
    const nearest = candidates.reduce((best, d) => {
      const km = d.baseLat != null ? haversineKm({ lat: d.baseLat, lng: d.baseLng }, pickupPlace) : 999;
      return !best || km < best.km ? { d, km } : best;
    }, null);
    driver = driverPublic(nearest.d);
    if (nearest.d.baseLat != null) driverStart = { lat: nearest.d.baseLat, lng: nearest.d.baseLng };
    driverEta = etaToPickupMin(nearest.d, pickupPlace, tier);
  }

  const ride = {
    id: uid(),
    userId: req.user.id,
    customerName: req.user.name,
    pickup: pickupPlace.name,
    dropoff: dropoffPlace.name,
    pickupLoc: { lat: pickupPlace.lat, lng: pickupPlace.lng },
    dropoffLoc: { lat: dropoffPlace.lat, lng: dropoffPlace.lng },
    tier,
    tierLabel: isParcel ? 'SewaGo Parcel' : option.label,
    icon: isParcel ? '📦' : option.icon,
    kind: isParcel ? 'parcel' : 'ride',
    recipient: parcelRecipient,
    parcelNote: isParcel ? String(parcelNote || '').trim().slice(0, 120) : '',
    distanceKm,
    fare: option.fare,
    surge: option.surge,
    serviceFee,
    total: option.fare + serviceFee,
    // Shown to the customer before they cancel a ride a driver already accepted.
    lateCancelFee: payMethod === 'wallet' ? cancelFeeSplit().total : 0,
    payment: payMethod,
    mode,
    driver,
    driverId: null,
    driverStart,
    driverEtaToPickupMin: driverEta,
    status: 'searching',
    tripSeconds: Math.min(90, Math.max(20, Math.round(distanceKm * 8))),
    rating: null,
    createdAt: Date.now()
  };
  if (payMethod === 'wallet') {
    req.user.wallet -= ride.total;
    recordTxn('user', req.user, {
      type: 'ride',
      label: `Ride: ${ride.pickup} → ${ride.dropoff}`,
      amount: ride.total,
      sign: -1,
      refId: ride.id
    });
    if (serviceFee > 0) {
      recordPlatformRevenue({
        source: 'service_fee',
        label: `Ride service fee: ${ride.pickup} → ${ride.dropoff}`,
        amount: serviceFee,
        refId: ride.id
      });
    }
  }
  db.rides.push(ride);
  save();
  // Live mode: offer the ride to the nearest driver (sequential dispatch).
  if (mode === 'live') dispatch.startDispatch(ride);
  events.publish('admin', { topic: 'rides' });
  res.json({ ride: withStatus(ride), user: publicUser(req.user) });
});

router.get('/rides/active', authRequired, (req, res) => {
  const rides = db.rides.filter((r) => r.userId === req.user.id).map(withStatus);
  const latest = rides[rides.length - 1];
  if (!latest) return res.json({ ride: null });
  const showable =
    (latest.status !== 'completed' && latest.status !== 'cancelled') ||
    (latest.status === 'completed' && !latest.rating && Date.now() - (latest.completedAt || 0) < 10 * 60 * 1000) ||
    (latest.status === 'cancelled' && latest.cancelReason === 'no_drivers' && Date.now() - (latest.cancelledAt || 0) < 60 * 1000);
  res.json({ ride: showable ? latest : null, user: publicUser(req.user) });
});

router.get('/rides', authRequired, (req, res) => {
  const rides = db.rides
    .filter((r) => r.userId === req.user.id)
    .map(withStatus)
    .reverse();
  res.json({ rides });
});

router.post('/rides/:id/cancel', authRequired, (req, res) => {
  const ride = db.rides.find((r) => r.id === req.params.id && r.userId === req.user.id);
  if (!ride) return res.status(404).json({ error: 'Ride not found.' });
  const current = withStatus(ride);
  if (current.status !== 'searching' && current.status !== 'driver_en_route') {
    return res.status(400).json({ error: 'This ride can no longer be cancelled.' });
  }
  // A real driver already heading to the pickup gets compensated: half the
  // cancellation fee goes to them, half to the platform. Searching rides,
  // simulated drivers and cash rides cancel free.
  const chargeCancelFee = ride.mode === 'live' &&
    current.status === 'driver_en_route' &&
    ride.payment !== 'cash' &&
    !!ride.driverId;
  ride.status = 'cancelled';
  ride.cancelReason = 'customer';
  ride.cancelledAt = Date.now();
  if (ride.payment !== 'cash') {
    const paid = ride.total ?? ride.fare;
    let refund = paid;
    if (chargeCancelFee) {
      const fee = cancelFeeSplit();
      refund = Math.max(0, paid - fee.total);
      ride.cancelFee = fee.total;
      ride.cancelFeeDriver = fee.driver;
      ride.cancelFeePlatform = fee.platform;
      const driver = db.drivers.find((d) => d.id === ride.driverId);
      if (driver) {
        driver.earnings = (driver.earnings || 0) + fee.driver;
        recordTxn('driver', driver, {
          type: 'cancel_compensation',
          label: `Cancelled ride compensation: ${ride.pickup} → ${ride.dropoff}`,
          amount: fee.driver,
          sign: 1,
          refId: ride.id
        });
      }
      recordPlatformRevenue({
        source: 'cancel_fee',
        label: `Late cancellation fee: ${ride.pickup} → ${ride.dropoff}`,
        amount: fee.platform,
        refId: ride.id
      });
    }
    req.user.wallet += refund;
    recordTxn('user', req.user, {
      type: 'ride_refund',
      label: chargeCancelFee
        ? `Ride cancelled — refund minus Rs ${ride.cancelFee} fee: ${ride.pickup} → ${ride.dropoff}`
        : `Ride cancelled — refund: ${ride.pickup} → ${ride.dropoff}`,
      amount: refund,
      sign: 1,
      refId: ride.id
    });
    if (ride.serviceFee > 0) {
      // The booking's service-fee revenue entry is reversed with the refund.
      recordPlatformRevenue({
        source: 'service_fee',
        label: `Ride cancelled — service fee reversed: ${ride.pickup} → ${ride.dropoff}`,
        amount: -ride.serviceFee,
        refId: ride.id
      });
    }
  }
  // Release any pending offer, and tell the assigned driver the trip is off.
  dispatch.clearOffer(ride);
  save();
  if (ride.driverId) events.publish(`driver:${ride.driverId}`, { topic: 'ride' });
  events.publish('admin', { topic: 'rides' });
  res.json({ ride: withStatus(ride), user: publicUser(req.user) });
});

// While a live ride is still searching, the customer can raise the fare to
// attract a driver. The boost restarts dispatch with a clean slate (drivers who
// declined the old price get offered the new one) and resets the 45s search
// window. Wallet rides pay the extra up-front; cash boosts are collected by
// the driver at the end like the rest of the fare.
const FARE_BOOST_STEPS = [20, 50, 100];
const FARE_BOOST_MAX = 500;

router.post('/rides/:id/boost', authRequired, (req, res) => {
  const ride = db.rides.find((r) => r.id === req.params.id && r.userId === req.user.id);
  if (!ride) return res.status(404).json({ error: 'Ride not found.' });
  const current = withStatus(ride);
  if (ride.mode !== 'live' || current.status !== 'searching') {
    return res.status(400).json({ error: 'The fare can only be raised while we are still looking for a driver.' });
  }
  const amount = Math.round(Number((req.body || {}).amount));
  if (!FARE_BOOST_STEPS.includes(amount)) {
    return res.status(400).json({ error: `Fare boost must be Rs ${FARE_BOOST_STEPS.join(', Rs ')}.` });
  }
  if ((ride.fareBoost || 0) + amount > FARE_BOOST_MAX) {
    return res.status(400).json({ error: `The fare can be raised by at most Rs ${FARE_BOOST_MAX} in total.` });
  }
  if (ride.payment !== 'cash') {
    if (req.user.wallet < amount) {
      return res.status(402).json({ error: 'Not enough wallet balance to raise the fare.' });
    }
    req.user.wallet -= amount;
    recordTxn('user', req.user, {
      type: 'ride',
      label: `Fare raised (+Rs ${amount}): ${ride.pickup} → ${ride.dropoff}`,
      amount,
      sign: -1,
      refId: ride.id
    });
  }
  ride.fare += amount;
  ride.total = (ride.total ?? ride.fare) + amount;
  ride.fareBoost = (ride.fareBoost || 0) + amount;
  // Fresh 45s search window from now, then a clean dispatch pass at the new price.
  ride.searchTimeoutSeconds = Math.round((Date.now() - ride.createdAt) / 1000) + SEARCH_TIMEOUT_SECONDS;
  dispatch.clearOffer(ride);
  dispatch.startDispatch(ride);
  save();
  events.publish('admin', { topic: 'rides' });
  res.json({ ride: withStatus(ride), user: publicUser(req.user) });
});

router.post('/rides/:id/rate', authRequired, (req, res) => {
  const ride = db.rides.find((r) => r.id === req.params.id && r.userId === req.user.id);
  if (!ride) return res.status(404).json({ error: 'Ride not found.' });
  const stars = Number((req.body || {}).stars);
  if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'Rating must be 1-5 stars.' });
  if (withStatus(ride).status !== 'completed') {
    return res.status(400).json({ error: 'You can rate a ride after it finishes.' });
  }
  const firstRating = !ride.rating;
  ride.rating = stars;
  // Only real (live) drivers accumulate reputation — rating a simulated
  // fallback driver would poison a seeded account that never drove the trip.
  if (firstRating && ride.mode === 'live' && ride.driverId) {
    const driver = db.drivers.find((d) => d.id === ride.driverId);
    if (driver) applyRating(driver, stars);
  }
  save();
  res.json({ ride: withStatus(ride) });
});

module.exports = router;
