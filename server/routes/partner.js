const express = require('express');
const { db, save, uid } = require('../db');
const { coordsFor } = require('../places');
const { withStatus: orderWithStatus, refundOrder } = require('../orderLogic');
const { recordTxn, recordPlatformRevenue, createWithdrawal } = require('../payments');
const { settleDueBookings } = require('../settlement');
const { PROMOTE_WEEK_PRICE, PROMOTE_WEEK_MS } = require('../fees');
const { savePartnerPhoto, ownedPhotos } = require('../photos');

// Accept either the legacy single `photo` or a `photos` gallery (max 5);
// `.photo` stays mirrored to the first entry so older clients keep working.
function galleryFrom(partner, body) {
  const photos = ownedPhotos(partner, [
    ...(Array.isArray(body.photos) ? body.photos : []),
    ...(body.photo ? [body.photo] : [])
  ]);
  return { photos, photo: photos[0] || '' };
}
const events = require('../events');
const sessionTokens = require('../sessionTokens');
const { hashPassword, verifyPassword } = require('../passwords');
const { deleteAccount } = require('../accountDeletion');
const {
  normalizePhone,
  requestPhoneOtp,
  verifyPhoneOtp,
  requestLoginOtp,
  verifyLoginOtp,
  requestPasswordReset,
  resetPassword
} = require('../accountSecurity');
const { logAudit } = require('../audit');

const router = express.Router();

// Enough for fat fingers at a busy counter, useless for brute force. Same cap
// the kirana handover and the OTP flow use.
const COLLECT_CODE_MAX_TRIES = 5;

function profile(p) {
  return {
    id: p.id,
    name: p.name,
    email: p.email,
    phone: p.phone || '',
    phoneVerified: !!p.phoneVerified,
    regNo: p.regNo || '',
    businessKycStatus: p.businessKycStatus || 'pending',
    businessKycNote: p.businessKyc && p.businessKyc.note ? p.businessKyc.note : '',
    businessKycDocumentRef: p.businessKyc && p.businessKyc.documentRef ? p.businessKyc.documentRef : '',
    earnings: p.earnings || 0,
    // Income from bookings/orders not yet checked-in/delivered — becomes
    // withdrawable earnings on fulfillment; shown so the partner sees it coming.
    pendingEarnings: p.pendingEarnings || 0
  };
}

function authPartner(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const partnerId = sessionTokens.tokenOwner(db.partnerTokens, token);
  const partner = partnerId && db.partners.find((p) => p.id === partnerId);
  if (!partner) return res.status(401).json({ error: 'Please log in again.' });
  if (partner.suspended) {
    return res.status(403).json({ error: 'Your partner account is suspended — contact SewaGo support.' });
  }
  req.partner = partner;
  next();
}

function issueToken(partnerId) {
  return sessionTokens.issueToken(db.partnerTokens, partnerId);
}

function myListings(partnerId) {
  return {
    restaurants: db.restaurants.filter((r) => r.ownerId === partnerId),
    hotels: db.hotels.filter((h) => h.ownerId === partnerId)
  };
}

function requirePartnerKyc(req, res) {
  if (!req.partner.phoneVerified) {
    res.status(403).json({ error: 'Verify your phone number before adding listings.' });
    return false;
  }
  if (req.partner.businessKycStatus !== 'approved') {
    res.status(403).json({ error: 'Business KYC must be approved before adding listings.' });
    return false;
  }
  return true;
}

/* ---------------- auth ---------------- */

router.post('/partner/register', (req, res) => {
  const { name, email, password, phone, regNo } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Business name, email and password are required.' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const cleanPhone = normalizePhone(phone);
  if (!/^\+?\d{7,15}$/.test(cleanPhone)) {
    return res.status(400).json({ error: 'A valid phone number is required — our team calls to verify.' });
  }
  const cleanRegNo = String(regNo || '').trim();
  if (cleanRegNo.length < 3 || cleanRegNo.length > 30) {
    return res.status(400).json({ error: 'Business registration / PAN number is required (3-30 characters).' });
  }
  if (db.partners.some((p) => p.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'A partner with that email already exists.' });
  }
  if (db.partners.some((p) => normalizePhone(p.phone) === cleanPhone)) {
    return res.status(409).json({ error: 'A partner with that phone already exists.' });
  }
  const partner = {
    id: uid(),
    name: name.trim(),
    email: email.trim(),
    password: hashPassword(password),
    phone: cleanPhone,
    phoneVerified: false,
    regNo: cleanRegNo,
    businessKycStatus: 'pending',
    businessKyc: {
      legalName: name.trim(),
      regNo: cleanRegNo,
      documentRef: '',
      submittedAt: Date.now(),
      reviewedAt: null,
      note: ''
    }
  };
  db.partners.push(partner);
  const token = issueToken(partner.id);
  save();
  res.json({ token, partner: profile(partner), ...myListings(partner.id) });
});

