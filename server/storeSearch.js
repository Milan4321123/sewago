const { db } = require('./db');
const { haversineKm } = require('./places');

// Marketplace search across every shop.
//
// The naive version — loop every shop, loop every item, match the string — is
// O(shops × items) PER REQUEST. At 2,000 shops carrying 300 lines each that is
// 600,000 comparisons for one customer typing one letter.
//
// So item names live in an inverted index (token -> the items containing it) and
// shops in a geo grid (≈1 km cells -> the shops inside). A search touches only
// what can possibly match.
//
// Two decisions that make this actually fast, both learned from measuring:
//
//  1. Index rows hold DIRECT REFERENCES to the live store and item objects.
//     Looking them up by id instead meant a linear scan of every shop per
//     candidate, which made the "index" slower than no index at all. Because the
//     references are live, a sale or price change is visible immediately and
//     never needs re-indexing — only renames, adds and removals touch the index.
//
//  2. Every shop keeps its own key set, so removing a shop costs the size of
//     that shop rather than the size of the whole market. Without it, a full
//     rebuild was quadratic and took ten seconds.

const CELL = 0.01; // ~1.1 km at Kathmandu's latitude
const MIN_TOKEN = 2;
const SCAN_CEILING = 50000; // pathological-query guard, far above real result sets

const tokenIndex = new Map();   // token -> Set(key)
const entries = new Map();      // key -> { storeId, itemId, store, item, tokens }
const storeItems = new Map();   // storeId -> Set(key)
const cells = new Map();        // 'cellY:cellX' -> Set(storeId)
const storeCell = new Map();    // storeId -> cell key
const storesById = new Map();   // storeId -> store (approved only)

let built = false;

const keyOf = (storeId, itemId) => `${storeId}:${itemId}`;
const cellKey = (lat, lng) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;

// Product names split on any non-letter boundary — works for Devanagari and Latin.
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= MIN_TOKEN);
}

/* ---------------- maintenance ---------------- */

function dropKey(key) {
  const entry = entries.get(key);
  if (!entry) return;
  for (const t of entry.tokens) {
    const set = tokenIndex.get(t);
    if (set) {
      set.delete(key);
      if (!set.size) tokenIndex.delete(t);
    }
  }
  entries.delete(key);
  const own = storeItems.get(entry.storeId);
  if (own) own.delete(key);
}

function indexItem(store, item) {
  if (!store || !item) return;
  const key = keyOf(store.id, item.id);
  dropKey(key);
  if (item.archived || store.status !== 'approved' || store.removedAt) return;
  const tokens = [...new Set([...tokenize(item.name), ...tokenize(item.category)])];
  entries.set(key, { storeId: store.id, itemId: item.id, store, item, tokens });
  for (const t of tokens) {
    let set = tokenIndex.get(t);
    if (!set) { set = new Set(); tokenIndex.set(t, set); }
    set.add(key);
  }
  let own = storeItems.get(store.id);
  if (!own) { own = new Set(); storeItems.set(store.id, own); }
  own.add(key);
}

function removeItem(storeId, itemId) {
  dropKey(keyOf(storeId, itemId));
}

function unindexStore(storeId) {
  const own = storeItems.get(storeId);
  if (own) {
    for (const key of [...own]) dropKey(key);
    storeItems.delete(storeId);
  }
  const ck = storeCell.get(storeId);
  if (ck) {
    const set = cells.get(ck);
    if (set) {
      set.delete(storeId);
      if (!set.size) cells.delete(ck);
    }
    storeCell.delete(storeId);
  }
  storesById.delete(storeId);
}

function indexStore(store) {
  if (!store) return;
  unindexStore(store.id);
  if (store.status !== 'approved' || store.removedAt) return;
  storesById.set(store.id, store);
  const loc = store.loc;
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
    const ck = cellKey(loc.lat, loc.lng);
    let set = cells.get(ck);
    if (!set) { set = new Set(); cells.set(ck, set); }
    set.add(store.id);
    storeCell.set(store.id, ck);
  }
  for (const item of store.items || []) indexItem(store, item);
}

function rebuild() {
  tokenIndex.clear();
  entries.clear();
  storeItems.clear();
  cells.clear();
  storeCell.clear();
  storesById.clear();
  for (const store of db.stores || []) indexStore(store);
  built = true;
}

function ensureBuilt() {
  if (!built) rebuild();
}

function stats() {
  ensureBuilt();
  return { items: entries.size, tokens: tokenIndex.size, cells: cells.size, shops: storesById.size };
}

