const crypto = require('crypto');
const express = require('express');
const { db, save, uid } = require('../db');
const { config } = require('../config');
const { authRequired, publicUser } = require('./auth');
const partnerRoutes = require('./partner');
const { recordTxn, recordPlatformRevenue, debitWallet } = require('../payments');
const { STORE_COMMISSION_PCT, STORE_SERVICE_FEE } = require('../fees');
const { coordsFor } = require('../places');
const { resolveLocation } = require('../geo');
const { parseItemSpeech } = require('../voiceParse');
const { cleanupPhoto } = require('../photoAI');
const events = require('../events');
const { logAudit } = require('../audit');
const {
  UNITS, MAX_ITEMS_PER_STORE, isUnit, storeById, itemIn, storeIsLive, storeIsOpen,
  moveStock, reorderSuggestions, storeStats, lowStockThreshold, canManageStore,
  publicItem, publicStore
} = require('../stores');
const search = require('../storeSearch');
const ai = require('../ai');

const { authPartner, requirePartnerKyc, galleryFrom } = partnerRoutes;
const router = express.Router();

const MAX_ORDER_LINES = 40; // a grocery basket is longer than a food order
const PICKUP_CODE_MAX_TRIES = 5; // same cap the OTP flow uses — enough for fat fingers, useless for brute force

/* ---------------- shared helpers ---------------- */

// Resolve a store the caller is allowed to manage, as owner or as a hired helper.
function manageableStore(req, res, { helpersAllowed = true } = {}) {
  const store = storeById(req.params.id);
  if (!store || store.removedAt) {
    res.status(404).json({ error: 'Store not found.' });
    return null;
  }
  const who = canManageStore(store, {
    partnerId: req.partner ? req.partner.id : null,
    userId: req.user ? req.user.id : null
  });
  if (!who || (who.role === 'helper' && !helpersAllowed)) {
    res.status(403).json({ error: 'You do not manage this store.' });
    return null;
  }
  req.storeRole = who.role;
  return store;
}

function actorFrom(req) {
  if (req.storeRole === 'helper' && req.user) {
    return { actorKind: 'helper', actorId: req.user.id, actorName: req.user.name };
  }
  return { actorKind: 'partner', actorId: req.partner ? req.partner.id : null, actorName: req.partner ? req.partner.name : '' };
}

function subscribedItemIds(userId, storeId) {
  return new Set(
    db.itemSubscriptions
      .filter((s) => s.userId === userId && s.storeId === storeId && s.status === 'active')
      .map((s) => s.itemId)
  );
}

// Items this customer has asked the shop to make subscribable, still unanswered.
function pendingRequestItemIds(userId, storeId) {
  return new Set(
    db.subscriptionRequests
      .filter((r) => r.userId === userId && r.storeId === storeId && r.status === 'pending')
      .map((r) => r.itemId)
  );
}

function ownerOf(store) {
  return db.partners.find((p) => p.id === store.ownerId);
}

/* ---------------- voice ---------------- */

// Shared by the shopkeeper and helper flows: speech text in, item fields out.
// Never writes anything — the client always confirms before saving.
router.post('/stores/voice/parse', (req, res, next) => {
  // Either a partner or a customer (helper) may be speaking.
  if (req.headers.authorization) return next();
  res.status(401).json({ error: 'Please log in again.' });
}, (req, res) => {
  const { text, lines } = req.body || {};
  if (Array.isArray(lines)) {
    return res.json({ items: lines.slice(0, 50).map((l) => parseItemSpeech(l)) });
  }
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Say the item name, quantity and price.' });
  }
  res.json({ item: parseItemSpeech(text) });
});

/* ---------------- shopkeeper: the store itself ---------------- */

router.post('/partner/stores', authPartner, (req, res) => {
  if (!requirePartnerKyc(req, res)) return;
  const { name, area, icon, deliveryFee } = req.body || {};
  if (!name || String(name).trim().length < 2) {
    return res.status(400).json({ error: 'Your shop needs a name.' });
  }
  if (db.stores.some((s) => s.ownerId === req.partner.id && !s.removedAt && s.name.toLowerCase() === String(name).trim().toLowerCase())) {
    return res.status(409).json({ error: 'You already have a shop with that name.' });
  }
  const gallery = galleryFrom(req.partner, req.body || {});
  const spot = coordsFor(String(area || '').trim() || name);
  const store = {
    id: uid(),
    ownerId: req.partner.id,
    name: String(name).trim().slice(0, 60),
    area: String(area || '').trim().slice(0, 60),
    loc: { name: spot.name, lat: spot.lat, lng: spot.lng },
    icon: String(icon || '🏪').slice(0, 8),
    photo: gallery.photo,
    photos: gallery.photos,
    deliveryFee: Math.min(200, Math.max(0, Math.round(Number(deliveryFee) || 0))),
    open: true,
    items: [],
    helpers: [],
    status: 'pending', // staff review, same as every other listing
    reviewNote: '',
    submittedAt: Date.now()
  };
  db.stores.push(store);
  save();
  events.publish('admin', { topic: 'queue' });
  res.json({ store });
});

router.get('/partner/stores', authPartner, (req, res) => {
  const stores = db.stores
    .filter((s) => s.ownerId === req.partner.id && !s.removedAt)
    .map((s) => ({
      ...publicStore(s),
      status: s.status,
      locPinned: !!s.locPinned,
      reviewNote: s.reviewNote || '',
      stats: storeStats(s),
      helpers: (s.helpers || []).filter((h) => h.status === 'active').length
    }));
  res.json({ stores });
});

