// Sequential ride dispatch: instead of broadcasting a request to every online
// driver of the tier (first tap wins, accept-collisions at scale), the ride is
// OFFERED to one driver at a time — nearest pickup first. A driver holds the
// offer exclusively for RIDE_OFFER_SECONDS; declining or letting it lapse
// cascades to the next-nearest. Drivers who passed are never re-offered the
// same ride. If the list runs dry the ride waits un-offered and the sweep
// retries as drivers come online or free up, until the 45s search timeout
// refunds the customer (rideLogic).
const { db, save } = require('./db');
const events = require('./events');
const { withStatus, driverIsAvailable, etaToPickupMin } = require('./rideLogic');
const { currentDelivery } = require('./orderLogic');

const RIDE_OFFER_SECONDS = (() => {
  const n = Number(process.env.RIDE_OFFER_SECONDS);
  return Number.isFinite(n) && n >= 5 ? Math.min(n, 60) : 15;
})();

// Live rides carry explicit statuses, so a stored-status scan is enough.
function driverBusy(driverId) {
  if (currentDelivery(driverId)) return true;
  return db.rides.some(
    (r) => r.driverId === driverId && (r.status === 'driver_en_route' || r.status === 'in_progress')
  );
}

function candidatesFor(ride) {
  const declined = new Set(ride.declinedDriverIds || []);
  return db.drivers
    .filter((d) => driverIsAvailable(d, ride.tier) && !declined.has(d.id) && !driverBusy(d.id))
    .map((d) => ({ d, eta: etaToPickupMin(d, ride.pickupLoc, ride.tier) }))
    .sort((a, b) => a.eta - b.eta)
    .map((x) => x.d);
}

function offerTo(ride, driver) {
  ride.offer = {
    driverId: driver.id,
    offeredAt: Date.now(),
    expiresAt: Date.now() + RIDE_OFFER_SECONDS * 1000
  };
  events.publish(`driver:${driver.id}`, { topic: 'ride_request' });
}

function startDispatch(ride) {
  ride.declinedDriverIds = [];
  ride.offer = null;
  const [next] = candidatesFor(ride);
  if (next) offerTo(ride, next);
  save();
}

// The current holder passed (explicit decline or lapsed offer) — burn their
// turn and move to the next-nearest.
function offerNext(ride) {
  if (ride.offer) {
    ride.declinedDriverIds = [...(ride.declinedDriverIds || []), ride.offer.driverId];
    ride.offer = null;
  }
  const [next] = candidatesFor(ride);
  if (next) offerTo(ride, next);
  save();
  events.publish('admin', { topic: 'rides' });
}

// Keep a searching ride's offer honest: advance a lapsed one, and give an
// un-offered ride another look (a driver may have come online or finished a
// trip since the list last ran dry).
function refresh(ride) {
  if (ride.mode !== 'live' || ride.status !== 'searching') return;
  if (ride.offer && ride.offer.expiresAt < Date.now()) {
    offerNext(ride);
  } else if (!ride.offer) {
    const [next] = candidatesFor(ride);
    if (next) {
      offerTo(ride, next);
      save();
    }
  }
}

// Runs every few seconds from index.js so offers advance even when nobody is
// polling; withStatus() first so the 45s search timeout still fires.
function sweep() {
  for (const ride of db.rides) {
    if (ride.mode !== 'live' || ride.status !== 'searching') continue;
    withStatus(ride);
    if (ride.status === 'searching') refresh(ride);
  }
}

// The ride stopped searching (accepted, cancelled, timed out) — release the
// pending offer and tell that driver their card is gone.
function clearOffer(ride) {
  if (!ride.offer) return;
  events.publish(`driver:${ride.offer.driverId}`, { topic: 'ride_taken' });
  ride.offer = null;
}

module.exports = { startDispatch, offerNext, refresh, sweep, clearOffer, RIDE_OFFER_SECONDS };
