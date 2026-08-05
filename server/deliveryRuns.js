const { db, uid } = require('./db');
const { haversineKm } = require('./places');
const { driverIsAvailable, cashJobFitsFloat, ROAD_FACTOR } = require('./rideLogic');
const events = require('./events');

// Batched multi-stop courier runs.
//
// One shop order at a time is terrible economics in Kathmandu: a rider burns
// twenty minutes and a litre of petrol to carry one Rs 300 basket. So orders
// that are ready at nearby shops, going to nearby customers, are grouped into a
// single RUN — collect from two or three shops, drop to three or four homes, one
// trip.
//
// Two rules keep it honest:
//   * No order waits forever to fill a batch. A run dispatches as soon as it
//     hits the target size OR the oldest order in it has waited too long,
//     whichever comes first. A quiet afternoon must still get the food moving.
//   * A run is only offered to a courier whose cash float can cover the WHOLE
//     run's cash-on-delivery total. Checking the standing balance instead of the
//     projected one is exactly the hole an earlier review found in single
//     deliveries; batching multiplies the exposure, so it is checked up front.

function envNum(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

const BATCH_TARGET = envNum('DELIVERY_BATCH_TARGET', 6, 1, 10);        // orders per run
const MAX_ORDERS = 10; // hard per-run ceiling, whatever the env target says
const MAX_WAIT_MIN = envNum('DELIVERY_MAX_WAIT_MIN', 12, 0.01, 120);   // never strand an order
const PICKUP_RADIUS_KM = envNum('DELIVERY_PICKUP_RADIUS_KM', 2, 0.2, 15);
const DROP_RADIUS_KM = envNum('DELIVERY_DROP_RADIUS_KM', 3, 0.2, 20);
const OFFER_SECONDS = envNum('DELIVERY_OFFER_SECONDS', 25, 5, 120);
// How long a rider who let an offer lapse is skipped before being asked again.
const LAPSE_COOLDOWN_MS = envNum('DELIVERY_LAPSE_COOLDOWN_SEC', 45, 5, 600) * 1000;
// 16 lets a full 10-order run across a few shops fit (10 drops + up to 6 pickups).
const MAX_STOPS = envNum('DELIVERY_MAX_STOPS', 16, 2, 20);
// A run is only offered to riders actually near its first pickup. Offering the
// nearest of the whole city meant a rider 20 km out could be handed a Thamel
// run and burn the offer window (or the petrol) getting nowhere.
const OFFER_RADIUS_KM = envNum('DELIVERY_OFFER_RADIUS_KM', 6, 0.5, 50);

// Courier pay: a base for showing up, something per stop because stops are the
// real work, and distance for the long ones.
const RUN_BASE = envNum('COURIER_RUN_BASE', 40, 0, 500);
const PER_STOP = envNum('COURIER_PER_STOP', 15, 0, 200);
const PER_KM = envNum('COURIER_PER_KM', 12, 0, 200);

function storeOf(order) {
  return (db.stores || []).find((s) => s.id === order.storeId);
}

function pickupLocOf(order) {
  const store = storeOf(order);
  return store && store.loc && Number.isFinite(store.loc.lat) ? store.loc : null;
}

/** Orders packed and waiting for a courier, oldest first. */
function pendingOrders() {
  const claimed = new Set();
  for (const run of db.deliveryRuns || []) {
    if (run.status !== 'completed' && run.status !== 'cancelled') {
      for (const id of run.orderIds) claimed.add(id);
    }
  }
  return (db.storeOrders || [])
    .filter((o) => o.status === 'ready' && o.deliveryLoc && !claimed.has(o.id) && pickupLocOf(o))
    .sort((a, b) => (a.readyAt || a.createdAt) - (b.readyAt || b.createdAt));
}

function centroid(points) {
  if (!points.length) return null;
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lng: points.reduce((s, p) => s + p.lng, 0) / points.length
  };
}

/**
 * Greedy geographic clustering: seed with the longest-waiting order, then pull
 * in orders whose shop is near the seed's shop AND whose drop is near the
 * cluster's drop centroid. Both ends have to be close or the "batch" is just a
 * long detour wearing a batch's clothes.
 */
function buildCluster(seed, pool) {
  const cluster = [seed];
  const seedPickup = pickupLocOf(seed);
  for (const order of pool) {
    // BATCH_TARGET is the dispatch trigger; MAX_ORDERS is the ceiling a single
    // rider's bag (and sanity) can hold even if the env pushes the target up.
    if (order === seed || cluster.length >= Math.min(BATCH_TARGET, MAX_ORDERS)) continue;
    const pickup = pickupLocOf(order);
    if (!pickup) continue;
    if (haversineKm(seedPickup, pickup) > PICKUP_RADIUS_KM) continue;
    const dropCentre = centroid(cluster.map((o) => o.deliveryLoc));
    if (haversineKm(dropCentre, order.deliveryLoc) > DROP_RADIUS_KM) continue;
    // Distinct shops + one drop each must stay inside the stop budget.
    const shops = new Set([...cluster, order].map((o) => o.storeId));
    if (shops.size + cluster.length + 1 > MAX_STOPS) continue;
    cluster.push(order);
  }
  return cluster;
}