// Open/closed and the delivery fee are the two things a shopkeeper changes daily.
router.patch('/partner/stores/:id', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const body = req.body || {};
  if (body.open !== undefined) store.open = !!body.open;
  if (body.deliveryFee !== undefined) {
    store.deliveryFee = Math.min(200, Math.max(0, Math.round(Number(body.deliveryFee) || 0)));
  }
  if (body.name && String(body.name).trim().length >= 2) store.name = String(body.name).trim().slice(0, 60);
  if (body.icon) store.icon = String(body.icon).slice(0, 8);
  // A precise pin dropped from the shop's own phone beats a typed area name —
  // this is what puts the shop on the customer's map and in "near me".
  if (body.lat !== undefined && body.lng !== undefined) {
    const resolved = resolveLocation({ lat: body.lat, lng: body.lng, name: body.locName || store.area || store.name });
    if (resolved.error === 'outside') {
      return res.status(400).json({ error: 'That location is outside the service area.' });
    }
    if (resolved.error) return res.status(400).json({ error: 'Could not read that location.' });
    store.loc = { name: resolved.name, lat: resolved.lat, lng: resolved.lng };
    store.locPinned = true;
  }
  search.indexStore(store); // re-cell the shop if it moved
  save();
  res.json({ store: { ...publicStore(store), status: store.status } });
});

/* ---------------- shopkeeper: inventory ---------------- */

router.get('/partner/stores/:id/inventory', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const q = String(req.query.q || '').trim().toLowerCase();
  const items = store.items
    .filter((i) => !i.archived)
    .filter((i) => !q || i.name.toLowerCase().includes(q) || (i.category || '').toLowerCase().includes(q))
    .map((i) => ({
      id: i.id,
      name: i.name,
      unit: i.unit,
      unitLabel: (UNITS[i.unit] || UNITS.each).label,
      price: i.price,
      subscribePrice: i.subscribePrice || null,
      stock: i.stock,
      lowStockAt: lowStockThreshold(i),
      low: (Number(i.stock) || 0) <= lowStockThreshold(i),
      category: i.category || '',
      photo: i.photo || '',
      soldTotal: i.soldTotal || 0
    }))
    .sort((a, b) => Number(b.low) - Number(a.low) || a.name.localeCompare(b.name));
  res.json({ items, stats: storeStats(store), units: UNITS, open: store.open !== false, status: store.status });
});

// Add one item. Accepts the output of the voice parser directly, so the confirm
// screen posts exactly what the shopkeeper saw.
// canPrice=false for helpers: they may add a line they found on the shelf, but
// must never be able to rewrite the price of something the shop already sells.
// (The restock branch below silently did exactly that, and with qty 0 moveStock
// records nothing — so the shopkeeper had no trace of the change at all.)
function addItem(store, body, actor, { canPrice = true } = {}) {
  const name = String(body.name || '').trim();
  const price = Math.round(Number(body.price));
  const unit = isUnit(body.unit) ? body.unit : 'each';
  const stock = Number(body.stock ?? body.qty ?? 0);
  if (name.length < 1 || name.length > 60) return { error: 'Item needs a name.' };
  if (!Number.isFinite(price) || price < 1 || price > 100000) {
    return { error: 'Price must be between Rs 1 and Rs 100,000.' };
  }
  if (!Number.isFinite(stock) || stock < 0 || stock > 100000) return { error: 'Enter a valid quantity.' };
  if (store.items.filter((i) => !i.archived).length >= MAX_ITEMS_PER_STORE) {
    return { error: `A shop can hold ${MAX_ITEMS_PER_STORE} items.` };
  }
  const dup = store.items.find((i) => !i.archived && i.name.toLowerCase() === name.toLowerCase() && i.unit === unit);
  if (dup) {
    // Saying an item you already stock is a restock, not a duplicate line —
    // this is what happens naturally during a shelf count.
    moveStock(store, dup, { qty: stock, reason: 'restock', refId: null, ...actor });
    if (canPrice && Number.isFinite(price) && price > 0 && price !== dup.price) {
      // A price change leaves no stock movement, so record it explicitly or it
      // would be invisible in the shop's history.
      logAudit({
        actor: { role: actor.actorKind, id: actor.actorId, email: actor.actorName },
        action: 'store.item.price_change',
        targetType: 'store_item',
        targetId: dup.id,
        meta: { storeId: store.id, name: dup.name, from: dup.price, to: price }
      });
      dup.price = price;
    }
    return { item: dup, restocked: true };
  }
  const subscribePrice = Number(body.subscribePrice);
  const item = {
    id: uid(),
    name,
    unit,
    price,
    subscribePrice: Number.isFinite(subscribePrice) && subscribePrice > 0 && subscribePrice < price
      ? Math.round(subscribePrice)
      : null,
    stock: 0,
    lowStockAt: Number.isFinite(Number(body.lowStockAt)) ? Number(body.lowStockAt) : null,
    category: String(body.category || '').trim().slice(0, 40),
    photo: '',
    photos: [],
    salesDaily: {},
    soldTotal: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  store.items.push(item);
  if (stock > 0) moveStock(store, item, { qty: stock, reason: 'initial_count', ...actor });
  search.indexItem(store, item);
  return { item };
}

router.post('/partner/stores/:id/items', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const result = addItem(store, req.body || {}, actorFrom(req));
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  res.json({ item: result.item, restocked: !!result.restocked });
});

// A voice shelf-count produces many lines at once. Partial success is the point:
// eight good rows should not be lost because the ninth was mis-heard.
router.post('/partner/stores/:id/items/bulk', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const rows = Array.isArray((req.body || {}).items) ? (req.body || {}).items.slice(0, 100) : [];
  if (!rows.length) return res.status(400).json({ error: 'Nothing to add.' });
  const actor = actorFrom(req);
  const added = [];
  const failed = [];
  for (const row of rows) {
    const result = addItem(store, row, actor);
    if (result.error) failed.push({ name: row.name || '', error: result.error });
    else added.push({ id: result.item.id, name: result.item.name, restocked: !!result.restocked });
  }
  save();
  res.json({ added, failed, stats: storeStats(store) });
});

