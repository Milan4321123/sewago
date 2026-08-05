/* SewaGo Partner — list your restaurant, hotel or shop so it appears in the app */

const $ = (sel) => document.querySelector(sel);

const state = {
  token: localStorage.getItem('sewago_partner_token'),
  partner: null,
  authMode: 'login',
  resetToken: '',
  otpLogin: { phone: '', devCode: '' },
  restaurants: [],
  hotels: [],
  orders: [],
  transactions: [],
  txnShow: 8, // earnings feed pagination — "show more" raises it
  showRestForm: false,
  showHotelForm: false,
  showWithdraw: false,
  showPhoneEdit: false, // re-open the OTP form to change a verified phone
  photos: {}, // slot -> uploaded /uploads/ URL pending form submission
  photoBusy: '', // slot currently uploading (disables its button)
  // Hub-and-spoke shell: Home launcher + full-screen pages (no bottom bar)
  tab: localStorage.getItem('sewago_partner_tab') || 'home',
  _popNav: false, // current setTab was triggered by the browser back button
  pipeTab: 'new', // orders pipeline: new | progress | ready | done
  activeListing: null, // { kind:'restaurants'|'hotels', id } -> full-screen editor
  confirmReject: '', // order id with the reject inline-form open
  confirmRemove: '', // listing id with the remove inline-form open
  pickupFor: '', // store order id with the pickup-code inline-form open
  groupSplit: '', // group order id with the who-pays-what breakdown open
  // General store (kirana) inventory
  stores: [],
  showStoreForm: false,
  activeStore: null, // store id -> opens the full-screen inventory manager
  inventory: null, // { items, stats, units, open, status }
  invSearch: '',
  invTab: 'stock', // stock | reorder | subs
  reorder: null,
  storeOrders: [], // customer orders across ALL approved stores
  subReqs: {}, // storeId -> { requests, pendingByItem }
  subAccept: '', // subscription request id with the price inline-form open
  itemForm: null, // { id, kind:'restock'|'price'|'sub' } inline-form on an item row
  drafts: null, // { source:'voice'|'ai', note, items:[…] } — the shared review table
  aiBusy: false,
  aiDisabled: false, // server said the AI assistant is not configured
  helperForm: false,
  helperInvite: null, // { code, name } from a fresh helper invite
  voice: { listening: false, heard: '', error: '' }
};

// The old bottom bar persisted a combined 'listings' tab that no longer
// exists — migrate those sessions (and any junk value) to Home.
const PAGES = ['home', 'orders', 'shops', 'restaurants', 'hotels', 'earnings', 'profile'];
if (!PAGES.includes(state.tab)) state.tab = 'home';

// Remembers which KYC decision the partner has already dismissed, so the
// "approved/rejected" banner survives reloads until they acknowledge it.
const KYC_ACK_KEY = 'sewago_partner_kyc_ack';

const REST_ICONS = ['🍽️', '🥟', '🍛', '🍕', '🍔', '🍚', '🍜', '🥘', '🍗', '🍮'];
const HOTEL_ICONS = ['🏨', '🏡', '🏙️', '🌅', '⛰️', '🐘', '🏰', '🛖'];

/* ---------------- helpers ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.partner) {
    logoutLocal();
    throw new Error('Session expired — please log in again.');
  }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong');
    err.status = res.status; // callers branch on this (503 hides the AI card)
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function money(n) {
  return 'Rs ' + Number(n).toLocaleString('en-IN');
}

function timeAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

/* ---------------- listing photos ---------------- */

// Downscale on the phone before uploading: a 12 MP camera shot becomes a
// ~200 KB 1280px JPEG, which uploads fast and renders fast in the app.
function downscaleImage(file, maxSide = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read that image.'))), 'image/jpeg', quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file is not an image.'));
    };
    img.src = url;
  });
}

async function uploadPhotoBlob(blob) {
  const res = await fetch('/api/partner/photos', {
    method: 'POST',
    headers: {
      'Content-Type': 'image/jpeg',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {})
    },
    body: blob
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Photo upload failed.');
  return data.url;
}

const MAX_PHOTOS = 5;

function slotPhotos(slot) {
  if (!Array.isArray(state.photos[slot])) state.photos[slot] = [];
  return state.photos[slot];
}

// Reusable gallery field: up to 5 photos, tap ✕ on any to drop it. Uploaded
// URLs park in state.photos[slot] until the form that owns the slot submits.
function photoField(slot, label = '📷 Add photos') {
  const urls = slotPhotos(slot);
  const busy = state.photoBusy === slot;
  return `
  <div class="photo-field">
    ${urls.map((url) => `
      <span class="photo-cell">
        <img class="photo-preview" src="${esc(url)}" alt="photo" />
        <button class="photo-x" onclick="clearPhoto('${slot}', '${esc(url)}')">✕</button>
      </span>`).join('')}
    ${urls.length < MAX_PHOTOS ? `
    <label class="btn ghost compact" style="margin:0">
      ${busy ? 'Uploading…' : label}
      <input type="file" accept="image/*" multiple style="display:none" ${busy ? 'disabled' : ''}
        onchange="pickPhoto(event, '${slot}')" />
    </label>` : ''}
    ${urls.length ? `<span class="muted small">${urls.length}/${MAX_PHOTOS}</span>` : ''}
  </div>`;
}

// Re-render without losing what the partner already typed into form fields
// (render() rebuilds the whole DOM, which would wipe a half-filled form).
function renderKeepingForms() {
  const values = {};
  document.querySelectorAll('input[id], select[id], textarea[id]').forEach((el) => {
    if (el.type !== 'file' && el.type !== 'password') values[el.id] = el.value;
  });
  render();
  for (const [id, value] of Object.entries(values)) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  }
}

