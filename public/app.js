/* SewaGo — rides · food · stays (single-page app) */

const $ = (sel) => document.querySelector(sel);

const state = {
  token: localStorage.getItem('sewago_token'),
  user: null,
  tab: 'home', // hub-and-spoke: the launcher is the default page
  _popNav: false, // current setTab was triggered by the browser back button
  authMode: 'login',
  demo: false, // set from /api/app-info; only then do we show seed-account hints
  resetToken: '',
  resetFromLink: false,
  otpLogin: { phone: '', devCode: '' },
  // rides
  ridePickup: '',
  rideDropoff: '',
  pickupSel: null, // {name,lat,lng} when chosen from GPS/address search
  dropoffSel: null,
  fare: null, // { pickup, dropoff, distanceKm, pickupPlace, dropoffPlace, options }
  parcelMode: false,
  payMethod: 'wallet',
  activeRide: null,
  pendingStars: 0,
  places: [],
  _rideKey: null,
  // food
  restaurants: [],
  foodServiceFee: 0,
  deliverTo: '',
  deliverToLoc: null,
  foodPayMethod: 'wallet', // 'cash' = pay the courier at the door (COD)
  foodMode: 'delivery', // 'delivery' | 'pickup' | 'dinein' (order-ahead)
  foodWhen: 'asap', // 'asap' | minutes-from-now | 'custom' — order-ahead time
  foodWhenTime: '', // HH:MM when foodWhen === 'custom'
  dismissedOrders: {},
  restaurant: null, // currently open menu
  cart: {}, // itemId -> qty
  orders: [],
  groups: null, // my group orders (null until first load — SSE diffs need "loaded")
  group: null, // open group takeover screen (one of state.groups)
  groupMenu: null, // that group's restaurant (menu for the my-plate editor)
  groupCart: {}, // itemId -> qty — my picks in the open group
  groupStart: { restaurantId: '', mode: 'dinein', when: '60', whenTime: '' },
  // shops
  baskets: {}, // storeId -> { store, items } — one basket per shop, several at once
  basketsSheet: false, // the all-baskets sheet is open
  // stays
  staySearch: { city: 'All', checkIn: '', checkOut: '' },
  hotels: null,
  bookings: [],
  cities: [],
  // reviews
  listingReviews: null, // open restaurant: { id, list, rating, count }
  hotelReviews: {}, // hotelId -> { open, list, rating, count }
  orderReview: { id: '', stars: 0 }, // delivered order being reviewed
  stayReview: { id: '', stars: 0 }, // finished stay being reviewed
  // payments
  txns: [],
  payUi: null,
  payment: null,
  showPhoneEdit: false, // profile: re-open the OTP form to change a verified phone
  // tasks
  tasksBoard: [],
  myTasks: { posted: [], working: [] },
  showTaskForm: false,
  applyingTask: '', // board task whose application note is open
  _tasksKey: null,
  // activity
  rides: []
};

const TASK_CATEGORIES = [
  ['shopping', '🛒 Shopping'],
  ['cleaning', '🧹 Cleaning'],
  ['delivery', '📦 Delivery'],
  ['repair', '🔧 Repair'],
  ['other', '💼 Anything else']
];

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
  if (res.status === 401 && state.user) {
    doLogoutLocal();
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
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

function setUser(user) {
  if (user) state.user = user;
  const chip = $('#wallet-chip');
  if (chip && state.user) chip.textContent = '👛 ' + money(state.user.wallet);
}

function fmtDateTime(ts) {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ---------------- listing photo galleries ---------------- */

function photosOf(x) {
  if (Array.isArray(x.photos) && x.photos.length) return x.photos;
  return x.photo ? [x.photo] : [];
}

// Every gallery image carries its full photo set, so a tap opens the
// fullscreen viewer at that photo with the rest one swipe away.
function lightboxAttrs(urls, idx) {
  return `data-gallery="${esc(JSON.stringify(urls))}" data-idx="${idx}" onclick="openLightboxFrom(this)" role="button"`;
}

// Swipeable gallery: one photo = full-width cover; several = a snap-scroll
// strip you flick through like any listings app. Tap = fullscreen.
function photoStrip(urls, alt) {
  if (!urls.length) return '';
  if (urls.length === 1) {
    return `<img class="cover-img" src="${esc(urls[0])}" alt="${esc(alt)}" loading="lazy" ${lightboxAttrs(urls, 0)} />`;
  }
  return `
  <div class="photo-strip">
    ${urls.map((u, i) => `<img src="${esc(u)}" alt="${esc(alt)}" loading="lazy" ${lightboxAttrs(urls, i)} />`).join('')}
  </div>`;
}

// Small inline variant for menu items / room types. Tap = fullscreen too.
function thumbStrip(urls, alt) {
  if (!urls.length) return '';
  if (urls.length === 1) {
    return `<img class="thumb" src="${esc(urls[0])}" alt="${esc(alt)}" loading="lazy" ${lightboxAttrs(urls, 0)} />`;
  }
  return `
  <div class="thumb-strip">
    ${urls.map((u, i) => `<img src="${esc(u)}" alt="${esc(alt)}" loading="lazy" ${lightboxAttrs(urls, i)} />`).join('')}
  </div>`;
}

/* ---------------- reviews ---------------- */

function starRow(stars) {
  return '★'.repeat(stars) + '<span style="opacity:0.25">' + '★'.repeat(5 - stars) + '</span>';
}

function reviewList(list) {
  if (!list || !list.length) {
    return `<div class="muted small">No reviews yet — be the first after your visit.</div>`;
  }
  return list.map((r) => `
    <div class="review-row">
      <div class="row">
        <div><b>${esc(r.userName)}</b> <span class="review-stars">${starRow(r.stars)}</span></div>
        <span class="muted small">${new Date(r.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
      </div>
      ${r.text ? `<div class="muted small" style="margin-top:3px">“${esc(r.text)}”</div>` : ''}
    </div>`).join('');
}

/* Fullscreen viewer: native scroll-snap does the swiping, so it feels like
   the iOS Photos app. Lives outside #app so re-renders never close it. */
let lightboxEl = null;
function ensureLightbox() {
  if (lightboxEl) return lightboxEl;
  lightboxEl = document.createElement('div');
  lightboxEl.id = 'lightbox';
  lightboxEl.className = 'lightbox hidden';
  document.body.appendChild(lightboxEl);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });
  return lightboxEl;
}

window.openLightboxFrom = (el) => {
  try {
    openLightbox(JSON.parse(el.dataset.gallery), Number(el.dataset.idx) || 0);
  } catch (e) { /* malformed gallery — ignore the tap */ }
};

function openLightbox(urls, index) {
  if (!urls || !urls.length) return;
  const box = ensureLightbox();
  box.innerHTML = `
    <div class="lightbox-top">
      <span class="lightbox-count" id="lb-count">${index + 1} / ${urls.length}</span>
      <button class="lightbox-close" onclick="closeLightbox()" aria-label="Close">✕</button>
    </div>
    <div class="lightbox-track" id="lb-track">
      ${urls.map((u) => `
      <div class="lightbox-slide" onclick="if (event.target === this) closeLightbox()">
        <img src="${esc(u)}" alt="photo" />
      </div>`).join('')}
    </div>
    ${urls.length > 1 ? `<div class="lightbox-dots" id="lb-dots">
      ${urls.map((u, i) => `<span class="${i === index ? 'on' : ''}"></span>`).join('')}
    </div>` : ''}`;
  box.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  const track = $('#lb-track');
  // Jump to the tapped photo once the track has a size to measure.
  requestAnimationFrame(() => { track.scrollLeft = track.clientWidth * index; });
  track.addEventListener('scroll', () => {
    const i = Math.min(urls.length - 1, Math.max(0, Math.round(track.scrollLeft / track.clientWidth)));
    const count = $('#lb-count');
    if (count) count.textContent = `${i + 1} / ${urls.length}`;
    const dots = $('#lb-dots');
    if (dots) [...dots.children].forEach((d, n) => d.classList.toggle('on', n === i));
  }, { passive: true });
}

window.closeLightbox = () => {
  if (!lightboxEl || lightboxEl.classList.contains('hidden')) return;
  lightboxEl.classList.add('hidden');
  lightboxEl.innerHTML = '';
  document.body.style.overflow = '';
};

async function loadPlaces() {
  if (state.places.length) return;
  try {
    const data = await api('/api/places');
    state.places = data.places;
  } catch (e) { /* autocomplete is optional */ }
}

function stepper(steps, currentIdx) {
  return `<div class="stepper">${steps
    .map((s, i) => {
      const cls = i < currentIdx ? 'done' : i === currentIdx ? 'now' : '';
      return `<div class="step ${cls}"><div class="dot"></div><div class="lbl">${s}</div></div>`;
    })
    .join('')}</div>`;
}

/* ---------------- auth ---------------- */