function waitedMinutes(order) {
  return (Date.now() - (order.readyAt || order.createdAt)) / 60000;
}

/** Nearest-neighbour ordering — good enough for 3-6 stops and instant to compute. */
function orderByNearest(points, from) {
  const remaining = [...points];
  const route = [];
  let cursor = from;
  while (remaining.length) {
    let best = 0;
    let bestKm = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const km = cursor ? haversineKm(cursor, remaining[i].loc) : 0;
      if (km < bestKm) { bestKm = km; best = i; }
    }
    const next = remaining.splice(best, 1)[0];
    route.push(next);
    cursor = next.loc;
  }
  return route;
}

/** Turn a cluster of orders into an ordered stop list: all pickups, then drops. */
function planStops(cluster, from) {
  const byStore = new Map();
  for (const order of cluster) {
    if (!byStore.has(order.storeId)) {
      byStore.set(order.storeId, {
        type: 'pickup',
        storeId: order.storeId,
        name: order.storeName,
        loc: pickupLocOf(order),
        orderIds: []
      });
    }
    byStore.get(order.storeId).orderIds.push(order.id);
  }
  const pickups = orderByNearest([...byStore.values()], from);
  const lastPickup = pickups.length ? pickups[pickups.length - 1].loc : from;
  const drops = orderByNearest(
    cluster.map((o) => ({
      type: 'dropoff',
      orderId: o.id,
      userId: o.userId,
      name: o.customerName,
      loc: o.deliveryLoc,
      cash: o.payment === 'cash' ? o.total : 0
    })),
    lastPickup
  );
  return [...pickups, ...drops].map((s, i) => ({ ...s, seq: i, done: false, doneAt: null }));
}

function routeDistanceKm(stops, from) {
  let km = 0;
  let cursor = from;
  for (const stop of stops) {
    if (cursor) km += haversineKm(cursor, stop.loc);
    cursor = stop.loc;
  }
  return Math.round(km * ROAD_FACTOR * 10) / 10;
}

function payoutFor(stops, distanceKm) {
  return Math.round(RUN_BASE + PER_STOP * stops.length + PER_KM * distanceKm);
}

function cashTotal(cluster) {
  return cluster.reduce((sum, o) => sum + (o.payment === 'cash' ? o.total : 0), 0);
}

// Cash a rider is already committed to collect on their current run but has not
// yet been debited for — the debit only lands as each drop completes, so the
// standing balance understates what they will be holding.
function committedRunCash(driverId) {
  const run = runForCourier(driverId);
  if (!run) return 0;
  return run.stops
    .filter((s) => s.type === 'dropoff' && !s.done)
    .reduce((sum, s) => sum + (s.cash || 0), 0);
}

// A rider mid-ride or mid-food-delivery is not free, and vice versa — the float
// is one rider's pocket, not one vertical's.
function courierOtherwiseBusy(driverId) {
  const { currentDelivery } = require('./orderLogic');
  if (currentDelivery(driverId)) return true;
  return (db.rides || []).some(
    (r) => r.driverId === driverId && (r.status === 'driver_en_route' || r.status === 'in_progress')
  );
}

/** Bike couriers who are online, free, and whose float covers this run's cash. */
function eligibleCouriers(runCash, near) {
  const busy = new Set();
  for (const run of db.deliveryRuns || []) {
    if (run.courierId && run.status !== 'completed' && run.status !== 'cancelled') busy.add(run.courierId);
  }
  return (db.drivers || [])
    .filter((d) => d.tier === 'bike' && driverIsAvailable(d) && !busy.has(d.id))
    .filter((d) => !courierOtherwiseBusy(d.id))
    .filter((d) => !(d.runNoShowUntil > Date.now()))
    // The courier will be holding every rupee of this run's cash at once.
    .filter((d) => cashJobFitsFloat(d, runCash))
    .map((d) => ({
      driver: d,
      km: near && Number.isFinite(d.currentLat)
        ? haversineKm({ lat: d.currentLat, lng: d.currentLng }, near)
        : 999
    }))
    // Only riders actually near the first pickup. A rider with no known
    // location scores 999 and is skipped too — we cannot show they are close.
    .filter((c) => !near || c.km <= OFFER_RADIUS_KM)
    .sort((a, b) => a.km - b.km);
}

