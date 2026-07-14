// Sequential ride dispatch: instead of broadcasting a request to every online
// driver of the tier (first tap wins, accept-collisions at scale), the ride is
// OFFERED to one driver at a time — nearest pickup first. A driver holds the
// offer exclusively for RIDE_OFFER_SECONDS.
//
// An explicit decline is permanent (declinedDriverIds — never re-offered), but
// an offer that merely LAPSES is a soft pass (passedDriverIds): once every
// available driver has had a turn, the round resets and the cascade starts
// again. So a lone online driver who was slow to look keeps getting the
// request back until the search timeout refunds the customer (rideLogic) —
// instead of the ride silently dying after one missed 15s window.
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
  const skip = new Set([...(ride.declinedDriverIds || []), ...(ride.passedDriverIds || [])]);
  return db.drivers
    .filter((d) => driverIsAvailable(d, ride.tier) && !skip.has(d.id) && !driverBusy(d.id))
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
  ride.passedDriverIds = [];
  ride.offer = null;
  const [next] = candidatesFor(ride);
  if (next) offerTo(ride, next);
  save();
}

// The current holder's offer lapsed — soft pass: burn their turn for this
// round and move to the next-nearest. When the round runs dry, reset it so
// slow-but-willing drivers get another look.
function offerNext(ride) {
  if (ride.offer) {
    ride.passedDriverIds = [...(ride.passedDriverIds || []), ride.offer.driverId];
    ride.offer = null;
  }
  let [next] = candidatesFor(ride);
  if (!next && (ride.passedDriverIds || []).length) {
    ride.passedDriverIds = [];
    [next] = candidatesFor(ride);
  }
  if (next) offerTo(ride, next);
  save();
  events.publish('admin', { topic: 'rides' });
}

// The current holder explicitly declined — they are never offered this ride
// again, then the cascade continues as usual.
function declineOffer(ride) {
  if (ride.offer) {
    ride.declinedDriverIds = [...(ride.declinedDriverIds || []), ride.offer.driverId];
    ride.offer = null;
  }
  offerNext(ride);
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

module.exports = { startDispatch, offerNext, declineOffer, refresh, sweep, clearOffer, RIDE_OFFER_SECONDS };
