// Platform revenue knobs: per-booking service fees, the late-cancellation fee,
// and demand-based surge pricing. All amounts are rupees and env-tunable so
// pricing can be changed without a deploy rollback.
const { db } = require('./db');
const { driverIsAvailable } = require('./rideLogic');
const { haversineKm } = require('./places');

function envInt(name, fallback) {
  const n = Math.round(Number(process.env[name]));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Service fee added on top of the fare/order total. Ride fee applies to wallet
// rides only (nothing extra to collect on cash); food orders are always wallet.
const RIDE_SERVICE_FEE = envInt('RIDE_SERVICE_FEE', 5);
const FOOD_SERVICE_FEE = envInt('FOOD_SERVICE_FEE', 15);

// Charged when a wallet ride is cancelled after a real driver already accepted;
// half compensates that driver for the wasted trip. Simulated and cash rides
// are exempt (no real driver lost time / nothing was collected).
const RIDE_CANCEL_FEE = envInt('RIDE_CANCEL_FEE', 40);
const CANCEL_FEE_DRIVER_SHARE = 0.5;

// Surge multiplier, stepped by how many riders are searching per online driver
// of that tier. No online drivers -> no surge: the sim fallback must never
// charge scarcity pricing for fake scarcity.
const SURGE_CAP = (() => {
  const n = Number(process.env.RIDE_SURGE_CAP);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 3) : 1.5;
})();

function surgeFor(tier) {
  const supply = db.drivers.filter((d) => driverIsAvailable(d, tier)).length;
  if (supply === 0) return 1;
  const pending = db.rides.filter(
    (r) => r.mode === 'live' && r.tier === tier && r.status === 'searching'
  ).length;
  const ratio = pending / supply;
  if (ratio >= 3) return SURGE_CAP;
  if (ratio >= 2) return Math.min(SURGE_CAP, 1.4);
  if (ratio >= 1) return Math.min(SURGE_CAP, 1.2);
  return 1;
}

// Distance-based delivery pricing: the restaurant's base fee covers the first
// FREE_KM of road distance; each km beyond adds PER_KM, capped so a mistyped
// address can't produce an absurd fee. The courier's 80% share rides the full
// fee, so far deliveries stay worth accepting.
const FOOD_DELIVERY_FREE_KM = envInt('FOOD_DELIVERY_FREE_KM', 3);
const FOOD_DELIVERY_PER_KM = envInt('FOOD_DELIVERY_PER_KM', 15);
const FOOD_DELIVERY_MAX_EXTRA = envInt('FOOD_DELIVERY_MAX_EXTRA', 300);
const ROAD_FACTOR = 1.3;

function deliveryFeeFor(restaurant, deliveryLoc) {
  const base = restaurant.deliveryFee || 0;
  if (!restaurant.loc || !deliveryLoc) return { fee: base, distanceKm: null };
  const distanceKm = Math.round(haversineKm(restaurant.loc, deliveryLoc) * ROAD_FACTOR * 10) / 10;
  const extraKm = Math.max(0, Math.ceil(distanceKm - FOOD_DELIVERY_FREE_KM));
  const extra = Math.min(FOOD_DELIVERY_MAX_EXTRA, extraKm * FOOD_DELIVERY_PER_KM);
  return { fee: base + extra, distanceKm };
}

// Featured placement: a partner spends earnings balance to pin a live listing
// to the top of the customer list for a week.
const PROMOTE_WEEK_PRICE = envInt('PROMOTE_WEEK_PRICE', 500);
const PROMOTE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function cancelFeeSplit() {
  const driver = Math.round(RIDE_CANCEL_FEE * CANCEL_FEE_DRIVER_SHARE);
  return { total: RIDE_CANCEL_FEE, driver, platform: RIDE_CANCEL_FEE - driver };
}

module.exports = {
  RIDE_SERVICE_FEE,
  FOOD_SERVICE_FEE,
  RIDE_CANCEL_FEE,
  SURGE_CAP,
  FOOD_DELIVERY_FREE_KM,
  FOOD_DELIVERY_PER_KM,
  PROMOTE_WEEK_PRICE,
  PROMOTE_WEEK_MS,
  surgeFor,
  cancelFeeSplit,
  deliveryFeeFor
};
