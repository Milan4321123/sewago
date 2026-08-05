/* SewaGo Partner — list your restaurant or hotel so it appears in the app */

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
  invTab: 'stock', // stock | reorder | orders
  reorder: null,
  storeOrders: [],
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
    throw new Error('Session expired — please log in again.');
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
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
        if (status === 'approved') toast('🎉 Your business KYC was approved — you can now list and withdraw!');
        else if (status === 'rejected') toast('Your business KYC was rejected — see the note in the KYC card.', true);
      }
    } else if (msg.topic === 'wallet') {
      await reload().catch(() => {});
      if (msg.event === 'withdrawal_paid') toast('🏦 Your payout was approved and sent.');
      if (msg.event === 'withdrawal_rejected') toast('Your payout was rejected — the amount is back in your earnings.', true);
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
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
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
      <div class="rt"><b>${money(o.subtotal)}</b><div class="muted small">you earn ${money(o.partnerCut)}</div></div>
    </div>
    <div class="muted small" style="margin-top:8px">${ORDER_STATUS_LINE[o.status] || esc(o.status)}${
      o.courier ? ` · 🛵 ${esc(o.courier.name)} (${esc(o.courier.plate)})` : ''}</div>
    ${o.status === 'placed' ? `
    <div class="grid2" style="margin-top:10px">
      <button class="btn" onclick="acceptOrder('${o.id}')">✅ Accept — start cooking</button>
      <button class="btn ghost" onclick="rejectOrder('${o.id}')">Reject</button>
    </div>` : ''}
    ${!active && o.status === 'cancelled' ? `<div class="muted small" style="margin-top:6px">Customer refunded in full.</div>` : ''}
  </div>`;
}

function ordersSection() {
  if (!state.restaurants.length) return '';
  const active = state.orders.filter((o) => ['placed', 'preparing', 'out_for_delivery'].includes(o.status));
  const recent = state.orders.filter((o) => !['placed', 'preparing', 'out_for_delivery'].includes(o.status)).slice(0, 5);
  return `
  <div class="section-title">Incoming orders 🔔${active.length ? ` <span class="badge">${active.length}</span>` : ''}</div>
  ${active.length ? active.map(orderQueueCard).join('')
    : `<div class="muted small" style="margin-bottom:12px">No orders waiting. New ones appear here instantly.</div>`}
  ${recent.length ? recent.map(orderQueueCard).join('') : ''}`;
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
  if (!confirm('Reject this order? The customer is refunded in full.')) return;
  try {
    await api(`/api/partner/orders/${id}/reject`, { method: 'POST', body: { note: '' } });
    toast('Order rejected — customer refunded.');
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
  // The inventory manager takes over the whole screen — a shopkeeper working
  // the shelves should not be scrolling past restaurant and hotel forms.
  if (state.activeStore) {
    app.innerHTML = inventoryView();
    return;
  }
  const ready = partnerReady();
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><img class="brand-mark" src="/icon.svg" alt="" />Sewa<em>Go</em> <span class="muted" style="font-size:13px;font-weight:700">PARTNER</span></div>
      <span class="badge">${esc(state.partner.name)}</span>
    </header>
    <main>
      <div class="muted small" style="margin-bottom:14px">
        New listings go to the <b style="color:var(--text)">SewaGo review team</b> first (we verify your documents and may call you). Once approved they appear in the customer app — restaurants in <b style="color:var(--text)">Food</b>, hotels in <b style="color:var(--text)">Stays</b>.
      </div>
      ${kycNotice()}
      ${kycCard()}
      ${ordersSection()}
      ${earningsCard()}

      ${storesSection()}

      <div class="section-title">Your restaurants 🍜</div>
      ${state.restaurants.length ? state.restaurants.map(restaurantCard).join('')
        : `<div class="empty"><div class="big">🍳</div>No restaurants yet — add your first one below.</div>`}
      ${ready ? (state.showRestForm ? restaurantForm() : `<button class="btn ghost" onclick="toggleRestForm()">+ Add a restaurant</button>`)
        : `<div class="muted small" style="margin-bottom:12px">Verify phone and complete business KYC before adding restaurants.</div>`}

      <div class="section-title">Your hotels 🏨</div>
      ${state.hotels.length ? state.hotels.map(hotelCard).join('')
        : `<div class="empty"><div class="big">🛎️</div>No hotels yet — add your first one below.</div>`}
      ${ready ? (state.showHotelForm ? hotelForm() : `<button class="btn ghost" onclick="toggleHotelForm()">+ Add a hotel</button>`)
        : `<div class="muted small" style="margin-bottom:12px">Business KYC approval is required before adding hotels.</div>`}

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
      </div>
    </main>`;
}