/* ---------------- query ---------------- */

// Exact token hit is O(1). A prefix ("chi" for "chini") scans the DISTINCT token
// list — a few thousand product words, never the items themselves.
function keysForToken(token) {
  const exact = tokenIndex.get(token);
  if (exact) return exact;
  const out = new Set();
  if (token.length < MIN_TOKEN) return out;
  for (const [t, set] of tokenIndex) {
    if (t.startsWith(token)) for (const k of set) out.add(k);
  }
  return out;
}

function usable(entry) {
  const { store, item } = entry;
  return store && item && !item.archived && !store.removedAt && store.status === 'approved';
}

function storeDistance(store, from) {
  if (!from || !store.loc || !Number.isFinite(store.loc.lat)) return null;
  return Math.round(haversineKm(from, store.loc) * 10) / 10;
}

/** Shop ids whose grid cell can possibly fall within radiusKm of a point. */
function nearbyStoreIds(lat, lng, radiusKm) {
  ensureBuilt();
  const span = Math.ceil(radiusKm / 1.1) + 1;
  const baseY = Math.floor(lat / CELL);
  const baseX = Math.floor(lng / CELL);
  const ids = new Set();
  for (let dy = -span; dy <= span; dy += 1) {
    for (let dx = -span; dx <= span; dx += 1) {
      const set = cells.get(`${baseY + dy}:${baseX + dx}`);
      if (set) for (const id of set) ids.add(id);
    }
  }
  return ids;
}

// Keys matching every token in the query (AND), or null for "no query".
function tokenKeysFor(tokens) {
  if (!tokens.length) return null;
  let keys = null;
  for (const t of tokens) {
    const hit = keysForToken(t);
    if (!keys) keys = hit; // first token: reuse the index's own Set, no copy
    else {
      const next = new Set();
      // Always walk the smaller side.
      const [small, large] = keys.size <= hit.size ? [keys, hit] : [hit, keys];
      for (const k of small) if (large.has(k)) next.add(k);
      keys = next;
    }
    if (!keys.size) break;
  }
  return keys || new Set();
}

// Does this item match every word the customer typed? Substring rather than
// whole-token, so "chin" finds "Chini" as they type.
function matchesTokens(item, tokens) {
  if (!tokens.length) return true;
  const name = item.name.toLowerCase();
  let cat = null; // only lowercased if the name misses — most items stop at the name
  for (const t of tokens) {
    if (name.includes(t)) continue;
    if (cat === null) cat = (item.category || '').toLowerCase();
    if (!cat.includes(t)) return false;
  }
  return true;
}

/**
 * Product search across every shop. Returns one row per shop that stocks a
 * matching item, so the client can show "Chini — Ram Kirana, 0.4 km, Rs 100".
 */
