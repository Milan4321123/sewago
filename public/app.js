/* SewaGo — rides · food · stays (single-page app) */

const $ = (sel) => document.querySelector(sel);

const state = {
  token: localStorage.getItem('sewago_token'),
  user: null,
  tab: 'rides',
  authMode: 'login',
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
  dismissedOrders: {},
  restaurant: null, // currently open menu
  cart: {}, // itemId -> qty
  orders: [],
  // stays
  staySearch: { city: 'All', checkIn: '', checkOut: '' },
  hotels: null,
  bookings: [],
  cities: [],
  // payments
  txns: [],
  payUi: null,
  payment: null,
  // tasks
  tasksBoard: [],
  myTasks: { posted: [], working: [] },
  showTaskForm: false,
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
      <div class="logo">🛺</div>
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
      <button class="btn" onclick="submitAuth()">${isLogin ? 'Log in' : 'Create account — get Rs 5,000 free credit'}</button>
      ${isLogin ? `<button class="btn ghost" style="margin-top:8px" onclick="setAuthMode('otp')">Log in with phone OTP</button>` : ''}
      <div style="text-align:center;margin-top:14px">
        <button class="link" onclick="toggleAuthMode()">
          ${isLogin ? "New here? Create an account" : 'Already have an account? Log in'}
        </button>
      </div>
      ${isLogin ? `<div style="text-align:center;margin-top:10px"><button class="link" onclick="setAuthMode('reset')">Forgot password?</button></div>` : ''}
    </div>
    ${isLogin ? `
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
  state.tab = 'rides';
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

const TABS = [
  { id: 'rides', label: 'Rides', ico: '🚗' },
  { id: 'food', label: 'Food', ico: '🍜' },
  { id: 'stays', label: 'Stays', ico: '🏨' },
  { id: 'tasks', label: 'Tasks', ico: '🧰' },
  { id: 'activity', label: 'Activity', ico: '🧾' },
  { id: 'profile', label: 'Profile', ico: '👤' }
];

function render() {
  const app = $('#app');
  if (!state.user) {
    app.innerHTML = authView();
    return;
  }
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">Sewa<em>Go</em></div>
      <div class="wallet-chip" id="wallet-chip">👛 ${money(state.user.wallet)}</div>
    </header>
    <main id="view"></main>
    <nav class="tabbar">
      ${TABS.map((t) => `
        <button class="${state.tab === t.id ? 'active' : ''}" onclick="setTab('${t.id}')">
          <span class="ico">${t.ico}</span>${t.label}
        </button>`).join('')}
    </nav>`;
  renderTab();
}

function renderTab() {
  const view = $('#view');
  if (state.tab === 'rides') {
    view.innerHTML = ridesView();
    state._rideKey = rideKey();
    mountRideMap(state.activeRide);
    return;
  }
  if (state.tab === 'food') view.innerHTML = foodView();
  else if (state.tab === 'stays') view.innerHTML = staysView();
  else if (state.tab === 'tasks') view.innerHTML = tasksView();
  else if (state.tab === 'activity') view.innerHTML = activityView();
  else view.innerHTML = profileView();
}

window.setTab = async (tab) => {
  state.tab = tab;
  state.restaurant = null;
  try {
    if (tab === 'food') {
      const [r, o] = await Promise.all([api('/api/restaurants'), api('/api/orders')]);
      state.restaurants = r.restaurants;
      state.foodServiceFee = r.serviceFee || 0;
      state.deliveryFreeKm = r.deliveryFreeKm ?? 3;
      state.deliveryPerKm = r.deliveryPerKm ?? 15;
      state.orders = o.orders;
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
        <div class="muted small">${o.etaMin} min · ${o.seats} seat${o.seats > 1 ? 's' : ''}</div>
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
          : 'Matching you with a nearby driver…'}</div>`
      : d ? `<div class="row">
          <div>
            <div><b>${esc(d.name)}</b> <span class="badge">★ ${d.rating}</span></div>
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
  L.polyline([pk, dp], { color: '#22c55e', weight: 3, opacity: 0.45, dashArray: '6 8' }).addTo(map);
  let driverMarker = null;
  if (ride.driverCoords) {
    driverMarker = L.marker([ride.driverCoords.lat, ride.driverCoords.lng], { icon: emojiIcon(ride.icon || '🚗', 26) }).addTo(map);
  }
  const bounds = L.latLngBounds([pk, dp]);
  if (ride.driverCoords) bounds.extend([ride.driverCoords.lat, ride.driverCoords.lng]);
  map.fitBounds(bounds.pad(0.25));
  rideMapRefs = { map, driverMarker, icon: ride.icon || '🚗' };
}

function updateRideMap(ride) {
  if (!rideMapRefs || !ride || !ride.driverCoords) return;
  const pos = [ride.driverCoords.lat, ride.driverCoords.lng];
  if (rideMapRefs.driverMarker) rideMapRefs.driverMarker.setLatLng(pos);
  else rideMapRefs.driverMarker = L.marker(pos, { icon: emojiIcon(rideMapRefs.icon, 26) }).addTo(rideMapRefs.map);
}

function rideKey() {
  const r = state.activeRide;
  return r ? r.id + ':' + r.status : (state.fare ? 'fare' : 'form');
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

function foodView() {
  if (state.restaurant) return menuView();
  return `
    <div id="orders-slot">${ordersSlot()}</div>
    <div class="section-title">Hungry? Order in 🍜</div>
    ${state.restaurants.map((r) => `
      <div class="tile" onclick="openRestaurant('${r.id}')">
        <span class="emoji">${r.icon}</span>
        <div>
          <h3>${esc(r.name)}${r.promotedUntil > Date.now() ? ' <span class="badge" style="background:#713f12;color:#fde68a">⭐ Featured</span>' : ''}</h3>
          <div class="sub">${esc(r.cuisine)} · ${r.etaMinutes} min · ${money(r.deliveryFee)} delivery</div>
        </div>
        <div class="right"><span class="badge">${r.rating ? '★ ' + r.rating : 'NEW'}</span></div>
      </div>`).join('')}`;
}

function ordersSlot() {
  // Fresh deliveries stay on screen until rated (or skipped) — one tap keeps
  // restaurant ratings honest without nagging.
  const active = state.orders.filter((o) =>
    (o.status !== 'delivered' && o.status !== 'cancelled') ||
    (o.status === 'delivered' && !o.ratingStars && !state.dismissedOrders[o.id] &&
      Date.now() - (o.deliveredAt || 0) < 60 * 60 * 1000));
  if (active.length === 0) return '';
  return `<div class="section-title">Your orders, live 🔴</div>` + active.map((o) => {
    const idx = ORDER_STEP_IDX[o.status] ?? 0;
    return `
    <div class="card">
      <div class="row">
        <div>
          <div><b>${o.restaurantIcon} ${esc(o.restaurantName)}</b></div>
          <div class="muted small">${o.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}</div>
        </div>
        <div><b>${money(o.total)}</b></div>
      </div>
      ${o.fulfillment === 'live' && o.status === 'placed'
        ? `<div class="muted small" style="margin:8px 0">🕐 Waiting for ${esc(o.restaurantName)} to confirm your order…</div>` : ''}
      ${stepper(ORDER_STEPS, idx)}
      ${o.courier ? `<div class="muted small" style="margin-top:8px">🛵 ${esc(o.courier.name)} is your courier · ${esc(o.courier.vehicle)} (${esc(o.courier.plate)})</div>` : ''}
      ${o.deliveryLoc ? `<div class="muted small" style="margin-top:4px">📍 Delivering to ${esc(o.deliveryLoc.name)}</div>` : ''}
      ${o.status === 'placed' ? `<button class="btn danger" style="margin-top:12px" onclick="cancelOrder('${o.id}')">Cancel order</button>` : ''}
      ${o.status === 'delivered' && !o.ratingStars ? `
      <div class="divider"></div>
      <div style="text-align:center"><b>How was the food?</b></div>
      <div class="stars">
        ${[1, 2, 3, 4, 5].map((n) => `<button onclick="rateOrder('${o.id}', ${n})">⭐</button>`).join('')}
      </div>
      <button class="btn ghost" style="margin-top:6px" onclick="dismissOrderRating('${o.id}')">Skip</button>` : ''}
    </div>`;
  }).join('');
}

window.rateOrder = async (id, stars) => {
  try {
    await api(`/api/orders/${id}/rate`, { method: 'POST', body: { stars } });
    const order = state.orders.find((o) => o.id === id);
    if (order) order.ratingStars = stars;
    toast('Thanks for the rating! ' + '⭐'.repeat(stars));
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
  return { fee: base + Math.min(300, extraKm * (state.deliveryPerKm ?? 15)), exact: true };
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
  const serviceFee = state.foodServiceFee || 0;
  const delivery = estimatedDeliveryFee(r);
  return { count, subtotal, serviceFee, deliveryFee: delivery.fee, deliveryExact: delivery.exact, total: subtotal + delivery.fee + serviceFee };
}

function menuView() {
  const r = state.restaurant;
  const { count, total, deliveryFee, deliveryExact } = cartTotals();
  return `
  <div class="row" style="margin-bottom:14px">
    <button class="btn ghost compact" onclick="closeMenu()">← Back</button>
    <span class="badge">${r.rating ? '★ ' + r.rating : 'NEW'} · ${r.etaMinutes} min</span>
  </div>
  <div class="card">
    <div class="row">
      <div>
        <div style="font-size:19px;font-weight:900">${r.icon} ${esc(r.name)}</div>
        <div class="muted small">${esc(r.cuisine)} · delivery ${money(r.deliveryFee)}</div>
      </div>
    </div>
  </div>
  ${r.menu.map((m) => {
    const qty = state.cart[m.id] || 0;
    return `
    <div class="card">
      <div class="row">
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
    </div>`;
  }).join('')}
  ${r.ownerId && count > 0 ? `
  <div class="card">
    <label class="field"><span>Deliver to</span>
      <input id="deliver-to" list="deliver-places" value="${esc(state.deliverTo || '')}"
        placeholder="e.g. Thamel, New Baneshwor…" oninput="deliveryAddressTyped()" onchange="deliveryAddressChosen()" />
    </label>
    <datalist id="deliver-places">${(state.places || []).map((p) => `<option value="${esc(p.name)}"></option>`).join('')}</datalist>
    <button class="btn ghost compact" onclick="useGpsForDelivery()">📍 Use my location</button>
  </div>` : ''}
  <div style="height:70px"></div>
  ${count > 0 ? `
  <div class="cartbar">
    <button class="btn" onclick="placeOrder()">
      Place order · ${count} item${count > 1 ? 's' : ''} · ${money(total)}
      <span class="small" style="font-weight:600">(incl. ${money(deliveryFee)}${deliveryExact ? '' : '+'} delivery${
        state.foodServiceFee ? ` + ${money(state.foodServiceFee)} service fee` : ''})</span>
    </button>
  </div>` : ''}`;
}

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
  const addressInput = $('#deliver-to');
  const typed = addressInput ? addressInput.value.trim() : '';
  if (state.restaurant.ownerId && !typed && !state.deliverToLoc) {
    return toast('Add a delivery location so the courier knows where to go.', true);
  }
  const deliveryTo = state.deliverToLoc && state.deliverToLoc.name === typed ? state.deliverToLoc : typed;
  try {
    const data = await api('/api/orders', {
      method: 'POST',
      body: { restaurantId: state.restaurant.id, items, deliveryTo }
    });
    setUser(data.user);
    state.restaurant = null;
    state.cart = {};
    const o = await api('/api/orders');
    state.orders = o.orders;
    toast('Order placed! The kitchen is on it 👨‍🍳');
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
      <div class="row">
        <div>
          <div style="font-weight:900">${h.icon} ${esc(h.name)}${h.promotedUntil > Date.now() ? ' <span class="badge" style="background:#713f12;color:#fde68a">⭐ Featured</span>' : ''}</div>
          <div class="muted small">${esc(h.area)}${h.area ? ', ' : ''}${esc(h.city)}${h.desc ? ' · ' + esc(h.desc) : ''}</div>
        </div>
        <span class="badge">${h.rating ? '★ ' + h.rating : 'NEW'}</span>
      </div>
      <div class="divider"></div>
      ${h.rooms.map((room) => `
        <div class="row" style="margin-bottom:12px">
          <div class="grow">
            <div><b>${esc(room.type)}</b> <span class="muted small">· sleeps ${room.sleeps}</span></div>
            <div style="margin:4px 0 2px">${room.amenities.map((a) => `<span class="amenity">${esc(a)}</span>`).join('')}</div>
            <div class="small"><b>${money(room.pricePerNight)}</b><span class="muted"> /night · ${money(room.pricePerNight * nights)} total</span></div>
          </div>
          ${room.available > 0
            ? `<button class="btn compact" style="width:auto" onclick="bookRoom('${h.id}','${room.id}')">Book</button>`
            : `<span class="badge red">Sold out</span>`}
        </div>`).join('')}
    </div>`).join('');
}

function bookingsSection() {
  const active = state.bookings.filter((b) => b.status === 'active');
  if (active.length === 0) return '';
  return `<div class="section-title">Your bookings 🧳</div>` + active.map((b) => `
    <div class="card">
      <div class="row">
        <div>
          <div><b>${b.hotelIcon} ${esc(b.hotelName)}</b> <span class="muted small">· ${esc(b.city)}</span></div>
          <div class="muted small">${esc(b.roomType)} · ${b.checkIn} → ${b.checkOut} (${b.nights} night${b.nights > 1 ? 's' : ''})</div>
        </div>
        <div><b>${money(b.total)}</b></div>
      </div>
      <button class="btn danger" style="margin-top:12px" onclick="cancelBooking('${b.id}')">Cancel (full refund)</button>
    </div>`).join('');
}

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
          <div class="muted small">${t.place ? '📍 ' + esc(t.place) + ' · ' : ''}budget ${money(t.budget)}${t.workerName ? ' · 🙋 ' + esc(t.workerName) : ''}</div>
        </div>
        ${taskBadge(t.status)}
      </div>
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
          <div class="muted small">by ${esc(t.posterName)}${t.place ? ' · 📍 ' + esc(t.place) : ''}</div>
          ${t.desc ? `<div class="muted small">${esc(t.desc)}</div>` : ''}
        </div>
        <div style="text-align:right">
          <div style="color:var(--accent);font-weight:900">earn ${money(t.workerPayout)}</div>
          <div class="muted small">budget ${money(t.budget)}</div>
        </div>
      </div>
      <button class="btn" style="margin-top:12px" onclick="acceptTask('${t.id}')">Accept this job</button>
    </div>`).join('')}`;
}

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
        budget: $('#t-budget').value
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

window.acceptTask = async (id) => {
  try {
    await api(`/api/tasks/${id}/accept`, { method: 'POST' });
    await refreshTasks();
    toast('Job accepted — it\'s yours! 💪');
    render();
  } catch (e) {
    toast(e.message, true);
    refreshTasks().then(render).catch(() => {});
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
  </div>`;
}

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
      <button class="btn" onclick="openPay('topup')">➕ Add money</button>
      <button class="btn ghost" onclick="openPay('withdraw')">🏦 Withdraw</button>
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
function connectEvents() {
  if (!state.token || typeof EventSource === 'undefined') return;
  disconnectEvents();
  sseSource = new EventSource('/api/events?role=user&token=' + encodeURIComponent(state.token));
  sseSource.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.topic === 'ride') syncActiveRideUI().catch(() => {});
    if (msg.topic === 'order' && state.tab === 'food') {
      api('/api/orders').then((o) => { state.orders = o.orders; render(); }).catch(() => {});
    }
  };
  // EventSource reconnects on its own; nothing to do on error.
}
function disconnectEvents() {
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
    }
    if (state.tab === 'food' && !state.restaurant &&
        state.orders.some((o) => o.status !== 'delivered' && o.status !== 'cancelled')) {
      const o = await api('/api/orders');
      state.orders = o.orders;
      const slot = $('#orders-slot');
      if (slot) slot.innerHTML = ordersSlot();
    }
    // Tasks are two-sided: refresh while watching the board (but never wipe the post form).
    if (state.tab === 'tasks' && !state.showTaskForm) {
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

(async function boot() {
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
  render();
  if (payResult === 'success') {
    const amount = Number(params.get('amount'));
    toast(`Payment successful — Rs ${amount || ''} added to your wallet 💸`);
  } else if (payResult === 'failed') {
    toast(params.get('reason') || 'Payment failed — you were not charged.', true);
  }
})();