window.pickPhoto = async (event, slot) => {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  const urls = slotPhotos(slot);
  state.photoBusy = slot;
  renderKeepingForms();
  try {
    for (const file of files) {
      if (urls.length >= MAX_PHOTOS) {
        toast(`Up to ${MAX_PHOTOS} photos each.`, true);
        break;
      }
      const blob = await downscaleImage(file);
      urls.push(await uploadPhotoBlob(blob));
    }
    toast(`${urls.length} photo${urls.length > 1 ? 's' : ''} ready 📷`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.photoBusy = '';
    renderKeepingForms();
  }
};

window.clearPhoto = (slot, url) => {
  state.photos[slot] = slotPhotos(slot).filter((u) => u !== url);
  render();
};

function photosOf(x) {
  if (Array.isArray(x.photos) && x.photos.length) return x.photos;
  return x.photo ? [x.photo] : [];
}

// Gallery manager on an already-live listing: add appends (max 5), ✕ removes.
function listingGallery(type, x) {
  const urls = photosOf(x);
  return `
  <div class="photo-field" style="margin-top:10px">
    ${urls.map((url) => `
      <span class="photo-cell">
        <img class="photo-preview" src="${esc(url)}" alt="photo" />
        <button class="photo-x" onclick="removeListingPhoto('${type}', '${x.id}', '${esc(url)}')">✕</button>
      </span>`).join('')}
    ${urls.length < MAX_PHOTOS ? `
    <label class="btn ghost compact" style="margin:0">📷 Add photos
      <input type="file" accept="image/*" multiple style="display:none"
        onchange="addListingPhotos(event, '${type}', '${x.id}')" />
    </label>` : ''}
  </div>`;
}

window.addListingPhotos = async (event, type, id) => {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  try {
    toast('Uploading…');
    const list = type === 'restaurants' ? state.restaurants : state.hotels;
    const photos = photosOf(list.find((x) => x.id === id) || {});
    for (const file of files) {
      if (photos.length >= MAX_PHOTOS) {
        toast(`Up to ${MAX_PHOTOS} photos each.`, true);
        break;
      }
      const blob = await downscaleImage(file);
      photos.push(await uploadPhotoBlob(blob));
    }
    await api(`/api/partner/${type}/${id}/photo`, { method: 'POST', body: { photos } });
    await reload();
    toast('Photos updated 📷');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.removeListingPhoto = async (type, id, url) => {
  try {
    const list = type === 'restaurants' ? state.restaurants : state.hotels;
    const photos = photosOf(list.find((x) => x.id === id) || {}).filter((u) => u !== url);
    await api(`/api/partner/${type}/${id}/photo`, { method: 'POST', body: { photos } });
    await reload();
    toast('Photo removed.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- data loading ---------------- */

async function reload() {
  const me = await api('/api/partner/me');
  state.partner = me.partner;
  state.restaurants = me.restaurants;
  state.hotels = me.hotels;
  state.transactions = me.transactions || [];
  state.promoteWeekPrice = me.promoteWeekPrice || 500;
  await reloadOrders();
  // A shopkeeper with no shop still needs the (empty) section to appear.
  await loadStores().catch(() => { state.stores = []; });
  await Promise.all([loadStoreOrders(), loadSubscribeRequests()]).catch(() => {});
}

async function reloadOrders() {
  try {
    const data = await api('/api/partner/orders');
    state.orders = data.orders || [];
  } catch (e) { /* the order queue is refreshed again on the next nudge */ }
}

// Customer orders from every approved shop, merged into one queue — the Orders
// tab shows food and store orders side by side, so this mirrors that shape.
async function loadStoreOrders() {
  const live = state.stores.filter((s) => s.status === 'approved');
  const lists = await Promise.all(live.map((s) =>
    api(`/api/partner/stores/${s.id}/orders`).then((d) => d.orders || [], () => [])));
  state.storeOrders = lists.flat();
}

// Subscription-request inboxes per shop; drives the Shops home-tile badge and
// the Subscriptions tab inside the inventory manager.
async function loadSubscribeRequests() {
  const live = state.stores.filter((s) => s.status === 'approved');
  const results = await Promise.all(live.map((s) =>
    api(`/api/partner/stores/${s.id}/subscribe-requests`)
      .then((d) => ({ id: s.id, requests: d.requests || [], pendingByItem: d.pendingByItem || {} }), () => null)));
  state.subReqs = {};
  for (const r of results) if (r) state.subReqs[r.id] = { requests: r.requests, pendingByItem: r.pendingByItem };
}

function pendingSubCount(storeId) {
  const sr = state.subReqs[storeId];
  return sr ? sr.requests.filter((r) => r.status === 'pending').length : 0;
}

function pendingSubTotal() {
  return Object.keys(state.subReqs).reduce((n, id) => n + pendingSubCount(id), 0);
}

function actionableOrderCount() {
  return state.orders.filter((o) => o.status === 'placed').length
    + state.storeOrders.filter((o) => o.status === 'placed').length;
}

/* Real-time: refresh the order queue the instant an order lands or a courier
   moves it along. Falls back to a 20s poll while any order is actionable. */
let eventSource = null;
let sseRetry = null;
let sseConnecting = false;
// The stream credential is a one-minute single-use ticket, not our session
// token — query strings end up in proxy access logs. Because the ticket burns on
// use, EventSource's own retry would loop on 401, so reconnects are ours to do.
async function connectEvents() {
  if (eventSource || !state.token || typeof EventSource === 'undefined' || sseConnecting) return;
  sseConnecting = true;
  let ticket;
  try {
    ticket = (await api('/api/events/ticket', { method: 'POST', body: { role: 'partner' } })).ticket;
  } catch (err) {
    sseConnecting = false;
    return scheduleEventsRetry(); // the poll loop below still keeps the board current
  }
  sseConnecting = false;
  if (!state.token || eventSource) return; // signed out or reconnected meanwhile
  eventSource = new EventSource(`/api/events?role=partner&ticket=${encodeURIComponent(ticket)}`);
  eventSource.onmessage = async (e) => {
    let msg = {};
    try { msg = JSON.parse(e.data); } catch (err) { /* bare nudge */ }
    if (msg.topic === 'kyc') {
      // The SewaGo team just reviewed our KYC — refetch and announce the outcome.
      const prev = state.partner && state.partner.businessKycStatus;
      await reload().catch(() => {});
      const status = state.partner && state.partner.businessKycStatus;
      if (status !== prev) {
        if (status === 'approved') toast('🎉 Your business KYC was approved — you can now list and withdraw!');
        else if (status === 'rejected') toast('Your business KYC was rejected — see the note in the KYC card.', true);
      }
    } else if (msg.topic === 'wallet') {
      await reload().catch(() => {});
      if (msg.event === 'withdrawal_paid') toast('🏦 Your payout was approved and sent.');
      if (msg.event === 'withdrawal_rejected') toast('Your payout was rejected — the amount is back in your earnings.', true);
    } else if (msg.topic === 'subscribe_requests') {
      // Badge on the Shops home tile / the inventory Subscriptions tab, instantly.
      await loadSubscribeRequests().catch(() => {});
      toast('🔁 A customer asked for a subscriber price — see your shop.');
    } else if (msg.topic === 'store_orders' || msg.topic === 'stores') {
      await Promise.all([loadStores(), loadStoreOrders()]).catch(() => {});
      if (state.activeStore) await loadInventory().catch(() => {});
    } else {
      await reloadOrders();
    }
    renderKeepingForms();
  };
  eventSource.onerror = () => { disconnectEvents(); scheduleEventsRetry(); };
}
function scheduleEventsRetry() {
  if (sseRetry || !state.token) return;
  sseRetry = setTimeout(() => { sseRetry = null; connectEvents(); }, 5000);
}
function disconnectEvents() {
  if (sseRetry) { clearTimeout(sseRetry); sseRetry = null; }
  if (eventSource) { eventSource.close(); eventSource = null; }
}
setInterval(async () => {
  if (!state.partner) return;
  const foodActive = state.orders.some((o) => ['placed', 'preparing', 'ready', 'out_for_delivery'].includes(o.status));
  const storeActive = state.storeOrders.some((o) => ['placed', 'accepted', 'ready'].includes(o.status));
  if (!foodActive && !storeActive) return;
  await reloadOrders();
  await loadStoreOrders().catch(() => {});
  // Repaint only where the queue is on screen — a shopkeeper mid-form on
  // another tab should never have a background poll redraw under their thumb.
  if (state.tab === 'orders' || state.tab === 'home') renderKeepingForms();
}, 20000);

/* ---------------- auth ---------------- */

function authView() {
  const isLogin = state.authMode === 'login';
  if (state.authMode === 'reset') {
    return `
    <div class="auth-wrap">
      <div class="auth-hero">
        <div class="logo">🔐</div>
        <h1>Partner password</h1>
        <p>Reset your partner portal password.</p>
      </div>
      <div class="card">
        <label class="field"><span>Email</span><input id="p-reset-email" type="email" placeholder="you@business.com" /></label>
        <button class="btn" onclick="partnerRequestPasswordReset()">Send reset token</button>
        ${state.resetToken ? `<div class="muted small" style="margin-top:10px">Sandbox token: <b style="color:var(--text)">${esc(state.resetToken)}</b></div>` : ''}
        <div class="divider"></div>
        <label class="field"><span>Reset token</span><input id="p-reset-token" value="${esc(state.resetToken)}" placeholder="Paste token" /></label>
        <label class="field"><span>New password</span><input id="p-reset-password" type="password" placeholder="At least 6 characters" /></label>
        <button class="btn" onclick="partnerCompletePasswordReset()">Change password</button>
        <button class="btn ghost" style="margin-top:8px" onclick="setAuthMode('login')">Back to login</button>
      </div>
    </div>`;
  }
  if (state.authMode === 'otp') {
    return `
    <div class="auth-wrap">
      <div class="auth-hero">
        <div class="logo">📲</div>
        <h1>Partner phone login</h1>
        <p>Use the mobile number registered to your partner account.</p>
      </div>
      <div class="card">
        <label class="field"><span>Mobile number</span>
          <input id="p-otp-phone" value="${esc(state.otpLogin.phone)}" placeholder="e.g. +9779841000000" autocomplete="tel" />
        </label>
        <button class="btn" onclick="partnerRequestOtpLogin()">Send code</button>
        ${state.otpLogin.devCode ? `<div class="muted small" style="margin-top:10px">Sandbox OTP: <b style="color:var(--text)">${esc(state.otpLogin.devCode)}</b></div>` : ''}
        <div class="divider"></div>
        <label class="field"><span>OTP code</span>
          <input id="p-otp-code" inputmode="numeric" placeholder="123456" autocomplete="one-time-code" />
        </label>
        <button class="btn" onclick="partnerVerifyOtpLogin()">Continue</button>
        <button class="btn ghost" style="margin-top:8px" onclick="setAuthMode('login')">Back to email login</button>
      </div>
    </div>`;
  }
  return `
  <div class="auth-wrap">
    <div class="auth-hero">
      <img class="logo-img" src="/icon.svg" alt="SewaGo Partner" />
      <h1>Sewa<em>Go</em> Partner</h1>
      <p>List your restaurant or hotel once — customers see it in the app instantly.</p>
      <div class="auth-services">
        <span>🍜 <b>Restaurants</b></span><span>🏨 <b>Hotels</b></span>
      </div>
    </div>
    <div class="card">
      ${isLogin ? '' : `
      <label class="field"><span>Business / owner name</span>
        <input id="p-name" placeholder="e.g. Adhikari Hospitality" />
      </label>`}
      <label class="field"><span>Email</span>
        <input id="p-email" type="email" placeholder="you@business.com" />
      </label>
      <label class="field"><span>Password</span>
        <input id="p-password" type="password" placeholder="At least 6 characters" />
      </label>
      ${isLogin ? '' : `
      <div class="grid2">
        <label class="field"><span>Phone (we call to verify)</span>
          <input id="p-phone" placeholder="e.g. 9841000000" />
        </label>
        <label class="field"><span>Registration / PAN no.</span>
          <input id="p-regno" placeholder="e.g. PAN-301234567" />
        </label>
      </div>
      <div class="muted small" style="margin-bottom:12px">
        🛡️ Every listing is reviewed by the SewaGo team before it goes live. Keep your registration certificate handy — we verify the number and call you.
      </div>`}
      <button class="btn" onclick="submitAuth()">${isLogin ? 'Log in' : 'Join as a partner'}</button>
      ${isLogin ? `<button class="btn ghost" style="margin-top:8px" onclick="setAuthMode('otp')">Log in with phone OTP</button>` : ''}
      <div style="text-align:center;margin-top:14px">
        <button class="link" onclick="toggleAuthMode()">
          ${isLogin ? 'New partner? Create an account' : 'Already registered? Log in'}
        </button>
      </div>
      ${isLogin ? `<div style="text-align:center;margin-top:10px"><button class="link" onclick="setAuthMode('reset')">Forgot password?</button></div>` : ''}
    </div>
    ${isLogin ? `
    <div class="card">
      <div class="muted small" style="line-height:1.8">
        <b style="color:var(--text)">Demo partner</b> (password: <b style="color:var(--text)">partner123</b>)<br/>
        partner.demo@sewago.app · 🏪 shopkeeper.demo@sewago.app
      </div>
    </div>` : ''}
    <div style="text-align:center;margin-top:14px">
      <a class="link" href="/">← Back to the customer app</a>
    </div>
  </div>`;
}

window.toggleAuthMode = () => {
  state.authMode = state.authMode === 'login' ? 'register' : 'login';
  state.resetToken = '';
  state.otpLogin = { phone: '', devCode: '' };
  render();
};

window.setAuthMode = (mode) => {
  state.authMode = mode;
  if (mode !== 'reset') state.resetToken = '';
  if (mode !== 'otp') state.otpLogin = { phone: '', devCode: '' };
  render();
};

function completePartnerAuth(data) {
  state.token = data.token;
  state.partner = data.partner;
  state.restaurants = data.restaurants || [];
  state.hotels = data.hotels || [];
  state.otpLogin = { phone: '', devCode: '' };
  localStorage.setItem('sewago_partner_token', data.token);
  toast(`Welcome, ${data.partner.name}! 🤝`);
  connectEvents();
  // The login payload carries restaurants and hotels but not shops, so fetch
  // those before the first paint shows an empty "add your shop" prompt.
  Promise.all([reloadOrders(), loadStores()])
    .then(() => Promise.all([loadStoreOrders(), loadSubscribeRequests()]))
    .then(() => render())
    .catch(() => {});
  render();
}

window.submitAuth = async () => {
  const email = $('#p-email').value.trim();
  const password = $('#p-password').value;
  try {
    let data;
    if (state.authMode === 'login') {
      data = await api('/api/partner/login', { method: 'POST', body: { email, password } });
    } else {
      data = await api('/api/partner/register', {
        method: 'POST',
        body: {
          name: $('#p-name').value.trim(),
          email,
          password,
          phone: $('#p-phone').value.trim(),
          regNo: $('#p-regno').value.trim()
        }
      });
    }
    completePartnerAuth(data);
  } catch (e) {
    toast(e.message, true);
  }
};

window.partnerRequestOtpLogin = async () => {
  try {
    const phone = $('#p-otp-phone').value.trim();
    const data = await api('/api/partner/otp/request', { method: 'POST', body: { phone } });
    state.otpLogin = { phone: data.phone || phone, devCode: data.devCode || '' };
    toast(data.message || 'Verification code sent.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.partnerVerifyOtpLogin = async () => {
  try {
    const data = await api('/api/partner/otp/verify', {
      method: 'POST',
      body: {
        phone: ($('#p-otp-phone').value || state.otpLogin.phone).trim(),
        code: $('#p-otp-code').value.trim()
      }
    });
    completePartnerAuth(data);
  } catch (e) {
    toast(e.message, true);
  }
};

window.partnerRequestPasswordReset = async () => {
  try {
    const data = await api('/api/partner/password/request-reset', {
      method: 'POST',
      body: { email: $('#p-reset-email').value.trim() }
    });
    state.resetToken = data.devResetToken || '';
    toast(data.message || 'If the account exists, reset instructions were sent.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.partnerCompletePasswordReset = async () => {
  try {
    await api('/api/partner/password/reset', {
      method: 'POST',
      body: { token: $('#p-reset-token').value.trim(), password: $('#p-reset-password').value }
    });
    state.resetToken = '';
    state.authMode = 'login';
    toast('Password changed. Log in with the new password.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

function logoutLocal() {
  disconnectEvents();
  state.token = null;
  state.partner = null;
  state.orders = [];
  state.storeOrders = [];
  state.stores = [];
  state.subReqs = {};
  state.activeStore = null;
  state.activeListing = null;
  localStorage.removeItem('sewago_partner_token');
  render();
}

window.doLogout = () => logoutLocal();

/* ---------------- shell (home launcher + full-screen pages) ---------------- */

function render() {
  const app = $('#app');
  if (!state.partner) {
    app.innerHTML = authView();
    return;
  }
  // Full-screen takeovers: a shopkeeper working the shelves — or a partner
  // editing one menu — should not be scrolling past the rest of the dashboard.
  if (state.activeStore) {
    app.innerHTML = inventoryView();
    return;
  }
  if (state.activeListing) {
    app.innerHTML = listingDetailView();
    return;
  }
  app.innerHTML = `
    <header class="topbar">
      ${state.tab !== 'home' ? `<button class="back-chip" onclick="setTab('home')" aria-label="Back to Home">←</button>` : ''}
      <div class="brand"><img class="brand-mark" src="/icon.svg" alt="" />Sewa<em>Go</em> <span class="muted" style="font-size:13px;font-weight:700">PARTNER</span></div>
      <span class="badge">${esc(state.partner.name)}</span>
    </header>
    <main id="view"></main>`;
  renderTab();
}

function renderTab() {
  const view = $('#view');
  // Glide-in only on real navigation — background re-renders from polling/SSE
  // must not replay the animation.
  if (state._pageAnim) {
    view.classList.add('page-enter');
    state._pageAnim = false;
  }
  if (state.tab === 'orders') view.innerHTML = ordersTab();
  else if (state.tab === 'shops') view.innerHTML = shopsPage();
  else if (state.tab === 'restaurants') view.innerHTML = restaurantsPage();
  else if (state.tab === 'hotels') view.innerHTML = hotelsPage();
  else if (state.tab === 'earnings') view.innerHTML = earningsTab();
  else if (state.tab === 'profile') view.innerHTML = profileTab();
  else view.innerHTML = homeTab();
}

window.setTab = async (tab) => {
  const fromPop = state._popNav;
  state._popNav = false;
  // Hardware/browser back mirrors the ← chip, one level deep (Home ↔ page):
  // leaving Home pushes an entry; the chip consumes it via history.back(), and
  // the popstate handler below finishes the trip back to Home.
  if (tab === 'home' && !fromPop && history.state && history.state.tab) {
    history.back();
    return;
  }
  if (tab !== 'home') {
    if (history.state && history.state.tab) history.replaceState({ tab }, '');
    else history.pushState({ tab }, '');
  }
  state._pageAnim = state.tab !== tab;
  state.tab = tab;
  localStorage.setItem('sewago_partner_tab', tab);
  try {
    if (tab === 'home') {
      await Promise.all([reloadOrders(), loadStores()]);
      await Promise.all([loadStoreOrders(), loadSubscribeRequests()]);
    } else if (tab === 'orders') {
      await Promise.all([reloadOrders(), loadStoreOrders()]);
    } else if (tab === 'shops') {
      await loadStores();
      await loadSubscribeRequests();
    } else {
      await reload(); // restaurants · hotels · earnings · profile
    }
  } catch (e) { /* stale data still renders; SSE and the poll repair it */ }
  render();
};

// Hardware/browser back from a page returns to Home instead of leaving the
// app (the entry was pushed by setTab when leaving Home).
window.addEventListener('popstate', () => {
  if (!state.partner || state.tab === 'home') return;
  // Close whatever takeover sits on top first — back always lands on Home.
  if (state.activeStore) closeStore();
  if (state.activeListing) closeListing();
  state._popNav = true;
  setTab('home');
});

/* ---------------- home (launcher) ---------------- */

// One tile = stat + door: the number rides in the hint line, and only counts
// that want a reaction (new orders, subscription asks) get the corner bubble.
function homeTile(id, ico, label, hint, badge) {
  return `
  <button class="home-tile" onclick="setTab('${id}')">
    ${badge ? `<span class="badge-dot">${badge}</span>` : ''}
    <span class="ico">${ico}</span>
    <span class="lbl">${label}</span>
    <span class="hint">${hint}</span>
  </button>`;
}

function homeTab() {
  const p = state.partner;
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Namaste' : 'Good evening';
  const needAction = actionableOrderCount();
  const inFlight = state.orders.filter((o) => ['preparing', 'ready', 'out_for_delivery'].includes(o.status)).length
    + state.storeOrders.filter((o) => ['accepted', 'ready'].includes(o.status)).length;
  const revenueToday = state.stores.reduce((sum, s) => sum + ((s.stats || {}).revenueToday || 0), 0);
  const lowStock = state.stores.reduce(
    (sum, s) => sum + ((s.stats || {}).lowStock || 0) + ((s.stats || {}).outOfStock || 0), 0);
  const subPending = pendingSubTotal();
  const liveRest = state.restaurants.filter((r) => r.status === 'approved').length;
  const liveHotels = state.hotels.filter((h) => h.status === 'approved').length;
  return `
  <div class="section-title">${hello}, ${esc((p.name || '').split(' ')[0])} 🙏</div>
  ${kycNotice()}
  ${!partnerReady() ? `
  <div class="card" style="border-color:var(--accent)">
    <div style="font-weight:900">Finish setting up</div>
    <div class="muted small" style="margin:6px 0 10px">
      ${!p.phoneVerified ? 'Verify your phone number' : 'Complete business KYC'} to unlock listings and withdrawals.
    </div>
    <button class="btn" onclick="setTab('profile')">${!p.phoneVerified ? '📱 Verify phone' : '🛡️ Complete KYC'}</button>
  </div>` : ''}
  <div class="home-grid">
    ${homeTile('orders', '🧾', 'Orders',
      needAction ? `${needAction} need${needAction === 1 ? 's' : ''} your action`
        : inFlight ? `${inFlight} in progress` : 'food & shop orders', needAction)}
    ${homeTile('shops', '🏪', 'Shops',
      `${state.stores.length || 'no'} shop${state.stores.length === 1 ? '' : 's'} · ${lowStock ? `⚠️ ${lowStock} low` : 'inventory & subs'}`, subPending)}
    ${homeTile('restaurants', '🍜', 'Restaurants',
      liveRest ? `${liveRest} live` : state.restaurants.length ? `${state.restaurants.length} in review` : 'list your kitchen', 0)}
    ${homeTile('hotels', '🏨', 'Hotels',
      liveHotels ? `${liveHotels} live` : state.hotels.length ? `${state.hotels.length} in review` : 'list your rooms', 0)}
    ${homeTile('earnings', '💰', 'Earnings',
      `${money(p.earnings || 0)}${revenueToday ? ` · ${money(revenueToday)} today` : ''}`, 0)}
    ${homeTile('profile', '👤', 'Profile', 'KYC · phone · account', 0)}
  </div>`;
}

/* ---------------- orders tab (food + store, one pipeline) ---------------- */

const ORDER_STATUS_LINE = {
  placed: '🕐 Waiting for you to confirm',
  preparing: '👨‍🍳 Preparing — courier being arranged',
  out_for_delivery: '🛵 On the way to the customer',
  delivered: '✅ Delivered',
  cancelled: '❌ Cancelled'
};

// Pickup / eat-there orders never see a courier — the customer walks to the
// counter with a 4-digit code, so every line points at that moment instead.
const AHEAD_STATUS_LINE = {
  placed: '🕐 Waiting for you to confirm',
  preparing: '👨‍🍳 Cooking — the customer comes to the counter',
  ready: "🛎️ Ready — waiting for the customer's code",
  completed: '✅ Collected at the counter',
  cancelled: '❌ Cancelled'
};

// One stage per pipeline segment — food and store orders walk the same pipe.
function orderStage(o) {
  if (o._kind === 'food') {
    // Order-ahead food parks at 'ready' until the counter code is read out;
    // delivery food sits in the same column while the courier carries it.
    return { placed: 'new', preparing: 'progress', ready: 'ready', out_for_delivery: 'ready' }[o.status] || 'done';
  }
  return { placed: 'new', accepted: 'progress', ready: 'ready' }[o.status] || 'done';
}

const PIPE_LABELS = { new: 'New', progress: 'In progress', ready: 'Ready', done: 'Done' };
const PIPE_EMPTY = {
  new: 'No new orders — they appear here instantly.',
  progress: 'Nothing being prepared right now.',
  ready: 'Nothing waiting for handover or delivery.',
  done: 'Finished orders show up here.'
};

function ordersTab() {
  const all = [
    ...state.orders.map((o) => ({ ...o, _kind: 'food' })),
    ...state.storeOrders.map((o) => ({ ...o, _kind: 'store' }))
  ];
  const buckets = { new: [], progress: [], ready: [], done: [] };
  for (const o of all) buckets[orderStage(o)].push(o);
  // Done is history — newest first. In the working stages, ASAP orders stay
  // newest-first and scheduled ones queue below them in kitchen order
  // (soonest — or most overdue — promised time first).
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => {
      if (k !== 'done') {
        if (a.scheduledFor && b.scheduledFor) return a.scheduledFor - b.scheduledFor;
        if (a.scheduledFor || b.scheduledFor) return a.scheduledFor ? 1 : -1;
      }
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }
  buckets.done = buckets.done.slice(0, 12);
  const t = buckets[state.pipeTab] ? state.pipeTab : 'new';
  return `
  <div class="section-title">Orders 🧾</div>
  <div class="pipe-tabs">
    ${['new', 'progress', 'ready', 'done'].map((k) => `
    <button class="${t === k ? 'active' : ''}" onclick="setPipeTab('${k}')">${PIPE_LABELS[k]}${
      k !== 'done' && buckets[k].length ? ` <b class="tab-badge">${buckets[k].length}</b>` : ''}</button>`).join('')}
  </div>
  ${buckets[t].length
    ? buckets[t].map((o) => (o._kind === 'food' ? foodOrderCard(o) : storeOrderCard(o))).join('')
    : `<div class="empty"><div class="big">🧾</div>${PIPE_EMPTY[t]}</div>`}`;
}

window.setPipeTab = (tab) => {
  state.pipeTab = tab;
  state.confirmReject = '';
  state.pickupFor = '';
  state.groupSplit = '';
  render();
};

window.setConfirmReject = (id) => {
  state.confirmReject = id;
  renderKeepingForms();
};

// "7:30 PM" today, "Aug 7, 7:30 PM" otherwise — kitchens think in clock time,
// so the date only shows up when the order is for another day.
function fmtWhen(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

const MODE_BADGE = {
  delivery: '<span class="badge gray">🛵 DELIVERY</span>',
  pickup: '<span class="badge blue">🥡 PICKUP</span>',
  dinein: '<span class="badge blue">🍽️ EAT HERE</span>'
};

// Chip row under the order header: how the food leaves the kitchen, when it's
// wanted (amber once the promised time has slipped), and the group tag.
function orderChips(o) {
  const overdue = o.scheduledFor && o.scheduledFor < Date.now()
    && !['completed', 'delivered', 'cancelled'].includes(o.status);
  return `
    <div class="order-chips">
      ${MODE_BADGE[o.mode || 'delivery']}
      ${o.scheduledFor ? `<span class="badge ${overdue ? 'amber' : 'gray'}">${overdue ? '⚠️ was for' : '🕐 for'} ${fmtWhen(o.scheduledFor)}</span>` : ''}
      ${o.group ? `<span class="badge green">👥 GROUP × ${o.group.size}${o.group.pct ? ` · ${o.group.pct}% off` : ''}</span>` : ''}
    </div>`;
}

// Tap open to see who's paying what on a group order — names and shares only,
// the wallets themselves stay on the customer side.
function groupSplitBlock(o) {
  if (!o.group || !Array.isArray(o.group.perMember)) return '';
  if (state.groupSplit !== o.id) {
    return `<button class="btn ghost compact" style="margin-top:8px" onclick="toggleGroupSplit('${o.id}')">👥 Who's in this group…</button>`;
  }
  return `
  <div class="member-split">
    ${o.group.perMember.map((m) => `
    <div class="row">
      <span>${esc(m.name)}</span>
      <span>${o.group.pct ? `<s class="muted small">${money(m.subtotal)}</s> ` : ''}<b>${money(m.paid)}</b></span>
    </div>`).join('')}
    <button class="btn ghost compact" style="margin:8px 0" onclick="toggleGroupSplit('')">Hide</button>
  </div>`;
}

function foodOrderCard(o) {
  const ahead = o.mode === 'pickup' || o.mode === 'dinein';
  const line = (ahead ? AHEAD_STATUS_LINE : ORDER_STATUS_LINE)[o.status];
  return `
  <div class="card" ${o.status === 'placed' ? 'style="border-color:var(--accent)"' : ''}>
    <div class="row">
      <div>
        <div><b>${esc(o.restaurantName)}</b> · ${esc(o.customerName)}</div>
        <div class="muted small">${o.items.map((l) => `${l.qty}× ${esc(l.name)}`).join(', ')}</div>
        <div class="muted small">🍜 food order${o.deliveryLoc ? ` · 📍 ${esc(o.deliveryLoc.name)}` : ''}</div>
      </div>
      <div class="rt">
        <b>${money(o.subtotal)}</b>
        <div class="muted small">you earn ${money(o.partnerCut)}</div>
        <span class="badge ${o.status === 'placed' ? 'amber' : 'gray'}">⏱ ${timeAgo(o.createdAt)}</span>
      </div>
    </div>
    ${orderChips(o)}
    <div class="muted small" style="margin-top:8px">${line || esc(o.status)}${
      o.courier ? ` · 🛵 ${esc(o.courier.name)} (${esc(o.courier.plate)})` : ''}</div>
    ${groupSplitBlock(o)}
    ${o.status === 'placed' ? (state.confirmReject === o.id ? `
    <div class="inline-form">
      <span>Reject this order? The customer is refunded in full.</span>
      <button class="btn danger" onclick="rejectOrder('${o.id}')">Reject & refund</button>
      <button class="btn ghost" onclick="setConfirmReject('')">Back</button>
    </div>` : `
    <button class="btn" style="margin-top:10px" onclick="acceptOrder('${o.id}')">✅ Accept — start cooking</button>
    <button class="btn ghost compact" style="margin-top:8px" onclick="setConfirmReject('${o.id}')">Reject…</button>`) : ''}
    ${ahead && o.status === 'preparing' ? `
    <button class="btn" style="margin-top:10px" onclick="markFoodReady('${o.id}')">🛎️ Food's ready</button>` : ''}
    ${ahead && o.status === 'ready' ? (state.pickupFor === o.id ? `
    <div class="inline-form">
      <span>Customer's 4-digit code (in their app)</span>
      <input id="collect-code-${o.id}" inputmode="numeric" placeholder="1234" />
      <button class="btn" onclick="confirmCollected('${o.id}')">Confirm</button>
      <button class="btn ghost" onclick="setPickupFor('')">Cancel</button>
    </div>` : `
    <button class="btn" style="margin-top:10px" onclick="setPickupFor('${o.id}')">🤝 ${o.mode === 'dinein' ? 'Served' : 'Handed over'} — enter code</button>`) : ''}
    ${ahead && o.status === 'ready' ? (state.confirmReject === o.id ? `
    <div class="inline-form">
      <span>Customer never came? They get their money back in full.</span>
      <button class="btn danger" onclick="rejectOrder('${o.id}')">Refund</button>
      <button class="btn ghost" onclick="setConfirmReject('')">Back</button>
    </div>` : `
    <button class="btn ghost compact" style="margin-top:8px" onclick="setConfirmReject('${o.id}')">Never collected — refund…</button>`) : ''}
    ${o.status === 'cancelled' ? `<div class="muted small" style="margin-top:6px">Customer refunded in full.</div>` : ''}
  </div>`;
}

window.acceptOrder = async (id) => {
  try {
    await api(`/api/partner/orders/${id}/accept`, { method: 'POST' });
    toast('Order accepted — a courier is being arranged 🛵');
    await reloadOrders();
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.rejectOrder = async (id) => {
  try {
    await api(`/api/partner/orders/${id}/reject`, { method: 'POST', body: { note: '' } });
    state.confirmReject = '';
    toast('Order rejected — customer refunded.');
    await reloadOrders();
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

// Order-ahead: the kitchen is done — the customer's phone flips to "ready".
window.markFoodReady = async (id) => {
  try {
    await api(`/api/partner/orders/${id}/ready`, { method: 'POST' });
    toast('Marked ready — ask the customer for their code 🛎️');
    await reloadOrders();
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

// The counter moment: right code → food changes hands and income settles.
window.confirmCollected = async (id) => {
  const code = (($(`#collect-code-${id}`) || {}).value || '').trim();
  if (!code) return toast("Enter the 4-digit code from the customer's app.", true);
  try {
    await api(`/api/partner/orders/${id}/collected`, { method: 'POST', body: { code } });
    state.pickupFor = '';
    toast('Collected — income settled 💰');
    await reloadOrders();
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.toggleGroupSplit = (id) => {
  state.groupSplit = state.groupSplit === id ? '' : id;
  renderKeepingForms();
};

const STORE_NEXT_ACTION = {
  placed: ['accept', '✅ Accept order'],
  accepted: ['ready', '📦 Mark ready'],
  ready: ['handover', '🤝 Handed over']
};

function storeOrderCard(o) {
  const store = state.stores.find((s) => s.id === o.storeId) || {};
  // Once a courier is carrying it, the order settles at the customer's door —
  // offering "Handed over" here would be the wrong tap at exactly the moment
  // the shopkeeper hands the bag over.
  const withCourier = !!o.courierId;
  const next = withCourier ? null : STORE_NEXT_ACTION[o.status];
  // The customer proves it is their order by reading out the code from their
  // app — the server rejects a handover with the wrong one.
  const needsCode = next && next[0] === 'handover' && o.fulfilment === 'pickup';
  const canReject = o.status === 'placed' || o.status === 'accepted'
    || (o.status === 'ready' && o.fulfilment === 'pickup' && !withCourier);
  const rejectLabel = o.status === 'ready' ? 'Never collected — refund' : "Can't fulfil — refund";
  return `
  <div class="card" ${o.status === 'placed' ? 'style="border-color:var(--accent)"' : ''}>
    <div class="row">
      <div class="grow">
        <div style="font-weight:800">${esc(o.customerName)} <span class="muted small">· ${store.icon || '🏪'} ${esc(store.name || 'your shop')}</span></div>
        <div class="muted small">${o.items.map((l) => `${l.qty}× ${esc(l.name)}`).join(', ')}</div>
        <div class="muted small">${o.payment === 'cash' ? '💵 cash on handover' : '👛 paid in app'}${
          o.fulfilment === 'pickup' ? ' · 🏃 customer collects' : o.deliveryLoc ? ` · 📍 ${esc(o.deliveryLoc.name)}` : ''}</div>
      </div>
      <div class="rt">
        <b>${money(o.total)}</b>
        <div class="muted small">you get ${money(o.partnerCut)}</div>
        <span class="badge ${o.status === 'placed' ? 'amber' : 'gray'}">⏱ ${timeAgo(o.createdAt)}</span>
      </div>
    </div>
    ${withCourier && o.status !== 'delivered' && o.status !== 'cancelled'
      ? `<div class="muted small" style="margin-top:8px">🛵 With ${esc((o.courier && o.courier.name) || 'a courier')} — settles at the customer's door.</div>` : ''}
    ${next && !needsCode ? `<button class="btn" style="margin-top:10px" onclick="decideStoreOrder('${o.id}','${next[0]}')">${next[1]}</button>` : ''}
    ${needsCode ? (state.pickupFor === o.id ? `
    <div class="inline-form">
      <span>Customer's 4-digit pickup code (in their app)</span>
      <input id="pickup-code-${o.id}" inputmode="numeric" placeholder="1234" />
      <button class="btn" onclick="confirmHandover('${o.id}')">Confirm</button>
      <button class="btn ghost" onclick="setPickupFor('')">Cancel</button>
    </div>` : `
    <button class="btn" style="margin-top:10px" onclick="setPickupFor('${o.id}')">🤝 Handed over — enter code</button>`) : ''}
    ${canReject ? (state.confirmReject === o.id ? `
    <div class="inline-form">
      <span>${rejectLabel}? The customer gets their money back.</span>
      <button class="btn danger" onclick="decideStoreOrder('${o.id}','reject')">Refund</button>
      <button class="btn ghost" onclick="setConfirmReject('')">Back</button>
    </div>` : `
    <button class="btn ghost compact" style="margin-top:8px" onclick="setConfirmReject('${o.id}')">${rejectLabel}…</button>`) : ''}
    ${o.status === 'delivered' ? `<div class="muted small" style="margin-top:6px">✓ Done${o.fulfilment === 'pickup' ? ' — collected' : ' — delivered'}.</div>` : ''}
    ${o.status === 'cancelled' ? `<div class="muted small" style="margin-top:6px">Cancelled — customer refunded.</div>` : ''}
  </div>`;
}

window.setPickupFor = (id) => {
  state.pickupFor = id;
  renderKeepingForms();
};

window.confirmHandover = (orderId) => {
  const code = (($(`#pickup-code-${orderId}`) || {}).value || '').trim();
  if (!code) return toast("Enter the 4-digit code from the customer's app.", true);
  decideStoreOrder(orderId, 'handover', code);
};

window.decideStoreOrder = async (orderId, action, code) => {
  try {
    await api(`/api/partner/store-orders/${orderId}/${action}`, { method: 'POST', body: code ? { code } : {} });
    state.pickupFor = '';
    state.confirmReject = '';
    await Promise.all([loadStoreOrders(), loadStores()]);
    if (state.activeStore) await loadInventory();
    toast({ accept: 'Order accepted 👍', reject: 'Order rejected — customer refunded', ready: 'Marked ready', handover: 'Handed over — income settled 💰' }[action]);
    render();
  } catch (e) { toast(e.message, true); }
};

/* ---------------- shops / restaurants / hotels pages ---------------- */

// Each listing page repeats only its own slice of the review-team message.
function reviewIntro(where) {
  return `
  <div class="muted small" style="margin-bottom:14px">
    New listings go to the <b style="color:var(--text)">SewaGo review team</b> first (we verify your documents and may call you). Once approved they appear in the customer app under <b style="color:var(--text)">${where}</b>.
  </div>`;
}

// The gate copy lives on the pages where the gated action is, not on Home.
function lockedNote() {
  return partnerReady() ? ''
    : `<div class="muted small" style="margin-bottom:12px">🔒 Verify your phone and finish business KYC (in Profile) before adding listings.</div>`;
}

function shopsPage() {
  const ready = partnerReady();
  return `
  <div class="section-title">Your shops 🏪</div>
  ${reviewIntro('Shops')}
  ${lockedNote()}
  <div class="muted small" style="margin-bottom:10px">
    A general store: add your stock by speaking, tap <b style="color:var(--text)">Sold</b> as you sell, and customers nearby can order from you.
  </div>
  ${state.stores.length ? state.stores.map(storeRow).join('')
    : `<div class="empty"><div class="big">🏪</div>No shop yet — add yours below.</div>`}
  ${ready ? (state.showStoreForm ? storeForm() : `<button class="btn ghost" onclick="toggleStoreForm()">+ Add a shop</button>`) : ''}`;
}

function restaurantsPage() {
  const ready = partnerReady();
  return `
  <div class="section-title">Your restaurants 🍜</div>
  ${reviewIntro('Food')}
  ${lockedNote()}
  ${state.restaurants.length ? state.restaurants.map(restaurantRow).join('')
    : `<div class="empty"><div class="big">🍳</div>No restaurants yet — add your first one below.</div>`}
  ${ready ? (state.showRestForm ? restaurantForm() : `<button class="btn ghost" onclick="toggleRestForm()">+ Add a restaurant</button>`) : ''}`;
}

function hotelsPage() {
  const ready = partnerReady();
  return `
  <div class="section-title">Your hotels 🏨</div>
  ${reviewIntro('Stays')}
  ${lockedNote()}
  ${state.hotels.length ? state.hotels.map(hotelRow).join('')
    : `<div class="empty"><div class="big">🛎️</div>No hotels yet — add your first one below.</div>`}
  ${ready ? (state.showHotelForm ? hotelForm() : `<button class="btn ghost" onclick="toggleHotelForm()">+ Add a hotel</button>`) : ''}`;
}

// Slim list rows — the heavy editors live in the full-screen takeovers.
function storeRow(s) {
  const st = s.stats || {};
  const subs = pendingSubCount(s.id);
  const badge = s.status === 'approved'
    ? `<span class="badge ${s.open ? '' : 'gray'}">${s.open ? '🟢 OPEN' : '⚫ CLOSED'}</span>`
    : s.status === 'pending' ? `<span class="badge amber">IN REVIEW</span>` : `<span class="badge red">REJECTED</span>`;
  return `
  <div class="tile" onclick="openStore('${s.id}')">
    <span class="emoji">${s.icon}</span>
    <div class="grow">
      <h3>${esc(s.name)}</h3>
      <div class="sub">${st.items || 0} items · sold ${st.soldToday || 0} today${st.lowStock ? ` · ⚠️ ${st.lowStock} low` : ''}${subs ? ` · 🔁 ${subs} ask${subs > 1 ? 's' : ''}` : ''}</div>
      ${s.status === 'rejected' && s.reviewNote ? `<div class="sub" style="color:var(--danger)">${esc(s.reviewNote)}</div>` : ''}
    </div>
    <div class="right">${badge}</div>
  </div>`;
}

function restaurantRow(r) {
  return `
  <div class="tile" onclick="openListing('restaurants','${r.id}')">
    <span class="emoji">${r.icon}</span>
    <div class="grow">
      <h3>${esc(r.name)}</h3>
      <div class="sub">${esc(r.cuisine)} · ${r.menu.length} menu item${r.menu.length === 1 ? '' : 's'}${r.promotedUntil > Date.now() ? ' · ⭐ featured' : ''}</div>
      ${r.status === 'rejected' && r.reviewNote ? `<div class="sub" style="color:var(--danger)">${esc(r.reviewNote)}</div>` : ''}
    </div>
    <div class="right">${reviewStatusBadge(r)}</div>
  </div>`;
}

function hotelRow(h) {
  return `
  <div class="tile" onclick="openListing('hotels','${h.id}')">
    <span class="emoji">${h.icon}</span>
    <div class="grow">
      <h3>${esc(h.name)}</h3>
      <div class="sub">${esc(h.area)}${h.area ? ', ' : ''}${esc(h.city)} · ${h.rooms.length} room type${h.rooms.length === 1 ? '' : 's'}${h.promotedUntil > Date.now() ? ' · ⭐ featured' : ''}</div>
      ${h.status === 'rejected' && h.reviewNote ? `<div class="sub" style="color:var(--danger)">${esc(h.reviewNote)}</div>` : ''}
    </div>
    <div class="right">${reviewStatusBadge(h)}</div>
  </div>`;
}

window.openListing = (kind, id) => {
  state.activeListing = { kind, id };
  state.confirmRemove = '';
  render();
};

window.closeListing = () => {
  state.activeListing = null;
  state.confirmRemove = '';
  render();
};

// Full-screen takeover holding the existing menu/room editors, so the listing
// rows above stay slim (same pattern as the inventory manager).
function listingDetailView() {
  const { kind, id } = state.activeListing;
  const back = kind === 'restaurants' ? 'Restaurants' : 'Hotels';
  const x = (kind === 'restaurants' ? state.restaurants : state.hotels).find((i) => i.id === id);
  if (!x) {
    return `
    <header class="topbar">
      <button class="btn ghost compact" onclick="closeListing()">← ${back}</button>
    </header>
    <main><div class="empty"><div class="big">🤔</div>That listing is gone.</div></main>`;
  }
  return `
    <header class="topbar">
      <button class="btn ghost compact" onclick="closeListing()">← ${back}</button>
      ${reviewStatusBadge(x)}
    </header>
    <main>
      ${kind === 'restaurants' ? restaurantDetail(x) : hotelDetail(x)}
      <div style="height:40px"></div>
    </main>`;
}

window.setConfirmRemove = (id) => {
  state.confirmRemove = id;
  render();
};

// Removing a live listing takes it off the marketplace — worth one deliberate
// extra tap, inline rather than a browser confirm().
function removeListingBlock(x, label, handler) {
  if (state.confirmRemove === x.id) {
    return `
    <div class="inline-form">
      <span>Remove ${esc(x.name)} from the app? Customers will no longer see it.</span>
      <button class="btn danger" onclick="${handler}('${x.id}')">Remove</button>
      <button class="btn ghost" onclick="setConfirmRemove('')">Keep</button>
    </div>`;
  }
  return `<button class="btn ghost compact" style="margin-top:10px;border-color:#7f1d1d;color:#f87171" onclick="setConfirmRemove('${x.id}')">${label}…</button>`;
}

window.toggleRestForm = () => { state.showRestForm = !state.showRestForm; render(); };
window.toggleHotelForm = () => { state.showHotelForm = !state.showHotelForm; render(); };

/* ---------------- restaurants ---------------- */

function restaurantForm() {
  return `
  <div class="card">
    <div style="font-weight:900;margin-bottom:12px">New restaurant</div>
    <label class="field"><span>Name</span><input id="r-name" placeholder="e.g. Newa Kitchen" /></label>
    <label class="field"><span>Cuisine</span><input id="r-cuisine" placeholder="e.g. Newari · Set meals" /></label>
    <label class="field"><span>Area / neighbourhood (courier pickup point)</span><input id="r-area" placeholder="e.g. Thamel, Jawalakhel, New Baneshwor" /></label>
    <div class="grid2">
      <label class="field"><span>Prep time (min)</span><input id="r-eta" type="number" value="30" min="5" max="120" /></label>
      <label class="field"><span>Delivery fee (Rs)</span><input id="r-fee" type="number" value="50" min="0" max="500" /></label>
    </div>
    <label class="field"><span>Icon</span>
      <select id="r-icon">${REST_ICONS.map((i) => `<option>${i}</option>`).join('')}</select>
    </label>
    <div class="muted small" style="margin-bottom:6px">Cover photo — customers pick with their eyes 👀</div>
    ${photoField('new-rest')}
    <button class="btn" onclick="addRestaurant()">Create restaurant</button>
    <button class="btn ghost" style="margin-top:8px" onclick="toggleRestForm()">Cancel</button>
  </div>`;
}

window.addRestaurant = async () => {
  try {
    await api('/api/partner/restaurants', {
      method: 'POST',
      body: {
        name: $('#r-name').value.trim(),
        cuisine: $('#r-cuisine').value.trim(),
        area: $('#r-area').value.trim(),
        etaMinutes: $('#r-eta').value,
        deliveryFee: $('#r-fee').value,
        icon: $('#r-icon').value,
        photos: state.photos['new-rest'] || []
      }
    });
    delete state.photos['new-rest'];
    state.showRestForm = false;
    await reload();
    toast('Restaurant created — now add menu items so customers can order! 🎉');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

function reviewStatusBadge(x) {
  if (x.status === 'approved') return `<span class="badge">🟢 LIVE</span>`;
  if (x.status === 'rejected') return `<span class="badge red">REJECTED</span>`;
  return `<span class="badge amber">IN REVIEW</span>`;
}

function reviewStatusLine(x, kind) {
  if (x.status === 'rejected') {
    return `
    <div class="muted small" style="margin:8px 0;color:var(--danger)">
      ✕ Rejected by SewaGo: ${esc(x.reviewNote || 'no note')}
    </div>
    <button class="btn ghost" style="margin-bottom:8px" onclick="resubmitListing('${kind}','${x.id}')">↻ Fix & resubmit for review</button>`;
  }
  if (x.status === 'pending') {
    return `<div class="muted small" style="margin:8px 0">⏳ Waiting for SewaGo review — we verify your documents and may call ${esc(state.partner.phone || 'you')}.</div>`;
  }
  return '';
}

function promoBlock(type, x) {
  if (x.status !== 'approved') return '';
  const active = x.promotedUntil > Date.now();
  return `
    <div class="row" style="margin-top:10px">
      <div class="muted small">${active
        ? `⭐ <b style="color:var(--text)">Featured</b> until ${new Date(x.promotedUntil).toLocaleDateString([], { month: 'short', day: 'numeric' })} — top of the customer list`
        : 'Get seen first: featured listings sit at the top of the customer list.'}</div>
      <button class="btn ghost compact" onclick="promoteListing('${type}','${x.id}')">${active ? '⭐ Extend' : '⭐ Promote'} · ${money(state.promoteWeekPrice || 500)}/wk</button>
    </div>`;
}

window.promoteListing = async (type, id) => {
  try {
    const data = await api(`/api/partner/${type}/${id}/promote`, { method: 'POST' });
    state.partner = data.partner;
    await reload();
    toast('Listing featured for 7 days ⭐');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

function restaurantDetail(r) {
  return `
  <div class="card">
    ${r.photo ? `<img class="cover-img" src="${esc(r.photo)}" alt="${esc(r.name)}" />` : ''}
    <div>
      <div style="font-weight:900">${r.icon} ${esc(r.name)} ${reviewStatusBadge(r)}</div>
      <div class="muted small">${esc(r.cuisine)} · ${r.etaMinutes} min · delivery ${money(r.deliveryFee)}</div>
    </div>
    ${listingGallery('restaurants', r)}
    ${reviewStatusLine(r, 'restaurants')}
    ${promoBlock('restaurants', r)}
    <div class="divider"></div>
    ${r.menu.length === 0 ? `<div class="muted small" style="margin-bottom:10px">⚠️ No menu items yet — customers can't order until you add some.</div>` : ''}
    ${r.menu.map((m) => `
      <div class="row" style="margin-bottom:8px">
        ${m.photo ? `<img class="thumb" src="${esc(m.photo)}" alt="${esc(m.name)}" />` : ''}
        <div class="grow">
          <div><b>${esc(m.name)}</b> · ${money(m.price)}</div>
          ${m.desc ? `<div class="muted small">${esc(m.desc)}</div>` : ''}
        </div>
        <button class="btn ghost compact" onclick="deleteMenuItem('${r.id}','${m.id}')">✕</button>
      </div>`).join('')}
    <div class="divider"></div>
    <div class="muted small" style="margin-bottom:8px;font-weight:700">Add menu item</div>
    <div class="grid2">
      <label class="field"><span>Item name</span><input id="mi-name-${r.id}" placeholder="e.g. Chatamari" /></label>
      <label class="field"><span>Price (Rs)</span><input id="mi-price-${r.id}" type="number" placeholder="250" /></label>
    </div>
    <label class="field"><span>Description (optional)</span><input id="mi-desc-${r.id}" placeholder="e.g. Newari rice crepe with toppings" /></label>
    ${photoField(`menu-${r.id}`, '📷 Add a dish photo')}
    <button class="btn" onclick="addMenuItem('${r.id}')">Add item</button>
    ${removeListingBlock(r, 'Remove this restaurant', 'deleteRestaurant')}
  </div>
  ${groupDiscountCard(r)}`;
}

// One knob, two numbers: "N people or more who order together get X% off".
// The server validates the same ranges the placeholders show.
function groupDiscountCard(r) {
  const gd = r.groupDiscount;
  return `
  <div class="card">
    <div style="font-weight:900">Group discount 👥</div>
    <div class="muted small" style="margin:6px 0 10px">
      Groups that order together save you cooking runs — offer a discount to attract them.
    </div>
    ${gd ? `<div style="margin-bottom:4px"><span class="badge green">👥 ${gd.pct}% off for groups of ${gd.minPeople}+</span></div>` : ''}
    <div class="inline-form">
      <span>Discount % · how many people must confirm to unlock it</span>
      <input id="gd-pct-${r.id}" type="number" inputmode="numeric" min="1" max="50" placeholder="% off (1–50)" value="${gd ? gd.pct : ''}" />
      <input id="gd-min-${r.id}" type="number" inputmode="numeric" min="2" max="50" placeholder="people (2–50)" value="${gd ? gd.minPeople : ''}" />
      <button class="btn" onclick="setGroupDiscount('${r.id}')">${gd ? 'Update' : 'Set discount'}</button>
      ${gd ? `<button class="btn ghost" onclick="clearGroupDiscount('${r.id}')">Remove</button>` : ''}
    </div>
  </div>`;
}

window.setGroupDiscount = async (rid) => {
  try {
    await api(`/api/partner/restaurants/${rid}/group-discount`, {
      method: 'POST',
      body: { pct: $(`#gd-pct-${rid}`).value, minPeople: $(`#gd-min-${rid}`).value }
    });
    await reload();
    toast('Group discount is live 👥');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.clearGroupDiscount = async (rid) => {
  try {
    await api(`/api/partner/restaurants/${rid}/group-discount`, { method: 'POST', body: {} });
    await reload();
    toast('Group discount removed.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.addMenuItem = async (rid) => {
  try {
    await api(`/api/partner/restaurants/${rid}/menu`, {
      method: 'POST',
      body: {
        name: $(`#mi-name-${rid}`).value.trim(),
        price: $(`#mi-price-${rid}`).value,
        desc: $(`#mi-desc-${rid}`).value.trim(),
        photos: state.photos[`menu-${rid}`] || []
      }
    });
    delete state.photos[`menu-${rid}`];
    await reload();
    toast('Menu item added ✅');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.deleteMenuItem = async (rid, mid) => {
  try {
    await api(`/api/partner/restaurants/${rid}/menu/${mid}`, { method: 'DELETE' });
    await reload();
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.deleteRestaurant = async (rid) => {
  try {
    await api(`/api/partner/restaurants/${rid}`, { method: 'DELETE' });
    state.activeListing = null;
    state.confirmRemove = '';
    await reload();
    toast('Restaurant removed from the app.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- hotels ---------------- */

function hotelForm() {
  return `
  <div class="card">
    <div style="font-weight:900;margin-bottom:12px">New hotel</div>
    <label class="field"><span>Name</span><input id="h-name" placeholder="e.g. Himal View Resort" /></label>
    <div class="grid2">
      <label class="field"><span>City</span><input id="h-city" placeholder="e.g. Pokhara" /></label>
      <label class="field"><span>Area</span><input id="h-area" placeholder="e.g. Lakeside" /></label>
    </div>
    <label class="field"><span>One-line description</span><input id="h-desc" placeholder="e.g. Mountain views from every room" /></label>
    <label class="field"><span>Icon</span>
      <select id="h-icon">${HOTEL_ICONS.map((i) => `<option>${i}</option>`).join('')}</select>
    </label>
    <div class="muted small" style="margin-bottom:6px">Cover photo — listings with photos get booked first 👀</div>
    ${photoField('new-hotel')}
    <button class="btn" onclick="addHotel()">Create hotel</button>
    <button class="btn ghost" style="margin-top:8px" onclick="toggleHotelForm()">Cancel</button>
  </div>`;
}

window.addHotel = async () => {
  try {
    await api('/api/partner/hotels', {
      method: 'POST',
      body: {
        name: $('#h-name').value.trim(),
        city: $('#h-city').value.trim(),
        area: $('#h-area').value.trim(),
        desc: $('#h-desc').value.trim(),
        icon: $('#h-icon').value,
        photos: state.photos['new-hotel'] || []
      }
    });
    delete state.photos['new-hotel'];
    state.showHotelForm = false;
    await reload();
    toast('Hotel created — now add room types so customers can book! 🎉');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

function hotelDetail(h) {
  return `
  <div class="card">
    ${h.photo ? `<img class="cover-img" src="${esc(h.photo)}" alt="${esc(h.name)}" />` : ''}
    <div>
      <div style="font-weight:900">${h.icon} ${esc(h.name)} ${reviewStatusBadge(h)}</div>
      <div class="muted small">${esc(h.area)}${h.area ? ', ' : ''}${esc(h.city)}${h.desc ? ' · ' + esc(h.desc) : ''}</div>
    </div>
    ${listingGallery('hotels', h)}
    ${reviewStatusLine(h, 'hotels')}
    ${promoBlock('hotels', h)}
    <div class="divider"></div>
    ${h.rooms.length === 0 ? `<div class="muted small" style="margin-bottom:10px">⚠️ No room types yet — customers can't book until you add some.</div>` : ''}
    ${h.rooms.map((room) => `
      <div class="row" style="margin-bottom:8px">
        ${room.photo ? `<img class="thumb" src="${esc(room.photo)}" alt="${esc(room.type)}" />` : ''}
        <div class="grow">
          <div><b>${esc(room.type)}</b> · ${money(room.pricePerNight)}/night · ${room.count} room${room.count > 1 ? 's' : ''} · sleeps ${room.sleeps}</div>
          ${room.amenities.length ? `<div style="margin-top:3px">${room.amenities.map((a) => `<span class="amenity">${esc(a)}</span>`).join('')}</div>` : ''}
        </div>
        <button class="btn ghost compact" onclick="deleteRoom('${h.id}','${room.id}')">✕</button>
      </div>`).join('')}
    <div class="divider"></div>
    <div class="muted small" style="margin-bottom:8px;font-weight:700">Add room type</div>
    <div class="grid2">
      <label class="field"><span>Type</span><input id="ro-type-${h.id}" placeholder="e.g. Deluxe Room" /></label>
      <label class="field"><span>Price / night (Rs)</span><input id="ro-price-${h.id}" type="number" placeholder="3500" /></label>
    </div>
    <div class="grid2">
      <label class="field"><span>How many rooms</span><input id="ro-count-${h.id}" type="number" value="3" min="1" max="50" /></label>
      <label class="field"><span>Sleeps</span><input id="ro-sleeps-${h.id}" type="number" value="2" min="1" max="10" /></label>
    </div>
    <label class="field"><span>Amenities (comma separated)</span><input id="ro-amen-${h.id}" placeholder="WiFi, Breakfast, AC" /></label>
    ${photoField(`room-${h.id}`, '📷 Add a room photo')}
    <button class="btn" onclick="addRoom('${h.id}')">Add room type</button>
    ${removeListingBlock(h, 'Remove this hotel', 'deleteHotel')}
  </div>`;
}

window.addRoom = async (hid) => {
  try {
    await api(`/api/partner/hotels/${hid}/rooms`, {
      method: 'POST',
      body: {
        type: $(`#ro-type-${hid}`).value.trim(),
        pricePerNight: $(`#ro-price-${hid}`).value,
        count: $(`#ro-count-${hid}`).value,
        sleeps: $(`#ro-sleeps-${hid}`).value,
        amenities: $(`#ro-amen-${hid}`).value,
        photos: state.photos[`room-${hid}`] || []
      }
    });
    delete state.photos[`room-${hid}`];
    await reload();
    toast('Room type added ✅');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.deleteRoom = async (hid, rid) => {
  try {
    await api(`/api/partner/hotels/${hid}/rooms/${rid}`, { method: 'DELETE' });
    await reload();
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.resubmitListing = async (kind, id) => {
  try {
    await api(`/api/partner/${kind}/${id}/resubmit`, { method: 'POST' });
    await reload();
    toast('Resubmitted — the SewaGo team will take another look. ⏳');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.deleteHotel = async (hid) => {
  try {
    await api(`/api/partner/hotels/${hid}`, { method: 'DELETE' });
    state.activeListing = null;
    state.confirmRemove = '';
    await reload();
    toast('Hotel removed from the app.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- earnings tab ---------------- */

const PARTNER_TXN_ICONS = {
  order_income: '🍜', order_reversal: '↩️', booking_income: '🏨', booking_reversal: '↩️',
  withdrawal: '🏦', withdrawal_refund: '↩️', promotion: '⭐'
};

function partnerReady() {
  const p = state.partner;
  return !!p && !!p.phoneVerified && p.businessKycStatus === 'approved';
}

function earningsTab() {
  return `
  <div class="section-title">Earnings 💰</div>
  ${earningsCard()}`;
}

function earningsCard() {
  const p = state.partner;
  const shown = state.transactions.slice(0, state.txnShow);
  const hidden = state.transactions.length - shown.length;
  return `
  <div class="card">
    <div class="row">
      <div>
        <div class="muted small">Available to withdraw</div>
        <div style="font-size:24px;font-weight:900">${money(p.earnings || 0)}</div>
      </div>
      <span style="font-size:28px">💰</span>
    </div>
    ${(p.pendingEarnings || 0) > 0 ? `
    <div class="muted small" style="margin-top:6px">
      ⏳ <b style="color:var(--text)">${money(p.pendingEarnings)}</b> pending — clears when orders are delivered and stays reach check-in.
    </div>` : ''}
    <div class="muted small" style="margin-top:6px">
      You receive <b style="color:var(--text)">85%</b> of food subtotals and <b style="color:var(--text)">90%</b> of bookings. Income clears to withdrawable once the order is delivered or the stay begins.
    </div>
    ${partnerReady() ? `
    <button class="btn ${state.showWithdraw ? '' : 'ghost'}" aria-pressed="${!!state.showWithdraw}" style="margin-top:12px" onclick="toggleWithdraw()">🏦 Withdraw earnings</button>`
    : `<div class="muted small" style="margin-top:12px">🔒 Withdrawals unlock once your phone is verified and business KYC is approved.</div>`}
    ${state.showWithdraw && partnerReady() ? `
    <div class="divider"></div>
    <div class="grid2">
      <label class="field"><span>Amount (Rs)</span><input id="pw-amount" type="number" placeholder="1000" min="100" /></label>
      <label class="field"><span>Payout to</span>
        <select id="pw-channel">
          <option value="bank">Bank transfer</option>
          <option value="esewa">eSewa</option>
          <option value="khalti">Khalti</option>
        </select>
      </label>
    </div>
    <label class="field"><span>Account / wallet ID</span><input id="pw-account" placeholder="e.g. business account no." /></label>
    <div class="muted small" style="margin-bottom:10px">Rs 10 payout fee · paid out after SewaGo approves it.</div>
    <button class="btn" onclick="partnerWithdraw()">Request payout</button>` : ''}
    ${shown.length ? `
    <div class="divider"></div>
    <div class="muted small" style="font-weight:700;margin-bottom:8px">Recent activity</div>
    ${shown.map((t) => `
      <div class="row" style="margin-bottom:8px">
        <div class="small">${PARTNER_TXN_ICONS[t.type] || '💳'} ${esc(t.label)}${t.status === 'processing' ? ' <span class="muted">· ⏳</span>' : ''}</div>
        <div style="font-weight:800;white-space:nowrap;color:${t.sign > 0 ? 'var(--accent)' : 'var(--text)'}">${t.sign > 0 ? '+' : '−'}${money(t.amount)}</div>
      </div>`).join('')}
    ${hidden > 0 ? `<button class="btn ghost compact" onclick="showMoreTxns()">Show ${Math.min(15, hidden)} more</button>` : ''}` : ''}
  </div>`;
}

window.showMoreTxns = () => {
  state.txnShow += 15;
  render();
};

window.toggleWithdraw = () => { state.showWithdraw = !state.showWithdraw; render(); };

window.partnerWithdraw = async () => {
  try {
    const data = await api('/api/partner/withdraw', {
      method: 'POST',
      body: {
        amount: $('#pw-amount').value,
        channel: $('#pw-channel').value,
        account: $('#pw-account').value.trim()
      }
    });
    state.partner = data.partner;
    state.showWithdraw = false;
    await reload();
    toast('Payout requested — money arrives once SewaGo approves it 🏦');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- profile tab (identity, KYC, account) ---------------- */

function profileTab() {
  const p = state.partner;
  return `
  <div class="section-title">Profile 👤</div>
  <div class="card">
    <div class="row">
      <div>
        <div style="font-weight:900">${esc(p.name)}</div>
        <div class="muted small">${esc(p.email)}${p.phone ? ` · 📱 ${esc(p.phone)}` : ''}</div>
      </div>
      <span style="font-size:28px">🤝</span>
    </div>
  </div>
  ${kycNotice()}
  ${kycCard()}
  <button class="btn danger" style="margin-top:18px" onclick="doLogout()">Log out</button>
  <div class="card" style="margin-top:14px;border-color:#7f1d1d">
    <div style="font-weight:800">Delete account</div>
    <div class="muted small" style="margin:6px 0 10px;line-height:1.6">
      Removes your personal data permanently and takes your listings off the marketplace.
      Withdraw your earnings and settle upcoming bookings first.
      <a href="/privacy" target="_blank" class="link">Privacy policy</a>
    </div>
    ${state.showDeleteAccount ? `
    <label class="field"><span>Confirm with your password</span>
      <input id="del-password" type="password" placeholder="Your password" />
    </label>
    <div class="grid2">
      <button class="btn danger" onclick="partnerDeleteAccount()">Delete forever</button>
      <button class="btn ghost" onclick="toggleDeleteAccount(false)">Keep my account</button>
    </div>` : `
    <button class="btn ghost" style="border-color:#7f1d1d;color:#f87171" onclick="toggleDeleteAccount(true)">Delete my account…</button>`}
  </div>`;
}

window.toggleDeleteAccount = (show) => {
  state.showDeleteAccount = show;
  render();
};

// The typed password IS the confirmation step — no browser confirm() on top.
window.partnerDeleteAccount = async () => {
  try {
    await api('/api/partner/account/delete', { method: 'POST', body: { password: $('#del-password').value } });
    toast('Your account has been deleted. Goodbye 👋');
    state.showDeleteAccount = false;
    logoutLocal();
  } catch (e) {
    toast(e.message, true);
  }
};

// One-time banner announcing the KYC decision. Shows until the partner
// dismisses it (acknowledgement is remembered per partner + status).
function kycNotice() {
  const p = state.partner;
  const status = p.businessKycStatus || 'pending';
  if (status !== 'approved' && status !== 'rejected') return '';
  if (localStorage.getItem(KYC_ACK_KEY) === `${p.id}:${status}`) return '';
  if (status === 'approved') {
    return `
    <div class="card" style="border-color:var(--accent)">
      <div class="row">
        <div>
          <div style="font-weight:900">🎉 Business KYC approved!</div>
          <div class="muted small">Your documents were verified — you can now add restaurants and hotels, and withdraw earnings.</div>
        </div>
        <button class="btn ghost compact" onclick="ackKycNotice()">Got it</button>
      </div>
    </div>`;
  }
  return `
  <div class="card" style="border-color:var(--danger)">
    <div class="row">
      <div>
        <div style="font-weight:900">❌ Business KYC rejected</div>
        <div class="muted small">${p.businessKycNote ? esc(p.businessKycNote) : 'Fix your details in the KYC card in Profile and resubmit.'}</div>
      </div>
      <button class="btn ghost compact" onclick="ackKycNotice()">Got it</button>
    </div>
  </div>`;
}

window.ackKycNotice = () => {
  localStorage.setItem(KYC_ACK_KEY, `${state.partner.id}:${state.partner.businessKycStatus || 'pending'}`);
  render();
};

function kycCard() {
  const p = state.partner;
  const status = p.businessKycStatus || 'pending';
  const showPhoneForm = !p.phoneVerified || state.showPhoneEdit;
  // Fully verified: everything is done, so hide the forms — resubmitting KYC
  // would put the account back into review and lock listings.
  if (!showPhoneForm && status === 'approved') {
    return `
  <div class="card">
    <div class="row">
      <div>
        <div style="font-weight:900">Business KYC</div>
        <div class="muted small">📱 ${esc(p.phone)} — verified · ${esc(p.regNo || '')} approved. You're all set.</div>
      </div>
      <span class="badge">APPROVED</span>
    </div>
    <button class="btn ghost compact" style="margin-top:12px" onclick="togglePhoneEdit(true)">Change phone number</button>
  </div>`;
  }
  return `
  <div class="card">
    <div class="row">
      <div>
        <div style="font-weight:900">Business KYC</div>
        <div class="muted small">Phone verification and business document review unlock listings.</div>
      </div>
      <span class="badge ${status === 'approved' ? '' : status === 'rejected' ? 'red' : 'amber'}">${esc(status.toUpperCase())}</span>
    </div>
    <div class="status-grid" style="margin-top:12px">
      <span class="badge ${p.phoneVerified ? '' : 'amber'}">${p.phoneVerified ? 'PHONE VERIFIED' : 'PHONE NEEDED'}</span>
      <span class="badge ${status === 'approved' ? '' : 'amber'}">BUSINESS ${esc(status.toUpperCase())}</span>
    </div>
    ${p.businessKycNote ? `<div class="muted small" style="color:var(--danger);margin-top:8px">${esc(p.businessKycNote)}</div>` : ''}
    ${showPhoneForm ? `
    <label class="field" style="margin-top:12px"><span>Phone</span>
      <input id="partner-phone" value="${esc(p.phone || '')}" placeholder="e.g. 9841000000" />
    </label>
    <div class="grid2">
      <button class="btn ghost" onclick="partnerRequestOtp()">Send OTP</button>
      <label class="field"><span>OTP code</span><input id="partner-otp" placeholder="123456" /></label>
    </div>
    <button class="btn" onclick="partnerVerifyOtp()">Verify phone</button>
    ${state.showPhoneEdit ? `<button class="btn ghost" style="margin-top:8px" onclick="togglePhoneEdit(false)">Cancel</button>` : ''}` : `
    <div class="muted small" style="margin-top:12px">📱 ${esc(p.phone)} — verified. <button class="link" onclick="togglePhoneEdit(true)">Change</button></div>`}
    ${status !== 'approved' ? `
    <div class="divider"></div>
    <label class="field"><span>Legal business name</span>
      <input id="kyc-name" value="${esc(p.name || '')}" placeholder="Registered business name" />
    </label>
    <label class="field"><span>Registration / PAN no.</span>
      <input id="kyc-regno" value="${esc(p.regNo || '')}" placeholder="PAN-301234567" />
    </label>
    <label class="field"><span>Document reference / upload link</span>
      <input id="kyc-doc" value="${esc(p.businessKycDocumentRef || '')}" placeholder="Certificate file ID or secure link" />
    </label>
    <button class="btn" onclick="submitPartnerKyc()">${status === 'rejected' ? 'Fix & resubmit KYC' : 'Submit KYC for review'}</button>` : ''}
  </div>`;
}

window.togglePhoneEdit = (show) => {
  state.showPhoneEdit = show;
  render();
};

window.partnerRequestOtp = async () => {
  try {
    const data = await api('/api/partner/phone/request-otp', {
      method: 'POST',
      body: { phone: $('#partner-phone').value.trim() }
    });
    state.partner = data.partner;
    toast(data.devCode ? `Sandbox OTP: ${data.devCode}` : 'Verification code sent.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.partnerVerifyOtp = async () => {
  try {
    const data = await api('/api/partner/phone/verify', {
      method: 'POST',
      body: { code: $('#partner-otp').value.trim() }
    });
    state.partner = data.partner;
    state.showPhoneEdit = false;
    toast('Phone verified.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.submitPartnerKyc = async () => {
  try {
    const data = await api('/api/partner/kyc', {
      method: 'POST',
      body: {
        legalName: $('#kyc-name').value.trim(),
        regNo: $('#kyc-regno').value.trim(),
        documentRef: $('#kyc-doc').value.trim()
      }
    });
    state.partner = data.partner;
    toast('KYC submitted — SewaGo will review it.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- boot ---------------- */

(async function boot() {
  // Know up-front whether the AI stock assistant exists — a shopkeeper should
  // never type a prompt into a card that can only answer "not configured".
  api('/api/app-info').then((info) => {
    state.aiDisabled = !info.ai;
    if (state.activeStore) renderKeepingForms();
  }).catch(() => {});
  if (state.token) {
    try {
      await reload();
      connectEvents();
    } catch (e) {
      state.token = null;
      localStorage.removeItem('sewago_partner_token');
    }
  }
  // Password-reset link from the email: open the reset form with the token in.
  const resetParam = new URLSearchParams(window.location.search).get('reset');
  if (resetParam && !state.partner) {
    window.history.replaceState({}, '', window.location.pathname);
    state.authMode = 'reset';
    state.resetToken = resetParam;
  }
  render();
})();

/* ==================================================================
   General store (kirana) — inventory manager
   ==================================================================
   The shopkeeper's daily loop: speak (or describe to the AI) what goes
   on the shelf, tap Sold when someone buys, glance at what's running
   out, answer subscription requests. Everything here is built for one
   thumb on a cheap phone in a busy shop.
*/

const STORE_ICONS = ['🏪', '🛒', '🥫', '🧺', '🏬', '🍚'];

async function loadStores() {
  const data = await api('/api/partner/stores');
  state.stores = data.stores || [];
}

async function loadInventory() {
  if (!state.activeStore) return;
  const q = state.invSearch ? `?q=${encodeURIComponent(state.invSearch)}` : '';
  state.inventory = await api(`/api/partner/stores/${state.activeStore}/inventory${q}`);
}

window.openStore = async (id) => {
  state.activeStore = id;
  state.invTab = 'stock';
  state.invSearch = '';
  try {
    await loadInventory();
    // Badge on the Subscriptions tab — best-effort, never blocks the shelves.
    loadSubscribeRequests().then(() => render()).catch(() => {});
    render();
  } catch (e) { toast(e.message, true); }
};

window.closeStore = () => {
  state.activeStore = null;
  state.inventory = null;
  state.voice = { listening: false, heard: '', error: '' };
  state.drafts = null;
  state.itemForm = null;
  state.subAccept = '';
  state.helperForm = false;
  state.helperInvite = null;
  render();
};

window.setInvTab = async (tab) => {
  state.invTab = tab;
  state.itemForm = null;
  render();
  try {
    if (tab === 'reorder') state.reorder = await api(`/api/partner/stores/${state.activeStore}/reorder`);
    if (tab === 'subs') await loadSubscribeRequests();
    render();
  } catch (e) { toast(e.message, true); }
};

window.toggleStoreForm = () => { state.showStoreForm = !state.showStoreForm; render(); };

window.createStore = async () => {
  const name = ($('#store-name') || {}).value || '';
  const area = ($('#store-area') || {}).value || '';
  const deliveryFee = ($('#store-fee') || {}).value || 0;
  try {
    await api('/api/partner/stores', { method: 'POST', body: { name, area, deliveryFee, icon: state.storeIcon || '🏪' } });
    state.showStoreForm = false;
    await loadStores();
    toast('Shop submitted for review 🏪');
    render();
  } catch (e) { toast(e.message, true); }
};

window.pickStoreIcon = (icon) => { state.storeIcon = icon; render(); };

window.toggleShopOpen = async (open) => {
  try {
    await api(`/api/partner/stores/${state.activeStore}`, { method: 'PATCH', body: { open } });
    await loadInventory();
    toast(open ? 'Shop is open — customers can order 🟢' : 'Shop closed — no new orders');
    render();
  } catch (e) { toast(e.message, true); }
};

function storeForm() {
  const icon = state.storeIcon || '🏪';
  return `
  <div class="card">
    <label class="field"><span>Shop name</span><input id="store-name" placeholder="e.g. Ram Kirana Pasal" /></label>
    <label class="field"><span>Area</span><input id="store-area" placeholder="e.g. Thamel, New Baneshwor" /></label>
    <label class="field"><span>Delivery charge (Rs, 0 if customers collect)</span><input id="store-fee" type="number" value="0" min="0" max="200" /></label>
    <div class="muted small" style="margin-bottom:6px">Shop icon</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      ${STORE_ICONS.map((i) => `<button class="btn ghost compact" style="${i === icon ? 'border-color:var(--accent)' : ''}" onclick="pickStoreIcon('${i}')">${i}</button>`).join('')}
    </div>
    <button class="btn" onclick="createStore()">Submit for review</button>
    <button class="btn ghost" style="margin-top:8px" onclick="toggleStoreForm()">Cancel</button>
  </div>`;
}

/* ---------------- AI stock assistant ---------------- */

// Free text in, draft rows out. The server never writes anything — every draft
// lands in the same review table the voice flow uses, and only "Add all"
// commits through the bulk endpoint.
function aiCard() {
  if (state.aiDisabled) {
    return `<div class="muted small" style="margin-bottom:12px">🤖 The AI stock assistant is not set up on this server — add items by voice or typing below.</div>`;
  }
  return `
  <div class="card ai-card">
    <div style="font-weight:900">Stock assistant 🤖</div>
    <div class="muted small" style="margin:6px 0 10px">
      Describe what to add or restock — it drafts the rows, you check and save.
    </div>
    <textarea id="ai-prompt" rows="3" placeholder="wai wai 20 packet 25 rs, coca cola 12 bottle…&#10;restock everything that's running low&#10;set up a typical cold store"></textarea>
    <button class="btn" style="margin-top:10px" onclick="aiGenerate()" ${state.aiBusy ? 'disabled' : ''}>${state.aiBusy ? '⏳ Drafting…' : '✨ Generate draft'}</button>
  </div>`;
}

window.aiGenerate = async () => {
  const prompt = (($('#ai-prompt') || {}).value || '').trim();
  if (prompt.length < 3) return toast('Describe what to add or restock first.', true);
  state.aiBusy = true;
  renderKeepingForms();
  try {
    const d = await api(`/api/partner/stores/${state.activeStore}/ai/inventory`, { method: 'POST', body: { prompt } });
    syncDraftEdits(); // keep any half-edited rows already in the table
    const rows = (d.items || []).map((r) => ({
      name: r.name, qty: Number(r.stock) || 0, unit: r.unit, price: r.price, category: r.category || ''
    }));
    state.drafts = state.drafts
      ? { source: 'ai', note: d.note || state.drafts.note, items: [...state.drafts.items, ...rows] }
      : { source: 'ai', note: d.note || '', items: rows };
    state.aiBusy = false;
    render();
  } catch (e) {
    state.aiBusy = false;
    if (e.status === 503) state.aiDisabled = true; // not configured — hide the card
    else toast(e.message, true);
    renderKeepingForms();
  }
};

/* ---------------- voice entry ---------------- */

// Browser speech recognition. Nepali first, since that is what a shopkeeper
// speaks; if the device has no Nepali model it still returns something usable
// and the review table catches the difference.
function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

window.startVoice = () => {
  if (!speechSupported()) {
    state.voice.error = 'This phone cannot listen — type the item instead.';
    return render();
  }
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new Rec();
  rec.lang = state.voiceLang || 'ne-NP';
  rec.interimResults = true;
  rec.continuous = false;
  state.voice = { ...state.voice, listening: true, heard: '', error: '' };
  render();

  rec.onresult = (ev) => {
    let text = '';
    for (let i = 0; i < ev.results.length; i += 1) text += ev.results[i][0].transcript;
    state.voice.heard = text;
    const line = $('#voice-heard');
    if (line) line.textContent = text;
    if (ev.results[ev.results.length - 1].isFinal) submitVoiceText(text);
  };
  rec.onerror = (ev) => {
    state.voice.listening = false;
    state.voice.error = ev.error === 'not-allowed'
      ? 'Microphone blocked — allow it in your browser, or type the item.'
      : 'Could not hear that. Try again, or type the item.';
    render();
  };
  rec.onend = () => { state.voice.listening = false; render(); };
  try { rec.start(); } catch (e) { state.voice.listening = false; render(); }
  state.voiceRec = rec;
};

window.stopVoice = () => {
  if (state.voiceRec) { try { state.voiceRec.stop(); } catch (e) { /* already stopped */ } }
  state.voice.listening = false;
  render();
};

window.toggleVoiceLang = () => {
  state.voiceLang = (state.voiceLang || 'ne-NP') === 'ne-NP' ? 'en-IN' : 'ne-NP';
  toast(state.voiceLang === 'ne-NP' ? 'Listening in Nepali' : 'Listening in English');
  render();
};

// The parse always lands in the review table — a mis-hear must cost one edit,
// never a wrong stock number saved silently. Speaking again queues another row.
async function submitVoiceText(text) {
  try {
    const data = await api('/api/stores/voice/parse', { method: 'POST', body: { text } });
    syncDraftEdits();
    if (!state.drafts) state.drafts = { source: 'voice', note: '', items: [] };
    state.drafts.items.push({ ...data.item, category: '' });
    state.voice.listening = false;
    state.voice.heard = '';
    render();
  } catch (e) { toast(e.message, true); }
}

window.typeVoiceLine = () => {
  const el = $('#voice-typed');
  if (el && el.value.trim()) submitVoiceText(el.value.trim());
};

function voiceCard() {
  const v = state.voice;
  const lang = (state.voiceLang || 'ne-NP') === 'ne-NP' ? 'नेपाली' : 'English';
  return `
  <div class="card">
    <div class="row">
      <div style="font-weight:900">Add stock by speaking 🎤</div>
      <button class="btn ghost compact" onclick="toggleVoiceLang()">${lang}</button>
    </div>
    <div class="muted small" style="margin:6px 0 12px">
      Say the item, how many, and the price — “<b style="color:var(--text)">दुई किलो चिनी सय रुपैयाँ</b>” or “<b style="color:var(--text)">5 packet wai wai 20 rupees</b>”.
    </div>
    ${v.listening
      ? `<button class="btn danger mic-btn listening" onclick="stopVoice()">● Listening… tap when done</button>
         <div class="muted small" id="voice-heard" style="margin-top:8px;min-height:20px">${esc(v.heard || '')}</div>`
      : `<button class="btn mic-btn" onclick="startVoice()">🎤 Hold a moment and speak</button>`}
    ${v.error ? `<div class="muted small" style="color:#fca5a5;margin-top:8px">${esc(v.error)}</div>` : ''}
    <div class="divider"></div>
    <label class="field" style="margin:0"><span>…or type it</span>
      <input id="voice-typed" placeholder="2 kg sugar 100" onkeydown="if(event.key==='Enter')typeVoiceLine()" />
    </label>
    <button class="btn ghost compact" style="margin-top:8px" onclick="typeVoiceLine()">Add typed line</button>
  </div>`;
}

/* ---------------- draft review table (voice + AI share it) ---------------- */

// Nothing reaches the shelves until the shopkeeper has seen it: every draft
// row is editable (fields the voice parser was unsure about are highlighted),
// and one "Add all" commits through the bulk endpoint — where a duplicate
// name+unit becomes a restock, which is exactly right for "restock" prompts.
function draftsCard() {
  const d = state.drafts;
  if (!d || !d.items.length) return '';
  const units = (state.inventory && state.inventory.units) || {};
  const warn = (row, f) => ((row.needsReview || []).includes(f) ? 'warn' : '');
  return `
  <div class="card" style="border-color:var(--accent);margin-top:12px">
    <div style="font-weight:900">${d.source === 'ai' ? '🤖 AI draft — check before saving' : 'Check before saving'}</div>
    ${d.note ? `<div class="muted small" style="margin-top:4px">${esc(d.note)}</div>` : ''}
    <div class="muted small" style="margin-top:4px">Nothing is saved yet — fix any cell, drop rows you don't want.</div>
    ${d.items.map((row, i) => `
    <div class="draft-row">
      <div class="dr-top">
        <input id="dr-name-${i}" class="${warn(row, 'name')}" value="${esc(row.name || '')}" placeholder="Item" />
        <button class="btn ghost compact dr-x" onclick="removeDraftRow(${i})">✕</button>
      </div>
      ${row.raw ? `<div class="muted small" style="margin-top:4px">Heard: “${esc(row.raw)}”</div>` : ''}
      <div class="dr-grid">
        <input id="dr-qty-${i}" class="${warn(row, 'qty')}" type="number" step="0.5" value="${row.qty ?? ''}" placeholder="Qty" />
        <select id="dr-unit-${i}" class="${warn(row, 'unit')}">
          ${Object.entries(units).map(([k, u]) => `<option value="${k}" ${k === row.unit ? 'selected' : ''}>${u.label}</option>`).join('')}
        </select>
        <input id="dr-price-${i}" class="${warn(row, 'price')}" type="number" value="${row.price ?? ''}" placeholder="Rs" />
        <input id="dr-cat-${i}" value="${esc(row.category || '')}" placeholder="Category" />
      </div>
    </div>`).join('')}
    <button class="btn" style="margin-top:12px" onclick="commitDrafts()">Add all ${d.items.length} to inventory</button>
    <button class="btn ghost" style="margin-top:8px" onclick="discardDrafts()">Discard draft</button>
  </div>`;
}

// Pull whatever the shopkeeper typed in the table back into state, so edits
// survive re-renders, row removals and a second AI/voice round.
function syncDraftEdits() {
  if (!state.drafts) return;
  state.drafts.items.forEach((row, i) => {
    const el = (id) => document.getElementById(id);
    const name = el(`dr-name-${i}`); if (name) row.name = name.value;
    const qty = el(`dr-qty-${i}`); if (qty) row.qty = Number(qty.value) || 0;
    const unit = el(`dr-unit-${i}`); if (unit) row.unit = unit.value;
    const price = el(`dr-price-${i}`); if (price) row.price = Number(price.value) || 0;
    const cat = el(`dr-cat-${i}`); if (cat) row.category = cat.value;
  });
}

window.removeDraftRow = (i) => {
  syncDraftEdits();
  state.drafts.items.splice(i, 1);
  if (!state.drafts.items.length) state.drafts = null;
  render();
};

window.discardDrafts = () => {
  state.drafts = null;
  render();
};

window.commitDrafts = async () => {
  syncDraftEdits();
  const rows = state.drafts.items
    .map((r) => ({ name: (r.name || '').trim(), qty: r.qty, unit: r.unit, price: r.price, category: (r.category || '').trim() }))
    .filter((r) => r.name);
  if (!rows.length) return toast('Nothing to add — every row needs a name.', true);
  try {
    const res = await api(`/api/partner/stores/${state.activeStore}/items/bulk`, { method: 'POST', body: { items: rows } });
    const restocked = (res.added || []).filter((a) => a.restocked).length;
    const added = (res.added || []).length - restocked;
    const failed = res.failed || [];
    state.drafts = null;
    await loadInventory();
    const summary = [added ? `${added} added` : '', restocked ? `${restocked} restocked` : ''].filter(Boolean).join(' · ') || 'Saved';
    if (failed.length) toast(`${summary} — ${failed.length} failed: ${failed[0].error}`, true);
    else toast(`${summary} ✓`);
    render();
  } catch (e) { toast(e.message, true); }
};

/* ---------------- stock actions ---------------- */

window.markSold = async (itemId, qty) => {
  try {
    await api(`/api/partner/stores/${state.activeStore}/items/${itemId}/sold`, { method: 'POST', body: { qty: qty || 1 } });
    await loadInventory();
    render();
  } catch (e) { toast(e.message, true); }
};

// Inline-form expansions on item rows — restock / price / subscriber price all
// open right under the row that triggered them, one at a time.
window.openItemForm = (id, kind) => {
  const f = state.itemForm;
  state.itemForm = f && f.id === id && f.kind === kind ? null : { id, kind };
  renderKeepingForms();
};

window.closeItemForm = () => {
  state.itemForm = null;
  render();
};

function itemInlineForm(i) {
  const f = state.itemForm;
  if (!f || f.id !== i.id) return '';
  if (f.kind === 'restock') {
    return `
    <div class="inline-form">
      <span>How many ${esc(i.unitLabel)} did you receive? (negative corrects a miscount)</span>
      <input id="if-qty-${i.id}" type="number" step="0.5" placeholder="10" />
      <button class="btn" onclick="confirmRestock('${i.id}')">Add stock</button>
      <button class="btn ghost" onclick="closeItemForm()">Cancel</button>
    </div>`;
  }
  if (f.kind === 'price') {
    return `
    <div class="inline-form">
      <span>New shelf price (Rs / ${esc(i.unitLabel)})</span>
      <input id="if-price-${i.id}" type="number" value="${i.price}" />
      <button class="btn" onclick="confirmPrice('${i.id}')">Save price</button>
      <button class="btn ghost" onclick="closeItemForm()">Cancel</button>
    </div>`;
  }
  return `
  <div class="inline-form">
    <span>Subscriber price — must be under Rs ${i.price}. Leave blank to remove.</span>
    <input id="if-sub-${i.id}" type="number" value="${i.subscribePrice || ''}" placeholder="Rs" />
    <button class="btn" onclick="confirmSubPrice('${i.id}')">Save</button>
    <button class="btn ghost" onclick="closeItemForm()">Cancel</button>
  </div>`;
}

window.confirmRestock = async (itemId) => {
  const qty = Number((($(`#if-qty-${itemId}`) || {}).value || ''));
  if (!qty) return toast('Enter how many came in.', true);
  try {
    await api(`/api/partner/stores/${state.activeStore}/items/${itemId}/restock`, { method: 'POST', body: { qty } });
    state.itemForm = null;
    await loadInventory();
    toast('Stock updated ✓');
    render();
  } catch (e) { toast(e.message, true); }
};

window.confirmPrice = async (itemId) => {
  const price = Number((($(`#if-price-${itemId}`) || {}).value || ''));
  try {
    await api(`/api/partner/stores/${state.activeStore}/items/${itemId}`, { method: 'PATCH', body: { price } });
    state.itemForm = null;
    await loadInventory();
    toast('Price updated ✓');
    render();
  } catch (e) { toast(e.message, true); }
};

window.confirmSubPrice = async (itemId) => {
  const raw = (($(`#if-sub-${itemId}`) || {}).value || '').trim();
  try {
    await api(`/api/partner/stores/${state.activeStore}/items/${itemId}`, {
      method: 'PATCH', body: { subscribePrice: raw ? Number(raw) : 0 }
    });
    state.itemForm = null;
    await loadInventory();
    toast(raw ? 'Subscriber price set — regulars pay less ✓' : 'Subscriber price removed');
    render();
  } catch (e) { toast(e.message, true); }
};

window.searchInventory = async () => {
  state.invSearch = ($('#inv-search') || {}).value || '';
  try { await loadInventory(); renderKeepingForms(); } catch (e) { toast(e.message, true); }
};

/* ---------------- helpers (staff) ---------------- */

window.toggleHelperForm = (show) => {
  state.helperForm = show;
  render();
};

window.dismissHelperInvite = () => {
  state.helperInvite = null;
  state.helperForm = false;
  render();
};

window.inviteHelper = async () => {
  const name = (($('#helper-name') || {}).value || '').trim();
  try {
    const res = await api(`/api/partner/stores/${state.activeStore}/helpers`, { method: 'POST', body: { name } });
    state.helperInvite = res.invite;
    state.helperForm = false;
    render();
  } catch (e) { toast(e.message, true); }
};

function helperBlock() {
  if (state.helperInvite) {
    return `
    <div class="card" style="border-color:var(--accent)">
      <div style="font-weight:900">👥 Helper invited</div>
      <div class="muted small" style="margin:6px 0 10px">
        Give ${esc(state.helperInvite.name || 'your helper')} this code to join in the SewaGo app. They can add items and count stock — never change prices or see your money.
      </div>
      <div style="font-size:26px;font-weight:900;letter-spacing:4px;text-align:center">${esc(state.helperInvite.code)}</div>
      <div class="muted small" style="text-align:center;margin-top:6px">Works for 24 hours — invite again if they miss it.</div>
      <button class="btn ghost" style="margin-top:10px" onclick="dismissHelperInvite()">Done</button>
    </div>`;
  }
  if (state.helperForm) {
    return `
    <div class="inline-form">
      <span>Helper name (so you know whose count is whose)</span>
      <input id="helper-name" placeholder="e.g. Sita" />
      <button class="btn" onclick="inviteHelper()">Invite</button>
      <button class="btn ghost" onclick="toggleHelperForm(false)">Cancel</button>
    </div>`;
  }
  return `
    <button class="btn ghost" onclick="toggleHelperForm(true)">👥 Invite a helper to count stock</button>
    <div class="muted small" style="margin-top:6px">They can add items and count shelves — never change prices or see your money.</div>`;
}

/* ---------------- views ---------------- */

function itemRow(i) {
  const out = i.stock <= 0;
  const asks = ((state.subReqs[state.activeStore] || {}).pendingByItem || {})[i.id] || 0;
  return `
  <div class="card" style="${out ? 'border-color:#7f1d1d' : i.low ? 'border-color:#a16207' : ''}">
    <div class="row">
      <div class="grow">
        <div style="font-weight:800">${esc(i.name)}</div>
        <div class="muted small">
          ${money(i.price)} / ${esc(i.unitLabel)}${i.subscribePrice ? ` · 🔁 ${money(i.subscribePrice)} for subscribers` : ''}
        </div>
      </div>
      <div style="text-align:right">
        <div style="font-size:20px;font-weight:900;color:${out ? '#f87171' : i.low ? '#fbbf24' : 'var(--text)'}">${i.stock}</div>
        <div class="muted small">${esc(i.unitLabel)} left</div>
      </div>
    </div>
    ${out ? `<div class="muted small" style="color:#fca5a5;margin-top:6px">Out of stock — customers cannot order it</div>`
      : i.low ? `<div class="muted small" style="color:#fbbf24;margin-top:6px">Running low — reorder soon</div>` : ''}
    ${asks ? `<div class="muted small" style="color:var(--accent);margin-top:6px">🔁 ${asks} customer${asks > 1 ? 's' : ''} asking to subscribe — see the Subscriptions tab</div>` : ''}
    <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
      <button class="btn compact" onclick="markSold('${i.id}', 1)" ${out ? 'disabled' : ''}>Sold 1</button>
      <button class="btn ghost compact" onclick="openItemForm('${i.id}','restock')">+ Stock</button>
      <button class="btn ghost compact" onclick="openItemForm('${i.id}','price')">Price</button>
      <button class="btn ghost compact" title="Subscriber price" onclick="openItemForm('${i.id}','sub')">🔁</button>
    </div>
    ${itemInlineForm(i)}
  </div>`;
}

function reorderView() {
  const r = state.reorder;
  if (!r) return `<div class="empty">Loading…</div>`;
  if (!r.suggestions.length) {
    return `<div class="empty"><div class="big">✅</div>Nothing is running low. Your shelves are in good shape.</div>`;
  }
  return `
  <div class="muted small" style="margin-bottom:10px">Ranked by how soon you run out, using how fast each item actually sells.</div>
  ${r.suggestions.map((s) => `
  <div class="card">
    <div class="row">
      <div class="grow">
        <div style="font-weight:800">${esc(s.name)}</div>
        <div class="muted small">
          ${s.stock} left · sells ${s.perDay}/day${s.daysLeft !== null ? ` · about ${s.daysLeft} days` : ''}
        </div>
      </div>
      <div style="text-align:right">
        <div style="font-weight:900;color:var(--accent)">buy ${s.suggestedQty}</div>
        ${s.outOfStock ? `<div class="muted small" style="color:#f87171">out now</div>` : ''}
      </div>
    </div>
  </div>`).join('')}
  ${state.aiDisabled ? '' : `<div class="muted small" style="margin-top:10px">Tip: ask the stock assistant on the Stock tab to “restock everything that's running low” — it drafts the whole list.</div>`}`;
}

/* ---------------- subscriptions (inside the inventory manager) ---------------- */

window.setSubAccept = (id) => {
  state.subAccept = id;
  renderKeepingForms();
};

window.acceptSubRequest = async (reqId) => {
  const sp = Number((($(`#sub-price-${reqId}`) || {}).value || ''));
  if (!sp) return toast('Enter the subscriber price first.', true);
  try {
    await api(`/api/partner/stores/${state.activeStore}/subscribe-requests/${reqId}/accept`, {
      method: 'POST', body: { subscribePrice: sp }
    });
    state.subAccept = '';
    await Promise.all([loadSubscribeRequests(), loadInventory()]);
    toast('Offer sent — the customer can subscribe now 🔁');
    render();
  } catch (e) { toast(e.message, true); }
};

window.declineSubRequest = async (reqId) => {
  try {
    await api(`/api/partner/stores/${state.activeStore}/subscribe-requests/${reqId}/decline`, { method: 'POST' });
    state.subAccept = '';
    await loadSubscribeRequests();
    toast('Request declined.');
    render();
  } catch (e) { toast(e.message, true); }
};

function subReqCard(r) {
  const item = ((state.inventory && state.inventory.items) || []).find((i) => i.id === r.itemId) || null;
  return `
  <div class="card" style="border-color:var(--accent)">
    <div class="row">
      <div class="grow">
        <div style="font-weight:800">👤 ${esc(r.userName)} asks for <b>${esc(r.itemName)}</b></div>
        <div class="muted small">${item ? `${money(item.price)} / ${esc(item.unitLabel)} on the shelf · ` : ''}asked ${timeAgo(r.createdAt)}</div>
      </div>
    </div>
    ${state.subAccept === r.id ? `
    <div class="inline-form">
      <span>Subscriber price${item ? ` — must be under Rs ${item.price}` : ''}</span>
      <input id="sub-price-${r.id}" type="number" placeholder="${item ? `e.g. ${Math.max(1, Math.round(item.price * 0.9))}` : 'Rs'}" />
      <button class="btn" onclick="acceptSubRequest('${r.id}')">Offer it</button>
      <button class="btn ghost" onclick="setSubAccept('')">Back</button>
    </div>` : `
    <div class="grid2" style="margin-top:10px">
      <button class="btn" onclick="setSubAccept('${r.id}')">✅ Accept — set price</button>
      <button class="btn ghost" onclick="declineSubRequest('${r.id}')">Decline</button>
    </div>`}
  </div>`;
}

function subPricedRow(i) {
  return `
  <div class="card">
    <div class="row">
      <div class="grow">
        <div style="font-weight:800">${esc(i.name)}</div>
        <div class="muted small">${money(i.price)} shelf · 🔁 ${money(i.subscribePrice)} for subscribers</div>
      </div>
      <button class="btn ghost compact" onclick="openItemForm('${i.id}','sub')">Edit</button>
    </div>
    ${itemInlineForm(i)}
  </div>`;
}

function subsView() {
  const sr = state.subReqs[state.activeStore] || { requests: [], pendingByItem: {} };
  const pending = sr.requests.filter((r) => r.status === 'pending');
  const priced = ((state.inventory && state.inventory.items) || []).filter((i) => i.subscribePrice);
  return `
  <div class="muted small" style="margin-bottom:10px">
    Subscriber prices: a lower price for customers who subscribe to an item — they save, you get steady weekly sales.
  </div>
  <div class="section-title">Customer requests 🔁${pending.length ? ` <span class="badge">${pending.length}</span>` : ''}</div>
  ${pending.length ? pending.map(subReqCard).join('')
    : `<div class="muted small" style="margin-bottom:12px">No one is waiting on an answer. Requests from the customer app land here instantly.</div>`}
  <div class="section-title">Items with a subscriber price</div>
  ${priced.length ? priced.map(subPricedRow).join('')
    : `<div class="muted small">None yet — accept a request above, or tap 🔁 on any item in Stock.</div>`}`;
}

/* ---------------- inventory takeover ---------------- */

function stockTab(inv) {
  return `
    ${aiCard()}
    ${voiceCard()}
    ${draftsCard()}
    <label class="field" style="margin-top:12px"><span>Find an item</span>
      <input id="inv-search" value="${esc(state.invSearch)}" placeholder="Search your shelves" oninput="searchInventory()" />
    </label>
    ${inv.items.length ? inv.items.map(itemRow).join('')
      : `<div class="empty"><div class="big">📦</div>${state.invSearch ? 'Nothing matches that.' : 'No items yet — speak your first one above.'}</div>`}
    <div class="divider"></div>
    ${helperBlock()}`;
}

function inventoryView() {
  const inv = state.inventory;
  const store = state.stores.find((s) => s.id === state.activeStore) || {};
  if (!inv) return `<div class="empty">Loading…</div>`;
  const st = inv.stats || {};
  const subsPending = pendingSubCount(state.activeStore);
  return `
    <header class="topbar">
      <button class="btn ghost compact" onclick="closeStore()">← Shops</button>
      <span class="badge ${inv.open ? '' : 'gray'}">${inv.open ? '🟢 OPEN' : '⚫ CLOSED'}</span>
    </header>
    <main>
      <div class="row" style="margin-bottom:12px">
        <div>
          <div style="font-size:18px;font-weight:900">${store.icon || '🏪'} ${esc(store.name || 'Your shop')}</div>
          <div class="muted small">${st.items || 0} items · ${money(st.stockValue || 0)} on the shelves</div>
        </div>
        <button class="btn ghost compact" onclick="toggleShopOpen(${inv.open ? 'false' : 'true'})">${inv.open ? 'Close shop' : 'Open shop'}</button>
      </div>

      ${store.locPinned ? '' : `
      <div class="card" style="border-color:var(--accent);margin-bottom:12px">
        <div style="font-weight:900">📍 Put your shop on the map</div>
        <div class="muted small" style="margin:4px 0 10px">
          Customers find shops by how close they are. Stand in your shop and tap below so nearby customers can see you.
        </div>
        <button class="btn" onclick="pinShopLocation()">Use my current location</button>
      </div>`}

      <div class="grid2" style="margin-bottom:12px">
        <div class="card" style="padding:12px">
          <div class="muted small">Sold today</div>
          <div style="font-size:22px;font-weight:900">${st.soldToday || 0}</div>
          <div class="muted small">${money(st.revenueToday || 0)}</div>
        </div>
        <div class="card" style="padding:12px">
          <div class="muted small">Needs attention</div>
          <div style="font-size:22px;font-weight:900;color:${(st.lowStock || st.outOfStock) ? '#fbbf24' : 'var(--text)'}">${(st.lowStock || 0) + (st.outOfStock || 0)}</div>
          <div class="muted small">${st.outOfStock || 0} out · ${st.lowStock || 0} low</div>
        </div>
      </div>

      <div class="pipe-tabs">
        <button class="${state.invTab === 'stock' ? 'active' : ''}" onclick="setInvTab('stock')">Stock</button>
        <button class="${state.invTab === 'reorder' ? 'active' : ''}" onclick="setInvTab('reorder')">To buy${state.reorder && state.reorder.suggestions.length ? ` <b class="tab-badge">${state.reorder.suggestions.length}</b>` : ''}</button>
        <button class="${state.invTab === 'subs' ? 'active' : ''}" onclick="setInvTab('subs')">Subscriptions${subsPending ? ` <b class="tab-badge">${subsPending}</b>` : ''}</button>
      </div>

      ${state.invTab === 'stock' ? stockTab(inv) : ''}
      ${state.invTab === 'reorder' ? reorderView() : ''}
      ${state.invTab === 'subs' ? subsView() : ''}
      <div style="height:40px"></div>
    </main>`;
}

// A shop's position is what puts it in "near me" for customers, so it is taken
// from the shopkeeper's own phone standing in the shop rather than a typed area.
window.pinShopLocation = () => {
  if (!navigator.geolocation) return toast('This phone cannot share location.', true);
  toast('Finding your shop…');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      await api(`/api/partner/stores/${state.activeStore}`, {
        method: 'PATCH',
        body: { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6) }
      });
      await loadStores();
      await loadInventory();
      toast('Shop pinned — nearby customers can find you now 📍');
      render();
    } catch (e) { toast(e.message, true); }
  }, () => toast('Could not get your location — allow it in your browser.', true), { enableHighAccuracy: true, timeout: 10000 });
};