function searchItems({ q = '', lat = null, lng = null, radiusKm = 5, category = '', sort = 'near', inStockOnly = true, page = 1, limit = 20 } = {}) {
  ensureBuilt();
  const from = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  const tokens = tokenize(q);
  const rows = [];
  const push = (store, item, distanceKm) => {
    const stock = Number(item.stock) || 0;
    rows.push({
      itemId: item.id,
      name: item.name,
      unit: item.unit,
      price: item.price,
      subscribePrice: item.subscribePrice || null,
      category: item.category || '',
      photo: item.photo || '',
      inStock: stock > 0,
      lowStock: stock > 0 && stock <= 3,
      storeId: store.id,
      storeName: store.name,
      storeIcon: store.icon || '🏪',
      storeOpen: store.open !== false,
      distanceKm
    });
  };
  const keep = (item) => {
    if (item.archived) return false;
    if (category && (item.category || '').toLowerCase() !== category.toLowerCase()) return false;
    if (inStockOnly && (Number(item.stock) || 0) <= 0) return false;
    return matchesTokens(item, tokens);
  };

  const size = Math.min(50, Math.max(1, limit));
  const start = (Math.max(1, page) - 1) * size;
  let truncated = false;
  let complete = true;

  if (from) {
    // Located: walk the neighbourhood the grid handed us. Distance is computed
    // ONCE PER SHOP — doing it per item made this slower than no index at all.
    //
    // Shops are visited in the SAME order the results are finally sorted in
    // (open first, then nearest). That is what makes stopping early safe: once
    // the page is full we already hold the closest matches, not an arbitrary
    // slice. Scanning in cell order instead silently returned the wrong
    // thousand results out of five thousand.
    const shops = [];
    for (const id of nearbyStoreIds(from.lat, from.lng, radiusKm)) {
      const store = storesById.get(id);
      if (!store || !store.loc) continue;
      const exact = haversineKm(from, store.loc);
      if (exact > radiusKm) continue; // true distance, not the rounded one
      shops.push({ store, exact });
    }
    shops.sort((a, b) => {
      const ao = a.store.open !== false;
      const bo = b.store.open !== false;
      if (ao !== bo) return ao ? -1 : 1;
      return a.exact - b.exact;
    });

    const needed = start + size + 1; // +1 so hasMore is knowable
    let scanned = 0;
    for (const { store, exact } of shops) {
      const distanceKm = Math.round(exact * 10) / 10;
      for (const item of store.items || []) {
        if (++scanned > SCAN_CEILING) { truncated = true; break; }
        if (keep(item)) push(store, item, distanceKm);
      }
      if (truncated) { complete = false; break; }
      // Only the distance-ordered default can stop early; price and name sorts
      // need the whole radius before they can rank.
      if (sort === 'near' && rows.length >= needed) { complete = false; break; }
    }
  } else {
    // No location: the token index is the only thing keeping this bounded.
    const keys = tokens.length ? tokenKeysFor(tokens) : entries.keys();
    let scanned = 0;
    for (const key of keys) {
      if (++scanned > SCAN_CEILING) { truncated = true; complete = false; break; }
      const entry = entries.get(key);
      if (!entry || !usable(entry)) continue;
      if (keep(entry.item)) push(entry.store, entry.item, null);
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  if (sort === 'cheap') rows.sort((a, b) => a.price - b.price || byName(a, b));
  else if (sort === 'name') rows.sort(byName);
  else {
    rows.sort((a, b) => {
      // Open shops first, then nearest, then cheapest — what a shopper wants.
      if (a.storeOpen !== b.storeOpen) return a.storeOpen ? -1 : 1;
      const ad = a.distanceKm === null ? 9999 : a.distanceKm;
      const bd = b.distanceKm === null ? 9999 : b.distanceKm;
      return ad - bd || a.price - b.price;
    });
  }

  const slice = rows.slice(start, start + size);
  return {
    results: slice,
    // Only claim a total when the whole radius was actually examined — an
    // early exit knows its page is right but not how many more exist.
    total: complete ? rows.length : null,
    page: Math.max(1, page),
    pageSize: size,
    hasMore: complete ? start + size < rows.length : rows.length > start + size || !complete,
    truncated
  };
}

/** Shops near a point, nearest first — the "shops around me" list. */
function nearbyStores({ lat = null, lng = null, radiusKm = 5, limit = 30 } = {}) {
  ensureBuilt();
  const from = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  const list = from
    ? [...nearbyStoreIds(from.lat, from.lng, radiusKm)].map((id) => storesById.get(id)).filter(Boolean)
    : [...storesById.values()];
  return list
    .map((store) => ({ store, distanceKm: storeDistance(store, from) }))
    .filter((r) => !from || r.distanceKm === null || r.distanceKm <= radiusKm)
    .sort((a, b) => {
      const ao = a.store.open !== false;
      const bo = b.store.open !== false;
      if (ao !== bo) return ao ? -1 : 1;
      const ad = a.distanceKm === null ? 9999 : a.distanceKm;
      const bd = b.distanceKm === null ? 9999 : b.distanceKm;
      return ad - bd;
    })
    .slice(0, Math.min(60, limit));
}

/**
 * Categories in stock nearby, for the browse chips. Driven from the shops in
 * range rather than the whole market, so it stays cheap as the market grows.
 */
function categoriesNear({ lat = null, lng = null, radiusKm = 5 } = {}) {
  ensureBuilt();
  const from = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  const shops = from
    ? [...nearbyStoreIds(from.lat, from.lng, radiusKm)].map((id) => storesById.get(id)).filter(Boolean)
    : [...storesById.values()].slice(0, 200);
  const counts = new Map();
  for (const store of shops) {
    if (store.open === false) continue;
    for (const item of store.items || []) {
      if (item.archived || !item.category || (Number(item.stock) || 0) <= 0) continue;
      counts.set(item.category, (counts.get(item.category) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

module.exports = {
  indexItem, removeItem, indexStore, unindexStore, rebuild, ensureBuilt, stats,
  searchItems, nearbyStores, categoriesNear, storeDistance, tokenize
};