window.toggleDeleteAccount = (show) => {
  state.showDeleteAccount = show;
  render();
};

window.partnerDeleteAccount = async () => {
  if (!confirm('Delete your SewaGo partner account forever? This cannot be undone.')) return;
  try {
    await api('/api/partner/account/delete', { method: 'POST', body: { password: $('#del-password').value } });
    toast('Your account has been deleted. Goodbye 👋');
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
        <div class="muted small">${p.businessKycNote ? esc(p.businessKycNote) : 'Fix your details in the KYC card below and resubmit.'}</div>
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

function earningsCard() {
  const p = state.partner;
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
    ${state.transactions.length ? `
    <div class="divider"></div>
    <div class="muted small" style="font-weight:700;margin-bottom:8px">Recent activity</div>
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

function restaurantCard(r) {
  return `
  <div class="card">
    ${r.photo ? `<img class="cover-img" src="${esc(r.photo)}" alt="${esc(r.name)}" />` : ''}
    <div class="row">
      <div>
        <div style="font-weight:900">${r.icon} ${esc(r.name)} ${reviewStatusBadge(r)}</div>
        <div class="muted small">${esc(r.cuisine)} · ${r.etaMinutes} min · delivery ${money(r.deliveryFee)}</div>
      </div>
      <button class="btn danger compact" onclick="deleteRestaurant('${r.id}')">Remove</button>
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

function hotelCard(h) {
  return `
  <div class="card">
    ${h.photo ? `<img class="cover-img" src="${esc(h.photo)}" alt="${esc(h.name)}" />` : ''}
    <div class="row">
      <div>
        <div style="font-weight:900">${h.icon} ${esc(h.name)} ${reviewStatusBadge(h)}</div>
        <div class="muted small">${esc(h.area)}${h.area ? ', ' : ''}${esc(h.city)}${h.desc ? ' · ' + esc(h.desc) : ''}</div>
      </div>
      <button class="btn danger compact" onclick="deleteHotel('${h.id}')">Remove</button>
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
    await reload();
    toast('Hotel removed from the app.');
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
  try {
    await loadInventory();
    render();
  } catch (e) { toast(e.message, true); }
};

window.closeStore = () => {
  state.activeStore = null;
  state.inventory = null;
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

/* ---------------- voice entry ---------------- */

// Browser speech recognition. Nepali first, since that is what a shopkeeper
// speaks; if the device has no Nepali model it still returns something usable
// and the confirm step catches the difference.
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
    toast(res.restocked ? `${body.name} restocked ✓` : `${body.name} added ✓`);
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
  const raw = prompt('How many did you receive? (use a negative number to correct a miscount)');
  if (raw === null) return;
  const qty = Number(raw);
  if (!qty) return;
  try {
    await api(`/api/partner/stores/${state.activeStore}/items/${itemId}/restock`, { method: 'POST', body: { qty } });
    await loadInventory();
    toast('Stock updated ✓');
    render();
  } catch (e) { toast(e.message, true); }
};

window.editItemPrice = async (itemId, current) => {
  const raw = prompt('New price (Rs):', current);
  if (raw === null) return;
  try {
    await api(`/api/partner/stores/${state.activeStore}/items/${itemId}`, { method: 'PATCH', body: { price: Number(raw) } });
    await loadInventory();
    render();
  } catch (e) { toast(e.message, true); }
};

window.setSubscribePrice = async (itemId, current, price) => {
  const raw = prompt(`Subscriber price (must be under Rs ${price}). Leave blank to remove:`, current || '');
  if (raw === null) return;
  try {
    await api(`/api/partner/stores/${state.activeStore}/items/${itemId}`, {
      method: 'PATCH', body: { subscribePrice: raw.trim() ? Number(raw) : 0 }
    });
    await loadInventory();
    toast(raw.trim() ? 'Subscriber price set — regulars pay less ✓' : 'Subscriber price removed');
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
      const code = prompt("Customer's 4-digit pickup code (in their app):");
      if (code === null) return;
      body.code = code.trim();
    }
  }
  try {
    await api(`/api/partner/store-orders/${orderId}/${action}`, { method: 'POST', body });
    const d = await api(`/api/partner/stores/${state.activeStore}/orders`);
    state.storeOrders = d.orders || [];
    await loadInventory();
    toast({ accept: 'Order accepted 👍', reject: 'Order rejected — customer refunded', ready: 'Marked ready', handover: 'Handed over — income settled 💰' }[action]);
    render();
  } catch (e) { toast(e.message, true); }
};

window.inviteHelper = async () => {
  const name = prompt('Helper name (so you know whose count is whose):') || '';
  try {
    const res = await api(`/api/partner/stores/${state.activeStore}/helpers`, { method: 'POST', body: { name } });
    alert(`Give ${name || 'your helper'} this code to join in the SewaGo app:\n\n${res.invite.code}\n\nThey can add items and count stock — never change prices or see your money.`);
  } catch (e) { toast(e.message, true); }
};

/* ---------------- views ---------------- */

function storesSection() {
  const ready = partnerReady();
  return `
  <div class="section-title">Your shops 🏪</div>
  <div class="muted small" style="margin-bottom:10px">
    A general store: add your stock by speaking, tap <b style="color:var(--text)">Sold</b> as you sell, and customers nearby can order from you.
  </div>
  ${state.stores.length ? state.stores.map(storeCard).join('')
    : `<div class="empty"><div class="big">🏪</div>No shop yet — add yours below.</div>`}
  ${ready ? (state.showStoreForm ? storeForm() : `<button class="btn ghost" onclick="toggleStoreForm()">+ Add your shop</button>`)
    : `<div class="muted small" style="margin-bottom:12px">Verify your phone and finish business KYC before adding a shop.</div>`}`;
}

function storeCard(s) {
  const st = s.stats || {};
  const badge = s.status === 'approved'
    ? `<span class="badge">${s.open ? '🟢 OPEN' : '⚫ CLOSED'}</span>`
    : `<span class="badge amber">${s.status === 'pending' ? 'IN REVIEW' : 'REJECTED'}</span>`;
  return `
  <div class="card">
    <div class="row">
      <div>
        <div style="font-weight:900">${s.icon} ${esc(s.name)}</div>
        <div class="muted small">${esc(s.area || '')} · ${st.items || 0} items${st.lowStock ? ` · ⚠️ ${st.lowStock} running low` : ''}</div>
      </div>
      ${badge}
    </div>
    ${s.status === 'rejected' && s.reviewNote ? `<div class="muted small" style="color:#fca5a5;margin-top:6px">${esc(s.reviewNote)}</div>` : ''}
    ${s.status === 'approved' ? `
    <div class="grid2" style="margin-top:10px">
      <div><div class="muted small">Stock value</div><div style="font-weight:900">${money(st.stockValue || 0)}</div></div>
      <div><div class="muted small">Sold today</div><div style="font-weight:900">${st.soldToday || 0}</div></div>
    </div>` : ''}
    <button class="btn" style="margin-top:12px" onclick="openStore('${s.id}')">Open inventory</button>
  </div>`;
}

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

function voiceCard() {
  const v = state.voice;
  if (v.draft) return draftCard(v.draft);
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
      ? `<button class="btn danger" onclick="stopVoice()">● Listening… tap to stop</button>
         <div class="muted small" id="voice-heard" style="margin-top:8px;min-height:20px">${esc(v.heard || '')}</div>`
      : `<button class="btn" onclick="startVoice()">🎤 Hold a moment and speak</button>`}
    ${v.error ? `<div class="muted small" style="color:#fca5a5;margin-top:8px">${esc(v.error)}</div>` : ''}
    <div class="divider"></div>
    <label class="field" style="margin:0"><span>…or type it</span>
      <input id="voice-typed" placeholder="2 kg sugar 100" onkeydown="if(event.key==='Enter')typeVoiceLine()" />
    </label>
    <button class="btn ghost compact" style="margin-top:8px" onclick="typeVoiceLine()">Add typed line</button>
  </div>`;
}

// Everything the parser was unsure about is highlighted, so the shopkeeper's
// eye goes straight to what needs fixing.
function draftCard(d) {
  const units = (state.inventory && state.inventory.units) || {};
  const warn = (f) => (d.needsReview || []).includes(f) ? 'border-color:#fbbf24' : '';
  return `
  <div class="card" style="border-color:var(--accent)">
    <div style="font-weight:900;margin-bottom:4px">Check this before saving</div>
    ${d.raw ? `<div class="muted small" style="margin-bottom:10px">Heard: “${esc(d.raw)}”</div>` : ''}
    <label class="field"><span>Item</span><input id="d-name" value="${esc(d.name || '')}" style="${warn('name')}" /></label>
    <div class="grid2">
      <label class="field"><span>Quantity</span><input id="d-qty" type="number" step="0.5" value="${d.qty ?? ''}" style="${warn('qty')}" /></label>
      <label class="field"><span>Unit</span>
        <select id="d-unit" style="${warn('unit')}">
          ${Object.entries(units).map(([k, u]) => `<option value="${k}" ${k === d.unit ? 'selected' : ''}>${u.label}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="grid2">
      <label class="field"><span>Price (Rs)</span><input id="d-price" type="number" value="${d.price ?? ''}" style="${warn('price')}" /></label>
      <label class="field"><span>Subscriber price</span><input id="d-sub" type="number" placeholder="optional" /></label>
    </div>
    <button class="btn" onclick="saveDraft()">Save to inventory</button>
    <button class="btn ghost" style="margin-top:8px" onclick="discardDraft()">Discard</button>
  </div>`;
}

function itemRow(i) {
  const out = i.stock <= 0;
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
    <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
      <button class="btn compact" onclick="markSold('${i.id}', 1)" ${out ? 'disabled' : ''}>Sold 1</button>
      <button class="btn ghost compact" onclick="restockItem('${i.id}')">+ Stock</button>
      <button class="btn ghost compact" onclick="editItemPrice('${i.id}', ${i.price})">Price</button>
      <button class="btn ghost compact" onclick="setSubscribePrice('${i.id}', ${i.subscribePrice || 0}, ${i.price})">🔁</button>
    </div>
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
  </div>`).join('')}`;
}

function storeOrdersView() {
  if (!state.storeOrders.length) {
    return `<div class="empty"><div class="big">🧾</div>No customer orders yet.</div>`;
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
          <div class="muted small">${o.payment === 'cash' ? '💵 cash on handover' : '👛 paid in app'}${o.fulfilment === 'pickup' ? ' · 🏃 customer collects' : o.deliveryLoc ? ` · 📍 ${esc(o.deliveryLoc.name)}` : ''}</div>
        </div>
        <div style="text-align:right">
          <div style="font-weight:900">${money(o.total)}</div>
          <div class="muted small">you get ${money(o.partnerCut)}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
        ${next ? `<button class="btn compact" onclick="decideStoreOrder('${o.id}','${next[0]}')">${next[1]}</button>` : ''}
        ${o.status === 'placed' || o.status === 'accepted'
          ? `<button class="btn ghost compact danger" onclick="decideStoreOrder('${o.id}','reject')">Can't fulfil</button>` : ''}
        ${o.status === 'ready' && o.fulfilment === 'pickup'
          ? `<button class="btn ghost compact danger" onclick="decideStoreOrder('${o.id}','reject')">Never collected — refund</button>` : ''}
        ${withCourier && o.status !== 'delivered' && o.status !== 'cancelled'
          ? `<span class="badge">🛵 with ${esc((o.courier && o.courier.name) || 'courier')}</span>` : ''}
        ${o.status === 'delivered' ? `<span class="badge">✓ DONE</span>` : ''}
        ${o.status === 'cancelled' ? `<span class="badge gray">CANCELLED</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function inventoryView() {
  const inv = state.inventory;
  const store = state.stores.find((s) => s.id === state.activeStore) || {};
  if (!inv) return `<div class="empty">Loading…</div>`;
  const st = inv.stats || {};
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

      <div class="grid2" style="margin-bottom:12px">
        <button class="btn ${state.invTab === 'stock' ? '' : 'ghost'} compact" onclick="setInvTab('stock')">Stock</button>
        <button class="btn ${state.invTab === 'reorder' ? '' : 'ghost'} compact" onclick="setInvTab('reorder')">To buy${state.reorder && state.reorder.suggestions.length ? ` (${state.reorder.suggestions.length})` : ''}</button>
      </div>
      <button class="btn ${state.invTab === 'orders' ? '' : 'ghost'} compact" style="width:100%;margin-bottom:14px" onclick="setInvTab('orders')">Customer orders</button>

      ${state.invTab === 'stock' ? `
        ${voiceCard()}
        <label class="field" style="margin-top:12px"><span>Find an item</span>
          <input id="inv-search" value="${esc(state.invSearch)}" placeholder="Search your shelves" oninput="searchInventory()" />
        </label>
        ${inv.items.length ? inv.items.map(itemRow).join('')
          : `<div class="empty"><div class="big">📦</div>${state.invSearch ? 'Nothing matches that.' : 'No items yet — speak your first one above.'}</div>`}
        <div class="divider"></div>
        <button class="btn ghost" onclick="inviteHelper()">👥 Invite a helper to count stock</button>
        <div class="muted small" style="margin-top:6px">They can add items and count shelves — never change prices or see your money.</div>
      ` : ''}
      ${state.invTab === 'reorder' ? reorderView() : ''}
      ${state.invTab === 'orders' ? storeOrdersView() : ''}
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