/**
 * The batching sweep. Forms runs from ready orders and offers each to the
 * nearest suitable courier, cycling to the next when an offer lapses.
 * Returns how many state changes it made, so the caller knows to persist.
 */
function sweepDeliveryRuns() {
  let changed = 0;
  const now = Date.now();

  // 1. Expire lapsed offers and pass them along.
  //    A LAPSE IS NOT A REFUSAL. A rider who was mid-junction when the card
  //    appeared must still be able to get the run — treating silence as a
  //    permanent decline strands the order entirely when they are the only rider
  //    in the area. Only an explicit "Pass" is permanent; a lapse just moves the
  //    run on and puts that rider on a short cooldown.
  for (const run of db.deliveryRuns || []) {
    if (run.status !== 'offered' || !run.offer) continue;
    if (run.offer.expiresAt > now) continue;
    run.offer.passed = { ...(run.offer.passed || {}), [run.offer.driverId]: now };
    run.offer = { ...run.offer, driverId: null, expiresAt: 0 };
    run.status = 'forming';
    changed += 1;
  }

  // 2. Form new runs from orders that are packed and waiting. This happens
  //    BEFORE offering so a fresh run goes out on this pass rather than idling
  //    for a whole sweep interval — a rider waiting and an order going cold.
  const pool = pendingOrders();
  while (pool.length) {
    const seed = pool[0];
    const cluster = buildCluster(seed, pool);
    const ready = cluster.length >= BATCH_TARGET || waitedMinutes(seed) >= MAX_WAIT_MIN;
    if (!ready) break; // the seed is the oldest; if it can wait, so can the rest

    const from = pickupLocOf(seed);
    const stops = planStops(cluster, from);
    const distanceKm = routeDistanceKm(stops, from);
    const run = {
      id: uid(),
      status: 'forming',
      courierId: null,
      courier: null,
      orderIds: cluster.map((o) => o.id),
      stops,
      distanceKm,
      payout: payoutFor(stops, distanceKm),
      cashToCollect: cashTotal(cluster),
      offer: { driverId: null, expiresAt: 0, declined: [] },
      createdAt: now
    };
    db.deliveryRuns.push(run);
    changed += 1;
    for (const o of cluster) {
      const idx = pool.indexOf(o);
      if (idx >= 0) pool.splice(idx, 1);
    }
  }

  // 3. Offer every run that is waiting for a courier, including the ones just
  //    formed above.
  for (const run of db.deliveryRuns || []) {
    if (run.status !== 'forming') continue;
    const declined = new Set((run.offer && run.offer.declined) || []);
    const passed = (run.offer && run.offer.passed) || {};
    const all = eligibleCouriers(run.cashToCollect, run.stops[0] && run.stops[0].loc)
      .filter((c) => !declined.has(c.driver.id));
    // Prefer riders who have not just let this run lapse — but if they are the
    // only ones left, offer it again rather than letting the order die.
    const fresh = all.filter((c) => now - (passed[c.driver.id] || 0) > LAPSE_COOLDOWN_MS);
    const candidates = fresh.length ? fresh : all;
    if (!candidates.length) continue;
    run.status = 'offered';
    run.offer = {
      driverId: candidates[0].driver.id,
      expiresAt: now + OFFER_SECONDS * 1000,
      declined: [...declined],
      // Carry the lapse memory forward. Rebuilding the offer without it wiped
      // every cooldown the moment the run was re-offered, so the same distracted
      // rider could be handed the same run on the very next sweep, forever.
      passed
    };
    // Nudge the rider's app to fetch the offer now — a 25s window is mostly
    // gone by the time a 10s poll happens to notice it.
    events.publish(`driver:${run.offer.driverId}`, { topic: 'run_offer' });
    changed += 1;
  }

  return changed;
}

// A rider who accepts a run and then stops — goes offline, loses the phone,
// quits — used to strand it forever: nothing ever wrote 'cancelled' to a run, so
// its orders stayed claimed, the shop's money stayed pending, the customer's
// stock stayed reserved and the rider stayed marked busy. These deadlines give
// every run a way out, mirroring the food-delivery recovery.
// DELIVERY_ prefix to match the rest of this file's config; the low minimums are
// there so the recovery paths are testable in seconds rather than half an hour.
const RUN_PICKUP_DEADLINE_MS = envNum('DELIVERY_RUN_PICKUP_DEADLINE_MIN', 25, 0.01, 600) * 60000;
const RUN_DROPOFF_DEADLINE_MS = envNum('DELIVERY_RUN_DROPOFF_DEADLINE_MIN', 90, 0.01, 1440) * 60000;