// Self-service deletion (app-store requirement). Password-confirmed; earnings
// must be withdrawn and live listings are taken off the marketplace.
router.post('/partner/account/delete', authPartner, (req, res) => {
  if (!verifyPassword(String((req.body || {}).password || ''), req.partner.password)) {
    return res.status(401).json({ error: 'Confirm with your password to delete the account.' });
  }
  const result = deleteAccount('partner', req.partner, { ip: req.ip });
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  res.json({ ok: true, message: 'Your account and personal data have been deleted.' });
});

router.post('/partner/password/request-reset', async (req, res, next) => {
  try {
    const result = await requestPasswordReset('partner', (req.body || {}).email);
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

router.post('/partner/password/reset', (req, res) => {
  const result = resetPassword('partner', (req.body || {}).token, (req.body || {}).password);
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  res.json({ ok: true });
});

router.post('/partner/login', (req, res) => {
  const partner = db.partners.find((p) => p.email.toLowerCase() === String((req.body || {}).email || '').toLowerCase());
  if (!partner || !verifyPassword(String((req.body || {}).password || ''), partner.password)) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  const token = issueToken(partner.id);
  save();
  res.json({ token, partner: profile(partner), ...myListings(partner.id) });
});

router.post('/partner/otp/request', async (req, res, next) => {
  try {
    const result = await requestLoginOtp('partner', (req.body || {}).phone);
    if (result.error) return res.status(400).json({ error: result.error });
    save();
    res.json({
      phone: result.phone,
      devCode: result.devCode,
      expiresAt: result.expiresAt,
      message: result.devCode ? 'Sandbox OTP generated.' : 'If that partner phone exists, a verification code was sent.'
    });
  } catch (err) {
    next(err);
  }
});

router.post('/partner/otp/verify', (req, res) => {
  const result = verifyLoginOtp('partner', (req.body || {}).phone, (req.body || {}).code);
  if (result.error) return res.status(400).json({ error: result.error });
  if (!result.entity) return res.status(401).json({ error: 'No partner account is registered for that phone.' });

  result.entity.phone = result.phone;
  result.entity.phoneVerified = true;
  result.entity.phoneVerifiedAt = Date.now();
  const token = issueToken(result.entity.id);
  save();
  res.json({ token, partner: profile(result.entity), ...myListings(result.entity.id) });
});

router.get('/partner/me', authPartner, (req, res) => {
  settleDueBookings(); // reflect any check-ins reached since last load
  const transactions = db.transactions
    .filter((t) => t.ownerKind === 'partner' && t.ownerId === req.partner.id)
    .slice(-10)
    .reverse();
  res.json({
    partner: profile(req.partner),
    transactions,
    promoteWeekPrice: PROMOTE_WEEK_PRICE,
    ...myListings(req.partner.id)
  });
});

router.post('/partner/phone/request-otp', authPartner, async (req, res, next) => {
  try {
    const result = await requestPhoneOtp('partner', req.partner, (req.body || {}).phone);
    if (result.error) return res.status(400).json({ error: result.error });
    save();
    res.json({
      partner: profile(req.partner),
      devCode: result.devCode,
      expiresAt: result.expiresAt,
      message: result.devCode ? 'Sandbox OTP generated.' : 'Verification code sent.'
    });
  } catch (err) {
    next(err);
  }
});

router.post('/partner/phone/verify', authPartner, (req, res) => {
  const result = verifyPhoneOtp('partner', req.partner, (req.body || {}).code);
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  res.json({ partner: profile(req.partner) });
});

router.post('/partner/kyc', authPartner, (req, res) => {
  const { legalName, regNo, documentRef } = req.body || {};
  const cleanName = String(legalName || req.partner.name || '').trim();
  const cleanRegNo = String(regNo || '').trim();
  const cleanDoc = String(documentRef || '').trim();
  if (cleanName.length < 2 || cleanName.length > 80) {
    return res.status(400).json({ error: 'Legal business name is required.' });
  }
  if (cleanRegNo.length < 3 || cleanRegNo.length > 30) {
    return res.status(400).json({ error: 'Registration / PAN number must be 3-30 characters.' });
  }
  if (cleanDoc.length < 4 || cleanDoc.length > 120) {
    return res.status(400).json({ error: 'Add a document reference, upload link, or file ID for review.' });
  }
  req.partner.regNo = cleanRegNo;
  req.partner.businessKycStatus = 'pending';
  req.partner.businessKyc = {
    legalName: cleanName,
    regNo: cleanRegNo,
    documentRef: cleanDoc,
    submittedAt: Date.now(),
    reviewedAt: null,
    note: ''
  };
  save();
  res.json({ partner: profile(req.partner) });
});

// Photo upload: the raw image body rides its own parser (the global JSON
// parser ignores image/* content types). Client downscales before sending.
router.post('/partner/photos', authPartner, express.raw({ type: 'image/*', limit: '4mb' }), (req, res) => {
  const result = savePartnerPhoto(req.partner, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  res.json({ url: result.url });
});

// Replace the photo gallery of an existing listing (max 5; first = cover).
router.post('/partner/:type(restaurants|hotels)/:id/photo', authPartner, (req, res) => {
  const list = req.params.type === 'restaurants' ? db.restaurants : db.hotels;
  const listing = list.find((x) => x.id === req.params.id && x.ownerId === req.partner.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found.' });
  const { photos, photo } = galleryFrom(req.partner, req.body || {});
  listing.photos = photos;
  listing.photo = photo;
  save();
  res.json({ ok: true, photos, photo });
});

router.post('/partner/withdraw', authPartner, (req, res) => {
  // Earnings only ever leave the platform through KYC-approved businesses.
  if (req.partner.businessKycStatus !== 'approved') {
    return res.status(403).json({ error: 'Business KYC must be approved before earnings can be withdrawn.' });
  }
  settleDueBookings(); // settle any newly-checked-in stays before computing balance
  const result = createWithdrawal('partner', req.partner, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  res.json({ withdrawal: result.withdrawal, partner: profile(req.partner) });
});

/* ---------------- restaurants ---------------- */

/* ---------------- live order queue ---------------- */

// What the restaurant needs to fulfil an order — no customer wallet data, and
// NEVER the collect code: the counter check proves nothing if the kitchen can
// read the answer through the API.
function partnerOrderView(order) {
  const o = orderWithStatus(order);
  return {
    id: o.id,
    restaurantId: o.restaurantId,
    restaurantName: o.restaurantName,
    customerName: o.customerName || 'Customer',
    items: o.items,
    subtotal: o.subtotal,
    partnerCut: o.partnerCut || 0,
    deliveryLoc: o.deliveryLoc,
    mode: o.mode || 'delivery',
    scheduledFor: o.scheduledFor || null,
    // Per-member breakdown for group orders (name · share) — no wallet data.
    group: o.group || null,
    status: o.status,
    cancelReason: o.cancelReason || null,
    courier: o.courier || null,
    createdAt: o.createdAt,
    acceptedAt: o.acceptedAt || null,
    readyAt: o.readyAt || null,
    pickedUpAt: o.pickedUpAt || null,
    deliveredAt: o.deliveredAt || null,
    collectedAt: o.collectedAt || null
  };
}

// Group members watch the 'group' topic — nudge them all when their order moves.
function pingGroupMembers(order) {
  if (!order.group) return;
  const group = (db.groupOrders || []).find((g) => g.id === order.group.id);
  if (group) for (const m of group.members) events.publish(`user:${m.userId}`, { topic: 'group' });
}

router.get('/partner/orders', authPartner, (req, res) => {
  const orders = db.orders
    .filter((o) => o.partnerId === req.partner.id)
    .map(partnerOrderView)
    .reverse();
  // Actionable orders first, then the recent history.
  const rank = { placed: 0, preparing: 1, ready: 2, out_for_delivery: 2 };
  orders.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
  res.json({ orders: orders.slice(0, 40) });
});

router.post('/partner/orders/:id/accept', authPartner, (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id && o.partnerId === req.partner.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (orderWithStatus(order).status !== 'placed') {
    return res.status(409).json({ error: 'This order is no longer waiting for confirmation.' });
  }
  order.status = 'preparing';
  order.acceptedAt = Date.now();
  save();
  // Customer sees "preparing"; bike couriers get the delivery job offer —
  // unless the customer is walking to the counter themselves.
  events.publish(`user:${order.userId}`, { topic: 'order' });
  if ((order.mode || 'delivery') === 'delivery') events.publish('drivers:bike', { topic: 'delivery_request' });
  pingGroupMembers(order);
  events.publish('admin', { topic: 'orders' });
  res.json({ order: partnerOrderView(order) });
});

router.post('/partner/orders/:id/reject', authPartner, (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id && o.partnerId === req.partner.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const status = orderWithStatus(order).status;
  // Order-ahead has the same trap as store pickups: once the food is cooking,
  // the only other exit is a code an absent customer holds. Reject-at-ready is
  // the no-show refund path — without it the money is stranded forever.
  const noShow = (order.mode === 'pickup' || order.mode === 'dinein') &&
    (status === 'preparing' || status === 'ready');
  if (status !== 'placed' && !noShow) {
    return res.status(409).json({ error: 'Only unconfirmed orders can be rejected.' });
  }
  order.status = 'cancelled';
  order.cancelReason = noShow ? 'not_collected' : 'restaurant';
  order.rejectNote = String((req.body || {}).note || '').slice(0, 200);
  order.cancelledAt = Date.now();
  refundOrder(order, {
    label: noShow
      ? `Order not collected — refund: ${order.restaurantName}`
      : `Restaurant couldn't take the order — refund: ${order.restaurantName}`
  });
  save();
  events.publish(`user:${order.userId}`, { topic: 'order' });
  pingGroupMembers(order);
  events.publish('admin', { topic: 'orders' });
  res.json({ order: partnerOrderView(order) });
});

// Order-ahead only: the kitchen is done, the counter is waiting for the code.
router.post('/partner/orders/:id/ready', authPartner, (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id && o.partnerId === req.partner.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.mode !== 'pickup' && order.mode !== 'dinein') {
    return res.status(400).json({ error: 'Delivery orders go out with a courier — only order-ahead is marked ready.' });
  }
  if (orderWithStatus(order).status !== 'preparing') {
    return res.status(409).json({ error: 'Accept the order first.' });
  }
  order.status = 'ready';
  order.readyAt = Date.now();
  save();
  events.publish(`user:${order.userId}`, { topic: 'order' });
  pingGroupMembers(order);
  events.publish('admin', { topic: 'orders' });
  res.json({ order: partnerOrderView(order) });
});

// The customer read out their 4-digit code at the counter: the food changes
// hands, and this is the moment the kitchen's income becomes really theirs
// (mirrors the courier deliver handler's settlement). Wrong code → 400, no
// state change.
router.post('/partner/orders/:id/collected', authPartner, (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id && o.partnerId === req.partner.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.mode !== 'pickup' && order.mode !== 'dinein') {
    return res.status(400).json({ error: 'Only pickup and eat-there orders are collected at the counter.' });
  }
  const status = orderWithStatus(order).status;
  // 'ready' is the normal moment; 'preparing' covers the customer who shows up
  // early while the last plate is still being packed.
  if (status !== 'ready' && status !== 'preparing') {
    return res.status(409).json({ error: 'This order is not waiting to be collected.' });
  }
  // The code has 9000 possible values and this settles prepaid money, so
  // unlimited guesses let a restaurant script its way to keeping the payment for
  // an order nobody collected — the customer has no refund path once the order
  // is 'completed'. Five failures lock it; reject-and-refund is the exit. Same
  // cap and same reasoning as the kirana handover (routes/stores.js).
  if ((order.codeTries || 0) >= COLLECT_CODE_MAX_TRIES) {
    return res.status(409).json({ error: 'Too many wrong codes — this order is locked. Reject it to refund the customer.' });
  }
  const code = String((req.body || {}).code || '').trim();
  if (!code || code !== order.collectCode) {
    order.codeTries = (order.codeTries || 0) + 1;
    logAudit({
      actor: { role: 'partner', id: req.partner.id, email: req.partner.email },
      action: 'food.order.collect_code_failed',
      targetType: 'order',
      targetId: order.id,
      meta: { restaurantId: order.restaurantId, tries: order.codeTries }
    });
    save();
    const left = COLLECT_CODE_MAX_TRIES - order.codeTries;
    return res.status(left > 0 ? 400 : 409).json({
      error: left > 0
        ? `Wrong code — ask the customer for the 4-digit code in their app (${left} ${left === 1 ? 'try' : 'tries'} left).`
        : 'Too many wrong codes — this order is locked. Reject it to refund the customer.'
    });
  }
  order.status = 'completed';
  order.collectedAt = Date.now();
  // Collection is the handover, so pending income settles into withdrawable
  // earnings now — it can no longer be refunded, so it's truly theirs.
  if (order.partnerCut && !order.partnerSettled) {
    req.partner.pendingEarnings = (req.partner.pendingEarnings || 0) - order.partnerCut;
    req.partner.earnings = (req.partner.earnings || 0) + order.partnerCut;
    recordTxn('partner', req.partner, {
      type: 'order_income',
      label: `Order collected — income: ${order.restaurantName}`,
      amount: order.partnerCut,
      sign: 1,
      refId: order.id
    });
    order.partnerSettled = true;
  }
  save();
  events.publish(`user:${order.userId}`, { topic: 'order' });
  pingGroupMembers(order);
  events.publish('admin', { topic: 'orders' });
  res.json({ order: partnerOrderView(order) });
});

/* ---------------- promoted (featured) listings ---------------- */

// A partner spends earnings to pin a live listing to the top of the customer
// list for 7 days. Repeat purchases extend the window; the fee lands in the
// platform ledger as its own revenue source.
router.post('/partner/:type(restaurants|hotels)/:id/promote', authPartner, (req, res) => {
  const list = req.params.type === 'restaurants' ? db.restaurants : db.hotels;
  const listing = list.find((x) => x.id === req.params.id && x.ownerId === req.partner.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found.' });
  if (listing.status !== 'approved') {
    return res.status(400).json({ error: 'Only live (approved) listings can be promoted.' });
  }
  if ((req.partner.earnings || 0) < PROMOTE_WEEK_PRICE) {
    return res.status(402).json({
      error: `Featuring a listing costs Rs ${PROMOTE_WEEK_PRICE} for 7 days — your earnings balance is too low.`
    });
  }
  req.partner.earnings -= PROMOTE_WEEK_PRICE;
  listing.promotedUntil = Math.max(Date.now(), listing.promotedUntil || 0) + PROMOTE_WEEK_MS;
  recordTxn('partner', req.partner, {
    type: 'promotion',
    label: `Featured placement (7 days): ${listing.name}`,
    amount: PROMOTE_WEEK_PRICE,
    sign: -1,
    refId: listing.id
  });
  recordPlatformRevenue({
    source: 'promotion_fee',
    label: `Featured placement — ${listing.name}`,
    amount: PROMOTE_WEEK_PRICE,
    refId: listing.id
  });
  save();
  res.json({ partner: profile(req.partner), promotedUntil: listing.promotedUntil });
});

router.post('/partner/restaurants', authPartner, (req, res) => {
  if (!requirePartnerKyc(req, res)) return;
  const { name, cuisine, icon, etaMinutes, deliveryFee, area } = req.body || {};
  if (!name || !cuisine) return res.status(400).json({ error: 'Restaurant name and cuisine are required.' });
  const gallery = galleryFrom(req.partner, req.body || {});
  const eta = Math.min(120, Math.max(5, Number(etaMinutes) || 30));
  const fee = Math.min(500, Math.max(0, Number(deliveryFee) || 50));
  // Pickup point for couriers: the area resolves through the gazetteer.
  const spot = coordsFor(String(area || '').trim() || name);
  const restaurant = {
    id: uid(),
    ownerId: req.partner.id,
    name: name.trim(),
    cuisine: cuisine.trim(),
    rating: null, // shows as NEW until it earns reviews
    etaMinutes: eta,
    deliveryFee: fee,
    icon: (icon || '🍽️').slice(0, 8),
    photo: gallery.photo,
    photos: gallery.photos,
    loc: { name: spot.name, lat: spot.lat, lng: spot.lng },
    menu: [],
    status: 'pending', // SewaGo staff review every listing before it goes live
    reviewNote: '',
    submittedAt: Date.now()
  };
  db.restaurants.push(restaurant);
  save();
  res.json({ restaurant });
});

router.post('/partner/restaurants/:id/menu', authPartner, (req, res) => {
  const restaurant = db.restaurants.find((r) => r.id === req.params.id && r.ownerId === req.partner.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found.' });
  const { name, price, desc } = req.body || {};
  const p = Number(price);
  if (!name || !(p >= 10 && p <= 10000)) {
    return res.status(400).json({ error: 'Item needs a name and a price between Rs 10 and Rs 10,000.' });
  }
  if (restaurant.menu.length >= 30) return res.status(400).json({ error: 'Menu is limited to 30 items.' });
  const gallery = galleryFrom(req.partner, req.body || {});
  const item = {
    id: uid(),
    name: name.trim(),
    price: Math.round(p),
    desc: String(desc || '').trim(),
    photo: gallery.photo,
    photos: gallery.photos
  };
  restaurant.menu.push(item);
  save();
  res.json({ restaurant });
});

// Group discount: "N people or more who order together get X% off". One knob,
// two numbers — validated here so the customer app can trust what it shows.
// Sending neither number clears the offer.
router.post('/partner/restaurants/:id/group-discount', authPartner, (req, res) => {
  const restaurant = db.restaurants.find((r) => r.id === req.params.id && r.ownerId === req.partner.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found.' });
  const { pct, minPeople } = req.body || {};
  if (pct == null && minPeople == null) {
    restaurant.groupDiscount = null;
    save();
    return res.json({ restaurant });
  }
  const p = Number(pct);
  const n = Number(minPeople);
  if (!Number.isInteger(p) || p < 1 || p > 50) {
    return res.status(400).json({ error: 'Discount must be a whole number between 1% and 50%.' });
  }
  if (!Number.isInteger(n) || n < 2 || n > 50) {
    return res.status(400).json({ error: 'Minimum group size must be between 2 and 50 people.' });
  }
  restaurant.groupDiscount = { pct: p, minPeople: n };
  save();
  res.json({ restaurant });
});

router.delete('/partner/restaurants/:rid/menu/:mid', authPartner, (req, res) => {
  const restaurant = db.restaurants.find((r) => r.id === req.params.rid && r.ownerId === req.partner.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found.' });
  restaurant.menu = restaurant.menu.filter((m) => m.id !== req.params.mid);
  save();
  res.json({ restaurant });
});

router.delete('/partner/restaurants/:id', authPartner, (req, res) => {
  const restaurant = db.restaurants.find((r) => r.id === req.params.id && r.ownerId === req.partner.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found.' });
  db.restaurants = db.restaurants.filter((r) => r.id !== restaurant.id);
  save();
  res.json({ ok: true });
});

/* ---------------- hotels ---------------- */

router.post('/partner/hotels', authPartner, (req, res) => {
  if (!requirePartnerKyc(req, res)) return;
  const { name, city, area, desc, icon } = req.body || {};
  if (!name || !city) return res.status(400).json({ error: 'Hotel name and city are required.' });
  const gallery = galleryFrom(req.partner, req.body || {});
  const hotel = {
    id: uid(),
    ownerId: req.partner.id,
    name: name.trim(),
    city: city.trim(),
    area: String(area || '').trim(),
    desc: String(desc || '').trim(),
    rating: null, // shows as NEW until it earns reviews
    icon: (icon || '🏨').slice(0, 8),
    photo: gallery.photo,
    photos: gallery.photos,
    rooms: [],
    status: 'pending', // SewaGo staff review every listing before it goes live
    reviewNote: '',
    submittedAt: Date.now()
  };
  db.hotels.push(hotel);
  save();
  res.json({ hotel });
});

router.post('/partner/hotels/:id/rooms', authPartner, (req, res) => {
  const hotel = db.hotels.find((h) => h.id === req.params.id && h.ownerId === req.partner.id);
  if (!hotel) return res.status(404).json({ error: 'Hotel not found.' });
  const { type, pricePerNight, count, sleeps, amenities } = req.body || {};
  const gallery = galleryFrom(req.partner, req.body || {});
  const price = Number(pricePerNight);
  const n = Number(count);
  const s = Number(sleeps);
  if (!type || !(price >= 100 && price <= 100000)) {
    return res.status(400).json({ error: 'Room needs a type and a nightly price between Rs 100 and Rs 100,000.' });
  }
  if (!(n >= 1 && n <= 50)) return res.status(400).json({ error: 'Room count must be 1-50.' });
  if (hotel.rooms.length >= 10) return res.status(400).json({ error: 'Hotels are limited to 10 room types.' });
  const room = {
    id: uid(),
    type: type.trim(),
    pricePerNight: Math.round(price),
    count: Math.round(n),
    sleeps: Math.min(10, Math.max(1, Math.round(s) || 2)),
    photo: gallery.photo,
    photos: gallery.photos,
    amenities: String(amenities || '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .slice(0, 6)
  };
  hotel.rooms.push(room);
  save();
  res.json({ hotel });
});

function hasActiveBookings(roomIds) {
  const today = new Date().toISOString().slice(0, 10);
  return db.bookings.some((b) => roomIds.includes(b.roomId) && b.status === 'active' && b.checkOut >= today);
}

router.delete('/partner/hotels/:hid/rooms/:rid', authPartner, (req, res) => {
  const hotel = db.hotels.find((h) => h.id === req.params.hid && h.ownerId === req.partner.id);
  if (!hotel) return res.status(404).json({ error: 'Hotel not found.' });
  if (hasActiveBookings([req.params.rid])) {
    return res.status(409).json({ error: 'That room type has active bookings and cannot be removed yet.' });
  }
  hotel.rooms = hotel.rooms.filter((r) => r.id !== req.params.rid);
  save();
  res.json({ hotel });
});

router.delete('/partner/hotels/:id', authPartner, (req, res) => {
  const hotel = db.hotels.find((h) => h.id === req.params.id && h.ownerId === req.partner.id);
  if (!hotel) return res.status(404).json({ error: 'Hotel not found.' });
  if (hasActiveBookings(hotel.rooms.map((r) => r.id))) {
    return res.status(409).json({ error: 'This hotel has active bookings and cannot be removed yet.' });
  }
  db.hotels = db.hotels.filter((h) => h.id !== hotel.id);
  save();
  res.json({ ok: true });
});

/* ---------------- resubmission after rejection ---------------- */

function resubmit(collection, id, partnerId) {
  const listing = collection.find((x) => x.id === id && x.ownerId === partnerId);
  if (!listing) return { error: 'Listing not found.', code: 404 };
  if (listing.status !== 'rejected') return { error: 'Only rejected listings can be resubmitted.', code: 400 };
  listing.status = 'pending';
  listing.submittedAt = Date.now();
  save();
  return { listing };
}

router.post('/partner/restaurants/:id/resubmit', authPartner, (req, res) => {
  const result = resubmit(db.restaurants, req.params.id, req.partner.id);
  if (result.error) return res.status(result.code).json({ error: result.error });
  res.json({ restaurant: result.listing });
});

router.post('/partner/hotels/:id/resubmit', authPartner, (req, res) => {
  const result = resubmit(db.hotels, req.params.id, req.partner.id);
  if (result.error) return res.status(result.code).json({ error: result.error });
  res.json({ hotel: result.listing });
});

module.exports = router;
// Shared with the stores vertical so partner auth and the KYC gate are defined
// in exactly one place — a second copy would drift.
module.exports.authPartner = authPartner;
module.exports.requirePartnerKyc = requirePartnerKyc;
module.exports.galleryFrom = galleryFrom;