router.patch('/partner/stores/:id/items/:itemId', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const item = itemIn(store, req.params.itemId);
  if (!item || item.archived) return res.status(404).json({ error: 'Item not found.' });
  const body = req.body || {};
  if (body.name && String(body.name).trim()) item.name = String(body.name).trim().slice(0, 60);
  if (body.price !== undefined) {
    const p = Math.round(Number(body.price));
    if (!Number.isFinite(p) || p < 1 || p > 100000) return res.status(400).json({ error: 'Price must be between Rs 1 and Rs 100,000.' });
    item.price = p;
  }
  if (body.subscribePrice !== undefined) {
    const sp = Math.round(Number(body.subscribePrice));
    // A subscriber price above the shelf price would be a worse deal, not an offer.
    item.subscribePrice = Number.isFinite(sp) && sp > 0 && sp < item.price ? sp : null;
  }
  if (body.unit !== undefined && isUnit(body.unit)) item.unit = body.unit;
  if (body.category !== undefined) item.category = String(body.category).trim().slice(0, 40);
  if (body.lowStockAt !== undefined) {
    const t = Number(body.lowStockAt);
    item.lowStockAt = Number.isFinite(t) && t >= 0 ? t : null;
  }
  if (body.photo !== undefined || body.photos !== undefined) {
    const gallery = galleryFrom(req.partner, body);
    item.photo = gallery.photo;
    item.photos = gallery.photos;
  }
  item.updatedAt = Date.now();
  search.indexItem(store, item); // a rename or recategorise changes what it matches
  save();
  res.json({ item });
});

router.delete('/partner/stores/:id/items/:itemId', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const item = itemIn(store, req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  // Archive rather than delete: past orders and the stock ledger still name it.
  item.archived = true;
  item.updatedAt = Date.now();
  search.removeItem(store.id, item.id);
  save();
  res.json({ ok: true });
});

// The single most-used button in the shop: someone bought something over the
// counter. One tap, stock down, sale recorded for the reorder maths.
router.post('/partner/stores/:id/items/:itemId/sold', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const item = itemIn(store, req.params.itemId);
  if (!item || item.archived) return res.status(404).json({ error: 'Item not found.' });
  const qty = Number((req.body || {}).qty);
  const sell = Number.isFinite(qty) && qty > 0 ? qty : 1;
  if ((Number(item.stock) || 0) < sell) {
    return res.status(400).json({ error: `Only ${item.stock} ${(UNITS[item.unit] || UNITS.each).label} left — correct the count first.` });
  }
  moveStock(store, item, { qty: -sell, reason: 'sale_counter', ...actorFrom(req) });
  save();
  res.json({ item: { id: item.id, stock: item.stock }, stats: storeStats(store) });
});

router.post('/partner/stores/:id/items/:itemId/restock', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const item = itemIn(store, req.params.itemId);
  if (!item || item.archived) return res.status(404).json({ error: 'Item not found.' });
  const qty = Number((req.body || {}).qty);
  if (!Number.isFinite(qty) || qty === 0 || Math.abs(qty) > 100000) {
    return res.status(400).json({ error: 'Enter how many you received.' });
  }
  moveStock(store, item, { qty, reason: qty > 0 ? 'restock' : 'correction', ...actorFrom(req) });
  save();
  res.json({ item: { id: item.id, stock: item.stock }, stats: storeStats(store) });
});

router.get('/partner/stores/:id/reorder', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  res.json({ suggestions: reorderSuggestions(store), stats: storeStats(store) });
});

// "Where did my stock go?" — the shopkeeper's audit trail.
router.get('/partner/stores/:id/moves', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const moves = db.stockMoves
    .filter((m) => m.storeId === store.id)
    .slice(-60)
    .reverse();
  res.json({ moves });
});

/* ---------------- shopkeeper: AI inventory assistant ---------------- */

// The model is not free, so each partner gets a small per-minute budget —
// enough for a real session, useless for a scripted loop. In-memory on purpose:
// a restart forgiving the count is fine for a soft limit.
const AI_DRAFT_LIMIT = 10;
const aiDraftCalls = new Map(); // partnerId -> timestamps within the last minute

function aiRateLimited(partnerId) {
  const now = Date.now();
  const recent = (aiDraftCalls.get(partnerId) || []).filter((t) => now - t < 60000);
  if (recent.length >= AI_DRAFT_LIMIT) {
    aiDraftCalls.set(partnerId, recent);
    return true;
  }
  recent.push(now);
  aiDraftCalls.set(partnerId, recent);
  return false;
}

// Free text in, DRAFT rows out — nothing is written here. The client shows the
// drafts in the same editable review table the voice flow uses and commits the
// approved rows through POST /partner/stores/:id/items/bulk (where a duplicate
// name+unit is a restock, which is exactly right for "restock what's low").
router.post('/partner/stores/:id/ai/inventory', authPartner, async (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  if (!ai.aiEnabled()) {
    // The client hides the assistant card on this exact status.
    return res.status(503).json({ error: 'AI assistant is not configured on this server.' });
  }
  const prompt = String((req.body || {}).prompt || '').trim();
  if (prompt.length < 3 || prompt.length > 2000) {
    return res.status(400).json({ error: 'Describe what to add or restock (3-2000 characters).' });
  }
  if (aiRateLimited(req.partner.id)) {
    return res.status(429).json({ error: 'Too many AI requests — wait a minute and try again.' });
  }
  try {
    const result = await ai.draftInventory({ prompt, store });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ items: result.items, note: result.note });
  } catch (err) {
    res.status(502).json({ error: 'The AI assistant could not be reached — try again.' });
  }
});

