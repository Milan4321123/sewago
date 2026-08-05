/* SewaGo Partner — list your restaurant or hotel so it appears in the app */

const $ = (sel) => document.querySelector(sel);

/* ---------------- language ----------------
   Nepali first: the shopkeeper this portal is built for reads नेपाली, so that
   is the default; one button flips to English and the choice sticks. The
   dictionary (partner-lang.js) is keyed by the English strings themselves, so
   anything untranslated falls back to readable English — never a broken key. */
const NE = window.SEWAGO_NE || {};
let LANG = localStorage.getItem('sewago_partner_lang') || 'ne';
document.documentElement.lang = LANG;

function t(s, vars) {
  let out = LANG === 'ne' && NE[s] ? NE[s] : s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}

window.toggleLang = () => {
  LANG = LANG === 'ne' ? 'en' : 'ne';
  localStorage.setItem('sewago_partner_lang', LANG);
  document.documentElement.lang = LANG;
  render();
};

function langButton() {
  return `<button class="btn ghost compact no-print" onclick="toggleLang()">🌐 ${LANG === 'ne' ? 'English' : 'नेपाली'}</button>`;
}

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
  showRestForm: false,
  showHotelForm: false,
  showWithdraw: false,
  showPhoneEdit: false, // re-open the OTP form to change a verified phone
  photos: {}, // slot -> uploaded /uploads/ URL pending form submission
  photoBusy: '', // slot currently uploading (disables its button)
  // General store (kirana) inventory
  stores: [],
  showStoreForm: false,
  activeStore: null, // store id -> opens the full-screen inventory manager
  inventory: null, // { items, stats, units, open, status }
  invSearch: '',
  invTab: 'stock', // stock | reorder | orders | insights
  reorder: null,
  storeOrders: [],
  insights: null, // today's sales, fetched when the insights tab opens
  invoiceOrder: null, // store order rendered as a printable bill (full screen)
  voice: { listening: false, heard: '', draft: null, queue: [], error: '' }
};

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
    throw new Error(t('Session expired — please log in again.'));
  }
  if (!res.ok) throw new Error(data.error || t('Something went wrong'));
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
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t('Could not read that image.')))), 'image/jpeg', quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t('That file is not an image.')));
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
  if (!res.ok) throw new Error(data.error || t('Photo upload failed.'));
  return data.url;
}

const MAX_PHOTOS = 5;

function slotPhotos(slot) {
  if (!Array.isArray(state.photos[slot])) state.photos[slot] = [];
  return state.photos[slot];
}

// Reusable gallery field: up to 5 photos, tap ✕ on any to drop it. Uploaded
// URLs park in state.photos[slot] until the form that owns the slot submits.
function photoField(slot, label = '') {
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
      ${busy ? t('Uploading…') : (label || t('📷 Add photos'))}
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
  document.querySelectorAll('input[id], select[id]').forEach((el) => {
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
        toast(t('Up to {n} photos each.', { n: MAX_PHOTOS }), true);
        break;
      }
      const blob = await downscaleImage(file);
      urls.push(await uploadPhotoBlob(blob));
    }
    toast(t('{n} ready 📷', { n: urls.length }));
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
    <label class="btn ghost compact" style="margin:0">${t('📷 Add photos')}
      <input type="file" accept="image/*" multiple style="display:none"
        onchange="addListingPhotos(event, '${type}', '${x.id}')" />
    </label>` : ''}
  </div>`;
}

