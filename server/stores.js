const { db, uid } = require('./db');

// Kirana / general-store inventory domain.
//
// The unit of value here is TRUST IN THE STOCK NUMBER: a shopkeeper only keeps
// using this if the count on screen matches the shelf. So every change to stock
// goes through moveStock() and lands in an append-only ledger with a reason and
// an actor — the same discipline the money ledger uses, for the same reason.

// Units a Nepali general store actually sells in. `each` covers goto/ota.
const UNITS = {
  each: { label: 'pcs', step: 1 },
  kg: { label: 'kg', step: 0.5 },
  g: { label: 'g', step: 50 },
  l: { label: 'litre', step: 0.5 },
  ml: { label: 'ml', step: 100 },
  packet: { label: 'packet', step: 1 },
  dozen: { label: 'dozen', step: 1 },
  bottle: { label: 'bottle', step: 1 },
  sack: { label: 'bora', step: 1 }
};

const MAX_ITEMS_PER_STORE = 500; // a real kirana carries a few hundred lines
const STOCK_LEDGER_CAP = 20000;  // trimmed oldest-first; daily buckets carry history
const SALES_HISTORY_DAYS = 60;

function isUnit(u) {
  return Object.prototype.hasOwnProperty.call(UNITS, u);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function storeById(id) {
  return db.stores.find((s) => s.id === id);
}

function itemIn(store, itemId) {
  return store && store.items.find((i) => i.id === itemId);
}

// Only approved stores are visible to customers. Mirrors the listing review
// used by restaurants and hotels.
function storeIsLive(store) {
  return !!store && store.status === 'approved' && !store.removedAt;
}

// Open/closed is the shopkeeper's own switch — a store can be approved but shut
// for the evening, and customers should not be able to order into a closed shop.
function storeIsOpen(store) {
  return storeIsLive(store) && store.open !== false;
}

/**
 * The single way stock ever changes. Records an append-only movement so the
 * shopkeeper can always answer "where did my stock go?".
 * qty is signed: negative for sales, positive for restocks.
 */
function moveStock(store, item, { qty, reason, actorKind = 'partner', actorId = null, actorName = '', refId = null }) {
  const delta = Math.round(Number(qty) * 100) / 100;
  if (!Number.isFinite(delta) || delta === 0) return null;
  const before = Number(item.stock) || 0;
  const after = Math.round((before + delta) * 100) / 100;
  item.stock = Math.max(0, after);
  item.updatedAt = Date.now();

  // Sales feed the reorder analytics through bounded daily buckets rather than
  // an ever-growing per-item log.
  if (delta < 0 && (reason === 'sale_counter' || reason === 'order')) {
    item.salesDaily = item.salesDaily || {};
    const key = today();
    item.salesDaily[key] = Math.round(((item.salesDaily[key] || 0) + -delta) * 100) / 100;
    item.soldTotal = Math.round(((item.soldTotal || 0) + -delta) * 100) / 100;
    trimSalesHistory(item);
  }

  db.stockMoves.push({
    id: uid(),
    storeId: store.id,
    itemId: item.id,
    itemName: item.name,
    qty: delta,
    reason,
    stockAfter: item.stock,
    actorKind,
    actorId,
    actorName,
    refId,
    at: Date.now()
  });
  if (db.stockMoves.length > STOCK_LEDGER_CAP) {
    db.stockMoves.splice(0, db.stockMoves.length - STOCK_LEDGER_CAP);
  }
  return item.stock;
}

function trimSalesHistory(item) {
  const keys = Object.keys(item.salesDaily || {});
  if (keys.length <= SALES_HISTORY_DAYS) return;
  keys.sort();
  for (const k of keys.slice(0, keys.length - SALES_HISTORY_DAYS)) delete item.salesDaily[k];
}

// Average units sold per day over the trailing window, using only days since the
// item existed so a brand-new item is not judged against 30 days of zeroes.
function salesVelocity(item, days = 14) {
  const daily = item.salesDaily || {};
  const now = Date.now();
  let sold = 0;
  for (let i = 0; i < days; i += 1) {
    const key = new Date(now - i * 86400000).toISOString().slice(0, 10);
    sold += daily[key] || 0;
  }
  const ageDays = Math.max(1, Math.ceil((now - (item.createdAt || now)) / 86400000));
  return sold / Math.min(days, ageDays);
}

function lowStockThreshold(item) {
  if (Number.isFinite(item.lowStockAt)) return item.lowStockAt;
  // Sensible default: about a week of cover, floor of 3.
  return Math.max(3, Math.ceil(salesVelocity(item) * 7));
}

/**
 * What to buy next. Ranks by urgency — how many days of stock remain at the
 * current rate — so a fast-moving item with 5 left outranks a slow one with 2.
 */
function reorderSuggestions(store, limit = 20) {
  const out = [];
  for (const item of store.items) {
    if (item.archived) continue;
    const velocity = salesVelocity(item);
    const stock = Number(item.stock) || 0;
    const daysLeft = velocity > 0 ? stock / velocity : (stock > 0 ? Infinity : 0);
    const threshold = lowStockThreshold(item);
    const isLow = stock <= threshold;
    if (!isLow && daysLeft > 10) continue;
    out.push({
      itemId: item.id,
      name: item.name,
      unit: item.unit,
      stock,
      threshold,
      perDay: Math.round(velocity * 10) / 10,
      daysLeft: daysLeft === Infinity ? null : Math.round(daysLeft * 10) / 10,
      soldTotal: item.soldTotal || 0,
      // Order roughly two weeks of cover, rounded up, always at least 1.
      suggestedQty: Math.max(1, Math.ceil(velocity * 14) - Math.floor(stock)),
      outOfStock: stock <= 0
    });
  }
  out.sort((a, b) => {
    if (a.outOfStock !== b.outOfStock) return a.outOfStock ? -1 : 1;
    const ad = a.daysLeft === null ? 999 : a.daysLeft;
    const bd = b.daysLeft === null ? 999 : b.daysLeft;
    return ad - bd;
  });
  return out.slice(0, limit);
}

// Headline numbers for the shopkeeper's dashboard.
function storeStats(store) {
  const items = store.items.filter((i) => !i.archived);
  const lowStock = items.filter((i) => (Number(i.stock) || 0) <= lowStockThreshold(i));
  const stockValue = items.reduce((sum, i) => sum + (Number(i.stock) || 0) * (Number(i.price) || 0), 0);
  const key = today();
  const soldToday = items.reduce((sum, i) => sum + ((i.salesDaily || {})[key] || 0), 0);
  const revenueToday = items.reduce(
    (sum, i) => sum + ((i.salesDaily || {})[key] || 0) * (Number(i.price) || 0), 0
  );
  return {
    items: items.length,
    outOfStock: items.filter((i) => (Number(i.stock) || 0) <= 0).length,
    lowStock: lowStock.length,
    stockValue: Math.round(stockValue),
    soldToday: Math.round(soldToday * 10) / 10,
    revenueToday: Math.round(revenueToday)
  };
}

/* ---------------- helpers (staff a shopkeeper hires) ---------------- */

// A shopkeeper can bring in a helper to count shelves and add items. The helper
// uses their own customer account, so their work is attributed to them by name
// in the stock ledger — but they can never touch prices, delete items, or see
// the money side.
const HELPER_PERMS = ['items.add', 'items.stock'];

function helperFor(store, userId) {
  return (store.helpers || []).find((h) => h.userId === userId && h.status === 'active');
}

function canManageStore(store, { partnerId = null, userId = null }) {
  if (partnerId && store.ownerId === partnerId) return { role: 'owner' };
  if (userId && helperFor(store, userId)) return { role: 'helper' };
  return null;
}

function publicItem(item, { subscribedIds = new Set(), requestedIds = new Set() } = {}) {
  const subscribed = subscribedIds.has(item.id);
  const price = subscribed && item.subscribePrice ? item.subscribePrice : item.price;
  return {
    id: item.id,
    name: item.name,
    unit: item.unit,
    unitLabel: (UNITS[item.unit] || UNITS.each).label,
    price,
    listPrice: item.price,
    subscribePrice: item.subscribePrice || null,
    subscribed,
    // The caller has asked the shop to make this item subscribable and the shop
    // has not answered yet — the row shows "Requested ✓" instead of the CTA.
    subscribeRequested: requestedIds.has(item.id),
    category: item.category || '',
    photo: item.photo || '',
    inStock: (Number(item.stock) || 0) > 0,
    // Exact counts are the shopkeeper's business; customers see availability.
    lowStock: (Number(item.stock) || 0) > 0 && (Number(item.stock) || 0) <= 3
  };
}

function publicStore(store) {
  return {
    id: store.id,
    name: store.name,
    icon: store.icon || '🏪',
    area: store.area || '',
    loc: store.loc || null,
    photo: store.photo || '',
    open: store.open !== false,
    deliveryFee: store.deliveryFee || 0,
    itemCount: store.items.filter((i) => !i.archived && (Number(i.stock) || 0) > 0).length
  };
}

module.exports = {
  UNITS,
  MAX_ITEMS_PER_STORE,
  isUnit,
  storeById,
  itemIn,
  storeIsLive,
  storeIsOpen,
  moveStock,
  salesVelocity,
  lowStockThreshold,
  reorderSuggestions,
  storeStats,
  canManageStore,
  helperFor,
  HELPER_PERMS,
  publicItem,
  publicStore
};