/* ---------------- shopkeeper: helpers ---------------- */

router.post('/partner/stores/:id/helpers', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  store.helpers = store.helpers || [];
  if (store.helpers.filter((h) => h.status === 'active' || h.status === 'invited').length >= 5) {
    return res.status(400).json({ error: 'A shop can have up to 5 helpers.' });
  }
  const invite = {
    code: String(Math.floor(100000 + Math.random() * 900000)),
    status: 'invited',
    userId: null,
    name: String((req.body || {}).name || '').trim().slice(0, 40),
    createdAt: Date.now()
  };
  store.helpers.push(invite);
  save();
  res.json({ invite: { code: invite.code, name: invite.name } });
});

router.get('/partner/stores/:id/helpers', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  res.json({
    helpers: (store.helpers || []).map((h) => ({
      code: h.status === 'invited' ? h.code : null,
      name: h.name || '',
      status: h.status,
      userId: h.userId,
      joinedAt: h.joinedAt || null
    }))
  });
});

router.delete('/partner/stores/:id/helpers/:code', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const helper = (store.helpers || []).find((h) => h.code === req.params.code);
  if (!helper) return res.status(404).json({ error: 'Helper not found.' });
  helper.status = 'revoked';
  helper.revokedAt = Date.now();
  save();
  res.json({ ok: true });
});

// A helper joins with the code the shopkeeper read out to them, using their own
// customer account — so their counting work is attributed to them by name.
router.post('/stores/helper/join', authRequired, (req, res) => {
  const code = String((req.body || {}).code || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code from the shopkeeper.' });
  const store = db.stores.find((s) => !s.removedAt && (s.helpers || []).some((h) => h.code === code && h.status === 'invited'));
  if (!store) return res.status(404).json({ error: 'That code is not valid any more.' });
  const helper = store.helpers.find((h) => h.code === code);
  helper.status = 'active';
  helper.userId = req.user.id;
  helper.name = helper.name || req.user.name;
  helper.joinedAt = Date.now();
  save();
  events.publish(`partner:${store.ownerId}`, { topic: 'stores' });
  res.json({ store: publicStore(store) });
});

router.get('/stores/helper/assignments', authRequired, (req, res) => {
  const stores = db.stores
    .filter((s) => !s.removedAt && (s.helpers || []).some((h) => h.userId === req.user.id && h.status === 'active'))
    .map((s) => ({ ...publicStore(s), itemsToCount: s.items.filter((i) => !i.archived).length }));
  res.json({ stores });
});

// Helpers may add items and correct counts — never prices, never deletions.
router.post('/stores/:id/helper/items', authRequired, (req, res) => {
  const store = manageableStore(req, res);
  if (!store || req.storeRole !== 'helper') {
    if (!res.headersSent) res.status(403).json({ error: 'You do not help at this store.' });
    return;
  }
  const result = addItem(store, req.body || {}, actorFrom(req), { canPrice: false });
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  events.publish(`partner:${store.ownerId}`, { topic: 'stores' });
  res.json({ item: { id: result.item.id, name: result.item.name, stock: result.item.stock }, restocked: !!result.restocked });
});

router.post('/stores/:id/helper/items/:itemId/count', authRequired, (req, res) => {
  const store = manageableStore(req, res);
  if (!store || req.storeRole !== 'helper') {
    if (!res.headersSent) res.status(403).json({ error: 'You do not help at this store.' });
    return;
  }
  const item = itemIn(store, req.params.itemId);
  if (!item || item.archived) return res.status(404).json({ error: 'Item not found.' });
  const counted = Number((req.body || {}).stock);
  if (!Number.isFinite(counted) || counted < 0 || counted > 100000) {
    return res.status(400).json({ error: 'Enter the number you counted on the shelf.' });
  }
  const delta = counted - (Number(item.stock) || 0);
  if (delta !== 0) moveStock(store, item, { qty: delta, reason: 'stock_take', ...actorFrom(req) });
  save();
  events.publish(`partner:${store.ownerId}`, { topic: 'stores' });
  res.json({ item: { id: item.id, stock: item.stock } });
});

/* ---------------- shopkeeper: subscription requests ---------------- */

// The inbox of customers asking for a subscriber price. Pending first, newest
// first; per-item pending counts let the inventory list badge the items people
// are actually asking about.
router.get('/partner/stores/:id/subscribe-requests', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const requests = db.subscriptionRequests
    .filter((r) => r.storeId === store.id)
    .sort((a, b) =>
      (Number(b.status === 'pending') - Number(a.status === 'pending')) || b.createdAt - a.createdAt)
    .slice(0, 100);
  const pendingByItem = {};
  for (const r of requests) {
    if (r.status === 'pending') pendingByItem[r.itemId] = (pendingByItem[r.itemId] || 0) + 1;
  }
  res.json({ requests, pendingByItem });
});

router.post('/partner/stores/:id/subscribe-requests/:reqId/accept', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const request = db.subscriptionRequests.find((r) => r.id === req.params.reqId && r.storeId === store.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'This request was already answered.' });
  const item = itemIn(store, request.itemId);
  if (!item || item.archived) return res.status(404).json({ error: 'That item is no longer sold here.' });
  const sp = Math.round(Number((req.body || {}).subscribePrice));
  // Same bound the item PATCH enforces: at or above the shelf price is a worse
  // deal, not an offer — and the price is validated HERE, never trusted later.
  if (!Number.isFinite(sp) || sp <= 0 || sp >= item.price) {
    return res.status(400).json({ error: `Subscriber price must be between Rs 1 and Rs ${item.price - 1}.` });
  }
  item.subscribePrice = sp;
  item.updatedAt = Date.now();
  request.status = 'accepted';
  request.decidedAt = Date.now();
  save();
  // "The shop accepted — subscribe now" lands on the customer's app instantly.
  events.publish(`user:${request.userId}`, { topic: 'subscription' });
  res.json({ request, item: { id: item.id, subscribePrice: item.subscribePrice } });
});