function authView() {
  const isLogin = state.authMode === 'login';
  if (state.authMode === 'reset') {
    return `
    <div class="auth-wrap">
      <div class="auth-hero">
        <div class="logo">🔐</div>
        <h1>Reset password</h1>
        <p>${state.resetFromLink ? 'Your reset link is ready — just choose a new password.' : 'Get a reset token and choose a new password.'}</p>
      </div>
      <div class="card">
        ${state.resetFromLink ? '' : `
        <label class="field"><span>Email</span>
          <input id="reset-email" type="email" placeholder="you@example.com" />
        </label>
        <button class="btn" onclick="requestPasswordReset()">Send reset token</button>
        ${state.resetToken ? `<div class="muted small" style="margin-top:10px">Sandbox token: <b style="color:var(--text)">${esc(state.resetToken)}</b></div>` : ''}`}
        <div class="divider"></div>
        <label class="field"><span>Reset token</span>
          <input id="reset-token" value="${esc(state.resetToken)}" placeholder="Paste token" />
        </label>
        <label class="field"><span>New password</span>
          <input id="reset-password" type="password" placeholder="At least 6 characters" />
        </label>
        <button class="btn" onclick="completePasswordReset()">Change password</button>
        <button class="btn ghost" style="margin-top:8px" onclick="setAuthMode('login')">Back to login</button>
      </div>
    </div>`;
  }
  if (state.authMode === 'otp') {
    return `
    <div class="auth-wrap">
      <div class="auth-hero">
        <div class="logo">📲</div>
        <h1>Phone login</h1>
        <p>Use your mobile number to open SewaGo.</p>
      </div>
      <div class="card">
        <label class="field"><span>Mobile number</span>
          <input id="otp-phone" value="${esc(state.otpLogin.phone)}" placeholder="e.g. +9779841000000" autocomplete="tel" />
        </label>
        <button class="btn" onclick="requestCustomerOtpLogin()">Send code</button>
        ${state.otpLogin.devCode ? `<div class="muted small" style="margin-top:10px">Sandbox OTP: <b style="color:var(--text)">${esc(state.otpLogin.devCode)}</b></div>` : ''}
        <div class="divider"></div>
        <label class="field"><span>OTP code</span>
          <input id="otp-code" inputmode="numeric" placeholder="123456" autocomplete="one-time-code" />
        </label>
        <label class="field"><span>Name</span>
          <input id="otp-name" placeholder="Optional for new accounts" autocomplete="name" />
        </label>
        <label class="field"><span>Email</span>
          <input id="otp-email" type="email" placeholder="Optional" autocomplete="email" />
        </label>
        <button class="btn" onclick="verifyCustomerOtpLogin()">Continue</button>
        <button class="btn ghost" style="margin-top:8px" onclick="setAuthMode('login')">Back to email login</button>
      </div>
    </div>`;
  }
  return `
  <div class="auth-wrap">
    <div class="auth-hero">
      <img class="logo-img" src="/icon.svg" alt="SewaGo" />
      <h1>Sewa<em>Go</em></h1>
      <p>One app for getting around, eating well and sleeping easy.</p>
      <div class="auth-services">
        <span>🚗 <b>Rides</b></span><span>🍜 <b>Food</b></span><span>🏨 <b>Stays</b></span>
      </div>
    </div>
    <div class="card">
      ${isLogin ? '' : `
      <label class="field"><span>Full name</span>
        <input id="auth-name" placeholder="e.g. Milan Adhikari" autocomplete="name" />
      </label>
      <label class="field"><span>Phone</span>
        <input id="auth-phone" placeholder="e.g. 9841000000" autocomplete="tel" />
      </label>`}
      <label class="field"><span>Email</span>
        <input id="auth-email" type="email" placeholder="you@example.com" autocomplete="email" />
      </label>
      <label class="field"><span>Password</span>
        <input id="auth-password" type="password" placeholder="At least 6 characters" />
      </label>
      <button class="btn" onclick="submitAuth()">${isLogin ? 'Log in' : 'Create account'}</button>
      ${isLogin ? `<button class="btn ghost" style="margin-top:8px" onclick="setAuthMode('otp')">Log in with phone OTP</button>` : ''}
      <div style="text-align:center;margin-top:14px">
        <button class="link" onclick="toggleAuthMode()">
          ${isLogin ? "New here? Create an account" : 'Already have an account? Log in'}
        </button>
      </div>
      ${isLogin ? `<div style="text-align:center;margin-top:10px"><button class="link" onclick="setAuthMode('reset')">Forgot password?</button></div>` : ''}
    </div>
    ${isLogin && state.demo ? `
    <div class="card">
      <div class="muted small" style="line-height:1.8">
        <b style="color:var(--text)">Demo customers</b> (password: <b style="color:var(--text)">customer123</b>)<br/>
        aarav.demo@sewago.app · maya.demo@sewago.app · nisha.demo@sewago.app
      </div>
    </div>` : ''}
    <div style="text-align:center;margin-top:16px">
      <a class="link" href="/download">📱 Install SewaGo on your phone</a>
    </div>
    <div style="text-align:center;margin-top:10px">
      <a class="link" href="/driver">🛵 Drive with SewaGo — open the Driver app</a>
    </div>
    <div style="text-align:center;margin-top:10px">
      <a class="link" href="/partner">🏪 Own a restaurant or hotel? Partner portal</a>
    </div>
    <div class="muted small" style="text-align:center;margin-top:14px">
      By continuing you agree to the <a class="link" href="/terms">Terms</a> and
      <a class="link" href="/privacy">Privacy Policy</a>.
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
  if (mode !== 'reset') {
    state.resetToken = '';
    state.resetFromLink = false;
  }
  if (mode !== 'otp') state.otpLogin = { phone: '', devCode: '' };
  render();
};

async function completeCustomerAuth(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('sewago_token', data.token);
  toast(`Namaste, ${data.user.name.split(' ')[0]}! 🙏`);
  state.tab = 'home'; // fresh login lands on the launcher
  state.otpLogin = { phone: '', devCode: '' };
  await loadPlaces();
  connectEvents();
  render();
}

window.submitAuth = async () => {
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  try {
    let data;
    if (state.authMode === 'login') {
      data = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    } else {
      const name = $('#auth-name').value.trim();
      const phone = $('#auth-phone').value.trim();
      data = await api('/api/auth/register', { method: 'POST', body: { name, email, phone, password } });
    }
    await completeCustomerAuth(data);
  } catch (e) {
    toast(e.message, true);
  }
};

window.requestCustomerOtpLogin = async () => {
  try {
    const phone = $('#otp-phone').value.trim();
    const data = await api('/api/auth/otp/request', { method: 'POST', body: { phone } });
    state.otpLogin = { phone: data.phone || phone, devCode: data.devCode || '' };
    toast(data.message || 'Verification code sent.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.verifyCustomerOtpLogin = async () => {
  try {
    const data = await api('/api/auth/otp/verify', {
      method: 'POST',
      body: {
        phone: ($('#otp-phone').value || state.otpLogin.phone).trim(),
        code: $('#otp-code').value.trim(),
        name: $('#otp-name').value.trim(),
        email: $('#otp-email').value.trim()
      }
    });
    await completeCustomerAuth(data);
  } catch (e) {
    toast(e.message, true);
  }
};

window.requestPasswordReset = async () => {
  try {
    const data = await api('/api/auth/password/request-reset', {
      method: 'POST',
      body: { email: $('#reset-email').value.trim() }
    });
    state.resetToken = data.devResetToken || '';
    toast(data.message || 'If the account exists, reset instructions were sent.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.completePasswordReset = async () => {
  try {
    await api('/api/auth/password/reset', {
      method: 'POST',
      body: { token: $('#reset-token').value.trim(), password: $('#reset-password').value }
    });
    state.resetToken = '';
    state.resetFromLink = false;
    state.authMode = 'login';
    toast('Password changed. Log in with the new password.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

function doLogoutLocal() {
  disconnectEvents();
  state.token = null;
  state.user = null;
  state.activeRide = null;
  localStorage.removeItem('sewago_token');
  render();
}

window.doLogout = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  doLogoutLocal();
};

/* ---------------- shell ---------------- */

// Hub-and-spoke: these are the service pages launched from the Home grid
// (the ids double as `state.tab` values; `hint` is the tile's subtitle).
const TABS = [
  { id: 'rides', label: 'Rides', ico: '🚗', hint: 'Bike · car · parcel' },
  { id: 'shops', label: 'Shops', ico: '🏪', hint: 'Kirana near you' },
  { id: 'food', label: 'Food', ico: '🍜', hint: 'Restaurants' },
  { id: 'stays', label: 'Stays', ico: '🏨', hint: 'Hotels' },
  { id: 'tasks', label: 'Tasks', ico: '🧰', hint: 'Hire help' },
  { id: 'activity', label: 'Activity', ico: '🧾', hint: 'Trips & orders' },
  { id: 'profile', label: 'Profile', ico: '👤', hint: '' } // hint = live wallet balance
];

function render() {
  const app = $('#app');
  if (!state.user) {
    app.innerHTML = authView();
    return;
  }
  app.innerHTML = `
    <header class="topbar">
      ${state.tab !== 'home' ? `<button class="back-chip" onclick="setTab('home')" aria-label="Back to Home">←</button>` : ''}
      <div class="brand"><img class="brand-mark" src="/icon.svg" alt="" />Sewa<em>Go</em></div>
      <div class="wallet-chip" id="wallet-chip">👛 ${money(state.user.wallet)}</div>
    </header>
    <main id="view"></main>`;
  renderTab();
}

function renderTab() {
  const view = $('#view');
  // Glide-in only on real navigation (tab tap, menu open/close) — background
  // re-renders from polling/SSE must not replay the animation.
  if (state._pageAnim) {
    view.classList.add('page-enter');
    state._pageAnim = false;
  }
  if (state.tab === 'home') {
    view.innerHTML = homeView();
    return;
  }
  if (state.tab === 'rides') {
    view.innerHTML = ridesView();
    state._rideKey = rideKey();
    mountRideMap(state.activeRide);
    return;
  }
  if (state.tab === 'shops') view.innerHTML = shopsView();
  else if (state.tab === 'food') view.innerHTML = foodView();
  else if (state.tab === 'stays') view.innerHTML = staysView();
  else if (state.tab === 'tasks') view.innerHTML = tasksView();
  else if (state.tab === 'activity') view.innerHTML = activityView();
  else view.innerHTML = profileView();
}

/* ---------------- home launcher ---------------- */

// Counts render from whatever state is already loaded — homeView() itself never
// fetches. hydrateHome() below is what puts something there to read.
function homeActiveCounts() {
  // ORDER_DONE covers all three food endings: delivered (courier), completed
  // (collected at the counter) and cancelled — so in-flight pickup/eat-there
  // orders count on Home too.
  const food = (state.orders || []).filter((o) => !ORDER_DONE.includes(o.status)).length;
  const shop = (state.shopOrders || []).filter((o) => o.status !== 'delivered' && o.status !== 'cancelled').length;
  return { food, shop };
}

// One glass row per live thing (ride under way, food on the bike, shop order
// being packed) — a tap jumps straight into the service that owns it.
function homeCtxRow(tab, text) {
  return `
  <div class="card" style="cursor:pointer" onclick="setTab('${tab}')">
    <div class="row">
      <div class="grow" style="font-weight:700">${text}</div>
      <span style="color:var(--accent);font-weight:900">→</span>
    </div>
  </div>`;
}

// Home is the screen the app opens on, and it was the one screen that never
// loaded the orders it advertises: reopen the app with a shop order sitting
// packed and waiting at the counter and the launcher showed a bare grid — no
// row, no badge, nothing to tell the customer to go and collect it. Fetch the
// two lists in the background (never blocking the paint) and repaint if they
// turn out to say something.
let homeHydratedAt = 0;
async function hydrateHome({ force = false } = {}) {
  if (!state.user) return;
  if (!force && Date.now() - homeHydratedAt < 15000) return;
  homeHydratedAt = Date.now();
  try {
    const [food, shop] = await Promise.all([api('/api/orders'), api('/api/store-orders')]);
    state.orders = food.orders || state.orders;
    state.shopOrders = shop.orders || state.shopOrders;
    if (state.tab === 'home') render();
  } catch (e) {
    homeHydratedAt = 0; // a failed hydrate should not silence the next attempt
  }
}

function homeView() {
  const first = (state.user.name || '').split(' ')[0];
  const h = new Date().getHours();
  const daypart = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  const { food, shop } = homeActiveCounts();
  const ride = state.activeRide;
  const rideLive = ride && RIDE_STEP_IDX[ride.status] !== undefined && ride.status !== 'completed';
  const badges = { food, shops: shop };
  return `
  <div style="margin:2px 2px 16px">
    <div style="font-size:23px;font-weight:900;letter-spacing:-0.5px">Namaste, ${esc(first)} 🙏</div>
    <div class="muted small" style="margin-top:3px">Good ${daypart} — what do you need today?</div>
  </div>
  ${rideLive ? homeCtxRow('rides', `🚗 ${RIDE_STEPS[RIDE_STEP_IDX[ride.status]]} — your ride is live`) : ''}
  ${food ? homeCtxRow('food', `🍜 ${food} food order${food === 1 ? '' : 's'} in progress`) : ''}
  ${shop ? homeCtxRow('shops', `🏪 ${shop} shop order${shop === 1 ? '' : 's'} in progress`) : ''}
  <div class="home-grid" style="margin-top:${rideLive || food || shop ? 16 : 0}px">
    ${TABS.map((t) => `
    <button class="home-tile" onclick="setTab('${t.id}')">
      ${badges[t.id] ? `<span class="badge-dot">${badges[t.id]}</span>` : ''}
      <span class="ico">${t.ico}</span>
      <span class="lbl">${t.label}</span>
      <span class="hint">${t.id === 'profile' ? `Wallet · ${money(state.user.wallet)}` : t.hint}</span>
    </button>`).join('')}
  </div>`;
}

window.setTab = async (tab) => {
  const fromPop = state._popNav;
  state._popNav = false;
  // Hardware/browser back mirrors the ← chip, one level deep (Home ↔ service):
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
  localStorage.setItem('sewago_tab', tab); // reload lands back on the same tab
  state.restaurant = null;
  state.group = null;
  state.groupMenu = null;
  if (tab === 'home') {
    // Back on the launcher: close service sub-screens. The baskets survive —
    // they follow you until they're ordered or cleared.
    state.shop = null;
    state.basketsSheet = false;
    state.showGroupStart = false;
    state.showGroupJoin = false;
    state.showTaskForm = false;
    state.applyingTask = '';
    hydrateHome(); // in-flight rows are only as honest as the last fetch
  }
  try {
    if (tab === 'shops') {
      state.shop = null;
      state.basketsSheet = false;
      const [o] = await Promise.all([api('/api/store-orders'), refreshShops(), loadSubscriptions()]);
      state.shopOrders = o.orders || [];
    } else if (tab === 'food') {
      const [r, o, g] = await Promise.all([api('/api/restaurants'), api('/api/orders'), api('/api/group-orders')]);
      state.restaurants = r.restaurants;
      state.foodServiceFee = r.serviceFee || 0;
      state.deliveryFreeKm = r.deliveryFreeKm ?? 3;
      state.deliveryPerKm = r.deliveryPerKm ?? 15;
      state.deliveryMaxExtra = r.deliveryMaxExtra ?? 300;
      state.orders = o.orders;
      state.groups = g.groups || [];
    } else if (tab === 'stays') {
      const [b, c] = await Promise.all([api('/api/bookings'), api('/api/cities')]);
      state.bookings = b.bookings;
      state.cities = c.cities;
    } else if (tab === 'tasks') {
      await refreshTasks();
    } else if (tab === 'activity') {
      const [r, o, b] = await Promise.all([api('/api/rides'), api('/api/orders'), api('/api/bookings')]);
      state.rides = r.rides;
      state.orders = o.orders;
      state.bookings = b.bookings;
    } else if (tab === 'profile' || tab === 'rides') {
      const me = await api('/api/auth/me');
      setUser(me.user);
      if (tab === 'profile') await loadTxns();
    }
  } catch (e) {
    toast(e.message, true);
  }
  render();
};

/* ---------------- rides ---------------- */

const RIDE_STEPS = ['Finding driver', 'Driver on the way', 'On trip', 'Completed'];
const RIDE_STEP_IDX = { searching: 0, driver_en_route: 1, in_progress: 2, completed: 3 };

function ridesView() {
  return `
    <div class="section-title">Where to? 🗺️</div>
    <div id="ride-slot">${rideSlot()}</div>`;
}

function rideSlot() {
  const ride = state.activeRide;
  if (ride && ride.status !== 'cancelled') return activeRideCard(ride);
  if (state.fare) return fareCard();
  return rideForm();
}

function rideForm() {
  return `
  <div class="card">
    <label class="field"><span>Pickup</span>
      <div class="geo-field">
        <input id="pickup" autocomplete="off" placeholder="Search address or landmark" value="${esc(state.ridePickup)}"
          oninput="sgGeoInput('pickup', this.value)" onfocus="sgGeoInput('pickup', this.value)" />
        <button type="button" class="geo-gps" onclick="sgUseMyLocation()" title="Use my current location">📍</button>
        <div id="ac-pickup" class="geo-ac hidden"></div>
      </div>
    </label>
    <label class="field"><span>Dropoff</span>
      <div class="geo-field">
        <input id="dropoff" autocomplete="off" placeholder="Search address or landmark" value="${esc(state.rideDropoff)}"
          oninput="sgGeoInput('dropoff', this.value)" onfocus="sgGeoInput('dropoff', this.value)" />
        <div id="ac-dropoff" class="geo-ac hidden"></div>
      </div>
    </label>
    ${state.places.length ? `
    <div class="muted small" style="margin-bottom:8px">Popular places</div>
    <div class="chips">
      ${state.places.slice(0, 10).map((p) => `<button class="chip" onclick="pickPlace('${esc(p.name)}', ${p.lat}, ${p.lng})">${esc(p.name)}</button>`).join('')}
    </div>` : ''}
    <button class="btn" onclick="getFares()">See prices</button>
  </div>
  <div class="muted small" style="text-align:center">Real Kathmandu addresses · tap 📍 to use your GPS location</div>`;
}

// Popular-place chips carry exact coordinates, so treat them as GPS selections.
window.pickPlace = (name, lat, lng) => {
  const field = $('#pickup').value.trim() ? 'dropoff' : 'pickup';
  applyGeoSelection(field, { name, lat, lng });
};

// Debounced address search against the server-proxied geocoder.
const sgGeoTimers = {};
window.sgGeoInput = (field, value) => {
  if (field === 'pickup') { state.ridePickup = value; state.pickupSel = null; }
  else { state.rideDropoff = value; state.dropoffSel = null; }
  const box = document.getElementById('ac-' + field);
  const q = value.trim();
  clearTimeout(sgGeoTimers[field]);
  if (q.length < 2) { if (box) { box.classList.add('hidden'); box.innerHTML = ''; } return; }
  sgGeoTimers[field] = setTimeout(async () => {
    // Ignore stale responses if the user kept typing.
    if (($('#' + field) || {}).value !== value) return;
    try {
      const data = await api('/api/geo/search?q=' + encodeURIComponent(q));
      renderGeoResults(field, data.results || []);
    } catch (e) { /* search is best-effort */ }
  }, 320);
};

function renderGeoResults(field, results) {
  const box = document.getElementById('ac-' + field);
  if (!box) return;
  if (!results.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box._results = results;
  box.innerHTML = results
    .map((r, i) => `<button type="button" class="geo-opt" onclick="sgGeoPick('${field}', ${i})">📍 ${esc(r.name)}</button>`)
    .join('');
  box.classList.remove('hidden');
}

window.sgGeoPick = (field, idx) => {
  const box = document.getElementById('ac-' + field);
  const r = box && box._results && box._results[idx];
  if (r) applyGeoSelection(field, r);
};

function applyGeoSelection(field, place) {
  const sel = { name: place.name, lat: place.lat, lng: place.lng };
  if (field === 'pickup') { state.pickupSel = sel; state.ridePickup = sel.name; }
  else { state.dropoffSel = sel; state.rideDropoff = sel.name; }
  const input = $('#' + field);
  if (input) input.value = sel.name;
  const box = document.getElementById('ac-' + field);
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

window.sgUseMyLocation = () => {
  if (!navigator.geolocation) return toast('Location is not available on this device.', true);
  toast('Getting your GPS location…');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const data = await api('/api/geo/reverse?lat=' + pos.coords.latitude + '&lng=' + pos.coords.longitude);
      applyGeoSelection('pickup', data.place);
      toast('Pickup set to ' + data.place.name);
    } catch (e) { toast(e.message, true); }
  }, (err) => {
    toast(err.code === 1 ? 'Location permission denied — enable it to use GPS.' : 'Could not get your location.', true);
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
};

async function refreshActiveRide() {
  const prev = state.activeRide;
  const data = await api('/api/rides/active');
  state.activeRide = data.ride;
  if (data.user) setUser(data.user);
  // A live request that no driver accepted gets auto-cancelled and refunded.
  if (prev && data.ride && data.ride.id === prev.id &&
      data.ride.status === 'cancelled' && prev.status !== 'cancelled') {
    toast(data.ride.cancelReason === 'no_drivers'
      ? 'No drivers accepted in time — fare refunded to your wallet.'
      : 'Ride cancelled.', true);
    state.activeRide = null;
    render();
  }
}

window.getFares = async () => {
  const pickupText = $('#pickup').value.trim();
  const dropoffText = $('#dropoff').value.trim();
  state.ridePickup = pickupText;
  state.rideDropoff = dropoffText;
  if (!pickupText || !dropoffText) return toast('Enter both pickup and dropoff.', true);
  // Send exact coords when the text still matches a chosen place; else fall back
  // to free text that the server's gazetteer resolves.
  const pickup = state.pickupSel && state.pickupSel.name === pickupText ? state.pickupSel : pickupText;
  const dropoff = state.dropoffSel && state.dropoffSel.name === dropoffText ? state.dropoffSel : dropoffText;
  try {
    const data = await api('/api/rides/estimate', { method: 'POST', body: { pickup, dropoff } });
    state.fare = { pickup, dropoff, ...data };
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

function fareCard() {
  const f = state.fare;
  const exact = f.pickupPlace && f.pickupPlace.known && f.dropoffPlace.known;
  return `
  <div class="card">
    <div class="row"><div>
      <div><b>${esc(f.pickupPlace ? f.pickupPlace.name : f.pickup)}</b> → <b>${esc(f.dropoffPlace ? f.dropoffPlace.name : f.dropoff)}</b></div>
      <div class="muted small">${f.distanceKm} km via road · ${exact ? '📍 exact locations' : '≈ approximate spot'}</div>
    </div>
    <button class="btn ghost compact" onclick="clearFare()">Edit</button></div>
  </div>
  <div class="grid2" style="margin-bottom:10px">
    <button class="btn ${state.payMethod === 'wallet' ? '' : 'ghost'}" onclick="setPayMethod('wallet')">👛 Wallet</button>
    <button class="btn ${state.payMethod === 'cash' ? '' : 'ghost'}" onclick="setPayMethod('cash')">💵 Cash</button>
  </div>
  ${state.payMethod === 'cash' ? `<div class="muted small" style="text-align:center;margin-bottom:10px">Pay the driver directly when the trip ends — no wallet needed.</div>` : ''}
  ${state.parcelMode ? parcelForm(f) : `
  ${f.options.map((o) => `
    <div class="fare-option" onclick="bookRide('${o.tier}')">
      <span class="emoji">${o.icon}</span>
      <div>
        <div><b>${esc(o.label)}</b>${o.surge > 1 ? ` <span class="badge" style="background:#7c2d12;color:#fdba74">⚡ ${o.surge}× busy</span>` : ''}</div>
        <div class="muted small">${o.etaMin} min · ${o.seats} seat${o.seats > 1 ? 's' : ''} · ${
          o.liveDrivers > 0
            ? `<span style="color:var(--accent)">🟢 ${o.liveDrivers} live driver${o.liveDrivers > 1 ? 's' : ''} online</span>`
            : '🤖 demo driver'}</div>
      </div>
      <div class="price">${money(o.fare)}</div>
    </div>`).join('')}
  <div class="muted small" style="text-align:center">Tap a ride to book instantly${
    state.payMethod === 'wallet' && f.serviceFee ? ` · +${money(f.serviceFee)} service fee` : ''}</div>
  <button class="btn ghost" style="margin-top:10px" onclick="toggleParcelMode(true)">
    📦 Send a parcel instead — a bike courier delivers it (${money((f.options.find((o) => o.tier === 'bike') || {}).fare || 0)})
  </button>`}`;
}

window.clearFare = () => {
  state.fare = null;
  state.parcelMode = false;
  render();
};

/* ---------------- parcels ---------------- */

function parcelForm(f) {
  const bike = f.options.find((o) => o.tier === 'bike');
  return `
  <div class="card">
    <div style="font-weight:900;margin-bottom:4px">📦 Send a parcel</div>
    <div class="muted small" style="margin-bottom:10px">
      A bike courier picks it up at ${esc(f.pickupPlace ? f.pickupPlace.name : f.pickup)} and hands it
      to your receiver at ${esc(f.dropoffPlace ? f.dropoffPlace.name : f.dropoff)}.
    </div>
    <label class="field"><span>Receiver's name</span><input id="pk-name" placeholder="Who accepts it?" /></label>
    <label class="field"><span>Receiver's phone</span><input id="pk-phone" placeholder="e.g. 9841000000" /></label>
    <label class="field"><span>What are you sending?</span><input id="pk-note" placeholder="documents, keys, a gift…" /></label>
    <button class="btn" onclick="bookParcel()">Send parcel · ${money(bike ? bike.fare : 0)}${
      state.payMethod === 'wallet' && f.serviceFee ? ` + ${money(f.serviceFee)} fee` : ''}</button>
    <button class="btn ghost" style="margin-top:8px" onclick="toggleParcelMode(false)">← Back to rides</button>
  </div>`;
}

window.toggleParcelMode = (on) => {
  state.parcelMode = on;
  render();
};

window.bookParcel = async () => {
  try {
    const data = await api('/api/rides', {
      method: 'POST',
      body: {
        pickup: state.fare.pickup,
        dropoff: state.fare.dropoff,
        tier: 'bike',
        payment: state.payMethod,
        kind: 'parcel',
        recipient: { name: $('#pk-name').value.trim(), phone: $('#pk-phone').value.trim() },
        parcelNote: $('#pk-note').value.trim()
      }
    });
    state.activeRide = data.ride;
    state.fare = null;
    state.parcelMode = false;
    state.pendingStars = 0;
    setUser(data.user);
    toast('Parcel booked! Finding a courier…');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.setPayMethod = (method) => {
  state.payMethod = method;
  render();
};

window.boostFare = async (rideId, amount) => {
  try {
    const data = await api(`/api/rides/${rideId}/boost`, { method: 'POST', body: { amount } });
    state.activeRide = data.ride;
    setUser(data.user);
    toast(`Fare raised to ${money(data.ride.fare)} — asking drivers again 📡`);
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.bookRide = async (tier) => {
  try {
    const data = await api('/api/rides', {
      method: 'POST',
      body: { pickup: state.fare.pickup, dropoff: state.fare.dropoff, tier, payment: state.payMethod }
    });
    state.activeRide = data.ride;
    state.fare = null;
    state.pendingStars = 0;
    setUser(data.user);
    toast('Ride booked! Finding your driver…');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

function activeRideCard(ride) {
  const idx = RIDE_STEP_IDX[ride.status] ?? 0;
  const done = ride.status === 'completed';
  const d = ride.driver;
  return `
  <div class="card">
    <div class="row">
      <div>
        <div><b>${esc(ride.pickup)}</b> → <b>${esc(ride.dropoff)}</b></div>
        <div class="muted small">${esc(ride.tierLabel)} · ${ride.distanceKm} km · ${money(ride.fare)} · ${ride.payment === 'cash' ? '💵 cash' : '👛 wallet'}</div>
        ${ride.kind === 'parcel' && ride.recipient ? `<div class="muted small">📦 Hand to ${esc(ride.recipient.name)} (${esc(ride.recipient.phone)})</div>` : ''}
      </div>
      <span style="font-size:28px">${ride.icon}</span>
    </div>
    ${!done && ride.status !== 'cancelled' && ride.pickupLoc ? '<div id="ride-map" class="ride-map"></div>' : ''}
    ${stepper(RIDE_STEPS, idx)}
    ${ride.status === 'in_progress' ? `<div class="progress"><div id="trip-bar" style="width:${Math.round(ride.progress * 100)}%"></div></div>` : ''}
    <div class="divider"></div>
    ${ride.status === 'searching'
      ? `<div class="muted">${ride.mode === 'live'
          ? '📡 Requesting nearby drivers — waiting for one to accept…'
          : '🤖 No real driver is online right now — a simulated demo driver will run this trip.'}</div>
        ${ride.mode === 'live' ? `
        <div class="muted small" style="margin-top:10px">No driver yet? Raise the fare to attract one — current fare <b style="color:var(--text)">${money(ride.fare)}</b>${ride.fareBoost ? ` (includes +${money(ride.fareBoost)} boost)` : ''}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px">
          <button class="btn ghost" onclick="boostFare('${ride.id}', 20)">+ Rs 20</button>
          <button class="btn ghost" onclick="boostFare('${ride.id}', 50)">+ Rs 50</button>
          <button class="btn ghost" onclick="boostFare('${ride.id}', 100)">+ Rs 100</button>
        </div>` : ''}`
      : d ? `<div class="row">
          <div>
            <div><b>${esc(d.name)}</b> <span class="badge">★ ${d.rating}</span>
              ${ride.mode === 'live' ? '<span class="badge">🟢 LIVE</span>' : '<span class="badge gray">🤖 DEMO</span>'}</div>
            <div class="muted small">${esc(d.vehicle)} · ${esc(d.plate)}</div>
          </div>
        </div>` : ''}
    ${ride.status === 'driver_en_route' && ride.driverEtaMin
      ? `<div class="eta-line" id="eta-line">🕐 ${d ? esc(d.name.split(' ')[0]) : 'Driver'} arrives at ${esc(ride.pickup)} in ~${ride.driverEtaMin} min</div>` : ''}
    ${ride.status === 'in_progress'
      ? `<div class="eta-line" id="eta-line">🛣️ On the way to ${esc(ride.dropoff)}</div>` : ''}
    ${done ? `
      <div class="divider"></div>
      ${ride.rating
        ? `<div style="text-align:center">You rated this trip ${'⭐'.repeat(ride.rating)}</div>
           <button class="btn ghost" style="margin-top:10px" onclick="dismissRide()">Done</button>`
        : `<div style="text-align:center"><b>Trip finished — how was it?</b></div>
           <div class="stars">
             ${[1, 2, 3, 4, 5].map((n) => `<button class="${state.pendingStars >= n ? 'on' : ''}" onclick="pickStars(${n})">⭐</button>`).join('')}
           </div>
           <button class="btn" onclick="rateRide()" ${state.pendingStars ? '' : 'disabled'}>Submit rating</button>
           <button class="btn ghost" style="margin-top:8px" onclick="dismissRide()">Skip</button>`}
    ` : ''}
    ${ride.status === 'searching'
      ? `<button class="btn danger" style="margin-top:12px" onclick="cancelRide()">Cancel ride (full refund)</button>` : ''}
    ${ride.status === 'driver_en_route'
      ? (ride.mode === 'live' && ride.payment !== 'cash' && ride.lateCancelFee > 0
        ? `<button class="btn danger" style="margin-top:12px" onclick="cancelRide(${ride.lateCancelFee})">Cancel ride (Rs ${ride.lateCancelFee} fee — driver is on the way)</button>`
        : `<button class="btn danger" style="margin-top:12px" onclick="cancelRide()">Cancel ride (full refund)</button>`)
      : ''}
  </div>`;
}

/* ---------------- live map (Leaflet) ---------------- */

let rideMapRefs = null;

function emojiIcon(emoji, size) {
  return L.divIcon({
    html: `<div class="map-emoji" style="font-size:${size}px">${emoji}</div>`,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

function mountRideMap(ride) {
  rideMapRefs = null;
  if (typeof L === 'undefined' || !ride || !ride.pickupLoc) return;
  const el = document.getElementById('ride-map');
  if (!el) return;
  const map = L.map(el, { zoomControl: false });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap · © CARTO'
  }).addTo(map);
  const pk = [ride.pickupLoc.lat, ride.pickupLoc.lng];
  const dp = [ride.dropoffLoc.lat, ride.dropoffLoc.lng];
  L.marker(pk, { icon: emojiIcon('🟢', 16) }).addTo(map).bindTooltip('Pickup: ' + esc(ride.pickup));
  L.marker(dp, { icon: emojiIcon('🏁', 20) }).addTo(map).bindTooltip('Dropoff: ' + esc(ride.dropoff));
  // Straight dashed line until the road route arrives, then the real path.
  L.polyline([pk, dp], { color: '#22c55e', weight: 3, opacity: 0.3, dashArray: '6 8' }).addTo(map);
  let driverMarker = null;
  if (ride.driverCoords) {
    driverMarker = L.marker([ride.driverCoords.lat, ride.driverCoords.lng], { icon: emojiIcon(ride.icon || '🚗', 26) }).addTo(map);
  }
  const bounds = L.latLngBounds([pk, dp]);
  if (ride.driverCoords) bounds.extend([ride.driverCoords.lat, ride.driverCoords.lng]);
  map.fitBounds(bounds.pad(0.25));
  rideMapRefs = { map, driverMarker, icon: ride.icon || '🚗' };
  drawRideRoute(ride);
}

// Fetch the road-following path for the trip and draw it over the fallback
// line. Cached per pickup/dropoff pair; failures just keep the dashed line.
let rideRouteCache = { key: '', points: null };
async function drawRideRoute(ride) {
  const pk = ride.pickupLoc;
  const dp = ride.dropoffLoc;
  const key = `${pk.lat},${pk.lng};${dp.lat},${dp.lng}`;
  try {
    if (rideRouteCache.key !== key) {
      const data = await api(`/api/geo/route?fromLat=${pk.lat}&fromLng=${pk.lng}&toLat=${dp.lat}&toLng=${dp.lng}`);
      rideRouteCache = { key, points: data.route.points };
    }
    // The map may have been remounted while we awaited — draw on the live one.
    if (rideMapRefs && rideRouteCache.points) {
      L.polyline(rideRouteCache.points, {
        color: '#34d399', weight: 4, opacity: 0.8, lineCap: 'round', lineJoin: 'round'
      }).addTo(rideMapRefs.map);
    }
  } catch (e) { /* dashed fallback stays */ }
}

function updateRideMap(ride) {
  if (!rideMapRefs || !ride || !ride.driverCoords) return;
  const pos = [ride.driverCoords.lat, ride.driverCoords.lng];
  if (rideMapRefs.driverMarker) rideMapRefs.driverMarker.setLatLng(pos);
  else rideMapRefs.driverMarker = L.marker(pos, { icon: emojiIcon(rideMapRefs.icon, 26) }).addTo(rideMapRefs.map);
}

function rideKey() {
  const r = state.activeRide;
  // fare is part of the key so a boost rebuilds the searching card.
  return r ? r.id + ':' + r.status + ':' + r.fare : (state.fare ? 'fare' : 'form');
}

function etaLineText(ride) {
  if (ride.status === 'driver_en_route' && ride.driverEtaMin) {
    const first = ride.driver ? ride.driver.name.split(' ')[0] : 'Driver';
    return `🕐 ${first} arrives at ${ride.pickup} in ~${ride.driverEtaMin} min`;
  }
  if (ride.status === 'in_progress') return `🛣️ On the way to ${ride.dropoff}`;
  return '';
}

window.pickStars = (n) => {
  state.pendingStars = n;
  const slot = $('#ride-slot');
  if (slot) slot.innerHTML = rideSlot();
};

window.rateRide = async () => {
  try {
    const data = await api(`/api/rides/${state.activeRide.id}/rate`, { method: 'POST', body: { stars: state.pendingStars } });
    state.activeRide = data.ride;
    toast('Thanks for the feedback! ⭐');
    const slot = $('#ride-slot');
    if (slot) slot.innerHTML = rideSlot();
  } catch (e) {
    toast(e.message, true);
  }
};

window.dismissRide = () => {
  state.activeRide = null;
  state.pendingStars = 0;
  render();
};

window.cancelRide = async (fee) => {
  if (fee > 0 && !confirm(`Your driver is already on the way — a Rs ${fee} cancellation fee applies. Cancel anyway?`)) {
    return;
  }
  try {
    const wasCash = state.activeRide && state.activeRide.payment === 'cash';
    const data = await api(`/api/rides/${state.activeRide.id}/cancel`, { method: 'POST' });
    state.activeRide = null;
    setUser(data.user);
    toast(wasCash ? 'Ride cancelled.' : 'Ride cancelled — fare refunded to wallet.');
    render();
  } catch (e) {
    toast(e.message, true);
    refreshActiveRide().then(() => render()).catch(() => {});
  }
};

/* ---------------- food ---------------- */

const ORDER_STEPS = ['Placed', 'Preparing', 'On the way', 'Delivered'];
const ORDER_STEP_IDX = { placed: 0, preparing: 1, out_for_delivery: 2, delivered: 3 };
// Order-ahead (pickup / eat-there) walks a different path: no courier leg —
// the customer collects at the counter with a code.
const AHEAD_STEPS = ['Sent', 'Cooking', 'Ready for you', 'Enjoy!'];
const AHEAD_STEP_IDX = { placed: 0, preparing: 1, ready: 2, completed: 3 };
// Terminal food statuses across all modes: courier delivered, counter
// collected, or cancelled.
const ORDER_DONE = ['delivered', 'completed', 'cancelled'];

// "7:30 PM" for today, "Aug 6, 7:30 PM" otherwise — order-ahead times read the
// way people say them.
function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtWhen(ts) {
  if (!ts) return 'ASAP';
  return new Date(ts).toDateString() === new Date().toDateString() ? fmtClock(ts) : fmtDateTime(ts);
}

// Turn a when-choice ('asap' | minutes-from-now | 'custom' + HH:MM) into a
// timestamp: null = ASAP, undefined = custom with nothing picked yet. A custom
// clock time already behind us means tomorrow.
function whenToTimestamp(when, timeStr) {
  if (when === 'asap') return null;
  if (when !== 'custom') return Date.now() + Number(when) * 60 * 1000;
  if (!timeStr) return undefined;
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() < Date.now() - 60 * 1000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function foodView() {
  if (state.restaurant) return menuView();
  if (state.group) return groupScreen();
  return `
    <div id="orders-slot">${ordersSlot()}</div>
    ${eatTogetherSection()}
    <div class="section-title">Hungry? Order in 🍜</div>
    ${state.restaurants.map((r) => `
      <div class="tile" onclick="openRestaurant('${r.id}')">
        ${r.photo ? `<img class="tile-photo" src="${esc(r.photo)}" alt="${esc(r.name)}" loading="lazy" />` : `<span class="emoji">${r.icon}</span>`}
        <div>
          <h3>${esc(r.name)}${r.promotedUntil > Date.now() ? ' <span class="badge" style="background:#713f12;color:#fde68a">⭐ Featured</span>' : ''}</h3>
          <div class="sub">${esc(r.cuisine)} · ${r.etaMinutes} min · ${money(r.deliveryFee)} delivery</div>
          ${r.groupDiscount ? `<div class="sub" style="color:var(--accent)">👥 ${r.groupDiscount.pct}% group discount</div>` : ''}
        </div>
        <div class="right"><span class="badge">${r.rating ? '★ ' + r.rating : 'NEW'}</span></div>
      </div>`).join('')}`;
}

function ordersSlot() {
  // Fresh deliveries (and counter collections) stay on screen until rated (or
  // skipped) — one tap keeps restaurant ratings honest without nagging.
  const active = state.orders.filter((o) =>
    !ORDER_DONE.includes(o.status) ||
    ((o.status === 'delivered' || o.status === 'completed') && !o.ratingStars && !state.dismissedOrders[o.id] &&
      Date.now() - (o.deliveredAt || o.collectedAt || 0) < 60 * 60 * 1000));
  if (active.length === 0) return '';
  return `<div class="section-title">Your orders, live 🔴</div>` + active.map((o) => {
    // Order-ahead cards walk the counter steps; delivery cards are unchanged.
    const ahead = o.mode === 'pickup' || o.mode === 'dinein';
    const idx = (ahead ? AHEAD_STEP_IDX : ORDER_STEP_IDX)[o.status] ?? 0;
    const done = o.status === 'delivered' || o.status === 'completed';
    return `
    <div class="card">
      <div class="row">
        <div>
          <div><b>${o.restaurantIcon} ${esc(o.restaurantName)}</b>${
            ahead ? ` <span class="badge">${o.mode === 'pickup' ? '🥡 PICKUP' : '🍽️ EAT THERE'}</span>` : ''}${
            o.group ? ` <span class="badge green">👥 × ${o.group.size}</span>` : ''}</div>
          <div class="muted small">${o.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}</div>
          ${o.scheduledFor ? `<div class="muted small">⏰ for ${fmtWhen(o.scheduledFor)}</div>` : ''}
        </div>
        <div style="text-align:right">
          <b>${money(o.total)}</b>
          ${o.payment === 'cash' ? `<div class="muted small">💵 cash on delivery</div>` : ''}
        </div>
      </div>
      ${o.payment === 'cash' && !ORDER_DONE.includes(o.status)
        ? `<div class="muted small" style="margin:8px 0;color:#fbbf24">💵 Have ${money(o.total)} in cash ready for the courier.</div>` : ''}
      ${o.fulfillment === 'live' && o.status === 'placed'
        ? `<div class="muted small" style="margin:8px 0">🕐 Waiting for ${esc(o.restaurantName)} to confirm your order…</div>` : ''}
      ${stepper(ahead ? AHEAD_STEPS : ORDER_STEPS, idx)}
      ${ahead && !done && o.status !== 'cancelled' && o.collectCode ? `
      <div class="code-card">
        <div class="muted small">Show this at the counter</div>
        <div class="code">${esc(o.collectCode)}</div>
      </div>` : ''}
      ${o.courier ? `<div class="muted small" style="margin-top:8px">🛵 ${esc(o.courier.name)} is your courier · ${esc(o.courier.vehicle)} (${esc(o.courier.plate)})</div>` : ''}
      ${o.deliveryLoc ? `<div class="muted small" style="margin-top:4px">📍 Delivering to ${esc(o.deliveryLoc.name)}</div>` : ''}
      ${o.status === 'placed' ? `<button class="btn danger" style="margin-top:12px" onclick="cancelOrder('${o.id}')">Cancel order</button>` : ''}
      ${done && !o.ratingStars ? `
      <div class="divider"></div>
      <div style="text-align:center"><b>How was the food?</b></div>
      <div class="stars">
        ${[1, 2, 3, 4, 5].map((n) => `<button class="${state.orderReview.id === o.id && state.orderReview.stars >= n ? 'on' : ''}" onclick="pickOrderStars('${o.id}', ${n})">⭐</button>`).join('')}
      </div>
      ${state.orderReview.id === o.id ? `
      <label class="field"><span>Tell others how it was (optional)</span>
        <input id="order-review-text" maxlength="300" placeholder="e.g. Momos arrived hot, would order again" />
      </label>
      <button class="btn" onclick="rateOrder('${o.id}')">Submit review</button>` : ''}
      <button class="btn ghost" style="margin-top:6px" onclick="dismissOrderRating('${o.id}')">Skip</button>` : ''}
    </div>`;
  }).join('');
}

window.pickOrderStars = (id, stars) => {
  const keepText = state.orderReview.id === id ? ($('#order-review-text') || {}).value || '' : '';
  state.orderReview = { id, stars };
  render();
  const input = $('#order-review-text');
  if (input) input.value = keepText;
};

window.rateOrder = async (id) => {
  const { stars } = state.orderReview;
  if (!stars) return toast('Pick a star rating first.', true);
  try {
    const textEl = $('#order-review-text');
    await api(`/api/orders/${id}/rate`, { method: 'POST', body: { stars, text: textEl ? textEl.value.trim() : '' } });
    const order = state.orders.find((o) => o.id === id);
    if (order) order.ratingStars = stars;
    state.orderReview = { id: '', stars: 0 };
    toast('Thanks — your review helps other customers! ' + '⭐'.repeat(stars));
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.dismissOrderRating = (id) => {
  state.dismissedOrders[id] = true;
  render();
};

window.openRestaurant = (id) => {
  state.restaurant = state.restaurants.find((r) => r.id === id);
  state.cart = {};
  state.deliverTo = '';
  state.deliverToLoc = null;
  state.foodMode = 'delivery';
  state.foodWhen = 'asap';
  state.foodWhenTime = '';
  state.listingReviews = null;
  state._pageAnim = true;
  // Reviews load alongside the menu; the card fills in when they arrive.
  api(`/api/restaurants/${id}/reviews`).then((data) => {
    if (state.restaurant && state.restaurant.id === id) {
      state.listingReviews = { id, list: data.reviews, rating: data.rating, count: data.ratingCount };
      render();
    }
  }).catch(() => {});
  render();
};

// GPS → delivery address, reusing the same reverse-geocode the ride picker uses.
window.useGpsForDelivery = () => {
  if (!navigator.geolocation) return toast('GPS is not available on this device.', true);
  toast('Getting your location…');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const data = await api('/api/geo/reverse?lat=' + pos.coords.latitude + '&lng=' + pos.coords.longitude);
      state.deliverToLoc = data.place;
      state.deliverTo = data.place.name;
      toast(`Delivering to ${data.place.name} 📍`);
      render();
    } catch (e) {
      toast(e.message, true);
    }
  }, () => toast('Could not get your location — type the area instead.', true), { enableHighAccuracy: true, timeout: 10000 });
};

window.closeMenu = () => {
  state.restaurant = null;
  state._pageAnim = true;
  render();
};

// Same formula the server applies at checkout (fees.js deliveryFeeFor), so the
// preview matches the charge whenever the delivery point is resolvable.
function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function resolvedDeliveryPoint() {
  if (state.deliverToLoc) return state.deliverToLoc;
  const typedEl = $('#deliver-to');
  const typed = (typedEl ? typedEl.value : state.deliverTo || '').trim().toLowerCase();
  if (!typed) return null;
  return (state.places || []).find((p) => p.name.toLowerCase() === typed) || null;
}

function estimatedDeliveryFee(r) {
  const base = r.deliveryFee || 0;
  if (!r.ownerId || !r.loc) return { fee: base, exact: true };
  const point = resolvedDeliveryPoint();
  if (!point) return { fee: base, exact: false }; // final fee fixed at checkout
  const km = Math.round(haversineKm(r.loc, point) * 1.3 * 10) / 10;
  const extraKm = Math.max(0, Math.ceil(km - (state.deliveryFreeKm ?? 3)));
  return { fee: base + Math.min(state.deliveryMaxExtra ?? 300, extraKm * (state.deliveryPerKm ?? 15)), exact: true };
}

// Order-ahead only works at partner kitchens — sim restaurants have no counter.
function activeFoodMode() {
  return state.restaurant && state.restaurant.ownerId ? state.foodMode : 'delivery';
}

function cartTotals() {
  const r = state.restaurant;
  let count = 0;
  let subtotal = 0;
  for (const [id, qty] of Object.entries(state.cart)) {
    const item = r.menu.find((m) => m.id === id);
    if (item && qty > 0) {
      count += qty;
      subtotal += item.price * qty;
    }
  }
  // Order-ahead has no courier leg: no delivery fee, no service fee — the food
  // is the whole bill (mirrors the server exactly).
  if (activeFoodMode() !== 'delivery') {
    return { count, subtotal, serviceFee: 0, deliveryFee: 0, deliveryExact: true, total: subtotal };
  }
  const serviceFee = state.foodServiceFee || 0;
  const delivery = estimatedDeliveryFee(r);
  return { count, subtotal, serviceFee, deliveryFee: delivery.fee, deliveryExact: delivery.exact, total: subtotal + delivery.fee + serviceFee };
}

function menuView() {
  const r = state.restaurant;
  const mode = activeFoodMode();
  const { count, total, deliveryFee, deliveryExact } = cartTotals();
  // The order-ahead clock, for the place button ("· eat there at 7:30 PM").
  const when = whenToTimestamp(state.foodWhen, state.foodWhenTime);
  const whenLabel = when === undefined ? 'at …' : when === null ? 'ASAP' : `at ${fmtClock(when)}`;
  return `
  <div class="row" style="margin-bottom:14px">
    <button class="btn ghost compact" onclick="closeMenu()">← Back</button>
    <span class="badge">${r.rating ? '★ ' + r.rating : 'NEW'} · ${r.etaMinutes} min</span>
  </div>
  <div class="card">
    ${photoStrip(photosOf(r), r.name)}
    <div class="row">
      <div>
        <div style="font-size:19px;font-weight:900">${r.icon} ${esc(r.name)}</div>
        <div class="muted small">${esc(r.cuisine)} · delivery ${money(r.deliveryFee)}</div>
      </div>
    </div>
  </div>
  ${state.listingReviews && state.listingReviews.id === r.id ? `
  <div class="card">
    <div style="font-weight:900;margin-bottom:8px">Reviews ${state.listingReviews.rating
      ? `<span class="badge">★ ${state.listingReviews.rating}</span> <span class="muted small">${state.listingReviews.count} rating${state.listingReviews.count === 1 ? '' : 's'}</span>`
      : '<span class="badge gray">NEW</span>'}</div>
    ${reviewList(state.listingReviews.list)}
    <div class="muted small" style="margin-top:8px">✍️ Only customers who received an order here can review it.</div>
  </div>` : ''}
  ${r.menu.map((m) => {
    const qty = state.cart[m.id] || 0;
    const mPhotos = photosOf(m);
    return `
    <div class="card">
      <div class="row">
        ${mPhotos.length === 1 ? thumbStrip(mPhotos, m.name) : ''}
        <div class="grow">
          <div><b>${esc(m.name)}</b></div>
          <div class="muted small">${esc(m.desc)}</div>
          <div style="margin-top:6px;font-weight:800">${money(m.price)}</div>
        </div>
        <div class="qty">
          ${qty > 0 ? `<button onclick="cartAdd('${m.id}', -1)">−</button><span class="n">${qty}</span>` : ''}
          <button onclick="cartAdd('${m.id}', 1)">+</button>
        </div>
      </div>
      ${mPhotos.length > 1 ? thumbStrip(mPhotos, m.name) : ''}
    </div>`;
  }).join('')}
  ${r.ownerId && count > 0 ? `
  <div class="card">
    <div class="pipe-tabs">
      <button class="${mode === 'delivery' ? 'active' : ''}" onclick="setFoodMode('delivery')">🛵 Deliver</button>
      <button class="${mode === 'pickup' ? 'active' : ''}" onclick="setFoodMode('pickup')">🥡 Pickup</button>
      <button class="${mode === 'dinein' ? 'active' : ''}" onclick="setFoodMode('dinein')">🍽️ Eat there</button>
    </div>
    ${mode === 'delivery' ? `
    <label class="field"><span>Deliver to</span>
      <input id="deliver-to" list="deliver-places" value="${esc(state.deliverTo || '')}"
        placeholder="e.g. Thamel, New Baneshwor…" oninput="deliveryAddressTyped()" onchange="deliveryAddressChosen()" />
    </label>
    <datalist id="deliver-places">${(state.places || []).map((p) => `<option value="${esc(p.name)}"></option>`).join('')}</datalist>
    <button class="btn ghost compact" onclick="useGpsForDelivery()">📍 Use my location</button>
    <div class="section-title" style="margin:14px 0 8px">How do you want to pay?</div>
    <div class="grid2">
      <button class="btn ${state.foodPayMethod === 'wallet' ? '' : 'ghost'}" onclick="setFoodPayMethod('wallet')">👛 Wallet</button>
      <button class="btn ${state.foodPayMethod === 'cash' ? '' : 'ghost'}" onclick="setFoodPayMethod('cash')">💵 Cash on delivery</button>
    </div>
    ${state.foodPayMethod === 'cash'
      ? `<div class="muted small" style="text-align:center;margin-top:8px">Pay the courier at your door — no wallet top-up needed.</div>`
      : `<div class="muted small" style="text-align:center;margin-top:8px">Paid from your wallet balance now.</div>`}` : `
    <div class="muted small" style="margin-bottom:8px">When should it be ready?</div>
    <div class="chips" style="margin-bottom:0">
      <button class="chip ${state.foodWhen === 'asap' ? 'on' : ''}" onclick="setFoodWhen('asap')">ASAP</button>
      <button class="chip ${state.foodWhen === '30' ? 'on' : ''}" onclick="setFoodWhen('30')">+30 min</button>
      <button class="chip ${state.foodWhen === '60' ? 'on' : ''}" onclick="setFoodWhen('60')">+1 hr</button>
      <button class="chip ${state.foodWhen === 'custom' ? 'on' : ''}" onclick="setFoodWhen('custom')">Pick a time</button>
      ${state.foodWhen === 'custom' ? `<input type="time" id="food-when-time" value="${esc(state.foodWhenTime)}"
        onchange="foodTimePicked(this.value)" style="width:auto;padding:6px 10px" />` : ''}
    </div>
    <div class="muted small" style="margin-top:10px">👛 Pay now — show your code at the counter and it's ready when you arrive.</div>`}
  </div>` : ''}
  <!-- Clearance for the fixed cart bar, which wraps to two lines with the fee
       breakdown — too little and it covers the payment picker above it. -->
  <div style="height:${count > 0 ? 170 : 70}px"></div>
  ${count > 0 ? `
  <div class="cartbar">
    <button class="btn" onclick="placeOrder()">
      ${mode === 'delivery' ? `Place order · ${count} item${count > 1 ? 's' : ''} · ${money(total)}
      <span class="small" style="font-weight:600">(incl. ${money(deliveryFee)}${deliveryExact ? '' : '+'} delivery${
        state.foodServiceFee ? ` + ${money(state.foodServiceFee)} service fee` : ''})</span>`
      : `Pay ${money(total)} · ${mode === 'pickup' ? 'pickup' : 'eat there'} ${whenLabel}`}
    </button>
  </div>` : ''}`;
}

window.setFoodPayMethod = (method) => {
  state.foodPayMethod = method;
  render();
};

window.setFoodMode = (mode) => {
  state.foodMode = mode;
  render();
};

window.setFoodWhen = (when) => {
  state.foodWhen = when;
  render();
};

window.foodTimePicked = (value) => {
  state.foodWhenTime = value;
  render();
};

window.cartAdd = (id, delta) => {
  const next = (state.cart[id] || 0) + delta;
  if (next <= 0) delete state.cart[id];
  else state.cart[id] = Math.min(20, next);
  render();
};

// Typing an address by hand invalidates a previous GPS pin.
window.deliveryAddressTyped = () => {
  state.deliverToLoc = null;
};

// Once an address is chosen (blur / datalist pick), refresh the cart so the
// distance-based delivery fee preview updates.
window.deliveryAddressChosen = () => {
  const el = $('#deliver-to');
  if (el) state.deliverTo = el.value;
  render();
};

window.placeOrder = async () => {
  const items = Object.entries(state.cart).map(([id, qty]) => ({ id, qty }));
  const mode = activeFoodMode();
  const body = { restaurantId: state.restaurant.id, items, mode };
  if (mode === 'delivery') {
    const addressInput = $('#deliver-to');
    const typed = addressInput ? addressInput.value.trim() : '';
    if (state.restaurant.ownerId && !typed && !state.deliverToLoc) {
      return toast('Add a delivery location so the courier knows where to go.', true);
    }
    body.deliveryTo = state.deliverToLoc && state.deliverToLoc.name === typed ? state.deliverToLoc : typed;
    // Only partner restaurants can be COD (a real courier collects the cash).
    body.payment = state.restaurant.ownerId ? state.foodPayMethod : 'wallet';
  } else {
    // Order-ahead is prepaid from the wallet — that's what lets the kitchen start.
    body.payment = 'wallet';
    const scheduledFor = whenToTimestamp(state.foodWhen, state.foodWhenTime);
    if (scheduledFor === undefined) return toast('Pick a time, or choose ASAP.', true);
    if (scheduledFor) body.scheduledFor = scheduledFor;
  }
  try {
    const data = await api('/api/orders', { method: 'POST', body });
    setUser(data.user);
    const placed = data.order;
    state.restaurant = null;
    state.cart = {};
    const o = await api('/api/orders');
    state.orders = o.orders;
    toast(mode === 'delivery'
      ? 'Order placed! The kitchen is on it 👨‍🍳'
      : `Paid ✓ — show code ${placed.collectCode} at the counter`);
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.cancelOrder = async (id) => {
  try {
    const data = await api(`/api/orders/${id}/cancel`, { method: 'POST' });
    setUser(data.user);
    const o = await api('/api/orders');
    state.orders = o.orders;
    toast('Order cancelled — amount refunded.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- group orders (eat together) ---------------- */
/* A group is a lobby: the host opens it at a partner restaurant for a pickup
   or eat-there time, friends join with a 6-digit code, everyone picks their
   own plate and confirms, and the host places ONE order — each wallet pays its
   own (discounted) share at that moment. SSE topic 'group' keeps every
   member's screen live. */

// Swap in a fresh server view of a group everywhere we hold one.
function applyGroupUpdate(g) {
  const groups = state.groups || [];
  state.groups = groups.some((x) => x.id === g.id)
    ? groups.map((x) => (x.id === g.id ? g : x))
    : [g, ...groups];
  if (state.group && state.group.id === g.id) state.group = g;
}

function eatTogetherSection() {
  const groups = state.groups || [];
  return `
  <div class="section-title">Eat together 👥</div>
  ${groups.map(groupRowCard).join('')}
  <div class="card">
    <div class="grid2">
      <button class="btn ${state.showGroupStart ? '' : 'ghost'} compact" onclick="toggleGroupStart()">👥 Start a group order</button>
      <button class="btn ${state.showGroupJoin ? '' : 'ghost'} compact" onclick="toggleGroupJoin()">🔢 Join with a code</button>
    </div>
    ${state.showGroupStart ? groupStartForm() : ''}
    ${state.showGroupJoin ? `
    <div class="inline-form">
      <span>Type the 6-digit code your host shared</span>
      <input id="join-code" inputmode="numeric" maxlength="6" placeholder="123456" />
      <button class="btn" onclick="joinGroup()">Join</button>
    </div>` : ''}
    ${!groups.length && !state.showGroupStart && !state.showGroupJoin
      ? `<div class="muted small" style="margin-top:10px">Order together, split the bill automatically — and unlock group discounts.</div>` : ''}
  </div>`;
}

function groupRowCard(g) {
  const saved = g.currentPct
    ? `<span style="color:var(--accent)">💚 saving ${money(g.savings)}</span>`
    : g.needMore && g.status === 'open'
      ? `${g.needMore.people} more for ${g.needMore.pct}% off`
      : '';
  return `
  <div class="card" style="cursor:pointer" onclick="openGroup('${g.id}')">
    <div class="row">
      <div class="grow">
        <div style="font-weight:800">${g.restaurantIcon} ${esc(g.restaurantName)}</div>
        <div class="muted small">${g.mode === 'dinein' ? '🍽️ eat there' : '🥡 pickup'} · ${fmtWhen(g.scheduledFor)} ·
          ${g.members.length} ${g.members.length === 1 ? 'person' : 'people'}${saved ? ' · ' + saved : ''}</div>
      </div>
      ${g.status === 'open' ? '<span class="badge amber">OPEN</span>' : '<span class="badge">PLACED</span>'}
    </div>
  </div>`;
}

function groupStartForm() {
  const live = state.restaurants.filter((r) => r.ownerId);
  if (!live.length) return `<div class="muted small" style="margin-top:10px">No partner restaurants take group orders yet.</div>`;
  const gs = state.groupStart;
  return `
  <div style="margin-top:12px">
    <label class="field"><span>Where are you eating?</span>
      <select id="gs-restaurant" onchange="groupStartChanged()">
        ${live.map((r) => `<option value="${r.id}" ${gs.restaurantId === r.id ? 'selected' : ''}>${r.icon} ${esc(r.name)}${
          r.groupDiscount ? ` — 👥 ${r.groupDiscount.pct}% off for ${r.groupDiscount.minPeople}+` : ''}</option>`).join('')}
      </select>
    </label>
    <div class="pipe-tabs">
      <button class="${gs.mode === 'pickup' ? 'active' : ''}" onclick="setGroupStartMode('pickup')">🥡 Pickup</button>
      <button class="${gs.mode === 'dinein' ? 'active' : ''}" onclick="setGroupStartMode('dinein')">🍽️ Eat there</button>
    </div>
    <div class="muted small" style="margin-bottom:8px">When? At least 30 minutes from now, so friends have time to join.</div>
    <div class="chips">
      <button class="chip ${gs.when === '60' ? 'on' : ''}" onclick="setGroupStartWhen('60')">In 1 hour</button>
      <button class="chip ${gs.when === '120' ? 'on' : ''}" onclick="setGroupStartWhen('120')">In 2 hours</button>
      <button class="chip ${gs.when === 'custom' ? 'on' : ''}" onclick="setGroupStartWhen('custom')">Pick a time</button>
      ${gs.when === 'custom' ? `<input type="time" id="gs-time" value="${esc(gs.whenTime)}"
        onchange="groupStartTimePicked(this.value)" style="width:auto;padding:6px 10px" />` : ''}
    </div>
    <button class="btn" onclick="startGroup()">Open the group — friends join with your code</button>
  </div>`;
}

window.toggleGroupStart = () => {
  state.showGroupStart = !state.showGroupStart;
  state.showGroupJoin = false;
  render();
};

window.toggleGroupJoin = () => {
  state.showGroupJoin = !state.showGroupJoin;
  state.showGroupStart = false;
  render();
};

// No render — a re-render would rebuild the select mid-tap. The choice is
// re-applied via the `selected` attr whenever something else re-renders.
window.groupStartChanged = () => {
  state.groupStart.restaurantId = ($('#gs-restaurant') || {}).value || '';
};

window.setGroupStartMode = (mode) => {
  state.groupStart.mode = mode;
  render();
};

window.setGroupStartWhen = (when) => {
  state.groupStart.when = when;
  render();
};

window.groupStartTimePicked = (value) => {
  state.groupStart.whenTime = value;
  render();
};

window.startGroup = async () => {
  const gs = state.groupStart;
  const sel = $('#gs-restaurant');
  const scheduledFor = whenToTimestamp(gs.when, gs.whenTime);
  if (scheduledFor === undefined || scheduledFor === null) return toast('Pick a time first.', true);
  try {
    const data = await api('/api/group-orders', {
      method: 'POST',
      body: { restaurantId: sel ? sel.value : gs.restaurantId, mode: gs.mode, scheduledFor }
    });
    state.showGroupStart = false;
    applyGroupUpdate(data.group);
    openGroup(data.group.id);
    toast('Group open — share the code so friends can join 👥');
  } catch (e) {
    toast(e.message, true);
  }
};

window.joinGroup = async () => {
  const code = (($('#join-code') || {}).value || '').trim();
  try {
    const data = await api('/api/group-orders/join', { method: 'POST', body: { code } });
    state.showGroupJoin = false;
    applyGroupUpdate(data.group);
    openGroup(data.group.id);
    toast(`You're in — ${data.group.restaurantName} with ${data.group.hostName} 🎉`);
  } catch (e) {
    toast(e.message, true);
  }
};

window.openGroup = (id) => {
  const g = (state.groups || []).find((x) => x.id === id);
  if (!g) return;
  state.group = g;
  state.groupCart = {};
  for (const line of g.myItems || []) state.groupCart[line.id] = line.qty;
  state.groupPlaceArm = false;
  state._pageAnim = true;
  // The menu powers the my-plate editor; the screen fills in when it arrives.
  state.groupMenu = null;
  api(`/api/restaurants/${g.restaurantId}`).then((data) => {
    if (state.group && state.group.restaurantId === data.restaurant.id) {
      state.groupMenu = data.restaurant;
      render();
    }
  }).catch(() => {});
  render();
};

window.closeGroup = () => {
  state.group = null;
  state.groupMenu = null;
  state._pageAnim = true;
  render();
};

// The lobby: full-screen takeover like a shop front. Everyone sees the same
// header / code / members; the middle is MY plate; the host holds the trigger.
// After place it becomes the shared collect-code screen.
function groupScreen() {
  const g = state.group;
  const isHost = g.hostUserId === state.user.id;
  const open = g.status === 'open';
  const menu = state.groupMenu;
  const myCount = Object.values(state.groupCart).reduce((n, q) => n + q, 0);
  const mySubtotal = menu
    ? Object.entries(state.groupCart).reduce((sum, [id, qty]) => {
      const item = menu.menu.find((m) => m.id === id);
      return sum + (item ? item.price * qty : 0);
    }, 0)
    : ((g.members.find((m) => m.userId === state.user.id) || {}).subtotal || 0);
  return `
  <div class="row" style="margin-bottom:14px">
    <button class="btn ghost compact" onclick="closeGroup()">← Food</button>
    ${open ? '<span class="badge amber">OPEN — friends can join</span>' : '<span class="badge">PLACED</span>'}
  </div>
  <div class="card">
    <div style="font-size:19px;font-weight:900">${g.restaurantIcon} ${esc(g.restaurantName)}</div>
    <div class="muted small" style="margin-top:2px">${g.mode === 'dinein' ? '🍽️ Eat there' : '🥡 Pickup'} ·
      ${fmtWhen(g.scheduledFor)} · hosted by ${isHost ? 'you' : esc(g.hostName)}</div>
    ${open ? `
    <div class="code-card">
      <div class="muted small">Share this code with friends</div>
      <div class="code">${esc(g.code)}</div>
      <div class="muted small">They tap "Join with a code" on their Food tab</div>
    </div>` : ''}
    ${g.discount ? (g.currentPct
      ? `<div class="eta-line" style="margin-top:10px">💚 Unlocked: ${g.currentPct}% off — saving ${money(g.savings)} together</div>`
      : open
        ? `<div class="eta-line" style="margin-top:10px">👥 ${g.discount.pct}% off when ${g.discount.minPeople} people confirm — ${g.needMore.people} more to go</div>`
        : '') : ''}
  </div>
  ${g.order ? `
  <div class="card">
    ${stepper(AHEAD_STEPS, AHEAD_STEP_IDX[g.order.status] ?? 0)}
    <div class="code-card">
      <div class="muted small">Show this at the counter — any of you can collect</div>
      <div class="code">${esc(g.order.collectCode)}</div>
    </div>
    <div class="muted small" style="text-align:center;margin-top:8px">${money(g.order.total)} paid — everyone covered their own share</div>
  </div>` : ''}
  <div class="card">
    <div style="font-weight:900;margin-bottom:8px">Who's in (${g.members.length})</div>
    ${g.members.map((m) => `
    <div class="row" style="margin-bottom:8px">
      <div class="grow">
        <div style="font-weight:700">${esc(m.name)}${m.userId === g.hostUserId ? ' <span class="muted small">· host</span>' : ''}${
          m.userId === state.user.id ? ' <span class="muted small">· you</span>' : ''}</div>
        <div class="muted small">${m.itemCount ? `${m.itemCount} item${m.itemCount === 1 ? '' : 's'} · ${money(m.subtotal)}` : 'still picking…'}</div>
      </div>
      ${m.confirmed ? '<span class="badge">✓ IN</span>' : '<span class="badge gray">PICKING</span>'}
    </div>`).join('')}
  </div>
  ${open ? (g.myConfirmed ? `
  <div class="card">
    <div class="row">
      <div>
        <div style="font-weight:900">Your part is locked in ✓</div>
        <div class="muted small">${myCount} item${myCount === 1 ? '' : 's'} · ${money(mySubtotal)}${
          g.currentPct ? ` → you pay ${money(Math.round(mySubtotal * (1 - g.currentPct / 100)))}` : ''}</div>
      </div>
      <button class="btn ghost compact" onclick="confirmGroupPart(false)">Edit again</button>
    </div>
  </div>` : `
  <div class="section-title">Pick your food 🍽️</div>
  ${menu ? menu.menu.map((m) => `
  <div class="card">
    <div class="row">
      <div class="grow">
        <div><b>${esc(m.name)}</b></div>
        <div class="muted small">${esc(m.desc)}</div>
        <div style="margin-top:6px;font-weight:800">${money(m.price)}</div>
      </div>
      ${qtyControl(state.groupCart[m.id] || 0, 'groupItemAdd', [m.id])}
    </div>
  </div>`).join('') : '<div class="muted small">Loading the menu…</div>'}
  <button class="btn" ${myCount ? '' : 'disabled'} onclick="confirmGroupPart(true)">✓ Confirm my part · ${money(mySubtotal)}</button>`) : ''}
  ${open && isHost ? (state.groupPlaceArm ? `
  <div class="inline-form">
    <span>This charges every confirmed member's wallet their own share${g.currentPct ? ` (${g.currentPct}% off)` : ''} and sends the kitchen one order.</span>
    <button class="btn" onclick="placeGroupOrder()">Charge everyone · place it</button>
    <button class="btn ghost" onclick="armGroupPlace(false)">Not yet</button>
  </div>` : `
  <button class="btn" style="margin-top:10px" ${g.confirmedCount ? '' : 'disabled'} onclick="armGroupPlace(true)">Place group order (charges everyone)</button>`) : ''}
  ${open && isHost ? `<button class="btn danger" style="margin-top:8px" onclick="cancelGroup()">Cancel the group</button>` : ''}
  ${open && !isHost ? `<button class="btn danger" style="margin-top:10px" onclick="leaveGroup()">Leave this group</button>` : ''}`;
}

window.groupItemAdd = (itemId, delta) => {
  const next = (state.groupCart[itemId] || 0) + delta;
  if (next <= 0) delete state.groupCart[itemId];
  else state.groupCart[itemId] = Math.min(20, next);
  render();
  pushGroupItems();
};

// Debounced save — a burst of stepper taps sends one request. The reply is the
// fresh group view (my edit also un-confirms me server-side).
let groupItemsTimer;
function pushGroupItems() {
  clearTimeout(groupItemsTimer);
  groupItemsTimer = setTimeout(async () => {
    if (!state.group) return;
    const items = Object.entries(state.groupCart).map(([id, qty]) => ({ id, qty }));
    try {
      const data = await api(`/api/group-orders/${state.group.id}/items`, { method: 'POST', body: { items } });
      applyGroupUpdate(data.group);
      render();
    } catch (e) {
      toast(e.message, true);
    }
  }, 450);
}

window.confirmGroupPart = async (confirm) => {
  try {
    if (confirm) {
      // Flush pending stepper edits first so the server confirms what's on screen.
      clearTimeout(groupItemsTimer);
      const items = Object.entries(state.groupCart).map(([id, qty]) => ({ id, qty }));
      const saved = await api(`/api/group-orders/${state.group.id}/items`, { method: 'POST', body: { items } });
      applyGroupUpdate(saved.group);
    }
    const data = await api(`/api/group-orders/${state.group.id}/${confirm ? 'confirm' : 'unconfirm'}`, { method: 'POST' });
    applyGroupUpdate(data.group);
    toast(confirm ? "You're in — waiting for the host to place it ✓" : 'Change what you like, then confirm again.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.armGroupPlace = (on) => {
  state.groupPlaceArm = on;
  render();
};

window.placeGroupOrder = async () => {
  try {
    const data = await api(`/api/group-orders/${state.group.id}/place`, { method: 'POST' });
    state.groupPlaceArm = false;
    applyGroupUpdate(data.group);
    if (data.user) setUser(data.user);
    // The host's copy of the order joins the live-orders slot too.
    const o = await api('/api/orders').catch(() => null);
    if (o) state.orders = o.orders;
    toast(data.group.savings ? `Order placed — ${money(data.group.savings)} saved 🎉` : 'Group order placed 🎉');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.leaveGroup = async () => {
  try {
    await api(`/api/group-orders/${state.group.id}/leave`, { method: 'POST' });
    state.groups = (state.groups || []).filter((x) => x.id !== state.group.id);
    closeGroup();
    toast('You left the group.');
  } catch (e) {
    toast(e.message, true);
  }
};

window.cancelGroup = async () => {
  try {
    const data = await api(`/api/group-orders/${state.group.id}/cancel`, { method: 'POST' });
    state.groups = (state.groups || []).filter((x) => x.id !== data.group.id);
    closeGroup();
    toast('Group cancelled — nobody was charged.');
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- stays ---------------- */

function plusDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function staysView() {
  const today = new Date().toISOString().slice(0, 10);
  const s = state.staySearch;
  if (!s.checkIn) s.checkIn = plusDays(today, 1);
  if (!s.checkOut) s.checkOut = plusDays(today, 2);
  return `
  <div class="section-title">Find a place to stay 🏨</div>
  <div class="card">
    <label class="field"><span>City</span>
      <select id="stay-city">
        ${['All', ...(state.cities.length ? state.cities : ['Kathmandu', 'Pokhara', 'Chitwan'])]
          .map((c) => `<option ${s.city === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
    </label>
    <div class="grid2">
      <label class="field"><span>Check-in</span>
        <input id="stay-in" type="date" value="${s.checkIn}" min="${today}" />
      </label>
      <label class="field"><span>Check-out</span>
        <input id="stay-out" type="date" value="${s.checkOut}" min="${today}" />
      </label>
    </div>
    <button class="btn" onclick="searchStays()">Search hotels</button>
  </div>
  ${state.hotels ? hotelResults() : ''}
  ${bookingsSection()}`;
}

function hotelResults() {
  if (state.hotels.length === 0) return `<div class="empty"><div class="big">🏜️</div>No hotels in that city yet.</div>`;
  const s = state.staySearch;
  const nights = Math.round((Date.parse(s.checkOut) - Date.parse(s.checkIn)) / 86400000);
  return `<div class="section-title">${state.hotels.length} hotels · ${nights} night${nights > 1 ? 's' : ''}</div>` +
    state.hotels.map((h) => `
    <div class="card">
      ${photoStrip(photosOf(h), h.name)}
      <div class="row">
        <div>
          <div style="font-weight:900">${h.icon} ${esc(h.name)}${h.promotedUntil > Date.now() ? ' <span class="badge" style="background:#713f12;color:#fde68a">⭐ Featured</span>' : ''}</div>
          <div class="muted small">${esc(h.area)}${h.area ? ', ' : ''}${esc(h.city)}${h.desc ? ' · ' + esc(h.desc) : ''}</div>
        </div>
        <span class="badge">${h.rating ? '★ ' + h.rating : 'NEW'}</span>
      </div>
      <button class="link" style="margin-top:6px" onclick="toggleHotelReviews('${h.id}')">
        💬 ${(state.hotelReviews[h.id] || {}).open ? 'Hide reviews' : `Reviews from past guests${h.ratingCount ? ` (${h.ratingCount})` : ''}`}
      </button>
      ${(state.hotelReviews[h.id] || {}).open ? `
      <div style="margin-top:8px">
        ${state.hotelReviews[h.id].list ? reviewList(state.hotelReviews[h.id].list) : '<div class="muted small">Loading reviews…</div>'}
        <div class="muted small" style="margin-top:8px">✍️ Only guests who completed a stay can review this hotel.</div>
      </div>` : ''}
      <div class="divider"></div>
      ${h.rooms.map((room) => {
        const rPhotos = photosOf(room);
        return `
        <div style="margin-bottom:12px">
          <div class="row">
            ${rPhotos.length === 1 ? thumbStrip(rPhotos, room.type) : ''}
            <div class="grow">
              <div><b>${esc(room.type)}</b> <span class="muted small">· sleeps ${room.sleeps}</span></div>
              <div style="margin:4px 0 2px">${room.amenities.map((a) => `<span class="amenity">${esc(a)}</span>`).join('')}</div>
              <div class="small"><b>${money(room.pricePerNight)}</b><span class="muted"> /night · ${money(room.pricePerNight * nights)} total</span></div>
            </div>
            ${room.available > 0
              ? `<button class="btn compact" style="width:auto" onclick="bookRoom('${h.id}','${room.id}')">Book</button>`
              : `<span class="badge red">Sold out</span>`}
          </div>
          ${rPhotos.length > 1 ? thumbStrip(rPhotos, room.type) : ''}
        </div>`;
      }).join('')}
    </div>`).join('');
}

function bookingsSection() {
  const today = new Date().toISOString().slice(0, 10);
  const active = state.bookings.filter((b) => b.status === 'active');
  const upcoming = active.filter((b) => b.checkOut > today);
  // Finished stays: reviewable once, and only by the guest who stayed.
  const finished = active.filter((b) => b.checkOut <= today);
  let out = '';
  if (upcoming.length) {
    out += `<div class="section-title">Your bookings 🧳</div>` + upcoming.map((b) => `
    <div class="card">
      <div class="row">
        <div>
          <div><b>${b.hotelIcon} ${esc(b.hotelName)}</b> <span class="muted small">· ${esc(b.city)}</span></div>
          <div class="muted small">${esc(b.roomType)} · ${b.checkIn} → ${b.checkOut} (${b.nights} night${b.nights > 1 ? 's' : ''})</div>
        </div>
        <div><b>${money(b.total)}</b></div>
      </div>
      ${b.checkIn > today
        ? `<button class="btn danger" style="margin-top:12px" onclick="cancelBooking('${b.id}')">Cancel (full refund)</button>`
        : `<div class="eta-line" style="margin-top:12px">🛎️ Enjoy your stay — you can review it after check-out.</div>`}
    </div>`).join('');
  }
  if (finished.length) {
    out += `<div class="section-title">Past stays 🌙</div>` + finished.map((b) => `
    <div class="card">
      <div class="row">
        <div>
          <div><b>${b.hotelIcon} ${esc(b.hotelName)}</b> <span class="muted small">· ${esc(b.city)}</span></div>
          <div class="muted small">${esc(b.roomType)} · ${b.checkIn} → ${b.checkOut}</div>
        </div>
        ${b.ratingStars ? `<span class="badge">★ ${b.ratingStars} · reviewed</span>` : ''}
      </div>
      ${!b.ratingStars ? `
      <div class="divider"></div>
      <div style="text-align:center"><b>How was your stay?</b></div>
      <div class="stars">
        ${[1, 2, 3, 4, 5].map((n) => `<button class="${state.stayReview.id === b.id && state.stayReview.stars >= n ? 'on' : ''}" onclick="pickStayStars('${b.id}', ${n})">⭐</button>`).join('')}
      </div>
      ${state.stayReview.id === b.id ? `
      <label class="field"><span>Tell future guests about it (optional)</span>
        <input id="stay-review-text" maxlength="300" placeholder="e.g. Clean rooms, great mountain view at breakfast" />
      </label>
      <button class="btn" onclick="rateStay('${b.id}')">Submit review</button>` : ''}` : ''}
    </div>`).join('');
  }
  return out;
}

window.pickStayStars = (id, stars) => {
  const keepText = state.stayReview.id === id ? ($('#stay-review-text') || {}).value || '' : '';
  state.stayReview = { id, stars };
  render();
  const input = $('#stay-review-text');
  if (input) input.value = keepText;
};

window.rateStay = async (id) => {
  const { stars } = state.stayReview;
  if (!stars) return toast('Pick a star rating first.', true);
  try {
    const textEl = $('#stay-review-text');
    const data = await api(`/api/bookings/${id}/rate`, {
      method: 'POST',
      body: { stars, text: textEl ? textEl.value.trim() : '' }
    });
    const booking = state.bookings.find((b) => b.id === id);
    if (booking) booking.ratingStars = data.booking.ratingStars;
    state.stayReview = { id: '', stars: 0 };
    toast('Thanks — future guests will see your review 🌟');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.toggleHotelReviews = (id) => {
  const cur = state.hotelReviews[id] || { open: false, list: null };
  cur.open = !cur.open;
  state.hotelReviews[id] = cur;
  if (cur.open && !cur.list) {
    api(`/api/hotels/${id}/reviews`).then((data) => {
      state.hotelReviews[id] = { open: true, list: data.reviews, rating: data.rating, count: data.ratingCount };
      render();
    }).catch(() => {});
  }
  render();
};

window.searchStays = async () => {
  const city = $('#stay-city').value;
  const checkIn = $('#stay-in').value;
  const checkOut = $('#stay-out').value;
  state.staySearch = { city, checkIn, checkOut };
  try {
    const data = await api(`/api/hotels?city=${encodeURIComponent(city)}&checkIn=${checkIn}&checkOut=${checkOut}`);
    state.hotels = data.hotels;
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.bookRoom = async (hotelId, roomId) => {
  const s = state.staySearch;
  try {
    const data = await api('/api/bookings', {
      method: 'POST',
      body: { hotelId, roomId, checkIn: s.checkIn, checkOut: s.checkOut }
    });
    setUser(data.user);
    const [b, h] = await Promise.all([
      api('/api/bookings'),
      api(`/api/hotels?city=${encodeURIComponent(s.city)}&checkIn=${s.checkIn}&checkOut=${s.checkOut}`)
    ]);
    state.bookings = b.bookings;
    state.hotels = h.hotels;
    toast('Booked! See you at check-in 🛎️');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.cancelBooking = async (id) => {
  try {
    const data = await api(`/api/bookings/${id}/cancel`, { method: 'POST' });
    setUser(data.user);
    const b = await api('/api/bookings');
    state.bookings = b.bookings;
    if (state.hotels) await window.searchStays.refresh?.();
    toast('Booking cancelled — amount refunded.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- tasks (mini job contracts) ---------------- */

async function refreshTasks() {
  const [b, m] = await Promise.all([api('/api/tasks/board'), api('/api/tasks/mine')]);
  state.tasksBoard = b.tasks;
  state.myTasks = m;
  state._tasksKey = JSON.stringify([b.tasks, m]);
}

const TASK_STATUS = {
  open: ['Open — waiting for a taker', 'amber'],
  assigned: ['In progress', 'amber'],
  done: ['Awaiting your confirmation', 'amber'],
  completed: ['Completed & paid', ''],
  cancelled: ['Cancelled', 'red']
};

function taskBadge(status) {
  const [label, tone] = TASK_STATUS[status] || [status, 'gray'];
  return `<span class="badge ${tone}">${label}</span>`;
}

function taskForm() {
  return `
  <div class="card">
    <div style="font-weight:900;margin-bottom:12px">Post a task</div>
    <label class="field"><span>What do you need done?</span>
      <input id="t-title" placeholder="e.g. Buy groceries from Bhatbhateni" />
    </label>
    <label class="field"><span>Category</span>
      <select id="t-category">${TASK_CATEGORIES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    </label>
    <label class="field"><span>Details</span>
      <input id="t-desc" placeholder="e.g. List has 12 items, deliver before 6pm" />
    </label>
    <div class="grid2">
      <label class="field"><span>Where</span>
        <input id="t-place" list="sg-places" placeholder="e.g. Thamel" />
      </label>
      <label class="field"><span>Budget (Rs)</span>
        <input id="t-budget" type="number" placeholder="500" min="100" max="50000" />
      </label>
    </div>
    <label class="field"><span>When do you need it? (optional)</span>
      <input id="t-when" placeholder="e.g. Today before 6pm, this weekend…" />
    </label>
    <datalist id="sg-places">
      ${state.places.map((p) => `<option value="${esc(p.name)}"></option>`).join('')}
    </datalist>
    <div class="muted small" style="margin-bottom:12px">
      💰 The budget is held from your wallet until you confirm the job is done. The tasker receives 90%, SewaGo keeps 10%.
    </div>
    <button class="btn" onclick="postTask()">Post task & hold budget</button>
    <button class="btn ghost" style="margin-top:8px" onclick="toggleTaskForm()">Cancel</button>
  </div>`;
}

function tasksView() {
  const { posted, working } = state.myTasks;
  return `
  <div class="section-title">Mini jobs 🧰</div>
  ${state.showTaskForm ? taskForm() : `<button class="btn" onclick="toggleTaskForm()">+ Post a task — get anything done</button>`}

  ${working.length ? `<div class="section-title">Jobs you took 💪</div>` + working.map((t) => `
    <div class="card">
      <div class="row">
        <div>
          <div><b>${t.icon} ${esc(t.title)}</b></div>
          <div class="muted small">for ${esc(t.posterName)}${t.place ? ' · 📍 ' + esc(t.place) : ''}</div>
          ${t.desc ? `<div class="muted small">${esc(t.desc)}</div>` : ''}
        </div>
        <div style="text-align:right">
          <div style="color:var(--accent);font-weight:900">+${money(t.workerPayout)}</div>
          ${taskBadge(t.status === 'done' ? 'assigned' : t.status)}
        </div>
      </div>
      ${t.status === 'assigned' ? `<button class="btn" style="margin-top:12px" onclick="markTaskDone('${t.id}')">✓ Mark as done</button>` : ''}
      ${t.status === 'done' ? `<div class="muted small" style="margin-top:8px">⏳ Waiting for ${esc(t.posterName.split(' ')[0])} to confirm and release payment.</div>` : ''}
    </div>`).join('') : ''}

  ${posted.length ? `<div class="section-title">Tasks you posted 📋</div>` + posted.map((t) => `
    <div class="card">
      <div class="row">
        <div>
          <div><b>${t.icon} ${esc(t.title)}</b></div>
          <div class="muted small">${t.place ? '📍 ' + esc(t.place) + ' · ' : ''}${t.when ? '⏰ ' + esc(t.when) + ' · ' : ''}budget ${money(t.budget)}${t.workerName ? ' · 🙋 ' + esc(t.workerName) : ''}</div>
        </div>
        ${taskBadge(t.status)}
      </div>
      ${t.status === 'open' && (t.applicants || []).length ? `
        <div class="divider"></div>
        <div class="muted small" style="font-weight:700;margin-bottom:8px">🙋 ${t.applicants.length} applicant${t.applicants.length > 1 ? 's' : ''} — pick who does the job</div>
        ${t.applicants.map((a) => `
        <div class="row" style="margin-bottom:10px">
          <div class="grow">
            <div><b>${esc(a.name)}</b> <span class="muted small">· ${a.completedJobs} job${a.completedJobs === 1 ? '' : 's'} done</span></div>
            ${a.note ? `<div class="muted small">“${esc(a.note)}”</div>` : ''}
          </div>
          <button class="btn compact" style="width:auto" onclick="hireWorker('${t.id}','${a.userId}')">Hire</button>
        </div>`).join('')}` : ''}
      ${t.status === 'open' && !(t.applicants || []).length ? `<div class="muted small" style="margin-top:8px">⏳ Waiting for people to apply…</div>` : ''}
      ${t.status === 'done' ? `<button class="btn" style="margin-top:12px" onclick="confirmTask('${t.id}')">✓ Confirm done — pay ${money(t.workerPayout)}</button>` : ''}
      ${t.status === 'open' ? `<button class="btn danger" style="margin-top:12px" onclick="cancelTask('${t.id}')">Cancel (refund ${money(t.budget)})</button>` : ''}
    </div>`).join('') : ''}

  <div class="section-title">Find work near you 💼</div>
  ${state.tasksBoard.length === 0
    ? `<div class="empty"><div class="big">🌤️</div>No open tasks right now — post one, or check back soon.</div>`
    : state.tasksBoard.map((t) => `
    <div class="card">
      <div class="row">
        <div>
          <div><b>${t.icon} ${esc(t.title)}</b></div>
          <div class="muted small">by ${esc(t.posterName)}${t.place ? ' · 📍 ' + esc(t.place) : ''}${t.when ? ' · ⏰ ' + esc(t.when) : ''}</div>
          ${t.desc ? `<div class="muted small">${esc(t.desc)}</div>` : ''}
        </div>
        <div style="text-align:right">
          <div style="color:var(--accent);font-weight:900">earn ${money(t.workerPayout)}</div>
          <div class="muted small">budget ${money(t.budget)}</div>
        </div>
      </div>
      ${t.applicantCount ? `<div class="muted small" style="margin-top:6px">🙋 ${t.applicantCount} applicant${t.applicantCount > 1 ? 's' : ''} so far</div>` : ''}
      ${t.applied
        ? `<div class="eta-line" style="margin-top:12px">✓ You applied — waiting for ${esc(t.posterName.split(' ')[0])} to pick</div>`
        : state.applyingTask === t.id ? `
        <label class="field" style="margin-top:12px"><span>Why you? (optional, shown to the poster)</span>
          <input id="apply-note-${t.id}" maxlength="200" placeholder="e.g. I live nearby and can start right away" />
        </label>
        <div class="grid2">
          <button class="btn" onclick="applyTask('${t.id}')">Send application</button>
          <button class="btn ghost" onclick="toggleApply('')">Cancel</button>
        </div>`
        : `<button class="btn" style="margin-top:12px" onclick="toggleApply('${t.id}')">🙋 Apply for this job</button>`}
    </div>`).join('')}`;
}

window.toggleApply = (id) => {
  state.applyingTask = id;
  render();
};

window.applyTask = async (id) => {
  try {
    const noteEl = $(`#apply-note-${id}`);
    await api(`/api/tasks/${id}/apply`, { method: 'POST', body: { note: noteEl ? noteEl.value.trim() : '' } });
    state.applyingTask = '';
    await refreshTasks();
    toast('Application sent — you\'ll see it here if you\'re hired 🙋');
    render();
  } catch (e) {
    toast(e.message, true);
    refreshTasks().then(render).catch(() => {});
  }
};

window.hireWorker = async (taskId, userId) => {
  try {
    await api(`/api/tasks/${taskId}/hire`, { method: 'POST', body: { userId } });
    await refreshTasks();
    toast('Hired! They\'ve been notified to start 💪');
    render();
  } catch (e) {
    toast(e.message, true);
    refreshTasks().then(render).catch(() => {});
  }
};

window.toggleTaskForm = () => {
  state.showTaskForm = !state.showTaskForm;
  render();
};

window.postTask = async () => {
  try {
    const data = await api('/api/tasks', {
      method: 'POST',
      body: {
        title: $('#t-title').value.trim(),
        category: $('#t-category').value,
        desc: $('#t-desc').value.trim(),
        place: $('#t-place').value.trim(),
        budget: $('#t-budget').value,
        when: $('#t-when').value.trim()
      }
    });
    setUser(data.user);
    state.showTaskForm = false;
    await refreshTasks();
    toast('Task posted — budget held in escrow 💰');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.markTaskDone = async (id) => {
  try {
    await api(`/api/tasks/${id}/done`, { method: 'POST' });
    await refreshTasks();
    toast('Marked done — payment released once the poster confirms.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.confirmTask = async (id) => {
  try {
    await api(`/api/tasks/${id}/confirm`, { method: 'POST' });
    await refreshTasks();
    const me = await api('/api/auth/me');
    setUser(me.user);
    toast('Confirmed — the tasker has been paid ✅');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.cancelTask = async (id) => {
  try {
    const data = await api(`/api/tasks/${id}/cancel`, { method: 'POST' });
    setUser(data.user);
    await refreshTasks();
    toast('Task cancelled — budget refunded.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- activity ---------------- */

const STATUS_LABEL = {
  searching: ['Finding driver', 'amber'], driver_en_route: ['Driver on the way', 'amber'],
  in_progress: ['On trip', 'amber'], completed: ['Completed', ''], cancelled: ['Cancelled', 'red'],
  placed: ['Placed', 'amber'], preparing: ['Preparing', 'amber'],
  out_for_delivery: ['On the way', 'amber'], delivered: ['Delivered', ''],
  ready: ['Ready for you', 'amber'],
  active: ['Confirmed', '']
};

function statusBadge(status) {
  const [label, tone] = STATUS_LABEL[status] || [status, 'gray'];
  return `<span class="badge ${tone}">${label}</span>`;
}

function activityView() {
  const noHistory = state.rides.length === 0 && state.orders.length === 0 && state.bookings.length === 0;
  if (noHistory) {
    return `<div class="empty"><div class="big">🌱</div>Nothing here yet.<br/>Book a ride, order food or reserve a room!</div>`;
  }
  return `
  ${state.rides.length ? `<div class="section-title">Rides 🚗</div>` + state.rides.map((r) => `
    <div class="card">
      <div class="row">
        <div>
          <div><b>${esc(r.pickup)} → ${esc(r.dropoff)}</b></div>
          <div class="muted small">${esc(r.tierLabel)} · ${r.distanceKm} km · ${fmtDateTime(r.createdAt)}${r.rating ? ' · ' + '⭐'.repeat(r.rating) : ''}</div>
        </div>
        <div style="text-align:right">
          <div><b>${money(r.fare)}</b></div>
          ${statusBadge(r.status)}
        </div>
      </div>
    </div>`).join('') : ''}
  ${state.orders.length ? `<div class="section-title">Food orders 🍜</div>` + state.orders.map((o) => `
    <div class="card">
      <div class="row">
        <div>
          <div><b>${o.restaurantIcon} ${esc(o.restaurantName)}</b></div>
          <div class="muted small">${o.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')} · ${fmtDateTime(o.createdAt)}</div>
        </div>
        <div style="text-align:right">
          <div><b>${money(o.total)}</b></div>
          ${statusBadge(o.status)}
        </div>
      </div>
    </div>`).join('') : ''}
  ${state.bookings.length ? `<div class="section-title">Stays 🏨</div>` + state.bookings.map((b) => `
    <div class="card">
      <div class="row">
        <div>
          <div><b>${b.hotelIcon} ${esc(b.hotelName)}</b></div>
          <div class="muted small">${esc(b.roomType)} · ${b.checkIn} → ${b.checkOut}</div>
        </div>
        <div style="text-align:right">
          <div><b>${money(b.total)}</b></div>
          ${statusBadge(b.status)}
        </div>
      </div>
    </div>`).join('') : ''}`;
}

/* ---------------- profile ---------------- */

const PAY_METHODS = [
  ['esewa', '🟢 eSewa'],
  ['khalti', '🟣 Khalti'],
  ['card', '💳 Debit / credit card']
];

// Server-driven list when loaded (marks sandbox methods); static fallback until then.
function availablePayMethods() {
  if (!state.payMethods) return PAY_METHODS;
  return PAY_METHODS
    .filter(([v]) => state.payMethods[v])
    .map(([v, l]) => [v, state.payMethods[v].sandbox ? `${l} (demo)` : l]);
}

const TXN_ICONS = {
  topup: '➕', bonus: '🎁', ride: '🚗', ride_refund: '↩️', food: '🍜', food_refund: '↩️',
  stay: '🏨', stay_refund: '↩️', task_hold: '🧰', task_refund: '↩️', task_income: '💪',
  withdrawal: '🏦', withdrawal_refund: '↩️'
};

async function loadTxns() {
  try {
    const data = await api('/api/payments/transactions');
    state.txns = data.transactions;
  } catch (e) { /* ledger is non-critical for rendering */ }
}

function topupCard() {
  return `
  <div class="card">
    <div style="font-weight:900;margin-bottom:12px">Add money</div>
    <div class="grid2">
      <label class="field"><span>Amount (Rs)</span>
        <input id="tp-amount" type="number" value="1000" min="50" max="100000" />
      </label>
      <label class="field"><span>Pay with</span>
        <select id="tp-method">${availablePayMethods().map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      </label>
    </div>
    <button class="btn" onclick="startTopup()">Continue to payment</button>
    <button class="btn ghost" style="margin-top:8px" onclick="closePay()">Cancel</button>
  </div>`;
}

function topupConfirmCard() {
  const p = state.payment;
  return `
  <div class="card">
    <div style="font-weight:900">Confirm payment</div>
    <div class="muted small" style="margin:6px 0 12px">
      Paying <b style="color:var(--text)">${money(p.amount)}</b> via <b style="color:var(--text)">${esc(p.methodLabel)}</b> (sandbox gateway)
    </div>
    <label class="field"><span>${esc(p.methodLabel)} PIN</span>
      <input id="tp-pin" type="password" placeholder="Sandbox PIN: 1234" />
    </label>
    <button class="btn" onclick="confirmTopup()">Pay ${money(p.amount)}</button>
    <button class="btn ghost" style="margin-top:8px" onclick="closePay()">Cancel</button>
  </div>`;
}

function withdrawCard() {
  return `
  <div class="card">
    <div style="font-weight:900;margin-bottom:12px">Withdraw to your account</div>
    <div class="grid2">
      <label class="field"><span>Amount (Rs)</span>
        <input id="wd-amount" type="number" placeholder="1000" min="100" />
      </label>
      <label class="field"><span>Payout to</span>
        <select id="wd-channel">
          <option value="esewa">eSewa</option>
          <option value="khalti">Khalti</option>
          <option value="bank">Bank transfer</option>
        </select>
      </label>
    </div>
    <label class="field"><span>Account / wallet ID</span>
      <input id="wd-account" placeholder="e.g. 9841000000 or account no." />
    </label>
    <div class="muted small" style="margin-bottom:10px">Rs 10 payout fee · processed after SewaGo approves it (usually same day).</div>
    <button class="btn" onclick="submitWithdraw()">Request withdrawal</button>
    <button class="btn ghost" style="margin-top:8px" onclick="closePay()">Cancel</button>
  </div>`;
}

function txnSection() {
  if (!state.txns.length) return '';
  return `<div class="section-title">Wallet activity 💳</div>
  <div class="card">
    ${state.txns.map((t) => `
    <div class="row" style="margin-bottom:12px">
      <div>
        <div class="small"><b>${TXN_ICONS[t.type] || '💳'} ${esc(t.label)}</b></div>
        <div class="muted small">${fmtDateTime(t.createdAt)}${t.status === 'processing' ? ' · ⏳ processing' : ''} · balance ${money(t.balanceAfter)}</div>
      </div>
      <div style="font-weight:900;white-space:nowrap;color:${t.sign > 0 ? 'var(--accent)' : 'var(--text)'}">${t.sign > 0 ? '+' : '−'}${money(t.amount)}</div>
    </div>`).join('')}
  </div>`;
}

function securityCard() {
  const u = state.user;
  // Verified accounts don't need the OTP form — just the badge and a way to
  // change the number (which restarts verification).
  if (u.phoneVerified && !state.showPhoneEdit) {
    return `
  <div class="card">
    <div class="row">
      <div>
        <div style="font-weight:900">Account security</div>
        <div class="muted small">📱 ${esc(u.phone)} — verified. This protects payouts, rides and account recovery.</div>
      </div>
      <span class="badge">PHONE VERIFIED</span>
    </div>
    <button class="btn ghost compact" style="margin-top:12px" onclick="togglePhoneEdit(true)">Change phone number</button>
  </div>`;
  }
  return `
  <div class="card">
    <div class="row">
      <div>
        <div style="font-weight:900">Account security</div>
        <div class="muted small">Phone verification protects payouts, rides and account recovery.</div>
      </div>
      <span class="badge ${u.phoneVerified ? '' : 'amber'}">${u.phoneVerified ? 'PHONE VERIFIED' : 'PHONE NEEDED'}</span>
    </div>
    <label class="field" style="margin-top:12px"><span>Phone</span>
      <input id="sec-phone" value="${esc(u.phone || '')}" placeholder="e.g. 9841000000" />
    </label>
    <div class="grid2">
      <button class="btn ghost" onclick="requestUserOtp()">Send OTP</button>
      <label class="field"><span>OTP code</span><input id="sec-otp" placeholder="123456" /></label>
    </div>
    <button class="btn" onclick="verifyUserOtp()">Verify phone</button>
    ${state.showPhoneEdit ? `<button class="btn ghost" style="margin-top:8px" onclick="togglePhoneEdit(false)">Cancel</button>` : ''}
  </div>`;
}

window.togglePhoneEdit = (show) => {
  state.showPhoneEdit = show;
  render();
};

function profileView() {
  const u = state.user;
  return `
  <div class="card" style="text-align:center;padding:26px 16px">
    <div style="font-size:44px">🧑‍🚀</div>
    <div style="font-size:20px;font-weight:900;margin-top:8px">${esc(u.name)}</div>
    <div class="muted">${esc(u.email)}</div>
  </div>
  <div class="card">
    <div class="row">
      <div>
        <div class="muted small">SewaGo Wallet</div>
        <div style="font-size:26px;font-weight:900">${money(u.wallet)}</div>
      </div>
      <span style="font-size:30px">👛</span>
    </div>
    <div class="grid2" style="margin-top:14px">
      <button class="btn ${state.payUi === 'topup' || state.payUi === 'topup-confirm' ? '' : 'ghost'}"
        aria-pressed="${state.payUi === 'topup' || state.payUi === 'topup-confirm'}" onclick="openPay('topup')">➕ Add money</button>
      <button class="btn ${state.payUi === 'withdraw' ? '' : 'ghost'}"
        aria-pressed="${state.payUi === 'withdraw'}" onclick="openPay('withdraw')">🏦 Withdraw</button>
    </div>
  </div>
  ${securityCard()}
  ${state.payUi === 'topup' ? topupCard() : ''}
  ${state.payUi === 'topup-confirm' ? topupConfirmCard() : ''}
  ${state.payUi === 'withdraw' ? withdrawCard() : ''}
  ${txnSection()}
  <div class="card">
    <div class="muted small" style="line-height:1.7">
      🚗 Rides charge your wallet when booked, refunded on cancel.<br/>
      🍜 Food can be cancelled until the kitchen starts.<br/>
      🏨 Stays refund fully before check-in day.<br/>
      🧰 Task budgets are held in escrow until you confirm the job.
    </div>
  </div>
  <button class="btn danger" onclick="doLogout()">Log out</button>
  <div class="card" style="margin-top:14px;border-color:#7f1d1d">
    <div style="font-weight:800">Delete account</div>
    <div class="muted small" style="margin:6px 0 10px;line-height:1.6">
      Removes your personal data permanently. Any remaining wallet balance is forfeited,
      and active rides, orders, stays or tasks must be finished or cancelled first.
      <a href="/privacy" target="_blank" class="link">Privacy policy</a>
    </div>
    ${state.showDeleteAccount ? `
      <label class="field"><span>Confirm with your password</span>
        <input id="del-password" type="password" placeholder="Your password" />
      </label>
      ${u.phoneVerified ? `<div class="muted small" style="margin-bottom:8px">No password? <button class="link" onclick="requestDeleteOtp()">Send a code to ${esc(u.phone)}</button>
        <input id="del-otp" placeholder="SMS code (optional)" style="margin-top:6px" /></div>` : ''}
      <div class="grid2">
        <button class="btn danger" onclick="confirmDeleteAccount()">Delete forever</button>
        <button class="btn ghost" onclick="toggleDeleteAccount(false)">Keep my account</button>
      </div>` : `
      <button class="btn ghost" style="border-color:#7f1d1d;color:#f87171" onclick="toggleDeleteAccount(true)">Delete my account…</button>`}
  </div>`;
}

window.toggleDeleteAccount = (show) => {
  state.showDeleteAccount = show;
  render();
};

window.requestDeleteOtp = async () => {
  try {
    const data = await api('/api/auth/otp/request', { method: 'POST', body: { phone: state.user.phone } });
    toast(data.devCode ? `Sandbox OTP: ${data.devCode}` : 'Code sent to your phone.');
  } catch (e) {
    toast(e.message, true);
  }
};

window.confirmDeleteAccount = async () => {
  if (!confirm('Delete your SewaGo account forever? This cannot be undone.')) return;
  try {
    const otpEl = $('#del-otp');
    await api('/api/auth/account/delete', {
      method: 'POST',
      body: { password: $('#del-password').value, otpCode: otpEl ? otpEl.value.trim() : '' }
    });
    toast('Your account has been deleted. Goodbye 👋');
    state.showDeleteAccount = false;
    doLogoutLocal();
  } catch (e) {
    toast(e.message, true);
  }
};

window.requestUserOtp = async () => {
  try {
    const data = await api('/api/auth/phone/request-otp', {
      method: 'POST',
      body: { phone: $('#sec-phone').value.trim() }
    });
    setUser(data.user);
    toast(data.devCode ? `Sandbox OTP: ${data.devCode}` : 'Verification code sent.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.verifyUserOtp = async () => {
  try {
    const data = await api('/api/auth/phone/verify', {
      method: 'POST',
      body: { code: $('#sec-otp').value.trim() }
    });
    setUser(data.user);
    state.showPhoneEdit = false;
    toast('Phone verified.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.openPay = (ui) => {
  state.payUi = state.payUi === ui ? null : ui;
  state.payment = null;
  render();
  // Refresh which methods are live vs sandbox (server decides by configured gateways).
  if (state.payUi === 'topup' && !state.payMethods) {
    api('/api/payments/methods').then((data) => {
      state.payMethods = data.methods;
      if (state.payUi === 'topup') render();
    }).catch(() => {});
  }
};

window.closePay = () => {
  state.payUi = null;
  state.payment = null;
  render();
};

window.startTopup = async () => {
  try {
    const data = await api('/api/payments/topup/initiate', {
      method: 'POST',
      body: { amount: $('#tp-amount').value, method: $('#tp-method').value }
    });
    // Real gateways take over the browser; the wallet is credited on return
    // after server-side verification.
    if (data.redirectUrl) {
      window.location.href = data.redirectUrl;
      return;
    }
    if (data.form) {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = data.form.url;
      for (const [name, value] of Object.entries(data.form.fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
      return;
    }
    state.payment = data.payment;
    state.payUi = 'topup-confirm';
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.confirmTopup = async () => {
  try {
    const data = await api('/api/payments/topup/confirm', {
      method: 'POST',
      body: { paymentId: state.payment.id, pin: $('#tp-pin').value }
    });
    setUser(data.user);
    state.payUi = null;
    state.payment = null;
    await loadTxns();
    toast('Payment successful — wallet topped up 💸');
    render();
  } catch (e) {
    toast(e.message, true);
    state.payUi = 'topup';
    state.payment = null;
    render();
  }
};

window.submitWithdraw = async () => {
  try {
    const data = await api('/api/payments/withdraw', {
      method: 'POST',
      body: {
        amount: $('#wd-amount').value,
        channel: $('#wd-channel').value,
        account: $('#wd-account').value.trim()
      }
    });
    setUser(data.user);
    state.payUi = null;
    await loadTxns();
    toast('Withdrawal requested — arrives once SewaGo approves it 🏦');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- realtime (push) + live polling ---------------- */

// Pull the authoritative active ride and reconcile the card/map. Driven both by
// the animation tick (below) and by instant server pushes over SSE.
async function syncActiveRideUI() {
  await refreshActiveRide();
  const slot = $('#ride-slot');
  const ride = state.activeRide;
  if (!slot) return;
  const key = rideKey();
  if (key !== state._rideKey) {
    // status changed -> rebuild the card and remount the map
    state._rideKey = key;
    slot.innerHTML = rideSlot();
    mountRideMap(ride);
  } else if (ride) {
    // same status -> only move the driver marker and refresh ETA/progress
    updateRideMap(ride);
    const eta = $('#eta-line');
    if (eta) eta.textContent = etaLineText(ride);
    const bar = $('#trip-bar');
    if (bar) bar.style.width = Math.round(ride.progress * 100) + '%';
  }
}

// SSE: the server nudges us the instant a driver accepts / starts / finishes,
// so status changes feel immediate instead of waiting for the next tick.
let sseSource = null;
let sseRetry = null;
let sseConnecting = false;
// The stream credential is a one-minute single-use ticket, not our session
// token — query strings end up in proxy access logs. Because the ticket burns on
// use, EventSource's own retry would loop on 401, so reconnects are ours to do.
async function connectEvents() {
  if (!state.token || typeof EventSource === 'undefined' || sseConnecting) return;
  sseConnecting = true;
  disconnectEvents();
  let ticket;
  try {
    ticket = (await api('/api/events/ticket', { method: 'POST', body: { role: 'user' } })).ticket;
  } catch (_) {
    sseConnecting = false;
    return scheduleEventsRetry(); // polling below still keeps the UI correct
  }
  sseConnecting = false;
  if (!state.token) return; // logged out while the ticket was in flight
  sseSource = new EventSource('/api/events?role=user&ticket=' + encodeURIComponent(ticket));
  sseSource.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.topic === 'ride') {
      // On Home the ride lives in a context row, not #ride-slot — repaint it.
      syncActiveRideUI().then(() => { if (state.tab === 'home') render(); }).catch(() => {});
    }
    if (msg.topic === 'order' && (state.tab === 'food' || state.tab === 'home')) {
      api('/api/orders').then((o) => { state.orders = o.orders; render(); }).catch(() => {});
    }
    if (msg.topic === 'group') {
      // A friend joined / picked / confirmed, or the host placed or cancelled —
      // re-pull my groups, toast the headline moments, keep an open lobby live.
      api('/api/group-orders').then((g) => {
        const prev = state.groups;
        const groups = g.groups || [];
        if (Array.isArray(prev)) {
          for (const next of groups) {
            const before = prev.find((x) => x.id === next.id);
            if (!before) continue;
            const newcomer = next.members.find((m) => !before.members.some((b) => b.userId === m.userId));
            if (newcomer && newcomer.userId !== state.user.id) toast(`${newcomer.name.split(' ')[0]} joined 🎉`);
            if (before.status === 'open' && next.status === 'placed') {
              toast(next.savings ? `Order placed — ${money(next.savings)} saved 🎉` : 'Group order placed 🎉');
              // My share just left my wallet — refresh the chip.
              api('/api/auth/me').then((me) => setUser(me.user)).catch(() => {});
            }
          }
        }
        state.groups = groups;
        if (state.group) {
          const cur = groups.find((x) => x.id === state.group.id);
          if (cur) {
            state.group = cur;
          } else {
            // The lobby I was looking at is gone: collected if it had been
            // placed, otherwise the host closed it.
            const wasPlaced = state.group.status === 'placed';
            state.group = null;
            state.groupMenu = null;
            toast(wasPlaced ? 'Order collected — enjoy! 🍽️' : 'The host closed this group order.', !wasPlaced);
          }
        }
        if (state.tab === 'food' || state.tab === 'home') render();
      }).catch(() => {});
    }
    if (msg.topic === 'store_order') {
      // The shopkeeper moved an order along. The moment one turns "ready" is
      // the come-and-get-it signal for a pickup order, so shout it.
      api('/api/store-orders').then((o) => {
        const wasReady = new Set((state.shopOrders || []).filter((x) => x.status === 'ready').map((x) => x.id));
        state.shopOrders = o.orders || [];
        for (const ord of state.shopOrders) {
          if (ord.status === 'ready' && !wasReady.has(ord.id) && ord.fulfilment === 'pickup') {
            toast(`📦 ${ord.storeName} packed your order — pickup code ${ord.pickupCode}`);
          }
        }
        if (state.tab === 'shops' || state.tab === 'home') render();
      }).catch(() => {});
    }
    if (msg.topic === 'subscription') {
      // A shopkeeper answered a subscribe request — invite the subscribe on the
      // spot, and refresh the open shop front so the CTA is there when they look.
      toast(`🔁 ${msg.storeName || 'The shop'} accepted your subscription request${
        msg.itemName ? ` for ${msg.itemName}` : ''} — subscribe now for the lower price!`);
      if (state.shop) {
        api(`/api/stores/${state.shop.store.id}`).then((data) => {
          if (state.shop && state.shop.store.id === data.store.id) {
            state.shop = data;
            if (state.tab === 'shops') render();
          }
        }).catch(() => {});
      }
    }
    if (msg.topic === 'wallet') {
      // A withdrawal was decided — refetch balance + ledger, then tell the user.
      Promise.all([api('/api/auth/me'), loadTxns()]).then(([me]) => {
        setUser(me.user);
        render();
      }).catch(() => {});
      if (msg.event === 'withdrawal_paid') toast('🏦 Your withdrawal was approved and paid out.');
      if (msg.event === 'withdrawal_rejected') toast('Your withdrawal was rejected — the amount is back in your wallet.', true);
    }
  };
  sseSource.onerror = () => scheduleEventsRetry();
}
function scheduleEventsRetry() {
  if (sseRetry || !state.token) return;
  sseRetry = setTimeout(() => { sseRetry = null; connectEvents(); }, 5000);
}
function disconnectEvents() {
  if (sseRetry) { clearTimeout(sseRetry); sseRetry = null; }
  if (sseSource) { sseSource.close(); sseSource = null; }
}

setInterval(async () => {
  if (!state.user) return;
  try {
    const rideActive = state.activeRide && state.activeRide.status !== 'cancelled' &&
      !(state.activeRide.status === 'completed' && state.activeRide.rating);
    // An active ride still tick-polls for smooth marker/progress animation and
    // time-based (sim) transitions; push covers the discrete live-ride changes.
    if (rideActive) {
      await syncActiveRideUI();
      // Home shows the ride as a context row; repaint only when the status
      // key moves so ticks don't rebuild the launcher every 2.5s.
      if (state.tab === 'home' && rideKey() !== state._rideKey) {
        state._rideKey = rideKey();
        renderTab();
      }
    }
    if (state.tab === 'food' && !state.restaurant &&
        state.orders.some((o) => !ORDER_DONE.includes(o.status))) {
      const o = await api('/api/orders');
      state.orders = o.orders;
      const slot = $('#orders-slot');
      if (slot) slot.innerHTML = ordersSlot();
    }
    // Tasks are two-sided: refresh while watching the board (but never wipe
    // the post form or an application note being typed).
    if (state.tab === 'tasks' && !state.showTaskForm && !state.applyingTask) {
      const prevKey = state._tasksKey;
      await refreshTasks();
      if (state._tasksKey !== prevKey) renderTab();
    }
  } catch (e) { /* transient polling errors are fine */ }
}, 2500);

/* ---------------- boot ---------------- */

// Close any open address-search dropdown when tapping elsewhere.
document.addEventListener('click', (e) => {
  if (e.target.closest('.geo-field')) return;
  document.querySelectorAll('.geo-ac').forEach((box) => {
    box.classList.add('hidden');
    box.innerHTML = '';
  });
});

// Hardware/browser back from a service page returns to Home instead of
// leaving the app (the entry was pushed by setTab when leaving Home).
window.addEventListener('popstate', () => {
  if (!state.user || state.tab === 'home') return;
  state._popNav = true;
  setTab('home');
});

(async function boot() {
  // Learn whether this is a demo/dev deployment before the first render, so
  // seed-account credentials never surface on a real production login screen.
  try {
    const info = await fetch('/api/app-info').then((r) => r.json());
    state.demo = !!info.demo;
  } catch (e) { /* default: not demo */ }
  if (state.token) {
    try {
      const me = await api('/api/auth/me');
      state.user = me.user;
      await Promise.all([refreshActiveRide(), loadPlaces()]);
      connectEvents();
    } catch (e) {
      state.token = null;
      localStorage.removeItem('sewago_token');
    }
  }
  // Reopen the page they were on last time (a fresh login lands on Home).
  const savedTab = localStorage.getItem('sewago_tab');
  if (state.user && savedTab && (savedTab === 'home' || TABS.some((t) => t.id === savedTab))) state.tab = savedTab;
  // Back from a payment gateway redirect (eSewa / Khalti).
  const params = new URLSearchParams(window.location.search);
  // Password-reset link from the email: open the reset form with the token in.
  const resetParam = params.get('reset');
  if (resetParam && !state.user) {
    window.history.replaceState({}, '', window.location.pathname);
    state.authMode = 'reset';
    state.resetToken = resetParam;
    state.resetFromLink = true;
  }
  const payResult = params.get('pay');
  if (payResult) {
    window.history.replaceState({}, '', window.location.pathname);
    if (state.user) state.tab = 'profile';
    if (state.user && state.tab === 'profile') await loadTxns().catch(() => {});
  }
  // The base history entry is Home: hardware back from a service page pops to
  // it (setTab pushes exactly one entry on top when leaving Home).
  history.replaceState({ home: true }, '');
  render();
  // The restored page paints instantly from empty state; hydrate it right after.
  if (state.user && state.tab !== 'rides' && state.tab !== 'home') setTab(state.tab).catch(() => {});
  else if (state.user && state.tab === 'home') hydrateHome({ force: true });
  if (payResult === 'success') {
    const amount = Number(params.get('amount'));
    toast(`Payment successful — Rs ${amount || ''} added to your wallet 💸`);
  } else if (payResult === 'failed') {
    toast(params.get('reason') || 'Payment failed — you were not charged.', true);
  }
})();

/* ==================================================================
   Shops — order from your neighbourhood general store
   ==================================================================
   The customer half of the kirana vertical: browse nearby shops, see
   what is actually on the shelf right now, and subscribe to the things
   you buy every week for a lower price.
*/

/* ---------------- baskets (one per shop, several at once) ---------------- */
/* A basket per shop, all alive at once: ADD from search, a category browse or
   any shop front and the right shop's basket grows — no "switch basket?"
   interruption, the floating .basket-bar carries them all around the tab.
   Lines snapshot name/price for the bar's running totals only — the shop front
   and the server both recompute from the live shelf, so a stale snapshot never
   mischarges anyone. */

const MAX_BASKETS = 5; // concurrent shops — enough for a real errand run

function basketQty(storeId, itemId) {
  const b = state.baskets[storeId];
  return b && b.items[itemId] ? b.items[itemId].qty : 0;
}

// Lines rolled up for ONE shop's basket.
function basketSummary(b) {
  const lines = b ? Object.values(b.items) : [];
  return {
    count: lines.reduce((n, l) => n + l.qty, 0),
    total: lines.reduce((n, l) => n + l.qty * l.price, 0)
  };
}

// Every basket rolled together, for the floating bar.
function basketsOverview() {
  const baskets = Object.values(state.baskets);
  let count = 0;
  let total = 0;
  for (const b of baskets) {
    const s = basketSummary(b);
    count += s.count;
    total += s.total;
  }
  return { baskets, count, total };
}

// The one write path: adding always lands in that shop's own basket.
function basketChange(store, item, delta) {
  let b = state.baskets[store.id];
  if (!b) {
    if (delta <= 0) return;
    if (Object.keys(state.baskets).length >= MAX_BASKETS) {
      return toast(`Baskets at ${MAX_BASKETS} shops is the limit — check one out first.`, true);
    }
    b = state.baskets[store.id] = { store, items: {} };
  }
  const line = b.items[item.id] || { id: item.id, name: item.name, price: item.price, qty: 0 };
  line.qty = Math.min(50, line.qty + delta);
  line.price = item.price; // freshest price we've seen wins
  if (line.qty <= 0) delete b.items[item.id];
  else b.items[item.id] = line;
  if (!Object.keys(b.items).length) delete state.baskets[store.id];
  render();
  if (delta > 0) {
    const bar = document.querySelector('.basket-bar');
    if (bar) bar.classList.add('bump'); // micro pop; onanimationend re-arms it
  }
}

// ADD pill ⇄ [− n +] stepper with the same footprint, so the swap on re-render
// reads as a morph. `fn` is a window handler name, `ids` its leading string
// args; the qty delta goes last.
function qtyControl(qty, fn, ids) {
  const call = (d) => `${fn}(${ids.map((x) => `'${x}'`).join(',')},${d})`;
  if (qty <= 0) return `<button class="add-btn" onclick="${call(1)}">ADD</button>`;
  return `
  <div class="stepper">
    <button onclick="${call(-1)}" aria-label="one less">−</button>
    <span class="n">${qty}</span>
    <button onclick="${call(1)}" aria-label="one more">+</button>
  </div>`;
}

// Floating pill hugging the bottom edge on every shops surface except a shop
// front with lines of its own (the full cartbar checkout takes over there).
// One basket: tapping opens that shop — the basket IS the shop. Several:
// tapping opens the all-baskets sheet, one section per shop.
function basketBar() {
  const { baskets, count, total } = basketsOverview();
  if (!baskets.length) return '';
  if (baskets.length === 1) {
    const b = baskets[0];
    return `
  <button class="basket-bar" onclick="openShopFront('${b.store.id}')" onanimationend="this.classList.remove('bump')">
    <span>${b.store.icon} ${count} item${count === 1 ? '' : 's'} · ${money(total)}</span>
    <span class="go">View basket →</span>
  </button>`;
  }
  return `
  <button class="basket-bar" onclick="openBasketsSheet()" onanimationend="this.classList.remove('bump')">
    <span>🧺 ${baskets.length} shops · ${count} item${count === 1 ? '' : 's'} · ${money(total)}</span>
    <span class="go">View baskets →</span>
  </button>`;
}

// All the baskets on one sheet: a section per shop with steppers, that shop's
// subtotal and a checkout button that jumps into its shop front — checkout
// itself stays per-shop, exactly as before.
function basketsSheet() {
  if (!state.basketsSheet) return '';
  const { baskets } = basketsOverview();
  if (!baskets.length) return '';
  return `
  <div class="offer-sheet" onclick="if (event.target === this) closeBasketsSheet()">
    <div class="card" style="max-height:80vh;overflow-y:auto">
      <div class="row" style="margin-bottom:4px">
        <div style="font-weight:900;font-size:17px">Your baskets 🧺</div>
        <button class="btn ghost compact" onclick="closeBasketsSheet()">Close</button>
      </div>
      ${baskets.map((b) => {
        const { count, total } = basketSummary(b);
        return `
      <div class="divider"></div>
      <div style="font-weight:900;margin-bottom:8px">${b.store.icon} ${esc(b.store.name)}</div>
      ${Object.values(b.items).map((l) => `
      <div class="row" style="margin-bottom:8px">
        <div class="grow">
          <div style="font-weight:700">${esc(l.name)}</div>
          <div class="muted small">${money(l.price)} each</div>
        </div>
        ${qtyControl(l.qty, 'sheetBasketAdd', [b.store.id, l.id])}
      </div>`).join('')}
      <button class="btn" style="margin-top:4px" onclick="checkoutBasket('${b.store.id}')">
        Checkout at ${esc(b.store.name)} · ${count} item${count === 1 ? '' : 's'} · ${money(total)}
      </button>`;
      }).join('')}
    </div>
  </div>`;
}

window.openBasketsSheet = () => { state.basketsSheet = true; render(); };

window.closeBasketsSheet = () => { state.basketsSheet = false; render(); };

// Steppers inside the sheet edit the line snapshots directly.
window.sheetBasketAdd = (storeId, itemId, delta) => {
  const b = state.baskets[storeId];
  const line = b && b.items[itemId];
  if (!line) return;
  basketChange(b.store, { id: line.id, name: line.name, price: line.price }, delta);
  if (!Object.keys(state.baskets).length) {
    state.basketsSheet = false; // last line of the last basket — drop the sheet
    render();
  }
};

// The sheet's per-shop checkout: into that shop front, where the cartbar takes over.
window.checkoutBasket = (storeId) => {
  state.basketsSheet = false;
  openShopFront(storeId);
};

// ADD straight from a search / category row — no need to open the shop first.
window.searchBasketAdd = (storeId, itemId, delta) => {
  const r = ((state.shopResults || {}).results || []).find((x) => x.storeId === storeId && x.itemId === itemId);
  if (!r) return;
  basketChange(
    { id: r.storeId, name: r.storeName, icon: r.storeIcon },
    { id: r.itemId, name: r.name, price: r.price },
    delta
  );
};

function shopsView() {
  if (state.shopReceipt) return shopReceiptView();
  if (state.shop) return shopDetailView();
  const orders = (state.shopOrders || []).filter((o) => o.status !== 'delivered' && o.status !== 'cancelled');
  const past = (state.shopOrders || []).filter((o) => o.status === 'delivered' || o.status === 'cancelled').slice(0, 6);
  const searching = !!(state.shopQuery || state.shopCategory);
  return `
  <div class="section-title" style="margin-top:0">What do you need? 🛒</div>
  <div class="card">
    <label class="field" style="margin:0"><span>Search every shop near you</span>
      <input id="shop-q" value="${esc(state.shopQuery || '')}" placeholder="chini, wai wai, sabun…"
        oninput="shopSearchTyped()" onkeydown="if(event.key==='Enter')runShopSearch()" />
    </label>
    ${state.located
      ? `<div class="muted small" style="margin-top:8px">📍 Showing shops within ${state.shopRadius || 3} km of you</div>`
      : `<button class="btn ghost compact" style="margin-top:8px" onclick="useMyLocationForShops()">📍 Use my location to find nearby shops</button>`}
  </div>

  ${(state.shopCategories || []).length ? `
  <div style="display:flex;gap:6px;overflow-x:auto;padding:10px 0">
    <button class="btn ${state.shopCategory ? 'ghost' : ''} compact" onclick="pickShopCategory('')">All</button>
    ${state.shopCategories.map((c) => `
      <button class="btn ${state.shopCategory === c.name ? '' : 'ghost'} compact" style="white-space:nowrap" onclick="pickShopCategory('${esc(c.name)}')">${esc(c.name)} ${c.count}</button>`).join('')}
  </div>` : ''}

  ${searching ? `
    <div class="row" style="margin:4px 0 10px">
      <div class="muted small">${state.shopResults ? `${state.shopResults.total ?? 'Many'} result${state.shopResults.total === 1 ? '' : 's'}` : 'Searching…'}</div>
      <div style="display:flex;gap:6px">
        <button class="btn ${state.shopSort !== 'cheap' ? '' : 'ghost'} compact" onclick="setShopSort('near')">Nearest</button>
        <button class="btn ${state.shopSort === 'cheap' ? '' : 'ghost'} compact" onclick="setShopSort('cheap')">Cheapest</button>
      </div>
    </div>
    ${(state.shopResults && state.shopResults.results.length)
      ? state.shopResults.results.map(productRow).join('') +
        (state.shopResults.hasMore ? `<button class="btn ghost" style="margin-top:8px" onclick="loadMoreShopResults()">Show more</button>` : '')
      : `<div class="empty"><div class="big">🔍</div>Nothing matching that is in stock nearby.</div>`}
    <div class="divider"></div>
  ` : ''}

  ${orders.length ? `
    <div class="section-title">Your orders</div>
    ${orders.map(shopOrderCard).join('')}
  ` : ''}

  ${past.length ? `
    <div class="section-title">Past orders 🧾</div>
    ${past.map(pastOrderRow).join('')}
  ` : ''}

  <div class="section-title">Shops near you 🏪</div>
  ${(state.shops || []).length
    ? state.shops.map(shopCard).join('')
    : `<div class="empty"><div class="big">🏪</div>No shops nearby yet — they are being added.</div>`}
  ${(state.subscriptions || []).length ? `
    <div class="section-title">Your subscriptions 🔁</div>
    ${state.subscriptions.map(subscriptionCard).join('')}` : ''}
  ${Object.keys(state.baskets).length ? '<div style="height:76px"></div>' : ''}
  ${basketBar()}
  ${basketsSheet()}`;
}

// One search hit, two actions: ADD drops the product straight into the basket,
// the store chip walks you into the shop it lives in.
function productRow(r) {
  const qty = basketQty(r.storeId, r.itemId);
  return `
  <div class="card">
    <div class="row">
      ${r.photo ? `<img src="${esc(r.photo)}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:10px" />` : ''}
      <div class="grow">
        <div style="font-weight:800">${esc(r.name)}</div>
        <div class="small"><b>${money(r.price)}</b> <span class="muted">per ${esc(r.unit === 'each' ? 'pc' : r.unit)}</span>${
          r.subscribePrice ? ` <span class="muted">· 🔁 ${money(r.subscribePrice)} for subscribers</span>` : ''}</div>
        ${r.lowStock ? `<div class="muted small" style="color:#fbbf24">only a few left</div>` : ''}
        <button class="link small" style="margin-top:4px" onclick="openShopFront('${r.storeId}')">
          ${r.storeIcon} ${esc(r.storeName)}${r.distanceKm !== null ? ` · ${r.distanceKm} km` : ''}${r.storeOpen ? '' : ' · closed'} ›
        </button>
      </div>
      ${r.storeOpen && r.inStock ? qtyControl(qty, 'searchBasketAdd', [r.storeId, r.itemId]) : ''}
    </div>
  </div>`;
}

function shopCard(s) {
  return `
  <div class="card" ${s.open ? `onclick="openShopFront('${s.id}')" style="cursor:pointer"` : ''}>
    <div class="row">
      <div class="grow">
        <div style="font-weight:900">${s.icon} ${esc(s.name)}</div>
        <div class="muted small">${esc(s.area || '')} · ${s.itemCount} items in stock${s.deliveryFee ? ` · ${money(s.deliveryFee)} delivery` : ' · free collection'}</div>
      </div>
      ${s.open ? '<span class="badge">OPEN</span>' : '<span class="badge gray">CLOSED</span>'}
    </div>
  </div>`;
}

function subscriptionCard(s) {
  const saving = s.listPrice - s.price;
  return `
  <div class="card">
    <div class="row">
      <div class="grow">
        <div style="font-weight:800">${esc(s.itemName)}</div>
        <div class="muted small">${esc(s.storeName)} · every ${s.everyDays} days${s.available ? '' : ' · not in stock now'}</div>
      </div>
      <div style="text-align:right">
        <div style="font-weight:900;color:var(--accent)">${money(s.price)}</div>
        ${saving > 0 ? `<div class="muted small">save ${money(saving)}</div>` : ''}
      </div>
    </div>
    <div style="display:flex;gap:6px;margin-top:10px">
      <button class="btn ghost compact" onclick="openShopFront('${s.storeId}')">Open shop</button>
      <button class="btn ghost compact danger" onclick="unsubscribeItem('${s.storeId}','${s.itemId}')">Cancel</button>
    </div>
  </div>`;
}

function shopOrderCard(o) {
  const pickup = o.fulfilment === 'pickup';
  const steps = {
    placed: 'Sent to the shop',
    accepted: 'Shopkeeper is packing',
    ready: pickup ? 'Packed and waiting — come collect it!' : 'Ready for you',
    collected: 'Courier is on the way',
    delivered: pickup ? 'Collected' : 'Done',
    cancelled: 'Cancelled'
  };
  return `
  <div class="card">
    <div class="row">
      <div class="grow">
        <div style="font-weight:800">${o.storeIcon || '🏪'} ${esc(o.storeName)}</div>
        <div class="muted small">${o.items.map((l) => `${l.qty}× ${esc(l.name)}`).join(', ')}${pickup ? ' · 🏃 pickup' : ''}</div>
        <div class="muted small" style="margin-top:4px;color:var(--accent)">${steps[o.status] || o.status}</div>
      </div>
      <div style="text-align:right">
        <div style="font-weight:900">${money(o.total)}</div>
        ${o.payment === 'cash' ? '<div class="muted small">💵 pay on handover</div>' : ''}
      </div>
    </div>
    ${pickup && o.status === 'ready' && o.pickupCode ? `
    <div class="code-card">
      <div class="muted small">Show this code at the counter</div>
      <div class="code">${esc(o.pickupCode)}</div>
    </div>` : ''}
    <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
      ${o.status === 'placed' ? `<button class="btn danger compact" onclick="cancelShopOrder('${o.id}')">Cancel order</button>` : ''}
      <button class="btn ghost compact" onclick="openShopReceipt('${o.id}')">🧾 Receipt</button>
    </div>
  </div>`;
}

// A finished order stays reachable — the receipt is often wanted days later.
function pastOrderRow(o) {
  const when = new Date(o.deliveredAt || o.cancelledAt || o.createdAt)
    .toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `
  <div class="card" onclick="openShopReceipt('${o.id}')" style="cursor:pointer">
    <div class="row">
      <div class="grow">
        <div style="font-weight:800">${o.storeIcon || '🏪'} ${esc(o.storeName)}</div>
        <div class="muted small">${when} · ${o.items.length} item${o.items.length === 1 ? '' : 's'}</div>
      </div>
      <div style="text-align:right">
        <div style="font-weight:900">${money(o.total)}</div>
        ${o.status === 'cancelled'
          ? '<span class="badge gray">CANCELLED</span>'
          : '<span class="badge">✓ DONE</span>'}
      </div>
    </div>
  </div>`;
}

window.openShopReceipt = (id) => {
  state.shopReceipt = (state.shopOrders || []).find((x) => x.id === id) || null;
  render();
  window.scrollTo(0, 0);
};

window.closeShopReceipt = () => {
  state.shopReceipt = null;
  render();
};

// The same paper-styled sheet the shopkeeper prints — the customer's copy.
// Every number was frozen onto the order at purchase time, so it stays right
// even after shelf prices change.
function shopReceiptView() {
  const o = state.shopReceipt;
  const delivered = o.status === 'delivered';
  const paidLine = o.payment === 'cash'
    ? (delivered ? 'Paid in cash' : 'To pay in cash on handover')
    : 'Paid from your SewaGo wallet';
  return `
  <div class="row no-print" style="margin-bottom:10px">
    <button class="btn ghost compact" style="width:auto" onclick="closeShopReceipt()">← Back</button>
    <button class="btn compact" style="width:auto" onclick="window.print()">🖨️ Print</button>
  </div>
  <div class="invoice-sheet">
    <div class="invoice-head">
      <div>
        <div style="font-size:19px;font-weight:900">${o.storeIcon || '🏪'} ${esc(o.storeName)}</div>
        ${o.deliveryLoc ? `<div class="invoice-muted">Delivered to: ${esc(o.deliveryLoc.name)}</div>` : `<div class="invoice-muted">Collected at the shop</div>`}
      </div>
      <div style="text-align:right">
        <div style="font-weight:900;letter-spacing:0.06em">RECEIPT</div>
        <div class="invoice-muted">#${esc(String(o.id).slice(-8).toUpperCase())}</div>
        <div class="invoice-muted">${new Date(o.createdAt).toLocaleString()}</div>
      </div>
    </div>
    <table class="invoice-table">
      <thead>
        <tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>
        ${o.items.map((l) => `
        <tr>
          <td>${esc(l.name)}${l.subscribed ? ' <span class="invoice-muted">🔁 subscriber price</span>' : ''}</td>
          <td class="num">${l.qty} ${esc(l.unit === 'each' ? 'pc' : l.unit)}</td>
          <td class="num">${money(l.price)}</td>
          <td class="num">${money(l.price * l.qty)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="invoice-totals">
      <div class="row"><div class="invoice-muted">Subtotal</div><div>${money(o.subtotal)}</div></div>
      ${o.deliveryFee ? `<div class="row"><div class="invoice-muted">Delivery fee</div><div>${money(o.deliveryFee)}</div></div>` : ''}
      ${o.serviceFee ? `<div class="row"><div class="invoice-muted">Service fee</div><div>${money(o.serviceFee)}</div></div>` : ''}
      <div class="row invoice-grand"><div>Total</div><div>${money(o.total)}</div></div>
      <div class="invoice-muted" style="margin-top:6px">${paidLine}${
        o.status === 'cancelled' ? ' · cancelled and refunded' : ''}${
        delivered && o.deliveredAt ? ` · ${new Date(o.deliveredAt).toLocaleString()}` : ''}</div>
    </div>
    <div class="invoice-muted" style="margin-top:16px;text-align:center">
      Thank you for ordering with SewaGo · sewago.app
    </div>
  </div>`;
}

function shopDetailView() {
  const s = state.shop;
  // This shop's persistent basket IS the cart; other shops' baskets stay put.
  const mine = state.baskets[s.store.id] || null;
  const cart = {};
  if (mine) for (const l of Object.values(mine.items)) cart[l.id] = l.qty;
  const lines = s.items.filter((i) => cart[i.id]);
  const subtotal = lines.reduce((sum, i) => sum + i.price * cart[i.id], 0);
  // Order from the sofa, collect at the counter: pickup skips the delivery fee.
  const canDeliver = (s.store.deliveryFee || 0) > 0;
  const fulfil = canDeliver && state.shopFulfil === 'delivery' ? 'delivery' : 'pickup';
  const fee = fulfil === 'delivery' ? s.store.deliveryFee : 0;
  const service = state.shopPay === 'cash' ? 0 : (state.shopServiceFee || 0);
  const total = subtotal + fee + service;
  return `
  <button class="btn ghost compact" onclick="closeShopFront()">← Shops</button>
  <div class="card" style="margin-top:10px">
    <div style="font-weight:900;font-size:17px">${s.store.icon} ${esc(s.store.name)}</div>
    <div class="muted small">${esc(s.store.area || '')}${fee ? ` · ${money(fee)} delivery` : ' · collect from the shop'}</div>
  </div>
  ${s.items.length ? s.items.map((i) => shopItemRow(i, cart[i.id] || 0)).join('')
    : `<div class="empty"><div class="big">📦</div>This shop has not added items yet.</div>`}
  <!-- Clearance for the fixed cart bar. It is opaque now, so the last shelf
       item must be able to scroll clear of it — delivery mode is tallest (it
       adds the address field), so reserve the most there. -->
  <div style="height:${lines.length ? (fulfil === 'delivery' ? 270 : canDeliver ? 224 : 178) : Object.keys(state.baskets).length ? 140 : 70}px"></div>
  ${lines.length ? `
  <div class="cartbar">
    ${canDeliver ? `
    <div class="grid2" style="margin-bottom:8px">
      <button class="btn ${fulfil === 'pickup' ? '' : 'ghost'} compact" onclick="setShopFulfil('pickup')">🏃 I'll collect — free</button>
      <button class="btn ${fulfil === 'delivery' ? '' : 'ghost'} compact" onclick="setShopFulfil('delivery')">🛵 Deliver · ${money(s.store.deliveryFee)}</button>
    </div>` : ''}
    ${fulfil === 'delivery' ? `
    <label class="field" style="margin:0 0 8px"><span>Deliver to</span>
      <input id="shop-deliver-to" placeholder="Landmark or address, e.g. Thamel" value="${esc(state.shopDeliverTo || '')}"
        oninput="shopDeliverTyped(this.value)" />
    </label>` : ''}
    <div class="grid2" style="margin-bottom:8px">
      <button class="btn ${state.shopPay !== 'cash' ? '' : 'ghost'} compact" onclick="setShopPay('wallet')">👛 Wallet</button>
      <button class="btn ${state.shopPay === 'cash' ? '' : 'ghost'} compact" onclick="setShopPay('cash')">💵 Cash</button>
    </div>
    <button class="btn" onclick="placeShopOrder()">
      Order ${lines.length} item${lines.length > 1 ? 's' : ''} · ${money(total)}
      <span class="small" style="font-weight:600">(${money(subtotal)} goods${fee ? ` + ${money(fee)} delivery` : ''}${service ? ` + ${money(service)} fee` : ''})</span>
    </button>
    ${fulfil === 'pickup' ? `<div class="muted small" style="text-align:center;margin-top:6px">Pack it while you walk over — show your code, grab it, go 🏃</div>` : ''}
  </div>` : basketBar() /* browsing shop B with baskets elsewhere: keep them a tap away */}
  ${basketsSheet()}`;
}

function shopItemRow(i, qty) {
  const saving = i.subscribePrice ? i.listPrice - i.subscribePrice : 0;
  return `
  <div class="card" style="${i.inStock ? '' : 'opacity:.55'}">
    <div class="row">
      ${i.photo ? `<img src="${esc(i.photo)}" alt="" style="width:52px;height:52px;object-fit:cover;border-radius:10px" />` : ''}
      <div class="grow">
        <div style="font-weight:800">${esc(i.name)}</div>
        <div class="muted small">
          ${money(i.price)} / ${esc(i.unitLabel)}
          ${i.subscribed ? ' · <span style="color:var(--accent)">🔁 subscriber price</span>' : ''}
          ${!i.inStock ? ' · out of stock' : i.lowStock ? ' · only a few left' : ''}
        </div>
        ${!i.subscribed && i.subscribePrice ? `
          <button class="link small" style="margin-top:4px" onclick="subscribeItem('${i.id}')">
            🔁 Subscribe — ${money(i.subscribePrice)} for subscribers, save ${money(saving)}
          </button>` : ''}
        ${!i.subscribePrice ? (i.subscribeRequested
          ? `<div class="small" style="margin-top:4px;color:var(--accent)">Requested ✓ — we'll tell you when the shop makes an offer</div>`
          : `<button class="link small" style="margin-top:4px;color:var(--muted)" onclick="requestSubscription('${i.id}')">🔁 Request a subscriber price</button>`) : ''}
      </div>
      ${i.inStock ? qtyControl(qty, 'shopCartAdd', [i.id]) : ''}
    </div>
  </div>`;
}

window.openShopFront = async (id) => {
  try {
    const data = await api(`/api/stores/${id}`);
    state.shop = data;
    state.shopFulfil = 'pickup';
    state.shopServiceFee = data.serviceFee || 0;
    // The shelf is authoritative: sync this shop's basket snapshots to it
    // (renames, price changes) and drop lines the shop no longer sells or has
    // run out of. Other shops' baskets are untouched.
    const b = state.baskets[data.store.id];
    if (b) {
      for (const l of Object.values(b.items)) {
        const live = data.items.find((i) => i.id === l.id);
        if (!live || !live.inStock) delete b.items[l.id];
        else { l.name = live.name; l.price = live.price; }
      }
      if (!Object.keys(b.items).length) delete state.baskets[data.store.id];
    }
    render();
  } catch (e) { toast(e.message, true); }
};

// The baskets survive leaving the shop — the floating bar keeps carrying them.
window.closeShopFront = () => { state.shop = null; render(); };

window.shopCartAdd = (itemId, delta) => {
  const s = state.shop;
  const i = s && s.items.find((x) => x.id === itemId);
  if (!i) return;
  basketChange(
    { id: s.store.id, name: s.store.name, icon: s.store.icon },
    { id: i.id, name: i.name, price: i.price },
    delta
  );
};

window.setShopPay = (how) => { state.shopPay = how; render(); };

window.setShopFulfil = (how) => { state.shopFulfil = how; render(); };

// No render — a re-render per keystroke would steal focus from the input.
window.shopDeliverTyped = (value) => { state.shopDeliverTo = value; };

window.subscribeItem = async (itemId) => {
  try {
    await api(`/api/stores/${state.shop.store.id}/items/${itemId}/subscribe`, { method: 'POST', body: { everyDays: 7 } });
    await openShopFront(state.shop.store.id);
    await loadSubscriptions();
    toast('Subscribed — you now pay the lower price 🔁');
  } catch (e) { toast(e.message, true); }
};

// Ask the shop to put a subscriber price on an item that has none yet. The
// answer comes back over SSE (topic 'subscription') whenever the shop decides.
window.requestSubscription = async (itemId) => {
  try {
    await api(`/api/stores/${state.shop.store.id}/items/${itemId}/subscribe-request`, { method: 'POST' });
    const item = state.shop.items.find((i) => i.id === itemId);
    if (item) item.subscribeRequested = true;
    toast('Asked the shop for a subscriber price 🔁 — we\'ll tell you when they answer.');
    render();
  } catch (e) { toast(e.message, true); }
};

window.unsubscribeItem = async (storeId, itemId) => {
  try {
    await api(`/api/stores/${storeId}/items/${itemId}/subscribe`, { method: 'DELETE' });
    await loadSubscriptions();
    toast('Subscription cancelled.');
    render();
  } catch (e) { toast(e.message, true); }
};

async function loadSubscriptions() {
  try {
    const d = await api('/api/subscriptions');
    state.subscriptions = d.subscriptions || [];
  } catch (e) { state.subscriptions = []; }
}

window.placeShopOrder = async () => {
  const storeId = state.shop.store.id;
  const mine = state.baskets[storeId] || null;
  const items = mine ? Object.values(mine.items).map((l) => ({ itemId: l.id, qty: l.qty })) : [];
  if (!items.length) return;
  const canDeliver = (state.shop.store.deliveryFee || 0) > 0;
  const fulfilment = canDeliver && state.shopFulfil === 'delivery' ? 'delivery' : 'pickup';
  const body = { storeId, items, payment: state.shopPay === 'cash' ? 'cash' : 'wallet', fulfilment };
  if (fulfilment === 'delivery') {
    const where = (state.shopDeliverTo || '').trim();
    if (!where) return toast('Where should we deliver? Add a landmark or address.', true);
    body.deliverTo = where;
  }
  try {
    const data = await api('/api/store-orders', { method: 'POST', body });
    if (data.user) setUser(data.user);
    state.shop = null;
    delete state.baskets[storeId]; // only this shop's basket clears — the rest keep waiting
    const o = await api('/api/store-orders');
    state.shopOrders = o.orders || [];
    toast(fulfilment === 'pickup' ? 'Order sent — we\'ll tell you when it\'s packed 🏪' : 'Order sent to the shop 🏪');
    render();
  } catch (e) { toast(e.message, true); }
};

window.cancelShopOrder = async (id) => {
  try {
    const data = await api(`/api/store-orders/${id}/cancel`, { method: 'POST' });
    if (data.user) setUser(data.user);
    const o = await api('/api/store-orders');
    state.shopOrders = o.orders || [];
    toast('Order cancelled and refunded.');
    render();
  } catch (e) { toast(e.message, true); }
};

/* ---------------- marketplace search ---------------- */

// The customer's own position, when they've shared it. Everything degrades to a
// distance-less list rather than failing if they haven't.
function shopGeoParams() {
  const p = [];
  if (state.myLoc) {
    p.push(`lat=${state.myLoc.lat}`, `lng=${state.myLoc.lng}`, `radiusKm=${state.shopRadius || 3}`);
  }
  return p.join('&');
}

window.useMyLocationForShops = () => {
  if (!navigator.geolocation) return toast('This phone cannot share location.', true);
  toast('Finding you…');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    state.myLoc = { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6) };
    state.located = true;
    await refreshShops();
    render();
  }, () => toast('Could not get your location — allow it in your browser.', true), { enableHighAccuracy: true, timeout: 10000 });
};

async function refreshShops() {
  const geo = shopGeoParams();
  const [s, c] = await Promise.all([
    api(`/api/stores?${geo}`),
    api(`/api/store-categories?${geo}`).catch(() => ({ categories: [] }))
  ]);
  state.shops = s.stores || [];
  state.located = !!s.located;
  state.shopServiceFee = s.serviceFee || 0;
  state.shopCategories = c.categories || [];
  if (state.shopQuery || state.shopCategory) await runShopSearchNow(1);
}

// Debounced so typing doesn't fire a request per keystroke.
window.shopSearchTyped = () => {
  const el = $('#shop-q');
  state.shopQuery = el ? el.value : '';
  clearTimeout(state._shopSearchTimer);
  state._shopSearchTimer = setTimeout(() => runShopSearchNow(1).then(() => render()), 250);
};

window.runShopSearch = () => runShopSearchNow(1).then(() => render());

async function runShopSearchNow(page) {
  const q = state.shopQuery || '';
  const cat = state.shopCategory || '';
  if (!q && !cat) { state.shopResults = null; return; }
  const params = [
    `q=${encodeURIComponent(q)}`,
    cat ? `category=${encodeURIComponent(cat)}` : '',
    `sort=${state.shopSort || 'near'}`,
    `page=${page}`,
    shopGeoParams()
  ].filter(Boolean).join('&');
  try {
    const data = await api(`/api/store-search?${params}`);
    if (page > 1 && state.shopResults) {
      data.results = [...state.shopResults.results, ...data.results];
    }
    state.shopResults = data;
    state.shopPage = page;
  } catch (e) { toast(e.message, true); }
}

window.loadMoreShopResults = async () => {
  await runShopSearchNow((state.shopPage || 1) + 1);
  render();
};

window.pickShopCategory = async (name) => {
  state.shopCategory = state.shopCategory === name ? '' : name;
  await runShopSearchNow(1);
  render();
};

window.setShopSort = async (sort) => {
  state.shopSort = sort;
  await runShopSearchNow(1);
  render();
};