// Releasing an abandoned run is only half the job: the rider who let it go dark
// is still online and still nearest the shop, so the very next sweep hands them
// the same orders back and the run dies again. Bench them for a while — the
// orders go to someone who will actually ride, and staff can see who did it.
const NO_SHOW_COOLDOWN_MS = envNum('DELIVERY_NO_SHOW_COOLDOWN_MIN', 15, 0.01, 720) * 60000;

function benchNoShow(driverId) {
  const driver = (db.drivers || []).find((d) => d.id === driverId);
  if (!driver) return;
  driver.runNoShowUntil = Date.now() + NO_SHOW_COOLDOWN_MS;
  driver.runNoShows = (driver.runNoShows || 0) + 1;
}

function lastActivityAt(run) {
  const done = run.stops.filter((s) => s.done && s.doneAt);
  return done.length ? Math.max(...done.map((s) => s.doneAt)) : (run.acceptedAt || run.createdAt);
}

function recoverAbandonedRuns() {
  const now = Date.now();
  let changed = 0;
  for (const run of db.deliveryRuns || []) {
    if (run.status !== 'collecting' && run.status !== 'delivering') continue;
    const nothingCollected = run.stops.every((s) => !s.done);
    const idleFor = now - lastActivityAt(run);

    if (nothingCollected && idleFor > RUN_PICKUP_DEADLINE_MS) {
      // Nothing has physically moved and no money settled — hand the whole run
      // back to the pool so another rider picks the orders up.
      run.status = 'cancelled';
      run.cancelledAt = now;
      run.cancelReason = 'courier_no_show';
      run.abandonedBy = run.courierId;
      benchNoShow(run.courierId);
      for (const orderId of run.orderIds) {
        const order = (db.storeOrders || []).find((o) => o.id === orderId);
        if (order && order.status === 'ready') {
          order.courierId = null;
          order.courier = null;
        }
      }
      changed += 1;
      continue;
    }

    if (!nothingCollected && idleFor > RUN_DROPOFF_DEADLINE_MS && !run.abandonedAt) {
      // Goods have left the shop. Only a human can resolve where they went, so
      // flag it for staff — but unpin the rider and release any order still
      // undelivered, so the rest of the system is not held hostage.
      run.abandonedAt = now;
      run.abandonedBy = run.courierId;
      run.status = 'cancelled';
      run.cancelledAt = now;
      run.cancelReason = 'courier_abandoned';
      benchNoShow(run.courierId);
      for (const orderId of run.orderIds) {
        const order = (db.storeOrders || []).find((o) => o.id === orderId);
        if (order && order.status !== 'delivered' && order.status !== 'cancelled') {
          order.needsAttention = 'courier_abandoned';
        }
      }
      changed += 1;
    }
  }
  return changed;
}

function runForCourier(driverId) {
  return (db.deliveryRuns || []).find(
    (r) => r.courierId === driverId && r.status !== 'completed' && r.status !== 'cancelled'
  );
}

function offeredRunFor(driverId) {
  return (db.deliveryRuns || []).find(
    (r) => r.status === 'offered' && r.offer && r.offer.driverId === driverId && r.offer.expiresAt > Date.now()
  );
}

function runContainingOrder(orderId) {
  return (db.deliveryRuns || []).find(
    (r) => r.orderIds.includes(orderId) && r.status !== 'cancelled'
  );
}

// What the courier sees: the next stop highlighted, the rest as a plan.
function runView(run) {
  if (!run) return null;
  const next = run.stops.find((s) => !s.done) || null;
  return {
    id: run.id,
    status: run.status,
    stops: run.stops.map((s) => ({
      seq: s.seq,
      type: s.type,
      name: s.name,
      loc: s.loc,
      orders: s.type === 'pickup' ? s.orderIds.length : 1,
      cash: s.cash || 0,
      done: s.done
    })),
    nextSeq: next ? next.seq : null,
    pickups: run.stops.filter((s) => s.type === 'pickup').length,
    dropoffs: run.stops.filter((s) => s.type === 'dropoff').length,
    orders: run.orderIds.length,
    distanceKm: run.distanceKm,
    payout: run.payout,
    cashToCollect: run.cashToCollect,
    expiresInSec: run.status === 'offered' && run.offer
      ? Math.max(0, Math.round((run.offer.expiresAt - Date.now()) / 1000))
      : null
  };
}

module.exports = {
  sweepDeliveryRuns,
  recoverAbandonedRuns,
  runForCourier,
  committedRunCash,
  courierOtherwiseBusy,
  offeredRunFor,
  runContainingOrder,
  runView,
  eligibleCouriers,
  planStops,
  routeDistanceKm,
  payoutFor,
  BATCH_TARGET,
  MAX_WAIT_MIN,
  OFFER_SECONDS
};