window.addListingPhotos = async (event, type, id) => {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  try {
    toast(t('Uploading…'));
    const list = type === 'restaurants' ? state.restaurants : state.hotels;
    const photos = photosOf(list.find((x) => x.id === id) || {});
    for (const file of files) {
      if (photos.length >= MAX_PHOTOS) {
        toast(t('Up to {n} photos each.', { n: MAX_PHOTOS }), true);
        break;
      }
      const blob = await downscaleImage(file);
      photos.push(await uploadPhotoBlob(blob));
    }
    await api(`/api/partner/${type}/${id}/photo`, { method: 'POST', body: { photos } });
    await reload();
    toast(t('Photos updated 📷'));
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
    toast(t('Photo removed.'));
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

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
}

async function reloadOrders() {
  try {
    const data = await api('/api/partner/orders');
    state.orders = data.orders || [];
  } catch (e) { /* the order queue is refreshed again on the next nudge */ }
}

/* Real-time: refresh the order queue the instant an order lands or a courier
   moves it along. Falls back to a 20s poll while any order is actionable. */
let eventSource = null;
function connectEvents() {
  if (eventSource || !state.token || typeof EventSource === 'undefined') return;
  eventSource = new EventSource(`/api/events?role=partner&token=${encodeURIComponent(state.token)}`);
  eventSource.onmessage = async (e) => {
    let msg = {};
    try { msg = JSON.parse(e.data); } catch (err) { /* bare nudge */ }
    if (msg.topic === 'kyc') {
      // The SewaGo team just reviewed our KYC — refetch and announce the outcome.
      const prev = state.partner && state.partner.businessKycStatus;
      await reload().catch(() => {});
      const status = state.partner && state.partner.businessKycStatus;
      if (status !== prev) {
        if (status === 'approved') toast(t('🎉 Your business KYC was approved — you can now list and withdraw!'));
        else if (status === 'rejected') toast(t('Your business KYC was rejected — see the note in the KYC card.'), true);
      }
    } else if (msg.topic === 'wallet') {
      await reload().catch(() => {});
      if (msg.event === 'withdrawal_paid') toast(t('🏦 Your payout was approved and sent.'));
      if (msg.event === 'withdrawal_rejected') toast(t('Your payout was rejected — the amount is back in your earnings.'), true);
    } else {
      await reloadOrders();
    }
    render();
  };
  eventSource.onerror = () => { /* EventSource retries on its own */ };
}
function disconnectEvents() {
  if (eventSource) { eventSource.close(); eventSource = null; }
}
setInterval(async () => {
  if (!state.partner) return;
  if (state.orders.some((o) => ['placed', 'preparing', 'out_for_delivery'].includes(o.status))) {
    await reloadOrders();
    render();
  }
}, 20000);

/* ---------------- auth ---------------- */

function authView() {
  const isLogin = state.authMode === 'login';
  const langRow = `<div style="display:flex;justify-content:flex-end;margin-bottom:8px">${langButton()}</div>`;
  if (state.authMode === 'reset') {
    return `
    <div class="auth-wrap">
      ${langRow}
      <div class="auth-hero">
        <div class="logo">🔐</div>
        <h1>${t('Partner password')}</h1>
        <p>${t('Reset your partner portal password.')}</p>
      </div>
      <div class="card">
        <label class="field"><span>${t('Email')}</span><input id="p-reset-email" type="email" placeholder="you@business.com" /></label>
        <button class="btn" onclick="partnerRequestPasswordReset()">${t('Send reset token')}</button>
        ${state.resetToken ? `<div class="muted small" style="margin-top:10px">${t('Sandbox token:')} <b style="color:var(--text)">${esc(state.resetToken)}</b></div>` : ''}
        <div class="divider"></div>
        <label class="field"><span>${t('Reset token')}</span><input id="p-reset-token" value="${esc(state.resetToken)}" placeholder="${t('Paste token')}" /></label>
        <label class="field"><span>${t('New password')}</span><input id="p-reset-password" type="password" placeholder="${t('At least 6 characters')}" /></label>
        <button class="btn" onclick="partnerCompletePasswordReset()">${t('Change password')}</button>
        <button class="btn ghost" style="margin-top:8px" onclick="setAuthMode('login')">${t('Back to login')}</button>
      </div>
    </div>`;
  }
  if (state.authMode === 'otp') {
    return `
    <div class="auth-wrap">
      ${langRow}
      <div class="auth-hero">
        <div class="logo">📲</div>
        <h1>${t('Partner phone login')}</h1>
        <p>${t('Use the mobile number registered to your partner account.')}</p>
      </div>
      <div class="card">
        <label class="field"><span>${t('Mobile number')}</span>
          <input id="p-otp-phone" value="${esc(state.otpLogin.phone)}" placeholder="${t('e.g.')} +9779841000000" autocomplete="tel" />
        </label>
        <button class="btn" onclick="partnerRequestOtpLogin()">${t('Send code')}</button>
        ${state.otpLogin.devCode ? `<div class="muted small" style="margin-top:10px">${t('Sandbox OTP:')} <b style="color:var(--text)">${esc(state.otpLogin.devCode)}</b></div>` : ''}
        <div class="divider"></div>
        <label class="field"><span>${t('OTP code')}</span>
          <input id="p-otp-code" inputmode="numeric" placeholder="123456" autocomplete="one-time-code" />
        </label>
        <button class="btn" onclick="partnerVerifyOtpLogin()">${t('Continue')}</button>
        <button class="btn ghost" style="margin-top:8px" onclick="setAuthMode('login')">${t('Back to email login')}</button>
      </div>
    </div>`;
  }
  return `
  <div class="auth-wrap">
    ${langRow}
    <div class="auth-hero">
      <img class="logo-img" src="/icon.svg" alt="SewaGo Partner" />
      <h1>Sewa<em>Go</em> ${t('Partner')}</h1>
      <p>${t('List your restaurant, hotel or shop once — customers see it in the app instantly.')}</p>
      <div class="auth-services">
        <span>🍜 <b>${t('Restaurants')}</b></span><span>🏨 <b>${t('Hotels')}</b></span><span>🏪 <b>${t('Shops')}</b></span>
      </div>
    </div>
    <div class="card">
      ${isLogin ? '' : `
      <label class="field"><span>${t('Business / owner name')}</span>
        <input id="p-name" placeholder="${t('e.g.')} Adhikari Hospitality" />
      </label>`}
      <label class="field"><span>${t('Email')}</span>
        <input id="p-email" type="email" placeholder="you@business.com" />
      </label>
      <label class="field"><span>${t('Password')}</span>
        <input id="p-password" type="password" placeholder="${t('At least 6 characters')}" />
      </label>
      ${isLogin ? '' : `
      <div class="grid2">
        <label class="field"><span>${t('Phone (we call to verify)')}</span>
          <input id="p-phone" placeholder="${t('e.g.')} 9841000000" />
        </label>
        <label class="field"><span>${t('Registration / PAN no.')}</span>
          <input id="p-regno" placeholder="${t('e.g.')} PAN-301234567" />
        </label>
      </div>
      <div class="muted small" style="margin-bottom:12px">
        ${t('🛡️ Every listing is reviewed by the SewaGo team before it goes live. Keep your registration certificate handy — we verify the number and call you.')}
      </div>`}
      <button class="btn" onclick="submitAuth()">${isLogin ? t('Log in') : t('Join as a partner')}</button>
      ${isLogin ? `<button class="btn ghost" style="margin-top:8px" onclick="setAuthMode('otp')">${t('Log in with phone OTP')}</button>` : ''}
      <div style="text-align:center;margin-top:14px">
        <button class="link" onclick="toggleAuthMode()">
          ${isLogin ? t('New partner? Create an account') : t('Already registered? Log in')}
        </button>
      </div>
      ${isLogin ? `<div style="text-align:center;margin-top:10px"><button class="link" onclick="setAuthMode('reset')">${t('Forgot password?')}</button></div>` : ''}
    </div>
    ${isLogin ? `
    <div class="card">
      <div class="muted small" style="line-height:1.8">
        <b style="color:var(--text)">${t('Demo partner')}</b> (${t('password:')} <b style="color:var(--text)">partner123</b>)<br/>
        partner.demo@sewago.app · 🏪 shopkeeper.demo@sewago.app
      </div>
    </div>` : ''}
    <div style="text-align:center;margin-top:14px">
      <a class="link" href="/">${t('← Back to the customer app')}</a>
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
  toast(t('Welcome, {name}! 🤝', { name: data.partner.name }));
  connectEvents();
  // The login payload carries restaurants and hotels but not shops, so fetch
  // those before the first paint shows an empty "add your shop" prompt.
  Promise.all([reloadOrders(), loadStores()]).then(() => render()).catch(() => {});
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
    toast(data.devCode ? t('Sandbox OTP: {code}', { code: data.devCode }) : t('Verification code sent.'));
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
    toast(data.devResetToken ? t('Sandbox reset token is filled in below.') : t('If the account exists, reset instructions were sent.'));
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
    toast(t('Password changed. Log in with the new password.'));
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
  localStorage.removeItem('sewago_partner_token');
  render();
}

window.doLogout = () => logoutLocal();

/* ---------------- live order queue ---------------- */

const ORDER_STATUS_LINE = {
  placed: '🕐 Waiting for you to confirm',
  preparing: '👨‍🍳 Preparing — courier being arranged',
  out_for_delivery: '🛵 On the way to the customer',
  delivered: '✅ Delivered',
  cancelled: '❌ Cancelled'
};

function timeAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return t('just now');
  if (min < 60) return t('{m} min ago', { m: min });
  return t('{h} h ago', { h: Math.round(min / 60) });
}

function orderQueueCard(o) {
  const active = ['placed', 'preparing', 'out_for_delivery'].includes(o.status);
  return `
  <div class="card" ${o.status === 'placed' ? 'style="border-color:var(--accent)"' : ''}>
    <div class="row">
      <div>
        <div><b>${esc(o.restaurantName)}</b> · ${esc(o.customerName)}</div>
        <div class="muted small">${o.items.map((l) => `${l.qty}× ${esc(l.name)}`).join(', ')}</div>
        <div class="muted small">${o.deliveryLoc ? `📍 ${esc(o.deliveryLoc.name)} · ` : ''}${timeAgo(o.createdAt)}</div>
      </div>
      <div class="rt"><b>${money(o.subtotal)}</b><div class="muted small">${t('you earn')} ${money(o.partnerCut)}</div></div>
    </div>
    <div class="muted small" style="margin-top:8px">${ORDER_STATUS_LINE[o.status] ? t(ORDER_STATUS_LINE[o.status]) : esc(o.status)}${
      o.courier ? ` · 🛵 ${esc(o.courier.name)} (${esc(o.courier.plate)})` : ''}</div>
    ${o.status === 'placed' ? `
    <div class="grid2" style="margin-top:10px">
      <button class="btn" onclick="acceptOrder('${o.id}')">${t('✅ Accept — start cooking')}</button>
      <button class="btn ghost" onclick="rejectOrder('${o.id}')">${t('Reject')}</button>
    </div>` : ''}
    ${!active && o.status === 'cancelled' ? `<div class="muted small" style="margin-top:6px">${t('Customer refunded in full.')}</div>` : ''}
  </div>`;
}

function ordersSection() {
  if (!state.restaurants.length) return '';
  const active = state.orders.filter((o) => ['placed', 'preparing', 'out_for_delivery'].includes(o.status));
  const recent = state.orders.filter((o) => !['placed', 'preparing', 'out_for_delivery'].includes(o.status)).slice(0, 5);
  return `
  <div class="section-title">${t('Incoming orders')} 🔔${active.length ? ` <span class="badge">${active.length}</span>` : ''}</div>
  ${active.length ? active.map(orderQueueCard).join('')
    : `<div class="muted small" style="margin-bottom:12px">${t('No orders waiting. New ones appear here instantly.')}</div>`}
  ${recent.length ? recent.map(orderQueueCard).join('') : ''}`;
}

window.acceptOrder = async (id) => {
  try {
    await api(`/api/partner/orders/${id}/accept`, { method: 'POST' });
    toast(t('Order accepted — a courier is being arranged 🛵'));
    await reloadOrders();
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.rejectOrder = async (id) => {
  if (!confirm(t('Reject this order? The customer is refunded in full.'))) return;
  try {
    await api(`/api/partner/orders/${id}/reject`, { method: 'POST', body: { note: '' } });
    toast(t('Order rejected — customer refunded.'));
    await reloadOrders();
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- dashboard ---------------- */

function render() {
  const app = $('#app');
  if (!state.partner) {
    app.innerHTML = authView();
    return;
  }
  // A bill being shown (or printed) takes the whole screen — nothing else may
  // leak onto the paper.
  if (state.invoiceOrder) {
    app.innerHTML = invoiceView();
    return;
  }
  // The inventory manager takes over the whole screen — a shopkeeper working
  // the shelves should not be scrolling past restaurant and hotel forms.
  if (state.activeStore) {
    app.innerHTML = inventoryView();
    return;
  }
  const ready = partnerReady();
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><img class="brand-mark" src="/icon.svg" alt="" />Sewa<em>Go</em> <span class="muted" style="font-size:13px;font-weight:700">${t('PARTNER')}</span></div>
      <div style="display:flex;gap:8px;align-items:center">${langButton()}<span class="badge">${esc(state.partner.name)}</span></div>
    </header>
    <main>
      <div class="muted small" style="margin-bottom:14px">
        ${t('New listings go to the SewaGo review team first (we verify your documents and may call you). Once approved they appear in the customer app.')}
      </div>
      ${kycNotice()}
      ${kycCard()}
      ${ordersSection()}
      ${earningsCard()}

      ${storesSection()}

      <div class="section-title">${t('Your restaurants')} 🍜</div>
      ${state.restaurants.length ? state.restaurants.map(restaurantCard).join('')
        : `<div class="empty"><div class="big">🍳</div>${t('No restaurants yet — add your first one below.')}</div>`}
      ${ready ? (state.showRestForm ? restaurantForm() : `<button class="btn ghost" onclick="toggleRestForm()">${t('+ Add a restaurant')}</button>`)
        : `<div class="muted small" style="margin-bottom:12px">${t('Verify phone and complete business KYC before adding restaurants.')}</div>`}

      <div class="section-title">${t('Your hotels')} 🏨</div>
      ${state.hotels.length ? state.hotels.map(hotelCard).join('')
        : `<div class="empty"><div class="big">🛎️</div>${t('No hotels yet — add your first one below.')}</div>`}
      ${ready ? (state.showHotelForm ? hotelForm() : `<button class="btn ghost" onclick="toggleHotelForm()">${t('+ Add a hotel')}</button>`)
        : `<div class="muted small" style="margin-bottom:12px">${t('Business KYC approval is required before adding hotels.')}</div>`}

      <button class="btn danger" style="margin-top:18px" onclick="doLogout()">${t('Log out')}</button>
      <div class="card" style="margin-top:14px;border-color:#7f1d1d">
        <div style="font-weight:800">${t('Delete account')}</div>
        <div class="muted small" style="margin:6px 0 10px;line-height:1.6">
          ${t('Removes your personal data permanently and takes your listings off the marketplace. Withdraw your earnings and settle upcoming bookings first.')}
          <a href="/privacy" target="_blank" class="link">${t('Privacy policy')}</a>
        </div>
        ${state.showDeleteAccount ? `
        <label class="field"><span>${t('Confirm with your password')}</span>
          <input id="del-password" type="password" placeholder="${t('Your password')}" />
        </label>
        <div class="grid2">
          <button class="btn danger" onclick="partnerDeleteAccount()">${t('Delete forever')}</button>
          <button class="btn ghost" onclick="toggleDeleteAccount(false)">${t('Keep my account')}</button>
        </div>` : `
        <button class="btn ghost" style="border-color:#7f1d1d;color:#f87171" onclick="toggleDeleteAccount(true)">${t('Delete my account…')}</button>`}
      </div>
    </main>`;
}

window.toggleDeleteAccount = (show) => {
  state.showDeleteAccount = show;
  render();
};

window.partnerDeleteAccount = async () => {
  if (!confirm(t('Delete your SewaGo partner account forever? This cannot be undone.'))) return;
  try {
    await api('/api/partner/account/delete', { method: 'POST', body: { password: $('#del-password').value } });
    toast(t('Your account has been deleted. Goodbye 👋'));
    state.showDeleteAccount = false;
    logoutLocal();
  } catch (e) {
    toast(e.message, true);
  }
};

const PARTNER_TXN_ICONS = {
  order_income: '🍜', order_reversal: '↩️', booking_income: '🏨', booking_reversal: '↩️',
  withdrawal: '🏦', withdrawal_refund: '↩️', promotion: '⭐'
};

function partnerReady() {
  const p = state.partner;
  return !!p && !!p.phoneVerified && p.businessKycStatus === 'approved';
}

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
          <div style="font-weight:900">${t('🎉 Business KYC approved!')}</div>
          <div class="muted small">${t('Your documents were verified — you can now add listings and withdraw earnings.')}</div>
        </div>
        <button class="btn ghost compact" onclick="ackKycNotice()">${t('Got it')}</button>
      </div>
    </div>`;
  }
  return `
  <div class="card" style="border-color:var(--danger)">
    <div class="row">
      <div>
        <div style="font-weight:900">${t('❌ Business KYC rejected')}</div>
        <div class="muted small">${p.businessKycNote ? esc(p.businessKycNote) : t('Fix your details in the KYC card below and resubmit.')}</div>
      </div>
      <button class="btn ghost compact" onclick="ackKycNotice()">${t('Got it')}</button>
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
        <div style="font-weight:900">${t('Business KYC')}</div>
        <div class="muted small">📱 ${esc(p.phone)} — ${t('verified')} · ${esc(p.regNo || '')} ${t('approved. You are all set.')}</div>
      </div>
      <span class="badge">${t('APPROVED')}</span>
    </div>
    <button class="btn ghost compact" style="margin-top:12px" onclick="togglePhoneEdit(true)">${t('Change phone number')}</button>
  </div>`;
  }
  return `
  <div class="card">
    <div class="row">
      <div>
        <div style="font-weight:900">${t('Business KYC')}</div>
        <div class="muted small">${t('Phone verification and business document review unlock listings.')}</div>
      </div>
      <span class="badge ${status === 'approved' ? '' : status === 'rejected' ? 'red' : 'amber'}">${t(status.toUpperCase())}</span>
    </div>
    <div class="status-grid" style="margin-top:12px">
      <span class="badge ${p.phoneVerified ? '' : 'amber'}">${p.phoneVerified ? t('PHONE VERIFIED') : t('PHONE NEEDED')}</span>
      <span class="badge ${status === 'approved' ? '' : 'amber'}">${t('BUSINESS')} ${t(status.toUpperCase())}</span>
    </div>
    ${p.businessKycNote ? `<div class="muted small" style="color:var(--danger);margin-top:8px">${esc(p.businessKycNote)}</div>` : ''}
    ${showPhoneForm ? `
    <label class="field" style="margin-top:12px"><span>${t('Phone')}</span>
      <input id="partner-phone" value="${esc(p.phone || '')}" placeholder="${t('e.g.')} 9841000000" />
    </label>
    <div class="grid2">
      <button class="btn ghost" onclick="partnerRequestOtp()">${t('Send OTP')}</button>
      <label class="field"><span>${t('OTP code')}</span><input id="partner-otp" placeholder="123456" /></label>
    </div>
    <button class="btn" onclick="partnerVerifyOtp()">${t('Verify phone')}</button>
    ${state.showPhoneEdit ? `<button class="btn ghost" style="margin-top:8px" onclick="togglePhoneEdit(false)">${t('Cancel')}</button>` : ''}` : `
    <div class="muted small" style="margin-top:12px">📱 ${esc(p.phone)} — ${t('verified')}. <button class="link" onclick="togglePhoneEdit(true)">${t('Change')}</button></div>`}
    ${status !== 'approved' ? `
    <div class="divider"></div>
    <label class="field"><span>${t('Legal business name')}</span>
      <input id="kyc-name" value="${esc(p.name || '')}" placeholder="${t('Registered business name')}" />
    </label>
    <label class="field"><span>${t('Registration / PAN no.')}</span>
      <input id="kyc-regno" value="${esc(p.regNo || '')}" placeholder="PAN-301234567" />
    </label>
    <label class="field"><span>${t('Document reference / upload link')}</span>
      <input id="kyc-doc" value="${esc(p.businessKycDocumentRef || '')}" placeholder="${t('Certificate file ID or secure link')}" />
    </label>
    <button class="btn" onclick="submitPartnerKyc()">${status === 'rejected' ? t('Fix & resubmit KYC') : t('Submit KYC for review')}</button>` : ''}
  </div>`;
}

window.togglePhoneEdit = (show) => {
  state.showPhoneEdit = show;
  render();
};

function earningsCard() {
  const p = state.partner;
  return `
  <div class="card">
    <div class="row">
      <div>
        <div class="muted small">${t('Available to withdraw')}</div>
        <div style="font-size:24px;font-weight:900">${money(p.earnings || 0)}</div>
      </div>
      <span style="font-size:28px">💰</span>
    </div>
    ${(p.pendingEarnings || 0) > 0 ? `
    <div class="muted small" style="margin-top:6px">
      ⏳ <b style="color:var(--text)">${money(p.pendingEarnings)}</b> ${t('pending — clears when orders are delivered and stays reach check-in.')}
    </div>` : ''}
    <div class="muted small" style="margin-top:6px">
      ${t('You receive 85% of food subtotals and 90% of bookings. Income clears to withdrawable once the order is delivered or the stay begins.')}
    </div>
    ${partnerReady() ? `
    <button class="btn ${state.showWithdraw ? '' : 'ghost'}" aria-pressed="${!!state.showWithdraw}" style="margin-top:12px" onclick="toggleWithdraw()">${t('🏦 Withdraw earnings')}</button>`
    : `<div class="muted small" style="margin-top:12px">${t('🔒 Withdrawals unlock once your phone is verified and business KYC is approved.')}</div>`}
    ${state.showWithdraw && partnerReady() ? `
    <div class="divider"></div>
    <div class="grid2">
      <label class="field"><span>${t('Amount (Rs)')}</span><input id="pw-amount" type="number" placeholder="1000" min="100" /></label>
      <label class="field"><span>${t('Payout to')}</span>
        <select id="pw-channel">
          <option value="bank">${t('Bank transfer')}</option>
          <option value="esewa">eSewa</option>
          <option value="khalti">Khalti</option>
        </select>
      </label>
    </div>
    <label class="field"><span>${t('Account / wallet ID')}</span><input id="pw-account" placeholder="${t('e.g. business account no.')}" /></label>
    <div class="muted small" style="margin-bottom:10px">${t('Rs 10 payout fee · paid out after SewaGo approves it.')}</div>
    <button class="btn" onclick="partnerWithdraw()">${t('Request payout')}</button>` : ''}
    ${state.transactions.length ? `
    <div class="divider"></div>
    <div class="muted small" style="font-weight:700;margin-bottom:8px">${t('Recent activity')}</div>
    ${state.transactions.map((t) => `
      <div class="row" style="margin-bottom:8px">
        <div class="small">${PARTNER_TXN_ICONS[t.type] || '💳'} ${esc(t.label)}${t.status === 'processing' ? ' <span class="muted">· ⏳</span>' : ''}</div>
        <div style="font-weight:800;white-space:nowrap;color:${t.sign > 0 ? 'var(--accent)' : 'var(--text)'}">${t.sign > 0 ? '+' : '−'}${money(t.amount)}</div>
      </div>`).join('')}` : ''}
  </div>`;
}

window.partnerRequestOtp = async () => {
  try {
    const data = await api('/api/partner/phone/request-otp', {
      method: 'POST',
      body: { phone: $('#partner-phone').value.trim() }
    });
    state.partner = data.partner;
    toast(data.devCode ? t('Sandbox OTP: {code}', { code: data.devCode }) : t('Verification code sent.'));
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
    toast(t('Phone verified.'));
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
    toast(t('KYC submitted — SewaGo will review it.'));
    render();
  } catch (e) {
    toast(e.message, true);
  }
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
    toast(t('Payout requested — money arrives once SewaGo approves it 🏦'));
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.toggleRestForm = () => { state.showRestForm = !state.showRestForm; render(); };
window.toggleHotelForm = () => { state.showHotelForm = !state.showHotelForm; render(); };

/* ---------------- restaurants ---------------- */

function restaurantForm() {
  return `
  <div class="card">
    <div style="font-weight:900;margin-bottom:12px">${t('New restaurant')}</div>
    <label class="field"><span>${t('Name')}</span><input id="r-name" placeholder="${t('e.g.')} Newa Kitchen" /></label>
    <label class="field"><span>${t('Cuisine')}</span><input id="r-cuisine" placeholder="${t('e.g.')} Newari" /></label>
    <label class="field"><span>${t('Area / neighbourhood (courier pickup point)')}</span><input id="r-area" placeholder="${t('e.g.')} Thamel, Jawalakhel" /></label>
    <div class="grid2">
      <label class="field"><span>${t('Prep time (min)')}</span><input id="r-eta" type="number" value="30" min="5" max="120" /></label>
      <label class="field"><span>${t('Delivery fee (Rs)')}</span><input id="r-fee" type="number" value="50" min="0" max="500" /></label>
    </div>
    <label class="field"><span>${t('Icon')}</span>
      <select id="r-icon">${REST_ICONS.map((i) => `<option>${i}</option>`).join('')}</select>
    </label>
    <div class="muted small" style="margin-bottom:6px">${t('Cover photo — customers pick with their eyes 👀')}</div>
    ${photoField('new-rest')}
    <button class="btn" onclick="addRestaurant()">${t('Create restaurant')}</button>
    <button class="btn ghost" style="margin-top:8px" onclick="toggleRestForm()">${t('Cancel')}</button>
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
    toast(t('Restaurant created — now add menu items so customers can order! 🎉'));
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

function reviewStatusBadge(x) {
  if (x.status === 'approved') return `<span class="badge">🟢 ${t('LIVE')}</span>`;
  if (x.status === 'rejected') return `<span class="badge red">${t('REJECTED')}</span>`;
  return `<span class="badge amber">${t('IN REVIEW')}</span>`;
}

function reviewStatusLine(x, kind) {
  if (x.status === 'rejected') {
    return `
    <div class="muted small" style="margin:8px 0;color:var(--danger)">
      ✕ ${t('Rejected by SewaGo:')} ${esc(x.reviewNote || t('no note'))}
    </div>
    <button class="btn ghost" style="margin-bottom:8px" onclick="resubmitListing('${kind}','${x.id}')">${t('↻ Fix & resubmit for review')}</button>`;
  }
  if (x.status === 'pending') {
    return `<div class="muted small" style="margin:8px 0">${t('⏳ Waiting for SewaGo review — we verify your documents and may call {phone}.', { phone: esc(state.partner.phone || t('you')) })}</div>`;
  }
  return '';
}

function promoBlock(type, x) {
  if (x.status !== 'approved') return '';
  const active = x.promotedUntil > Date.now();
  return `
    <div class="row" style="margin-top:10px">
      <div class="muted small">${active
        ? t('⭐ Featured until {date} — top of the customer list', { date: new Date(x.promotedUntil).toLocaleDateString([], { month: 'short', day: 'numeric' }) })
        : t('Get seen first: featured listings sit at the top of the customer list.')}</div>
      <button class="btn ghost compact" onclick="promoteListing('${type}','${x.id}')">${active ? t('⭐ Extend') : t('⭐ Promote')} · ${money(state.promoteWeekPrice || 500)}/${t('wk')}</button>
    </div>`;
}

window.promoteListing = async (type, id) => {
  try {
    const data = await api(`/api/partner/${type}/${id}/promote`, { method: 'POST' });
    state.partner = data.partner;
    await reload();
    toast(t('Listing featured for 7 days ⭐'));
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

function restaurantCard(r) {
  return `
  <div class="card">
    ${r.photo ? `<img class="cover-img" src="${esc(r.photo)}" alt="${esc(r.name)}" />` : ''}
    <div class="row">
      <div>
        <div style="font-weight:900">${r.icon} ${esc(r.name)} ${reviewStatusBadge(r)}</div>
        <div class="muted small">${esc(r.cuisine)} · ${r.etaMinutes} ${t('min')} · ${t('delivery')} ${money(r.deliveryFee)}</div>
      </div>
      <button class="btn danger compact" onclick="deleteRestaurant('${r.id}')">${t('Remove')}</button>
    </div>
    ${listingGallery('restaurants', r)}
    ${reviewStatusLine(r, 'restaurants')}
    ${promoBlock('restaurants', r)}
    <div class="divider"></div>
    ${r.menu.length === 0 ? `<div class="muted small" style="margin-bottom:10px">${t("⚠️ No menu items yet — customers can't order until you add some.")}</div>` : ''}
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
    <div class="muted small" style="margin-bottom:8px;font-weight:700">${t('Add menu item')}</div>
    <div class="grid2">
      <label class="field"><span>${t('Item name')}</span><input id="mi-name-${r.id}" placeholder="${t('e.g.')} Chatamari" /></label>
      <label class="field"><span>${t('Price (Rs)')}</span><input id="mi-price-${r.id}" type="number" placeholder="250" /></label>
    </div>
    <label class="field"><span>${t('Description (optional)')}</span><input id="mi-desc-${r.id}" placeholder="${t('e.g.')} ${t('Newari rice crepe with toppings')}" /></label>
    ${photoField(`menu-${r.id}`, t('📷 Add a dish photo'))}
    <button class="btn" onclick="addMenuItem('${r.id}')">${t('Add item')}</button>
  </div>`;
}

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
    toast(t('Menu item added ✅'));
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
    await reload();
    toast(t('Restaurant removed from the app.'));
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- hotels ---------------- */

function hotelForm() {
  return `
  <div class="card">
    <div style="font-weight:900;margin-bottom:12px">${t('New hotel')}</div>
    <label class="field"><span>${t('Name')}</span><input id="h-name" placeholder="${t('e.g.')} Himal View Resort" /></label>
    <div class="grid2">
      <label class="field"><span>${t('City')}</span><input id="h-city" placeholder="${t('e.g.')} Pokhara" /></label>
      <label class="field"><span>${t('Area')}</span><input id="h-area" placeholder="${t('e.g.')} Lakeside" /></label>
    </div>
    <label class="field"><span>${t('One-line description')}</span><input id="h-desc" placeholder="${t('e.g.')} ${t('Mountain views from every room')}" /></label>
    <label class="field"><span>${t('Icon')}</span>
      <select id="h-icon">${HOTEL_ICONS.map((i) => `<option>${i}</option>`).join('')}</select>
    </label>
    <div class="muted small" style="margin-bottom:6px">${t('Cover photo — listings with photos get booked first 👀')}</div>
    ${photoField('new-hotel')}
    <button class="btn" onclick="addHotel()">${t('Create hotel')}</button>
    <button class="btn ghost" style="margin-top:8px" onclick="toggleHotelForm()">${t('Cancel')}</button>
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
    toast(t('Hotel created — now add room types so customers can book! 🎉'));
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

function hotelCard(h) {
  return `
  <div class="card">
    ${h.photo ? `<img class="cover-img" src="${esc(h.photo)}" alt="${esc(h.name)}" />` : ''}
    <div class="row">
      <div>
        <div style="font-weight:900">${h.icon} ${esc(h.name)} ${reviewStatusBadge(h)}</div>
        <div class="muted small">${esc(h.area)}${h.area ? ', ' : ''}${esc(h.city)}${h.desc ? ' · ' + esc(h.desc) : ''}</div>
      </div>
      <button class="btn danger compact" onclick="deleteHotel('${h.id}')">${t('Remove')}</button>
    </div>
    ${listingGallery('hotels', h)}
    ${reviewStatusLine(h, 'hotels')}
    ${promoBlock('hotels', h)}
    <div class="divider"></div>
    ${h.rooms.length === 0 ? `<div class="muted small" style="margin-bottom:10px">${t("⚠️ No room types yet — customers can't book until you add some.")}</div>` : ''}
    ${h.rooms.map((room) => `
      <div class="row" style="margin-bottom:8px">
        ${room.photo ? `<img class="thumb" src="${esc(room.photo)}" alt="${esc(room.type)}" />` : ''}
        <div class="grow">
          <div><b>${esc(room.type)}</b> · ${money(room.pricePerNight)}/${t('night')} · ${t('{n} rooms', { n: room.count })} · ${t('sleeps')} ${room.sleeps}</div>
          ${room.amenities.length ? `<div style="margin-top:3px">${room.amenities.map((a) => `<span class="amenity">${esc(a)}</span>`).join('')}</div>` : ''}
        </div>
        <button class="btn ghost compact" onclick="deleteRoom('${h.id}','${room.id}')">✕</button>
      </div>`).join('')}
    <div class="divider"></div>
    <div class="muted small" style="margin-bottom:8px;font-weight:700">${t('Add room type')}</div>
    <div class="grid2">
      <label class="field"><span>${t('Type')}</span><input id="ro-type-${h.id}" placeholder="${t('e.g.')} Deluxe Room" /></label>
      <label class="field"><span>${t('Price / night (Rs)')}</span><input id="ro-price-${h.id}" type="number" placeholder="3500" /></label>
    </div>
    <div class="grid2">
      <label class="field"><span>${t('How many rooms')}</span><input id="ro-count-${h.id}" type="number" value="3" min="1" max="50" /></label>
      <label class="field"><span>${t('Sleeps')}</span><input id="ro-sleeps-${h.id}" type="number" value="2" min="1" max="10" /></label>
    </div>
    <label class="field"><span>${t('Amenities (comma separated)')}</span><input id="ro-amen-${h.id}" placeholder="WiFi, ${t('Breakfast')}, AC" /></label>
    ${photoField(`room-${h.id}`, t('📷 Add a room photo'))}
    <button class="btn" onclick="addRoom('${h.id}')">${t('Add room type')}</button>
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
    toast(t('Room type added ✅'));
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
    toast(t('Resubmitted — the SewaGo team will take another look. ⏳'));
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.deleteHotel = async (hid) => {
  try {
    await api(`/api/partner/hotels/${hid}`, { method: 'DELETE' });
    await reload();
    toast(t('Hotel removed from the app.'));
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- boot ---------------- */

(async function boot() {
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
   The shopkeeper's daily loop: speak an item onto the shelf, tap Sold
   when someone buys, glance at what's running out. Everything here is
   built for one thumb on a cheap phone in a busy shop.
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
  state.insights = null;
  try {
    await loadInventory();
    render();
  } catch (e) { toast(e.message, true); }
};

window.closeStore = () => {
  state.activeStore = null;
  state.inventory = null;
  state.insights = null;
  state.voice = { listening: false, heard: '', draft: null, queue: [], error: '' };
  render();
};

window.setInvTab = async (tab) => {
  state.invTab = tab;
  render();
  try {
    if (tab === 'reorder') state.reorder = await api(`/api/partner/stores/${state.activeStore}/reorder`);
    if (tab === 'orders') {
      const d = await api(`/api/partner/stores/${state.activeStore}/orders`);
      state.storeOrders = d.orders || [];
    }
    if (tab === 'insights') {
      // "Today" is the shopkeeper's midnight, not the server's — the phone
      // knows its own timezone, so it sends the boundary.
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      state.insights = await api(`/api/partner/stores/${state.activeStore}/insights?since=${midnight.getTime()}`);
    }
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
    toast(t('Shop submitted for review 🏪'));
    render();
  } catch (e) { toast(e.message, true); }
};

window.pickStoreIcon = (icon) => { state.storeIcon = icon; render(); };

window.toggleShopOpen = async (open) => {
  try {
    await api(`/api/partner/stores/${state.activeStore}`, { method: 'PATCH', body: { open } });
    await loadInventory();
    toast(open ? t('Shop is open — customers can order 🟢') : t('Shop closed — no new orders'));
    render();
  } catch (e) { toast(e.message, true); }
};

/* ---------------- voice entry ---------------- */

// Browser speech recognition. Nepali first, since that is what a shopkeeper
// speaks; if the device has no Nepali model it still returns something usable
// and the confirm step catches the difference.
function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

window.startVoice = () => {
  if (!speechSupported()) {
    state.voice.error = t('This phone cannot listen — type the item instead.');
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
      ? t('Microphone blocked — allow it in your browser, or type the item.')
      : t('Could not hear that. Try again, or type the item.');
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
  toast(state.voiceLang === 'ne-NP' ? t('Listening in Nepali') : t('Listening in English'));
  render();
};

// The parse always goes to a confirm card — a mis-hear must cost one tap, never
// a wrong stock number saved silently.
async function submitVoiceText(text) {
  try {
    const data = await api('/api/stores/voice/parse', { method: 'POST', body: { text } });
    state.voice.draft = data.item;
    state.voice.listening = false;
    render();
  } catch (e) { toast(e.message, true); }
}

window.typeVoiceLine = () => {
  const el = $('#voice-typed');
  if (el && el.value.trim()) submitVoiceText(el.value.trim());
};

window.editDraft = (field, value) => {
  if (!state.voice.draft) return;
  state.voice.draft[field] = field === 'name' || field === 'unit' ? value : Number(value);
  state.voice.draft.needsReview = (state.voice.draft.needsReview || []).filter((f) => f !== field);
};

window.saveDraft = async () => {
  const d = state.voice.draft;
  if (!d) return;
  const body = {
    name: ($('#d-name') || {}).value || d.name,
    qty: Number(($('#d-qty') || {}).value ?? d.qty ?? 0),
    unit: ($('#d-unit') || {}).value || d.unit,
    price: Number(($('#d-price') || {}).value ?? d.price ?? 0),
    subscribePrice: Number(($('#d-sub') || {}).value || 0) || undefined
  };
  try {
    const res = await api(`/api/partner/stores/${state.activeStore}/items`, { method: 'POST', body });
    state.voice.draft = null;
    state.voice.heard = '';
    await loadInventory();
    toast(res.restocked ? t('{name} restocked ✓', { name: body.name }) : t('{name} added ✓', { name: body.name }));
    render();
  } catch (e) { toast(e.message, true); }
};

window.discardDraft = () => { state.voice.draft = null; state.voice.heard = ''; render(); };

/* ---------------- stock actions ---------------- */

window.markSold = async (itemId, qty) => {
  try {
    await api(`/api/partner/stores/${state.activeStore}/items/${itemId}/sold`, { method: 'POST', body: { qty: qty || 1 } });
    await loadInventory();
    render();
  } catch (e) { toast(e.message, true); }
};

window.restockItem = async (itemId) => {
  const raw = prompt(t('How many did you receive? (use a negative number to correct a miscount)'));
  if (raw === null) return;
  const qty = Number(raw);
  if (!qty) return;
  try {
    await api(`/api/partner/stores/${state.activeStore}/items/${itemId}/restock`, { method: 'POST', body: { qty } });
    await loadInventory();
    toast(t('Stock updated ✓'));
    render();
  } catch (e) { toast(e.message, true); }
};

window.editItemPrice = async (itemId, current) => {
  const raw = prompt(t('New price (Rs):'), current);
  if (raw === null) return;
  try {
    await api(`/api/partner/stores/${state.activeStore}/items/${itemId}`, { method: 'PATCH', body: { price: Number(raw) } });
    await loadInventory();
    render();
  } catch (e) { toast(e.message, true); }
};

window.setSubscribePrice = async (itemId, current, price) => {
  const raw = prompt(t('Subscriber price (must be under Rs {price}). Leave blank to remove:', { price }), current || '');
  if (raw === null) return;
  try {
    await api(`/api/partner/stores/${state.activeStore}/items/${itemId}`, {
      method: 'PATCH', body: { subscribePrice: raw.trim() ? Number(raw) : 0 }
    });
    await loadInventory();
    toast(raw.trim() ? t('Subscriber price set — regulars pay less ✓') : t('Subscriber price removed'));
    render();
  } catch (e) { toast(e.message, true); }
};

window.searchInventory = async () => {
  state.invSearch = ($('#inv-search') || {}).value || '';
  try { await loadInventory(); render(); } catch (e) { toast(e.message, true); }
};

window.decideStoreOrder = async (orderId, action) => {
  const body = {};
  if (action === 'handover') {
    const order = state.storeOrders.find((x) => x.id === orderId);
    if (order && order.fulfilment === 'pickup') {
      // The customer proves it is their order by reading out the code from
      // their app — the server rejects a handover with the wrong one.
      const code = prompt(t("Customer's 4-digit pickup code (in their app):"));
      if (code === null) return;
      body.code = code.trim();
    }
  }
  try {
    await api(`/api/partner/store-orders/${orderId}/${action}`, { method: 'POST', body });
    const d = await api(`/api/partner/stores/${state.activeStore}/orders`);
    state.storeOrders = d.orders || [];
    await loadInventory();
    toast(t({ accept: 'Order accepted 👍', reject: 'Order rejected — customer refunded', ready: 'Marked ready', handover: 'Handed over — income settled 💰' }[action]));
    render();
  } catch (e) { toast(e.message, true); }
};

window.inviteHelper = async () => {
  const name = prompt(t('Helper name (so you know whose count is whose):')) || '';
  try {
    const res = await api(`/api/partner/stores/${state.activeStore}/helpers`, { method: 'POST', body: { name } });
    alert(t('Give {name} this code to join in the SewaGo app:', { name: name || t('your helper') })
      + `\n\n${res.invite.code}\n\n`
      + t('They can add items and count stock — never change prices or see your money.'));
  } catch (e) { toast(e.message, true); }
};

/* ---------------- views ---------------- */

function storesSection() {
  const ready = partnerReady();
  return `
  <div class="section-title">${t('Your shops')} 🏪</div>
  <div class="muted small" style="margin-bottom:10px">
    ${t('A general store: add your stock by speaking, tap Sold as you sell, and customers nearby can order from you.')}
  </div>
  ${state.stores.length ? state.stores.map(storeCard).join('')
    : `<div class="empty"><div class="big">🏪</div>${t('No shop yet — add yours below.')}</div>`}
  ${ready ? (state.showStoreForm ? storeForm() : `<button class="btn ghost" onclick="toggleStoreForm()">${t('+ Add your shop')}</button>`)
    : `<div class="muted small" style="margin-bottom:12px">${t('Verify your phone and finish business KYC before adding a shop.')}</div>`}`;
}

function storeCard(s) {
  const st = s.stats || {};
  const badge = s.status === 'approved'
    ? `<span class="badge">${s.open ? `🟢 ${t('OPEN')}` : `⚫ ${t('CLOSED')}`}</span>`
    : `<span class="badge amber">${s.status === 'pending' ? t('IN REVIEW') : t('REJECTED')}</span>`;
  return `
  <div class="card">
    <div class="row">
      <div>
        <div style="font-weight:900">${s.icon} ${esc(s.name)}</div>
        <div class="muted small">${esc(s.area || '')} · ${t('{n} items', { n: st.items || 0 })}${st.lowStock ? ` · ⚠️ ${t('{n} running low', { n: st.lowStock })}` : ''}</div>
      </div>
      ${badge}
    </div>
    ${s.status === 'rejected' && s.reviewNote ? `<div class="muted small" style="color:#fca5a5;margin-top:6px">${esc(s.reviewNote)}</div>` : ''}
    ${s.status === 'approved' ? `
    <div class="grid2" style="margin-top:10px">
      <div><div class="muted small">${t('Stock value')}</div><div style="font-weight:900">${money(st.stockValue || 0)}</div></div>
      <div><div class="muted small">${t('Sold today')}</div><div style="font-weight:900">${st.soldToday || 0}</div></div>
    </div>` : ''}
    <button class="btn" style="margin-top:12px" onclick="openStore('${s.id}')">${t('Open inventory')}</button>
  </div>`;
}

function storeForm() {
  const icon = state.storeIcon || '🏪';
  return `
  <div class="card">
    <label class="field"><span>${t('Shop name')}</span><input id="store-name" placeholder="${t('e.g.')} Ram Kirana Pasal" /></label>
    <label class="field"><span>${t('Area')}</span><input id="store-area" placeholder="${t('e.g.')} Thamel, New Baneshwor" /></label>
    <label class="field"><span>${t('Delivery charge (Rs, 0 if customers collect)')}</span><input id="store-fee" type="number" value="0" min="0" max="200" /></label>
    <div class="muted small" style="margin-bottom:6px">${t('Shop icon')}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      ${STORE_ICONS.map((i) => `<button class="btn ghost compact" style="${i === icon ? 'border-color:var(--accent)' : ''}" onclick="pickStoreIcon('${i}')">${i}</button>`).join('')}
    </div>
    <button class="btn" onclick="createStore()">${t('Submit for review')}</button>
    <button class="btn ghost" style="margin-top:8px" onclick="toggleStoreForm()">${t('Cancel')}</button>
  </div>`;
}

function voiceCard() {
  const v = state.voice;
  if (v.draft) return draftCard(v.draft);
  const lang = (state.voiceLang || 'ne-NP') === 'ne-NP' ? 'नेपाली' : 'English';
  return `
  <div class="card">
    <div class="row">
      <div style="font-weight:900">${t('Add stock by speaking 🎤')}</div>
      <button class="btn ghost compact" onclick="toggleVoiceLang()">${lang}</button>
    </div>
    <div class="muted small" style="margin:6px 0 12px">
      ${t('Say the item, how many, and the price —')} “<b style="color:var(--text)">दुई किलो चिनी सय रुपैयाँ</b>” ${t('or')} “<b style="color:var(--text)">5 packet wai wai 20 rupees</b>”.
    </div>
    ${v.listening
      ? `<button class="btn danger" onclick="stopVoice()">${t('● Listening… tap to stop')}</button>
         <div class="muted small" id="voice-heard" style="margin-top:8px;min-height:20px">${esc(v.heard || '')}</div>`
      : `<button class="btn" onclick="startVoice()">${t('🎤 Hold a moment and speak')}</button>`}
    ${v.error ? `<div class="muted small" style="color:#fca5a5;margin-top:8px">${esc(v.error)}</div>` : ''}
    <div class="divider"></div>
    <label class="field" style="margin:0"><span>${t('…or type it')}</span>
      <input id="voice-typed" placeholder="2 kg sugar 100" onkeydown="if(event.key==='Enter')typeVoiceLine()" />
    </label>
    <button class="btn ghost compact" style="margin-top:8px" onclick="typeVoiceLine()">${t('Add typed line')}</button>
  </div>`;
}

// Everything the parser was unsure about is highlighted, so the shopkeeper's
// eye goes straight to what needs fixing.
function draftCard(d) {
  const units = (state.inventory && state.inventory.units) || {};
  const warn = (f) => (d.needsReview || []).includes(f) ? 'border-color:#fbbf24' : '';
  return `
  <div class="card" style="border-color:var(--accent)">
    <div style="font-weight:900;margin-bottom:4px">${t('Check this before saving')}</div>
    ${d.raw ? `<div class="muted small" style="margin-bottom:10px">${t('Heard:')} “${esc(d.raw)}”</div>` : ''}
    <label class="field"><span>${t('Item')}</span><input id="d-name" value="${esc(d.name || '')}" style="${warn('name')}" /></label>
    <div class="grid2">
      <label class="field"><span>${t('Quantity')}</span><input id="d-qty" type="number" step="0.5" value="${d.qty ?? ''}" style="${warn('qty')}" /></label>
      <label class="field"><span>${t('Unit')}</span>
        <select id="d-unit" style="${warn('unit')}">
          ${Object.entries(units).map(([k, u]) => `<option value="${k}" ${k === d.unit ? 'selected' : ''}>${t(u.label)}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="grid2">
      <label class="field"><span>${t('Price (Rs)')}</span><input id="d-price" type="number" value="${d.price ?? ''}" style="${warn('price')}" /></label>
      <label class="field"><span>${t('Subscriber price')}</span><input id="d-sub" type="number" placeholder="${t('optional')}" /></label>
    </div>
    <button class="btn" onclick="saveDraft()">${t('Save to inventory')}</button>
    <button class="btn ghost" style="margin-top:8px" onclick="discardDraft()">${t('Discard')}</button>
  </div>`;
}

function itemRow(i) {
  const stock = Number(i.stock) || 0;
  const out = stock <= 0;
  // The level bar answers "do I need to buy this?" at a glance. Full means a
  // comfortable three times the low-stock mark; the colour is the verdict:
  // red = act now (at or under the low mark, or gone), amber = getting low,
  // green = fine. The low mark itself comes from the server — the shop's own
  // threshold if set, otherwise a week of cover at the item's real sales rate.
  const mark = Math.max(1, Number(i.lowStockAt) || 3);
  const pct = out ? 0 : Math.max(4, Math.min(100, Math.round((stock / (mark * 3)) * 100)));
  const level = out || stock <= mark ? 'low' : stock <= mark * 2 ? 'mid' : 'ok';
  const numColor = level === 'low' ? 'var(--danger)' : level === 'mid' ? 'var(--amber)' : 'var(--text)';
  return `
  <div class="card" style="${level === 'low' ? 'border-color:#7f1d1d' : level === 'mid' ? 'border-color:#a16207' : ''}">
    <div class="row">
      <div class="grow">
        <div style="font-weight:800">${esc(i.name)}</div>
        <div class="muted small">
          ${money(i.price)} / ${esc(t(i.unitLabel))}${i.subscribePrice ? ` · 🔁 ${money(i.subscribePrice)} ${t('for subscribers')}` : ''}
        </div>
      </div>
      <div style="text-align:right">
        <div style="font-size:20px;font-weight:900;color:${numColor}">${i.stock}</div>
        <div class="muted small">${esc(t(i.unitLabel))} ${t('left')}</div>
        <div class="stock-meter ${level}"><div style="width:${pct}%"></div></div>
      </div>
    </div>
    ${out ? `<div class="muted small" style="color:#fca5a5;margin-top:6px">${t('Out of stock — customers cannot order it')}</div>`
      : level === 'low' ? `<div class="muted small" style="color:#fca5a5;margin-top:6px">${t('Running low — reorder soon')}</div>` : ''}
    <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
      <button class="btn compact" onclick="markSold('${i.id}', 1)" ${out ? 'disabled' : ''}>${t('Sold 1')}</button>
      <button class="btn ghost compact" onclick="restockItem('${i.id}')">${t('+ Stock')}</button>
      <button class="btn ghost compact" onclick="editItemPrice('${i.id}', ${i.price})">${t('Price')}</button>
      <button class="btn ghost compact" onclick="setSubscribePrice('${i.id}', ${i.subscribePrice || 0}, ${i.price})">🔁</button>
    </div>
  </div>`;
}

function reorderView() {
  const r = state.reorder;
  if (!r) return `<div class="empty">${t('Loading…')}</div>`;
  if (!r.suggestions.length) {
    return `<div class="empty"><div class="big">✅</div>${t('Nothing is running low. Your shelves are in good shape.')}</div>`;
  }
  return `
  <div class="muted small" style="margin-bottom:10px">${t('Ranked by how soon you run out, using how fast each item actually sells.')}</div>
  ${r.suggestions.map((s) => `
  <div class="card">
    <div class="row">
      <div class="grow">
        <div style="font-weight:800">${esc(s.name)}</div>
        <div class="muted small">
          ${s.stock} ${t('left')} · ${t('sells {n}/day', { n: s.perDay })}${s.daysLeft !== null ? ` · ${t('about {n} days', { n: s.daysLeft })}` : ''}
        </div>
      </div>
      <div style="text-align:right">
        <div style="font-weight:900;color:var(--accent)">${t('buy')} ${s.suggestedQty}</div>
        ${s.outOfStock ? `<div class="muted small" style="color:#f87171">${t('out now')}</div>` : ''}
      </div>
    </div>
  </div>`).join('')}`;
}

function storeOrdersView() {
  if (!state.storeOrders.length) {
    return `<div class="empty"><div class="big">🧾</div>${t('No customer orders yet.')}</div>`;
  }
  const nextAction = { placed: ['accept', 'Accept'], accepted: ['ready', 'Mark ready'], ready: ['handover', 'Handed over'] };
  return state.storeOrders.map((o) => {
    // Once a courier is carrying it, the order settles at the customer's door —
    // offering "Handed over" here would be the wrong tap at exactly the moment
    // the shopkeeper hands the bag over.
    const withCourier = !!o.courierId;
    const next = withCourier ? null : nextAction[o.status];
    return `
    <div class="card">
      <div class="row">
        <div class="grow">
          <div style="font-weight:800">${esc(o.customerName)}</div>
          <div class="muted small">${o.items.map((l) => `${l.qty}× ${esc(l.name)}`).join(', ')}</div>
          <div class="muted small">${o.payment === 'cash' ? t('💵 cash on handover') : t('👛 paid in app')}${o.fulfilment === 'pickup' ? ` · ${t('🏃 customer collects')}` : o.deliveryLoc ? ` · 📍 ${esc(o.deliveryLoc.name)}` : ''}</div>
        </div>
        <div style="text-align:right">
          <div style="font-weight:900">${money(o.total)}</div>
          <div class="muted small">${t('you get')} ${money(o.partnerCut)}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
        ${next ? `<button class="btn compact" onclick="decideStoreOrder('${o.id}','${next[0]}')">${t(next[1])}</button>` : ''}
        ${o.status === 'placed' || o.status === 'accepted'
          ? `<button class="btn ghost compact danger" onclick="decideStoreOrder('${o.id}','reject')">${t("Can't fulfil")}</button>` : ''}
        ${o.status === 'ready' && o.fulfilment === 'pickup'
          ? `<button class="btn ghost compact danger" onclick="decideStoreOrder('${o.id}','reject')">${t('Never collected — refund')}</button>` : ''}
        ${o.status !== 'cancelled'
          ? `<button class="btn ghost compact" onclick="openInvoice('${o.id}')">🧾 ${t('Bill')}</button>` : ''}
        ${withCourier && o.status !== 'delivered' && o.status !== 'cancelled'
          ? `<span class="badge">🛵 ${t('with')} ${esc((o.courier && o.courier.name) || t('courier'))}</span>` : ''}
        ${o.status === 'delivered' ? `<span class="badge">✓ ${t('DONE')}</span>` : ''}
        ${o.status === 'cancelled' ? `<span class="badge gray">${t('CANCELLED')}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function inventoryView() {
  const inv = state.inventory;
  const store = state.stores.find((s) => s.id === state.activeStore) || {};
  if (!inv) return `<div class="empty">${t('Loading…')}</div>`;
  const st = inv.stats || {};
  return `
    <header class="topbar">
      <button class="btn ghost compact" onclick="closeStore()">${t('← Shops')}</button>
      <div style="display:flex;gap:8px;align-items:center">
        ${langButton()}
        <span class="badge ${inv.open ? '' : 'gray'}">${inv.open ? `🟢 ${t('OPEN')}` : `⚫ ${t('CLOSED')}`}</span>
      </div>
    </header>
    <main>
      <div class="row" style="margin-bottom:12px">
        <div>
          <div style="font-size:18px;font-weight:900">${store.icon || '🏪'} ${esc(store.name || t('Your shop'))}</div>
          <div class="muted small">${t('{n} items', { n: st.items || 0 })} · ${money(st.stockValue || 0)} ${t('on the shelves')}</div>
        </div>
        <button class="btn ghost compact" onclick="toggleShopOpen(${inv.open ? 'false' : 'true'})">${inv.open ? t('Close shop') : t('Open shop')}</button>
      </div>

      ${store.locPinned ? '' : `
      <div class="card" style="border-color:var(--accent);margin-bottom:12px">
        <div style="font-weight:900">${t('📍 Put your shop on the map')}</div>
        <div class="muted small" style="margin:4px 0 10px">
          ${t('Customers find shops by how close they are. Stand in your shop and tap below so nearby customers can see you.')}
        </div>
        <button class="btn" onclick="pinShopLocation()">${t('Use my current location')}</button>
      </div>`}

      <div class="grid2" style="margin-bottom:12px">
        <div class="card" style="padding:12px">
          <div class="muted small">${t('Sold today')}</div>
          <div style="font-size:22px;font-weight:900">${st.soldToday || 0}</div>
          <div class="muted small">${money(st.revenueToday || 0)}</div>
        </div>
        <div class="card" style="padding:12px">
          <div class="muted small">${t('Needs attention')}</div>
          <div style="font-size:22px;font-weight:900;color:${(st.lowStock || st.outOfStock) ? '#fbbf24' : 'var(--text)'}">${(st.lowStock || 0) + (st.outOfStock || 0)}</div>
          <div class="muted small">${st.outOfStock || 0} ${t('out')} · ${st.lowStock || 0} ${t('low')}</div>
        </div>
      </div>

      <div class="grid2" style="margin-bottom:12px">
        <button class="btn ${state.invTab === 'stock' ? '' : 'ghost'} compact" onclick="setInvTab('stock')">${t('Stock')}</button>
        <button class="btn ${state.invTab === 'reorder' ? '' : 'ghost'} compact" onclick="setInvTab('reorder')">${t('To buy')}${state.reorder && state.reorder.suggestions.length ? ` (${state.reorder.suggestions.length})` : ''}</button>
      </div>
      <div class="grid2" style="margin-bottom:14px">
        <button class="btn ${state.invTab === 'orders' ? '' : 'ghost'} compact" onclick="setInvTab('orders')">${t('Customer orders')}</button>
        <button class="btn ${state.invTab === 'insights' ? '' : 'ghost'} compact" onclick="setInvTab('insights')">📊 ${t('Insights')}</button>
      </div>

      ${state.invTab === 'stock' ? `
        ${voiceCard()}
        <label class="field" style="margin-top:12px"><span>${t('Find an item')}</span>
          <input id="inv-search" value="${esc(state.invSearch)}" placeholder="${t('Search your shelves')}" oninput="searchInventory()" />
        </label>
        ${inv.items.length ? inv.items.map(itemRow).join('')
          : `<div class="empty"><div class="big">📦</div>${state.invSearch ? t('Nothing matches that.') : t('No items yet — speak your first one above.')}</div>`}
        <div class="divider"></div>
        <button class="btn ghost" onclick="inviteHelper()">${t('👥 Invite a helper to count stock')}</button>
        <div class="muted small" style="margin-top:6px">${t('They can add items and count shelves — never change prices or see your money.')}</div>
      ` : ''}
      ${state.invTab === 'reorder' ? reorderView() : ''}
      ${state.invTab === 'orders' ? storeOrdersView() : ''}
      ${state.invTab === 'insights' ? insightsView() : ''}
      <div style="height:40px"></div>
    </main>`;
}

// A shop's position is what puts it in "near me" for customers, so it is taken
// from the shopkeeper's own phone standing in the shop rather than a typed area.
window.pinShopLocation = () => {
  if (!navigator.geolocation) return toast(t('This phone cannot share location.'), true);
  toast(t('Finding your shop…'));
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      await api(`/api/partner/stores/${state.activeStore}`, {
        method: 'PATCH',
        body: { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6) }
      });
      await loadStores();
      await loadInventory();
      toast(t('Shop pinned — nearby customers can find you now 📍'));
      render();
    } catch (e) { toast(e.message, true); }
  }, () => toast(t('Could not get your location — allow it in your browser.'), true), { enableHighAccuracy: true, timeout: 10000 });
};

/* ---------------- insights (how is my shop doing?) ---------------- */

// Pure-CSS bars: every number a shopkeeper needs, no chart library. The events
// come with real timestamps and are bucketed by the PHONE's clock, so "10 AM"
// means 10 AM in the shop, wherever the server lives.
function insightsView() {
  const ins = state.insights;
  if (!ins) return `<div class="empty">${t('Loading…')}</div>`;
  const tot = ins.totals || {};
  const events = ins.events || [];
  const topItems = ins.topItems || [];
  const week = ins.week || [];

  // Hour histogram, trimmed to the interesting part of the day but never
  // narrower than morning-to-evening so the shape is comparable day to day.
  const buckets = Array.from({ length: 24 }, () => 0);
  for (const e of events) buckets[new Date(e.at).getHours()] += e.qty;
  let lo = 7;
  let hi = 20;
  for (let h = 0; h < 24; h += 1) {
    if (buckets[h] > 0) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
  }
  const maxHour = Math.max(...buckets, 1);
  const hourBars = [];
  const hourLabels = [];
  for (let h = lo; h <= hi; h += 1) {
    const v = buckets[h];
    hourBars.push(`<div class="vbar ${v ? '' : 'zero'}" style="height:${v ? Math.max(8, Math.round((v / maxHour) * 100)) : 2}%" title="${h}:00 — ${v}"></div>`);
    hourLabels.push(`<span>${(h - lo) % 3 === 0 ? h : ''}</span>`);
  }

  const maxRevenue = Math.max(...topItems.map((x) => x.revenue), 1);
  const maxWeek = Math.max(...week.map((w) => w.units), 1);
  const dayNames = [t('Sun'), t('Mon'), t('Tue'), t('Wed'), t('Thu'), t('Fri'), t('Sat')];

  return `
  <div class="grid2" style="margin-bottom:12px">
    <div class="card" style="padding:12px">
      <div class="muted small">${t('Sold today')}</div>
      <div style="font-size:22px;font-weight:900">${tot.units || 0}</div>
      <div class="muted small">${t('{n} at the counter', { n: tot.walkinUnits || 0 })}</div>
    </div>
    <div class="card" style="padding:12px">
      <div class="muted small">${t("Today's sales")}</div>
      <div style="font-size:22px;font-weight:900;color:var(--accent)">${money(tot.revenue || 0)}</div>
      <div class="muted small">${t('{n} app orders', { n: tot.orders || 0 })}</div>
    </div>
  </div>

  <div class="card">
    <div style="font-weight:900">${t('When things sold today')} 🕐</div>
    ${events.length ? `
    <div class="vbar-chart" style="margin-top:10px">${hourBars.join('')}</div>
    <div class="vbar-labels">${hourLabels.join('')}</div>` : `
    <div class="muted small" style="margin:10px 0 4px">${t('Nothing sold yet today — sales appear here as they happen.')}</div>`}
  </div>

  <div class="card">
    <div style="font-weight:900">${t('What sold today')} 🏆</div>
    ${topItems.length ? topItems.slice(0, 8).map((x) => `
    <div style="margin-top:10px">
      <div class="row">
        <div class="grow small">${esc(x.name)} <span class="muted">· ${x.qty} ${esc(t(x.unit || ''))}</span></div>
        <div style="font-weight:800;white-space:nowrap">${money(x.revenue)}</div>
      </div>
      <div class="hbar-track"><div style="width:${Math.max(4, Math.round((x.revenue / maxRevenue) * 100))}%"></div></div>
    </div>`).join('') : `
    <div class="muted small" style="margin-top:8px">${t('Nothing sold yet today — sales appear here as they happen.')}</div>`}
    ${topItems.some((x) => x.walkinQty > 0) ? `
    <div class="muted small" style="margin-top:12px">${t("Counter sales are valued at today's shelf price.")}</div>` : ''}
  </div>

  <div class="card">
    <div style="font-weight:900">${t('Last 7 days')} 📅</div>
    <div class="vbar-chart" style="margin-top:10px">
      ${week.map((w, idx) => `<div class="vbar ${w.units ? '' : 'zero'} ${idx === week.length - 1 ? 'today' : ''}" style="height:${w.units ? Math.max(8, Math.round((w.units / maxWeek) * 100)) : 2}%" title="${esc(w.date)} — ${w.units}"></div>`).join('')}
    </div>
    <div class="vbar-labels">
      ${week.map((w) => `<span>${dayNames[new Date(w.date + 'T00:00:00').getDay()]}</span>`).join('')}
    </div>
    <div class="muted small" style="margin-top:8px">${t('Units sold per day — the amber bar is today.')}</div>
  </div>`;
}

/* ---------------- invoice (a printable bill per order) ---------------- */

window.openInvoice = (orderId) => {
  const order = state.storeOrders.find((x) => x.id === orderId);
  if (!order) return;
  state.invoiceOrder = order;
  render();
  window.scrollTo(0, 0);
};

window.closeInvoice = () => {
  state.invoiceOrder = null;
  render();
};

// Everything on the bill was frozen onto the order when it was placed (names,
// unit prices, fees), so it stays correct even after shelf prices change.
// Money the customer never sees — commission, the shop's cut — stays off it.
function invoiceView() {
  const o = state.invoiceOrder;
  const store = state.stores.find((s) => s.id === o.storeId) || {};
  const p = state.partner || {};
  const units = (state.inventory && state.inventory.units) || {};
  const unitLabel = (u) => (units[u] && units[u].label) || u || '';
  const delivered = o.status === 'delivered';
  const paidLine = o.payment === 'cash'
    ? (delivered ? t('Paid in cash') : t('To pay in cash on handover'))
    : t('Paid in the SewaGo app');
  return `
  <header class="topbar no-print">
    <button class="btn ghost compact" onclick="closeInvoice()">${t('← Back')}</button>
    <div style="display:flex;gap:8px">
      ${langButton()}
      <button class="btn compact" onclick="window.print()">🖨️ ${t('Print')}</button>
    </div>
  </header>
  <main>
    <div class="invoice-sheet">
      <div class="invoice-head">
        <div>
          <div style="font-size:19px;font-weight:900">${store.icon || '🏪'} ${esc(o.storeName)}</div>
          ${store.area ? `<div class="invoice-muted">${esc(store.area)}</div>` : ''}
          ${p.regNo ? `<div class="invoice-muted">${t('PAN / Reg. no.')}: ${esc(p.regNo)}</div>` : ''}
          ${p.phone ? `<div class="invoice-muted">${t('Phone')}: ${esc(p.phone)}</div>` : ''}
        </div>
        <div style="text-align:right">
          <div style="font-weight:900;letter-spacing:0.06em">${t('INVOICE')}</div>
          <div class="invoice-muted">#${esc(String(o.id).slice(-8).toUpperCase())}</div>
          <div class="invoice-muted">${new Date(o.createdAt).toLocaleString()}</div>
        </div>
      </div>

      <div style="margin-top:12px;font-size:13px">
        <div><span class="invoice-muted">${t('Customer')}:</span> <b>${esc(o.customerName)}</b></div>
        <div class="invoice-muted" style="margin-top:2px">
          ${o.fulfilment === 'pickup' ? t('Collected at the shop') : o.deliveryLoc ? `${t('Delivered to')}: ${esc(o.deliveryLoc.name)}` : ''}
          ${delivered && o.deliveredAt ? ` · ${new Date(o.deliveredAt).toLocaleString()}` : ''}
        </div>
      </div>

      <table class="invoice-table">
        <thead>
          <tr><th>${t('Item')}</th><th class="num">${t('Qty')}</th><th class="num">${t('Rate')}</th><th class="num">${t('Amount')}</th></tr>
        </thead>
        <tbody>
          ${o.items.map((l) => `
          <tr>
            <td>${esc(l.name)}${l.subscribed ? ` <span class="invoice-muted">🔁 ${t('subscriber price')}</span>` : ''}</td>
            <td class="num">${l.qty} ${esc(t(unitLabel(l.unit)))}</td>
            <td class="num">${money(l.price)}</td>
            <td class="num">${money(l.price * l.qty)}</td>
          </tr>`).join('')}
        </tbody>
      </table>

      <div class="invoice-totals">
        <div class="row"><div class="invoice-muted">${t('Subtotal')}</div><div>${money(o.subtotal)}</div></div>
        ${o.deliveryFee ? `<div class="row"><div class="invoice-muted">${t('Delivery fee')}</div><div>${money(o.deliveryFee)}</div></div>` : ''}
        ${o.serviceFee ? `<div class="row"><div class="invoice-muted">${t('Service fee')}</div><div>${money(o.serviceFee)}</div></div>` : ''}
        <div class="row invoice-grand"><div>${t('Total')}</div><div>${money(o.total)}</div></div>
        <div class="invoice-muted" style="margin-top:6px">${paidLine}</div>
      </div>

      <div class="invoice-muted" style="margin-top:16px;text-align:center">
        ${t('Thank you! Sold through SewaGo.')} · sewago.app
      </div>
    </div>
    <div style="height:40px"></div>
  </main>`;
}
