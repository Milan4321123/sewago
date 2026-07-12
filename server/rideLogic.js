const { db, save } = require('./db');
const { haversineKm } = require('./places');

// Demo timings (seconds) for simulated rides so a trip visibly progresses.
const MATCH_SECONDS = 6;
const PICKUP_SECONDS = 18;
// Live rides: how long a request waits for a real driver before auto-refund.
const SEARCH_TIMEOUT_SECONDS = 45;
const LOCATION_FRESH_MS = 2 * 60 * 1000;
// Driver keeps 80% of the fare; SewaGo takes 20%.
const DRIVER_SHARE = 0.8;
// Average city speeds (km/h) per tier, used for driver-arrival ETAs.
const SPEEDS = { bike: 28, car: 24, xl: 22 };
const ROAD_FACTOR = 1.3; // straight-line distance -> realistic road distance

function driverPublic(d) {
  return { id: d.id, name: d.name, vehicle: d.vehicle, plate: d.plate, rating: d.rating };
}

function driverIsVerified(driver) {
  return !!driver && (driver.licenseVerified === true || driver.verificationStatus === 'verified');
}

function driverHasFreshLocation(driver) {
  return !!driver &&
    Number.isFinite(driver.currentLat) &&
    Number.isFinite(driver.currentLng) &&
    driver.locationUpdatedAt &&
    Date.now() - driver.locationUpdatedAt <= LOCATION_FRESH_MS;
}

function driverLocation(driver, allowBase = true) {
  if (driverHasFreshLocation(driver)) return { lat: driver.currentLat, lng: driver.currentLng };
  if (allowBase && driver && driver.baseLat != null) return { lat: driver.baseLat, lng: driver.baseLng };
  return null;
}

function driverIsAvailable(driver, tier = null) {
  return !!driver &&
    (!tier || driver.tier === tier) &&
    !!driver.online &&
    driverIsVerified(driver) &&
    driver.phoneVerified !== false &&
    driverHasFreshLocation(driver);
}

function payoutFor(ride) {
  return Math.round(ride.fare * DRIVER_SHARE);
}

function refundUser(userId, amount, label = 'Ride refund', refId = null) {
  const user = db.users.find((u) => u.id === userId);
  if (!user) return;
  user.wallet += amount;
  // Required lazily to avoid a circular import at module load time.
  const { recordTxn } = require('./payments');
  recordTxn('user', user, { type: 'ride_refund', label, amount, sign: 1, refId });
}

// Minutes for a driver to reach the pickup point from their base location.
function etaToPickupMin(driver, pickupLoc, tier) {
  const loc = driverLocation(driver);
  if (!loc || !pickupLoc) return 5;
  const km = haversineKm(loc, pickupLoc) * ROAD_FACTOR;
  return Math.min(25, Math.max(1, Math.round((km / (SPEEDS[tier] || 24)) * 60)));
}

function lerp(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

// Attach the driver's current map position and arrival ETA to a ride payload.
function decorate(ride, status, progress) {
  const out = { ...ride, status, progress };
  const pk = ride.pickupLoc;
  const dp = ride.dropoffLoc;
  if (!pk || !dp) return out;

  const liveLocFresh = ride.driverLiveLoc &&
    ride.driverLiveLoc.updatedAt &&
    Date.now() - ride.driverLiveLoc.updatedAt <= LOCATION_FRESH_MS;

  if (status === 'driver_en_route' && ride.driverStart) {
    let fraction;
    if (ride.mode === 'live') {
      const elapsed = (Date.now() - (ride.acceptedAt || ride.createdAt)) / 1000;
      const total = (ride.driverEtaToPickupMin || 5) * 60;
      fraction = Math.min(0.92, elapsed / total);
      out.driverEtaMin = Math.max(1, Math.ceil((total - elapsed) / 60));
    } else {
      const t = (Date.now() - ride.createdAt) / 1000;
      fraction = Math.min(1, Math.max(0, (t - MATCH_SECONDS) / PICKUP_SECONDS));
      out.driverEtaMin = Math.max(1, Math.ceil((ride.driverEtaToPickupMin || 5) * (1 - fraction)));
    }
    out.driverCoords = lerp(ride.driverStart, pk, fraction);
  } else if (status === 'in_progress') {
    out.driverCoords = lerp(pk, dp, Math.min(1, progress));
  } else if (status === 'completed') {
    out.driverCoords = { ...dp };
  }
  if (ride.mode === 'live' && liveLocFresh && (status === 'driver_en_route' || status === 'in_progress')) {
    out.driverCoords = { lat: ride.driverLiveLoc.lat, lng: ride.driverLiveLoc.lng };
  }
  return out;
}

function withStatus(ride) {
  if (ride.status === 'completed' || ride.status === 'cancelled') {
    return decorate(ride, ride.status, 1);
  }
  const t = (Date.now() - ride.createdAt) / 1000;

  if (ride.mode === 'live') {
    // Live rides are driver-controlled; only the search timeout is automatic.
    const searchTimeoutSeconds = ride.searchTimeoutSeconds || SEARCH_TIMEOUT_SECONDS;
    if (ride.status === 'searching' && t > searchTimeoutSeconds) {
      ride.status = 'cancelled';
      ride.cancelReason = 'no_drivers';
      ride.cancelledAt = Date.now();
      if (ride.offer) {
        // Clear the lapsed offer so the driver's card disappears.
        require('./events').publish(`driver:${ride.offer.driverId}`, { topic: 'ride_taken' });
        ride.offer = null;
      }
      if (ride.payment !== 'cash') {
        refundUser(ride.userId, ride.total ?? ride.fare, `No driver found — refund: ${ride.pickup} → ${ride.dropoff}`, ride.id);
        if (ride.serviceFee > 0) {
          const { recordPlatformRevenue } = require('./payments');
          recordPlatformRevenue({
            source: 'service_fee',
            label: `No driver found — service fee reversed: ${ride.pickup} → ${ride.dropoff}`,
            amount: -ride.serviceFee,
            refId: ride.id
          });
        }
      }
      save();
      return decorate(ride, 'cancelled', 0);
    }
    let progress = 0;
    if (ride.status === 'in_progress') {
      progress = Math.min(0.95, (Date.now() - ride.startedAt) / 1000 / ride.tripSeconds);
    }
    return decorate(ride, ride.status, progress);
  }

  // Simulated ride: status advances on a timer.
  let status;
  let progress = 0;
  if (t < MATCH_SECONDS) {
    status = 'searching';
  } else if (t < MATCH_SECONDS + PICKUP_SECONDS) {
    status = 'driver_en_route';
  } else if (t < MATCH_SECONDS + PICKUP_SECONDS + ride.tripSeconds) {
    status = 'in_progress';
    progress = (t - MATCH_SECONDS - PICKUP_SECONDS) / ride.tripSeconds;
  } else {
    ride.status = 'completed';
    ride.completedAt = Date.now();
    save();
    return decorate(ride, 'completed', 1);
  }
  return decorate(ride, status, progress);
}

module.exports = {
  withStatus,
  driverPublic,
  refundUser,
  payoutFor,
  etaToPickupMin,
  driverIsVerified,
  driverHasFreshLocation,
  driverLocation,
  driverIsAvailable,
  SPEEDS,
  ROAD_FACTOR,
  LOCATION_FRESH_MS,
  SEARCH_TIMEOUT_SECONDS
};