router.post('/partner/stores/:id/subscribe-requests/:reqId/decline', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const request = db.subscriptionRequests.find((r) => r.id === req.params.reqId && r.storeId === store.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'This request was already answered.' });
  request.status = 'declined';
  request.decidedAt = Date.now();
  save();
  res.json({ request });
});

/* ---------------- customer: browse ---------------- */

// Where the customer is, if their phone shared it. Everything else degrades
// gracefully to "no distance" rather than failing.
function pointFrom(query) {
  const lat = Number(query.lat);
  const lng = Number(query.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : { lat: null, lng: null };
}

function radiusFrom(query) {
  const r = Number(query.radiusKm);
  return Number.isFinite(r) && r > 0 ? Math.min(25, r) : 5;
}

// "What do you need?" — search products across every shop at once. This is the
// front door of the marketplace, so it is index-backed and paginated.
router.get('/store-search', authRequired, (req, res) => {
  const { lat, lng } = pointFrom(req.query);
  const out = search.searchItems({
    q: String(req.query.q || '').slice(0, 60),
    lat, lng,
    radiusKm: radiusFrom(req.query),
    category: String(req.query.category || '').slice(0, 40),
    sort: ['near', 'cheap', 'name'].includes(req.query.sort) ? req.query.sort : 'near',
    inStockOnly: req.query.inStock !== 'all',
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 20
  });
  res.json({ ...out, serviceFee: STORE_SERVICE_FEE });
});

router.get('/store-categories', authRequired, (req, res) => {
  const { lat, lng } = pointFrom(req.query);
  res.json({ categories: search.categoriesNear({ lat, lng, radiusKm: radiusFrom(req.query) }) });
});

router.get('/stores', authRequired, (req, res) => {
  const { lat, lng } = pointFrom(req.query);
  const rows = search.nearbyStores({ lat, lng, radiusKm: radiusFrom(req.query), limit: Number(req.query.limit) || 30 });
  const stores = rows.map((r) => ({ ...publicStore(r.store), distanceKm: r.distanceKm }));
  res.json({ stores, serviceFee: STORE_SERVICE_FEE, located: lat !== null });
});

router.get('/stores/:id', authRequired, (req, res) => {
  const store = storeById(req.params.id);
  if (!storeIsLive(store)) return res.status(404).json({ error: 'Shop not found.' });
  const { lat, lng } = pointFrom(req.query);
  const distanceKm = search.storeDistance(store, Number.isFinite(lat) ? { lat, lng } : null);
  const subs = subscribedItemIds(req.user.id, store.id);
  const requested = pendingRequestItemIds(req.user.id, store.id);
  const items = store.items
    .filter((i) => !i.archived)
    .map((i) => publicItem(i, { subscribedIds: subs, requestedIds: requested }))
    .sort((a, b) => Number(b.inStock) - Number(a.inStock) || a.name.localeCompare(b.name));
  res.json({ store: { ...publicStore(store), distanceKm }, items, serviceFee: STORE_SERVICE_FEE });
});

/* ---------------- customer: subscriptions ---------------- */

// Subscribing is a standing interest in an item, and it unlocks the shopkeeper's
// subscriber price. Discount is applied server-side at order time, never trusted
// from the client.
router.post('/stores/:id/items/:itemId/subscribe', authRequired, (req, res) => {
  const store = storeById(req.params.id);
  if (!storeIsLive(store)) return res.status(404).json({ error: 'Shop not found.' });
  const item = itemIn(store, req.params.itemId);
  if (!item || item.archived) return res.status(404).json({ error: 'Item not found.' });
  if (!item.subscribePrice) {
    return res.status(400).json({ error: 'This item does not have a subscriber price yet.' });
  }
  const existing = db.itemSubscriptions.find(
    (s) => s.userId === req.user.id && s.itemId === item.id && s.status === 'active'
  );
  if (existing) return res.json({ subscription: existing });
  const everyDays = Math.min(90, Math.max(1, Math.round(Number((req.body || {}).everyDays) || 7)));
  const subscription = {
    id: uid(),
    userId: req.user.id,
    storeId: store.id,
    storeName: store.name,
    itemId: item.id,
    itemName: item.name,
    everyDays,
    price: item.subscribePrice,
    listPrice: item.price,
    status: 'active',
    createdAt: Date.now(),
    nextDueAt: Date.now() + everyDays * 86400000
  };
  db.itemSubscriptions.push(subscription);
  save();
  res.json({ subscription });
});

// A customer asks the shop to put a subscriber price on an item that has none.
// The shopkeeper answers from their app; acceptance is pushed back over SSE so
// the customer can subscribe the moment the offer exists.
router.post('/stores/:id/items/:itemId/subscribe-request', authRequired, (req, res) => {
  const store = storeById(req.params.id);
  if (!storeIsLive(store)) return res.status(404).json({ error: 'Shop not found.' });
  const item = itemIn(store, req.params.itemId);
  if (!item || item.archived) return res.status(404).json({ error: 'Item not found.' });
  if (item.subscribePrice) {
    return res.status(400).json({ error: 'This item already has a subscriber price — just subscribe.' });
  }
  const pending = db.subscriptionRequests.find(
    (r) => r.userId === req.user.id && r.itemId === item.id && r.status === 'pending'
  );
  if (pending) {
    return res.status(409).json({ error: 'You have already asked — the shop has not answered yet.' });
  }
  const request = {
    id: uid(),
    userId: req.user.id,
    userName: req.user.name,
    storeId: store.id,
    itemId: item.id,
    itemName: item.name,
    status: 'pending',
    createdAt: Date.now()
  };
  db.subscriptionRequests.push(request);
  save();
  events.publish(`partner:${store.ownerId}`, { topic: 'subscribe_requests' });
  res.json({ request });
});

router.delete('/stores/:id/items/:itemId/subscribe', authRequired, (req, res) => {
  const sub = db.itemSubscriptions.find(
    (s) => s.userId === req.user.id && s.itemId === req.params.itemId && s.status === 'active'
  );
  if (!sub) return res.status(404).json({ error: 'You are not subscribed to this item.' });
  sub.status = 'cancelled';
  sub.cancelledAt = Date.now();
  save();
  res.json({ ok: true });
});

router.get('/subscriptions', authRequired, (req, res) => {
  const subs = db.itemSubscriptions
    .filter((s) => s.userId === req.user.id && s.status === 'active')
    .map((s) => {
      const store = storeById(s.storeId);
      const item = store && itemIn(store, s.itemId);
      return {
        id: s.id,
        storeId: s.storeId,
        storeName: s.storeName,
        itemId: s.itemId,
        itemName: s.itemName,
        everyDays: s.everyDays,
        // Always read the CURRENT prices — a stale locked price would mislead.
        price: item && item.subscribePrice ? item.subscribePrice : s.price,
        listPrice: item ? item.price : s.listPrice,
        available: !!(item && !item.archived && (Number(item.stock) || 0) > 0 && storeIsOpen(store)),
        dueSoon: Date.now() >= (s.nextDueAt || 0) - 86400000
      };
    });
  res.json({ subscriptions: subs });
});

/* ---------------- customer: ordering ---------------- */

router.post('/store-orders', authRequired, (req, res) => {
  const { storeId, items, payment, deliverTo, fulfilment } = req.body || {};
  const pickup = fulfilment === 'pickup';
  const store = storeById(storeId);
  if (!storeIsLive(store)) return res.status(404).json({ error: 'Shop not found.' });
  if (!storeIsOpen(store)) return res.status(409).json({ error: `${store.name} is closed right now.` });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Your basket is empty.' });
  if (items.length > MAX_ORDER_LINES) {
    return res.status(400).json({ error: `An order can contain at most ${MAX_ORDER_LINES} different items.` });
  }

  // Aggregate duplicates so the per-line checks actually bind.
  const wanted = new Map();
  for (const line of items) {
    const qty = Number(line && line.qty);
    if (!line || !line.itemId || !Number.isFinite(qty) || qty <= 0 || qty > 1000) {
      return res.status(400).json({ error: 'Invalid item in your basket.' });
    }
    wanted.set(line.itemId, (wanted.get(line.itemId) || 0) + qty);
  }

  const subs = subscribedItemIds(req.user.id, store.id);
  const lines = [];
  let subtotal = 0;
  for (const [itemId, qty] of wanted) {
    const item = itemIn(store, itemId);
    if (!item || item.archived) return res.status(404).json({ error: 'An item in your basket is no longer sold here.' });
    if ((Number(item.stock) || 0) < qty) {
      return res.status(409).json({ error: `${item.name}: only ${item.stock} ${(UNITS[item.unit] || UNITS.each).label} left.` });
    }
    // Subscriber price is decided here, from the server's own record.
    const subscribed = subs.has(item.id) && !!item.subscribePrice;
    const unitPrice = subscribed ? item.subscribePrice : item.price;
    subtotal += unitPrice * qty;
    lines.push({
      itemId: item.id, name: item.name, unit: item.unit, qty,
      price: unitPrice, listPrice: item.price, subscribed
    });
  }

  // Click & collect: the customer walks in, so there is nothing to deliver
  // and nothing to charge for delivering.
  const deliveryFee = pickup ? 0 : (store.deliveryFee || 0);
  const payMethod = payment === 'cash' ? 'cash' : 'wallet';
  const serviceFee = payMethod === 'wallet' ? STORE_SERVICE_FEE : 0;
  const total = subtotal + deliveryFee + serviceFee;
  if (payMethod === 'wallet' && req.user.wallet < total) {
    return res.status(402).json({ error: 'Not enough wallet balance. Top up, or pay cash on delivery.' });
  }

  // A pickup order must never carry a delivery location: the courier sweep
  // treats "ready + deliveryLoc" as a job, and this order is not one.
  let deliveryLoc = null;
  if (!pickup && deliverTo) {
    const resolved = resolveLocation(deliverTo);
    if (resolved.error === 'outside') return res.status(400).json({ error: 'That delivery point is outside the service area.' });
    if (!resolved.error) deliveryLoc = { name: resolved.name, lat: resolved.lat, lng: resolved.lng };
  }
  // Choosing delivery means paying for a courier, and a courier needs a door.
  // Without this, the fee is charged but the run sweep (which needs deliveryLoc)
  // never dispatches anyone — a paid-for service that silently never happens.
  // Only explicit fulfilment opts into the check so older clients keep working.
  if (fulfilment === 'delivery' && !deliveryLoc) {
    return res.status(400).json({ error: 'Tell us where to deliver — add a landmark or address.' });
  }

  const commission = Math.round(subtotal * (STORE_COMMISSION_PCT / 100));
  const order = {
    id: uid(),
    userId: req.user.id,
    customerName: req.user.name,
    storeId: store.id,
    storeName: store.name,
    storeIcon: store.icon,
    partnerId: store.ownerId,
    items: lines,
    subtotal,
    deliveryFee,
    serviceFee,
    total,
    commission,
    partnerCut: subtotal + deliveryFee - commission,
    partnerSettled: false,
    payment: payMethod,
    fulfilment: pickup ? 'pickup' : 'delivery',
    // The customer's proof at the counter. Only they see it; the shopkeeper
    // hears it from their mouth at handover.
    pickupCode: pickup ? String(crypto.randomInt(1000, 10000)) : null,
    deliveryLoc,
    status: 'placed',
    createdAt: Date.now()
  };

  // Reserve the stock now so two customers cannot buy the last bag of rice.
  const actor = { actorKind: 'system', actorId: null, actorName: 'Customer order' };
  for (const line of lines) {
    moveStock(store, itemIn(store, line.itemId), { qty: -line.qty, reason: 'order', refId: order.id, ...actor });
  }

  if (payMethod === 'wallet') {
    debitWallet(req.user, total);
    recordTxn('user', req.user, {
      type: 'store_order', label: `Shop order: ${store.name}`, amount: total, sign: -1, refId: order.id
    });
    const owner = ownerOf(store);
    if (owner) {
      // Held as pending until handover, so a refunded order can never be cashed out.
      owner.pendingEarnings = (owner.pendingEarnings || 0) + order.partnerCut;
      recordTxn('partner', owner, {
        type: 'store_income_pending', label: `Order placed (pending handover): ${store.name}`,
        amount: order.partnerCut, sign: 1, refId: order.id
      });
    }
    recordPlatformRevenue({
      source: 'store_commission', label: `Store commission: ${store.name}`, amount: commission, refId: order.id
    });
    if (serviceFee > 0) {
      recordPlatformRevenue({
        source: 'service_fee', label: `Shop order service fee: ${store.name}`, amount: serviceFee, refId: order.id
      });
    }
  }

  db.storeOrders.push(order);
  save();
  events.publish(`partner:${store.ownerId}`, { topic: 'store_orders' });
  events.publish('admin', { topic: 'orders' });
  res.json({ order, user: publicUser(req.user) });
});

router.get('/store-orders', authRequired, (req, res) => {
  const orders = [];
  for (let i = db.storeOrders.length - 1; i >= 0 && orders.length < 20; i -= 1) {
    if (db.storeOrders[i].userId === req.user.id) orders.push(db.storeOrders[i]);
  }
  res.json({ orders });
});

// Cancelling puts the goods back on the shelf and unwinds every money movement.
function unwindStoreOrder(order, { label }) {
  const store = storeById(order.storeId);
  if (store) {
    for (const line of order.items) {
      const item = itemIn(store, line.itemId);
      if (item) {
        moveStock(store, item, {
          qty: line.qty, reason: 'order_cancel', refId: order.id,
          actorKind: 'system', actorId: null, actorName: 'Order cancelled'
        });
      }
    }
  }
  if (order.payment !== 'cash') {
    const user = db.users.find((u) => u.id === order.userId);
    if (user) {
      user.wallet += order.total;
      recordTxn('user', user, { type: 'store_refund', label, amount: order.total, sign: 1, refId: order.id });
    }
    const owner = db.partners.find((p) => p.id === order.partnerId);
    if (owner) {
      owner.pendingEarnings = (owner.pendingEarnings || 0) - order.partnerCut;
      recordTxn('partner', owner, {
        type: 'store_reversal', label: `Order cancelled: ${order.storeName}`,
        amount: order.partnerCut, sign: -1, refId: order.id
      });
    }
    recordPlatformRevenue({
      source: 'store_commission', label: `Order cancelled — commission reversed: ${order.storeName}`,
      amount: -order.commission, refId: order.id
    });
    if (order.serviceFee > 0) {
      recordPlatformRevenue({
        source: 'service_fee', label: `Order cancelled — service fee reversed: ${order.storeName}`,
        amount: -order.serviceFee, refId: order.id
      });
    }
  }
}

router.post('/store-orders/:id/cancel', authRequired, (req, res) => {
  const order = db.storeOrders.find((o) => o.id === req.params.id && o.userId === req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'placed') {
    return res.status(400).json({ error: 'The shop has already started packing — call them to cancel.' });
  }
  order.status = 'cancelled';
  order.cancelledAt = Date.now();
  unwindStoreOrder(order, { label: `Shop order cancelled — refund: ${order.storeName}` });
  save();
  events.publish(`partner:${order.partnerId}`, { topic: 'store_orders' });
  res.json({ order, user: publicUser(req.user) });
});

/* ---------------- shopkeeper: orders ---------------- */

// The pickup code is the customer's proof of identity at the counter. If the
// shopkeeper could read it through the API, the handover check would prove
// nothing — so every partner-facing view strips it.
function partnerOrderView(order) {
  const { pickupCode, ...rest } = order;
  return rest;
}

router.get('/partner/stores/:id/orders', authPartner, (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const active = { placed: 0, accepted: 1, ready: 2 };
  const orders = db.storeOrders
    .filter((o) => o.storeId === store.id)
    .slice(-40)
    .reverse()
    .sort((a, b) => (active[a.status] ?? 9) - (active[b.status] ?? 9))
    .map(partnerOrderView);
  res.json({ orders });
});

router.post('/partner/store-orders/:orderId/:action(accept|reject|ready|handover)', authPartner, (req, res) => {
  const order = db.storeOrders.find((o) => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const store = storeById(order.storeId);
  if (!store || store.ownerId !== req.partner.id) {
    return res.status(403).json({ error: 'You do not manage this store.' });
  }
  const action = req.params.action;

  if (action === 'reject') {
    // A packed pickup order's only other exit is a handover code the absent
    // customer holds — without reject-at-ready, a no-show would strand the
    // customer's money and the shop's pending income forever.
    const noShow = order.status === 'ready' && order.fulfilment === 'pickup';
    if (order.status !== 'placed' && order.status !== 'accepted' && !noShow) {
      return res.status(400).json({ error: 'This order can no longer be rejected.' });
    }
    order.status = 'cancelled';
    order.cancelledAt = Date.now();
    order.cancelReason = noShow ? 'not_collected' : 'shop_rejected';
    unwindStoreOrder(order, {
      label: noShow
        ? `Pickup order not collected — refund: ${order.storeName}`
        : `Shop could not fulfil the order — refund: ${order.storeName}`
    });
  } else if (action === 'accept') {
    if (order.status !== 'placed') return res.status(400).json({ error: 'This order was already handled.' });
    order.status = 'accepted';
    order.acceptedAt = Date.now();
  } else if (action === 'ready') {
    if (order.status !== 'accepted') return res.status(400).json({ error: 'Accept the order first.' });
    order.status = 'ready';
    order.readyAt = Date.now();
  } else if (action === 'handover') {
    if (order.status !== 'ready' && order.status !== 'accepted') {
      return res.status(400).json({ error: 'Mark the order ready first.' });
    }
    // If a courier is carrying this order, the shopkeeper must NOT settle it.
    // An order stays 'ready' until the rider ticks the pickup stop, so this is
    // exactly the tap a shopkeeper makes when handing the bag to the rider —
    // and settling here would mark it delivered, causing the run's dropoff to
    // skip the courier's cash debit entirely. The cash would simply vanish.
    // Only 'collecting'/'delivering' count: a run still forming or merely
    // offered has no rider holding anything, and with no couriers around such
    // a run never cancels — blocking on it would trap the order at the counter
    // while the customer stands right there.
    const activeRun = require('../deliveryRuns').runContainingOrder(order.id);
    if (activeRun && (activeRun.status === 'collecting' || activeRun.status === 'delivering')) {
      return res.status(409).json({
        error: 'A courier is delivering this order — it settles at the customer’s door.'
      });
    }
    if (order.fulfilment === 'pickup') {
      // The code has 9000 possible values, so unlimited guesses would let a
      // shopkeeper script their way to settling a prepaid order nobody
      // collected. Five failures lock the order; reject-and-refund is the exit.
      if ((order.codeTries || 0) >= PICKUP_CODE_MAX_TRIES) {
        return res.status(409).json({ error: 'Too many wrong codes — this order is locked. Reject it to refund the customer.' });
      }
      const code = String((req.body || {}).code || '').trim();
      if (!code || code !== order.pickupCode) {
        order.codeTries = (order.codeTries || 0) + 1;
        logAudit({
          actor: { role: 'partner', id: req.partner.id, email: req.partner.email },
          action: 'store.order.pickup_code_failed',
          targetType: 'store_order',
          targetId: order.id,
          meta: { storeId: store.id, tries: order.codeTries }
        });
        save();
        const left = PICKUP_CODE_MAX_TRIES - order.codeTries;
        return res.status(left > 0 ? 400 : 409).json({
          error: left > 0
            ? `Wrong pickup code — ask the customer for the 4-digit code in their app (${left} ${left === 1 ? 'try' : 'tries'} left).`
            : 'Too many wrong codes — this order is locked. Reject it to refund the customer.'
        });
      }
    }
    order.status = 'delivered';
    order.deliveredAt = Date.now();
    // Handover is the moment the goods actually change hands, so this is when
    // income settles and — for cash — when the platform's cut is really earned.
    const owner = ownerOf(store);
    if (owner && !order.partnerSettled) {
      if (order.payment === 'cash') {
        // The shopkeeper took the customer's cash, so they owe SewaGo its cut.
        owner.earnings = (owner.earnings || 0) - order.commission;
        recordTxn('partner', owner, {
          type: 'store_cash_commission', label: `Commission on cash order: ${store.name}`,
          amount: order.commission, sign: -1, refId: order.id
        });
        recordPlatformRevenue({
          source: 'store_commission', label: `Store commission (cash): ${store.name}`,
          amount: order.commission, refId: order.id
        });
      } else {
        owner.pendingEarnings = (owner.pendingEarnings || 0) - order.partnerCut;
        owner.earnings = (owner.earnings || 0) + order.partnerCut;
        recordTxn('partner', owner, {
          type: 'store_income', label: `Order handed over — income: ${store.name}`,
          amount: order.partnerCut, sign: 1, refId: order.id
        });
      }
      order.partnerSettled = true;
    }
  }
  save();
  events.publish(`user:${order.userId}`, { topic: 'store_order' });
  events.publish('admin', { topic: 'orders' });
  res.json({ order: partnerOrderView(order) });
});

/* ---------------- photos ---------------- */

// Item photos ride the existing partner upload pipeline, then get an optional
// AI cleanup pass. If no provider is configured the raw photo is used — a shop
// must never be blocked from listing an item because an image API is down.
router.post('/partner/stores/:id/items/:itemId/photo', authPartner, async (req, res) => {
  const store = manageableStore(req, res, { helpersAllowed: false });
  if (!store) return;
  const item = itemIn(store, req.params.itemId);
  if (!item || item.archived) return res.status(404).json({ error: 'Item not found.' });
  const gallery = galleryFrom(req.partner, req.body || {});
  if (!gallery.photo) return res.status(400).json({ error: 'Upload a photo first.' });
  const result = await cleanupPhoto(gallery.photo, { label: item.name });
  item.photo = result.url;
  item.photos = [result.url];
  item.photoCleaned = result.cleaned;
  item.updatedAt = Date.now();
  save();
  res.json({ item: { id: item.id, photo: item.photo, cleaned: result.cleaned, note: result.note } });
});

module.exports = router;
