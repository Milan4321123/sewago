/* SewaGo Driver — accept and run ride requests */

const $ = (sel) => document.querySelector(sel);

const state = {
  token: localStorage.getItem('sewago_driver_token'),
  driver: null,
  authMode: 'login',
  resetToken: '',
  otpLogin: { phone: '', devCode: '' },
  job: null,
  requests: [],
  delivery: null,
  deliveries: [],
  history: [],
  locationWatchId: null,
  locationBusy: false,
  locationError: '',
  showWithdraw: false,
  _uiKey: null
};

const TIER_META = {
  bike: { label: 'Bike', icon: '🏍️' },
  car: { label: 'Car', icon: '🚗' },
  xl: { label: 'XL', icon: '🚐' }
};

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
  if (res.status === 401 && state.driver) {
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

function locationFresh(driver = state.driver) {
  return !!driver && !!driver.locationFresh;
}

function locationLine(driver = state.driver) {
  if (!driver) return '';
  if (locationFresh(driver)) {
    const acc = driver.locationAccuracy ? ` · ±${driver.locationAccuracy}m` : '';
    // Show the coordinates the server actually received and how old they are,
    // so a tester can watch their live position land update by update.
    const coords = driver.currentLat != null && driver.currentLng != null
      ? ` · 📍 ${driver.currentLat.toFixed(5)}, ${driver.currentLng.toFixed(5)}`
      : '';
    const age = driver.locationUpdatedAt
      ? ` · updated ${Math.max(0, Math.round((Date.now() - driver.locationUpdatedAt) / 1000))}s ago`
      : '';
    return `Live GPS active${acc}${coords}${age}`;
  }
  return 'Live GPS needed before going online';
}

function verificationBadge(driver = state.driver) {
  if (!driver) return '';
  if (driver.licenseVerified) return `<span class="badge">✓ LICENSE VERIFIED${driver.licenseLast4 ? ' · ID ***' + esc(driver.licenseLast4) : ''}</span>`;
  return `<span class="badge amber">LICENSE PENDING</span>`;
}

function phoneBadge(driver = state.driver) {
  if (!driver) return '';
  return `<span class="badge ${driver.phoneVerified ? '' : 'amber'}">${driver.phoneVerified ? '✓ PHONE VERIFIED' : 'PHONE NEEDED'}</span>`;
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser does not support GPS location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 10000,
      timeout: 12000
    });
  });
}

async function sendLocation(position) {
  const coords = position.coords || {};
  const data = await api('/api/driver/location', {
    method: 'POST',
    body: {
      lat: coords.latitude,
      lng: coords.longitude,
      accuracy: coords.accuracy
    }
  });
  state.driver = data.driver;
  state.job = data.job || state.job;
  state.locationError = '';
  // Patch the GPS status line in place (a full render would steal input focus).
  const line = $('#gps-line');
  if (line) line.textContent = locationLine(state.driver);
  return data;
}

async function ensureLocation() {
  state.locationBusy = true;
  try {
    const position = await getPosition();
    const data = await sendLocation(position);
    return data;
  } finally {
    state.locationBusy = false;
  }
}

function startLocationWatch(silent = false) {
  if (!navigator.geolocation || state.locationWatchId != null) return;
  state.locationWatchId = navigator.geolocation.watchPosition(
    (position) => {
      sendLocation(position).catch(() => {});
    },
    (err) => {
      state.locationError = err.message || 'Could not read GPS location.';
      if (!silent) toast(state.locationError, true);
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 12000 }
  );
}

function stopLocationWatch() {
  if (state.locationWatchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(state.locationWatchId);
  }
  state.locationWatchId = null;
}

/* ---------------- auth views ---------------- */

function authView() {
  const isLogin = state.authMode === 'login';
  if (state.authMode === 'reset') {
    return `
    <div class="auth-wrap">
      <div class="auth-hero">
        <div class="logo">🔐</div>
        <h1>Driver password</h1>
        <p>Reset your driver app password.</p>
      </div>
      <div class="card">
        <label class="field"><span>Email</span><input id="d-reset-email" type="email" placeholder="you@sewago.app" /></label>
        <button class="btn" onclick="driverRequestPasswordReset()">Send reset token</button>
        ${state.resetToken ? `<div class="muted small" style="margin-top:10px">Sandbox token: <b style="color:var(--text)">${esc(state.resetToken)}</b></div>` : ''}
        <div class="divider"></div>
        <label class="field"><span>Reset token</span><input id="d-reset-token" value="${esc(state.resetToken)}" placeholder="Paste token" /></label>
        <label class="field"><span>New password</span><input id="d-reset-password" type="password" placeholder="At least 6 characters" /></label>
        <button class="btn" onclick="driverCompletePasswordReset()">Change password</button>
        <button class="btn ghost" style="margin-top:8px" onclick="setAuthMode('login')">Back to login</button>
      </div>
    </div>`;
  }
  if (state.authMode === 'otp') {
    return `
    <div class="auth-wrap">
      <div class="auth-hero">
        <div class="logo">📲</div>
        <h1>Driver phone login</h1>
        <p>Use the mobile number registered to your driver account.</p>
      </div>
      <div class="card">
        <label class="field"><span>Mobile number</span>
          <input id="d-otp-phone" value="${esc(state.otpLogin.phone)}" placeholder="e.g. +9779841000000" autocomplete="tel" />
        </label>
        <button class="btn" onclick="driverRequestOtpLogin()">Send code</button>
        ${state.otpLogin.devCode ? `<div class="muted small" style="margin-top:10px">Sandbox OTP: <b style="color:var(--text)">${esc(state.otpLogin.devCode)}</b></div>` : ''}
        <div class="divider"></div>
        <label class="field"><span>OTP code</span>
          <input id="d-otp-code" inputmode="numeric" placeholder="123456" autocomplete="one-time-code" />
        </label>
        <button class="btn" onclick="driverVerifyOtpLogin()">Continue</button>
        <button class="btn ghost" style="margin-top:8px" onclick="setAuthMode('login')">Back to email login</button>
      </div>
    </div>`;
  }
  return `
  <div class="auth-wrap">
    <div class="auth-hero">
      <div class="logo">🛵</div>
      <h1>Sewa<em>Go</em> Driver</h1>
      <p>Go online, accept requests, earn 80% of every fare.</p>
    </div>
    <div class="card">
      ${isLogin ? '' : `
      <label class="field"><span>Full name</span>
        <input id="d-name" placeholder="e.g. Ram Bahadur" />
      </label>`}
      <label class="field"><span>Email</span>
        <input id="d-email" type="email" placeholder="you@sewago.app" />
      </label>
      <label class="field"><span>Password</span>
        <input id="d-password" type="password" placeholder="At least 6 characters" />
      </label>
      ${isLogin ? '' : `
      <label class="field"><span>Phone</span>
        <input id="d-phone" placeholder="e.g. 9841000000" />
      </label>
      <label class="field"><span>Vehicle type</span>
        <select id="d-tier">
          <option value="bike">🏍️ Bike</option>
          <option value="car">🚗 Car</option>
          <option value="xl">🚐 XL (van / SUV)</option>
        </select>
      </label>
      <div class="grid2">
        <label class="field"><span>Vehicle</span>
          <input id="d-vehicle" placeholder="e.g. Honda Shine" />
        </label>
        <label class="field"><span>Plate no.</span>
          <input id="d-plate" placeholder="e.g. BA 1 PA 2345" />
        </label>
      </div>
      <label class="field"><span>License ID</span>
        <input id="d-license" placeholder="e.g. 01-23-456789" />
      </label>
      <label class="field"><span>One-time license code</span>
        <input id="d-license-code" placeholder="Demo code: 123456" />
      </label>`}
      <button class="btn" onclick="submitAuth()">${isLogin ? 'Log in' : 'Join as a driver'}</button>
      ${isLogin ? `<button class="btn ghost" style="margin-top:8px" onclick="setAuthMode('otp')">Log in with phone OTP</button>` : ''}
      <div style="text-align:center;margin-top:14px">
        <button class="link" onclick="toggleAuthMode()">
          ${isLogin ? 'New driver? Join SewaGo' : 'Already registered? Log in'}
        </button>
      </div>
      ${isLogin ? `<div style="text-align:center;margin-top:10px"><button class="link" onclick="setAuthMode('reset')">Forgot password?</button></div>` : ''}
    </div>
    ${isLogin ? `
    <div class="card">
      <div class="muted small" style="line-height:1.8">
        <b style="color:var(--text)">Demo driver accounts</b> (password: <b style="color:var(--text)">driver123</b>)<br/>
        🏍️ ramesh@sewago.app · 🚗 sita@sewago.app · 🚐 dipesh@sewago.app<br/>
        Demo seeded: 🏍️ bijay.demo@sewago.app · 🚗 tara.demo@sewago.app · 🚐 om.demo@sewago.app
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

async function completeDriverAuth(data) {
  state.token = data.token;
  state.driver = data.driver;
  state.otpLogin = { phone: '', devCode: '' };
  localStorage.setItem('sewago_driver_token', data.token);
  toast(`Welcome, ${data.driver.name.split(' ')[0]}! 🛵`);
  await refresh();
  connectEvents();
  render();
}

window.submitAuth = async () => {
  const email = $('#d-email').value.trim();
  const password = $('#d-password').value;
  try {
    let data;
    if (state.authMode === 'login') {
      data = await api('/api/driver/login', { method: 'POST', body: { email, password } });
    } else {
      data = await api('/api/driver/register', {
        method: 'POST',
        body: {
          name: $('#d-name').value.trim(),
          email,
          password,
          phone: $('#d-phone').value.trim(),
          tier: $('#d-tier').value,
          vehicle: $('#d-vehicle').value.trim(),
          plate: $('#d-plate').value.trim(),
          licenseId: $('#d-license').value.trim(),
          licenseCode: $('#d-license-code').value.trim()
        }
      });
    }
    await completeDriverAuth(data);
  } catch (e) {
    toast(e.message, true);
  }
};

window.driverRequestOtpLogin = async () => {
  try {
    const phone = $('#d-otp-phone').value.trim();
    const data = await api('/api/driver/otp/request', { method: 'POST', body: { phone } });
    state.otpLogin = { phone: data.phone || phone, devCode: data.devCode || '' };
    toast(data.message || 'Verification code sent.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.driverVerifyOtpLogin = async () => {
  try {
    const data = await api('/api/driver/otp/verify', {
      method: 'POST',
      body: {
        phone: ($('#d-otp-phone').value || state.otpLogin.phone).trim(),
        code: $('#d-otp-code').value.trim()
      }
    });
    await completeDriverAuth(data);
  } catch (e) {
    toast(e.message, true);
  }
};

window.driverRequestPasswordReset = async () => {
  try {
    const data = await api('/api/driver/password/request-reset', {
      method: 'POST',
      body: { email: $('#d-reset-email').value.trim() }
    });
    state.resetToken = data.devResetToken || '';
    toast(data.message || 'If the account exists, reset instructions were sent.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.driverCompletePasswordReset = async () => {
  try {
    await api('/api/driver/password/reset', {
      method: 'POST',
      body: { token: $('#d-reset-token').value.trim(), password: $('#d-reset-password').value }
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
  stopLocationWatch();
  disconnectEvents();
  state.token = null;
  state.driver = null;
  state.job = null;
  localStorage.removeItem('sewago_driver_token');
  render();
}

window.doLogout = async () => {
  try { await api('/api/driver/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  logoutLocal();
};

window.toggleDeleteAccount = (show) => {
  state.showDeleteAccount = show;
  render();
};

window.driverDeleteAccount = async () => {
  if (!confirm('Delete your SewaGo driver account forever? This cannot be undone.')) return;
  try {
    await api('/api/driver/account/delete', { method: 'POST', body: { password: $('#del-password').value } });
    toast('Your account has been deleted. Goodbye 👋');
    state.showDeleteAccount = false;
    logoutLocal();
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- live map (Leaflet) ---------------- */

let jobMapRefs = null;

function emojiIcon(emoji, size) {
  return L.divIcon({
    html: `<div class="map-emoji" style="font-size:${size}px">${emoji}</div>`,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

function addMapTiles(map) {
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap · © CARTO'
  }).addTo(map);
}

function mapPreview(item) {
  const pk = item.pickupLoc;
  const dp = item.dropoffLoc;
  if (!pk || !dp) return '';
  const minLng = Math.min(pk.lng, dp.lng);
  const maxLng = Math.max(pk.lng, dp.lng);
  const minLat = Math.min(pk.lat, dp.lat);
  const maxLat = Math.max(pk.lat, dp.lat);
  const lngRange = Math.max(0.001, maxLng - minLng);
  const latRange = Math.max(0.001, maxLat - minLat);
  const pos = (loc) => ({
    x: 18 + ((loc.lng - minLng) / lngRange) * 64,
    y: 18 + ((maxLat - loc.lat) / latRange) * 64
  });
  const a = pos(pk);
  const b = pos(dp);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.max(12, Math.sqrt(dx * dx + dy * dy));
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  return `
    <div class="route-preview" style="--pk-x:${a.x}%;--pk-y:${a.y}%;--dp-x:${b.x}%;--dp-y:${b.y}%;--route-l:${length}%;--route-a:${angle}deg">
      <div class="route-line"></div>
      <div class="route-pin pickup-pin">P</div>
      <div class="route-pin dropoff-pin">D</div>
      <div class="route-caption pickup-caption">Pickup · ${esc(item.pickup)}</div>
      <div class="route-caption dropoff-caption">Dropoff · ${esc(item.dropoff)}</div>
    </div>`;
}

function mountJobMap(job) {
  jobMapRefs = null;
  if (typeof L === 'undefined' || !job || !job.pickupLoc) return;
  const el = document.getElementById('job-map');
  if (!el) return;
  el.innerHTML = '';
  const map = L.map(el, { zoomControl: false });
  addMapTiles(map);
  const pk = [job.pickupLoc.lat, job.pickupLoc.lng];
  const dp = [job.dropoffLoc.lat, job.dropoffLoc.lng];
  L.marker(pk, { icon: emojiIcon('🟢', 16) }).addTo(map).bindTooltip('Pickup: ' + esc(job.pickup));
  L.marker(dp, { icon: emojiIcon('🏁', 20) }).addTo(map).bindTooltip('Dropoff: ' + esc(job.dropoff));
  L.polyline([pk, dp], { color: '#22c55e', weight: 3, opacity: 0.45, dashArray: '6 8' }).addTo(map);
  let driverMarker = null;
  if (job.driverCoords) {
    driverMarker = L.marker([job.driverCoords.lat, job.driverCoords.lng], { icon: emojiIcon(job.icon || '🚗', 26) }).addTo(map);
  }
  const bounds = L.latLngBounds([pk, dp]);
  if (job.driverCoords) bounds.extend([job.driverCoords.lat, job.driverCoords.lng]);
  map.fitBounds(bounds.pad(0.25));
  jobMapRefs = { map, driverMarker, icon: job.icon || '🚗' };
}

function mountRequestMaps() {
  if (typeof L === 'undefined') return;
  state.requests.forEach((r) => {
    if (!r.pickupLoc || !r.dropoffLoc) return;
    const el = document.getElementById(`request-map-${r.id}`);
    if (!el || el.dataset.mounted) return;
    el.dataset.mounted = '1';
    el.innerHTML = '';
    const map = L.map(el, { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false });
    addMapTiles(map);
    const pk = [r.pickupLoc.lat, r.pickupLoc.lng];
    const dp = [r.dropoffLoc.lat, r.dropoffLoc.lng];
    L.marker(pk, { icon: emojiIcon('🟢', 15) }).addTo(map).bindTooltip('Customer pickup: ' + esc(r.pickup));
    L.marker(dp, { icon: emojiIcon('🏁', 18) }).addTo(map).bindTooltip('Dropoff: ' + esc(r.dropoff));
    L.polyline([pk, dp], { color: '#22c55e', weight: 3, opacity: 0.45, dashArray: '6 8' }).addTo(map);
    map.fitBounds(L.latLngBounds([pk, dp]).pad(0.35));
  });
}

function updateJobMap(job) {
  if (!jobMapRefs || !job || !job.driverCoords) return;
  const pos = [job.driverCoords.lat, job.driverCoords.lng];
  if (jobMapRefs.driverMarker) jobMapRefs.driverMarker.setLatLng(pos);
  else jobMapRefs.driverMarker = L.marker(pos, { icon: emojiIcon(jobMapRefs.icon, 26) }).addTo(jobMapRefs.map);
}

// Re-render only when something structural changes; dynamic bits (driver
// marker, ETA, progress) are patched in place so the map never flickers.
function uiKey() {
  const d = state.driver;
  return JSON.stringify([
    !!d, state.authMode, d && d.online, d && d.earnings,
    d && d.licenseVerified, d && d.phoneVerified, d && d.locationFresh, state.showWithdraw,
    state.job && state.job.id, state.job && state.job.status,
    state.delivery && state.delivery.id, state.delivery && state.delivery.status,
    state.requests.map((r) => r.id), state.deliveries.map((d) => d.id), state.history.length
  ]);
}

/* ---------------- dashboard ---------------- */

function kycCard(d) {
  return `
  <div class="card">
    <div class="row">
      <div>
        <div style="font-weight:900">Driver verification</div>
        <div class="muted small">License, phone and GPS are required before going online.</div>
      </div>
      <span class="badge ${d.kycStatus === 'approved' ? '' : 'amber'}">${esc((d.kycStatus || 'pending').toUpperCase())}</span>
    </div>
    <div class="status-grid" style="margin-top:12px">
      ${verificationBadge(d)}
      ${phoneBadge(d)}
      <span class="badge ${locationFresh(d) ? '' : 'amber'}">${locationFresh(d) ? '📍 GPS LIVE' : '📍 GPS NEEDED'}</span>
    </div>
    ${d.kycNote ? `<div class="muted small" style="color:var(--danger);margin-top:8px">${esc(d.kycNote)}</div>` : ''}
    <label class="field" style="margin-top:12px"><span>Phone</span>
      <input id="driver-phone" value="${esc(d.phone || '')}" placeholder="e.g. 9841000000" />
    </label>
    <div class="grid2">
      <button class="btn ghost" onclick="driverRequestOtp()">Send OTP</button>
      <label class="field"><span>OTP code</span><input id="driver-otp" placeholder="123456" /></label>
    </div>
    <button class="btn" onclick="driverVerifyOtp()">Verify phone</button>
  </div>`;
}

function render() {
  const app = $('#app');
  if (!state.driver) {
    app.innerHTML = authView();
    return;
  }
  const d = state.driver;
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">Sewa<em>Go</em> <span class="muted" style="font-size:13px;font-weight:700">DRIVER</span></div>
      <span class="badge ${d.online ? '' : 'gray'}">${d.online ? '🟢 ONLINE' : '⚫ OFFLINE'}</span>
    </header>
    <main>
      <div class="card">
        <div class="row">
          <div>
            <div style="font-size:18px;font-weight:900">${TIER_META[d.tier].icon} ${esc(d.name)}</div>
            <div class="muted small">${esc(d.vehicle)} · ${esc(d.plate)} · ★ ${d.rating}</div>
          </div>
        </div>
        <div class="status-grid" style="margin-top:12px">
          ${verificationBadge(d)}
          ${phoneBadge(d)}
          <span class="badge ${locationFresh(d) ? '' : 'amber'}">${locationFresh(d) ? '📍 GPS LIVE' : '📍 GPS NEEDED'}</span>
        </div>
        <div class="muted small" style="margin-top:8px" id="gps-line">${esc(locationLine(d))}</div>
        ${state.locationError ? `<div class="muted small" style="color:#fca5a5;margin-top:6px">${esc(state.locationError)}</div>` : ''}
        <button class="btn ghost" style="margin-top:12px" onclick="updateGps()" ${state.locationBusy ? 'disabled' : ''}>
          ${state.locationBusy ? 'Reading GPS…' : 'Update live GPS'}
        </button>
        <button class="btn ${d.online ? 'danger' : ''}" style="margin-top:8px" onclick="toggleOnline()" ${!d.licenseVerified || !d.phoneVerified ? 'disabled' : ''}>
          ${d.online ? 'Go offline' : 'Go online'}
        </button>
      </div>
      ${kycCard(d)}
      <div class="card">
        <div class="row">
          <div>
            <div class="muted small">Earnings balance <span title="You keep 80% of each fare">(80% of fares)</span></div>
            <div style="font-size:24px;font-weight:900">${money(d.earnings)}</div>
          </div>
          <div style="text-align:right">
            <div class="muted small">Trips</div>
            <div style="font-size:24px;font-weight:900">${d.tripsCompleted}</div>
          </div>
        </div>
        <button class="btn ghost" style="margin-top:12px" onclick="toggleWithdraw()">🏦 Withdraw earnings</button>
        ${state.showWithdraw ? `
        <div class="divider"></div>
        <div class="grid2">
          <label class="field"><span>Amount (Rs)</span><input id="wd-amount" type="number" placeholder="1000" min="100" /></label>
          <label class="field"><span>Payout to</span>
            <select id="wd-channel">
              <option value="esewa">eSewa</option>
              <option value="khalti">Khalti</option>
              <option value="bank">Bank transfer</option>
            </select>
          </label>
        </div>
        <label class="field"><span>Account / wallet ID</span><input id="wd-account" placeholder="e.g. 9841000000 or account no." /></label>
        <div class="muted small" style="margin-bottom:10px">Rs 10 payout fee · paid out after SewaGo approves it (usually same day).</div>
        <button class="btn" onclick="driverWithdraw()">Request payout</button>` : ''}
      </div>
      <div id="job-slot">${jobSlot()}</div>
      ${historySection()}
      <button class="btn ghost" style="margin-top:8px" onclick="doLogout()">Log out</button>
      <div class="card" style="margin-top:14px;border-color:#7f1d1d">
        <div style="font-weight:800">Delete account</div>
        <div class="muted small" style="margin:6px 0 10px;line-height:1.6">
          Removes your personal data permanently. Withdraw your earnings and finish any
          active trip first. <a href="/privacy" target="_blank" class="link">Privacy policy</a>
        </div>
        ${state.showDeleteAccount ? `
        <label class="field"><span>Confirm with your password</span>
          <input id="del-password" type="password" placeholder="Your password" />
        </label>
        <div class="grid2">
          <button class="btn danger" onclick="driverDeleteAccount()">Delete forever</button>
          <button class="btn ghost" onclick="toggleDeleteAccount(false)">Keep my account</button>
        </div>` : `
        <button class="btn ghost" style="border-color:#7f1d1d;color:#f87171" onclick="toggleDeleteAccount(true)">Delete my account…</button>`}
      </div>
    </main>`;
  state._uiKey = uiKey();
  if (state.job) mountJobMap(state.job);
  else mountRequestMaps();
}

function jobSlot() {
  if (state.job) return jobCard(state.job);
  if (state.delivery) return deliveryCard(state.delivery);
  if (!state.driver.online) {
    return `<div class="empty"><div class="big">😴</div>You're offline.<br/>Share live GPS and go online to receive ride requests.</div>`;
  }
  return requestsSection() + deliveriesSection();
}

/* ---------------- food deliveries (bike couriers) ---------------- */

function deliveriesSection() {
  if (state.driver.tier !== 'bike' || state.deliveries.length === 0) return '';
  return `<div class="section-title">Delivery requests 🍜</div>` + state.deliveries.map((d) => `
    <div class="card">
      <div class="row">
        <div>
          <div><b>${d.restaurantIcon || '🍽️'} ${esc(d.restaurantName)} → ${esc(d.dropoffName)}</b></div>
          <div class="muted small">${d.items} item${d.items > 1 ? 's' : ''} · ${d.routeKm != null ? d.routeKm + ' km · ' : ''}${d.secondsAgo}s ago</div>
          ${d.etaToPickupMin != null ? `<div class="small" style="margin-top:2px">🕐 restaurant is ~${d.etaToPickupMin} min from your live GPS</div>` : ''}
        </div>
        <div style="text-align:right">
          <div class="small" style="color:var(--accent);font-weight:800">you earn ${money(d.payout)}</div>
        </div>
      </div>
      <button class="btn" style="margin-top:12px" onclick="acceptDelivery('${d.id}')">Accept delivery</button>
    </div>`).join('');
}

function deliveryCard(d) {
  const atRestaurant = d.status === 'preparing';
  return `
  <div class="section-title">Current delivery 🛵</div>
  <div class="card">
    <div class="row">
      <div>
        <div><b>${d.restaurantIcon || '🍽️'} ${esc(d.restaurantName)} → ${esc(d.dropoffName)}</b></div>
        <div class="muted small">${esc(d.customerName)} · ${d.items} item${d.items > 1 ? 's' : ''}${d.routeKm != null ? ` · ${d.routeKm} km` : ''}</div>
      </div>
      <div class="small" style="color:var(--accent);font-weight:800">you earn ${money(d.payout)}</div>
    </div>
    ${atRestaurant
      ? `<div class="muted small" style="margin-top:8px">👨‍🍳 The kitchen is preparing the order — head to the restaurant.</div>
         ${navButton(d.restaurantLoc, 'Navigate to restaurant')}
         <button class="btn" style="margin-top:8px" onclick="pickupDelivery('${d.id}')">Picked up the food</button>`
      : `<div class="muted small" style="margin-top:8px">📦 Food on board — deliver to ${esc(d.dropoffName)}.</div>
         ${navButton(d.deliveryLoc, 'Navigate to customer')}
         <button class="btn" style="margin-top:8px" onclick="completeDelivery('${d.id}')">Delivered — hand over</button>`}
  </div>`;
}

window.acceptDelivery = async (id) => {
  try {
    const data = await api(`/api/driver/deliveries/${id}/accept`, { method: 'POST' });
    state.delivery = data.delivery;
    state.deliveries = [];
    state.requests = [];
    toast('Delivery accepted — the kitchen is expecting you 🛵');
    render();
  } catch (e) {
    toast(e.message, true);
    refresh().then(() => render()).catch(() => {});
  }
};

window.pickupDelivery = async (id) => {
  try {
    const data = await api(`/api/driver/deliveries/${id}/pickup`, { method: 'POST' });
    state.delivery = data.delivery;
    toast('Marked picked up — take it to the customer.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.completeDelivery = async (id) => {
  try {
    const data = await api(`/api/driver/deliveries/${id}/deliver`, { method: 'POST' });
    state.delivery = null;
    state.driver = data.driver;
    toast(`Delivered! ${money(data.payout)} added to your earnings 💸`);
    await refresh();
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

function requestsSection() {
  if (state.requests.length === 0) {
    return `<div class="empty"><div class="big">📡</div>Waiting for ride requests…<br/>
      <span class="small">The nearest request is offered to you exclusively — accept or pass.</span></div>`;
  }
  return `<div class="section-title">Your offer 📡</div>` + state.requests.map((r) => `
    <div class="card" style="border-color:var(--accent)">
      <div class="row">
        <div>
          <div>${r.kind === 'parcel' ? '<span class="badge">📦 PARCEL</span> ' : ''}<b>${esc(r.pickup)} → ${esc(r.dropoff)}</b></div>
          <div class="muted small">${esc(r.customerName)}${r.recipientName ? ` → hand to ${esc(r.recipientName)}` : ''} · ${r.distanceKm} km</div>
          <div class="small" style="margin-top:2px">🕐 pickup is ~${r.etaToPickupMin} min from your live GPS</div>
        </div>
        <div style="text-align:right">
          <div><b>${money(r.fare)}</b> ${r.payment === 'cash' ? '💵' : '👛'}</div>
          <div class="small" style="color:var(--accent);font-weight:800">
            ${r.payment === 'cash' ? `collect cash · ${money(r.fare - r.payout)} fee` : `you earn ${money(r.payout)}`}
          </div>
        </div>
      </div>
      <div class="muted small" style="margin-top:6px">⏳ Reserved for you ~${r.offerExpiresIn ?? 15}s — then it goes to the next driver.</div>
      ${r.pickupLoc && r.dropoffLoc ? `<div id="request-map-${r.id}" class="ride-map request-map">${mapPreview(r)}</div>` : ''}
      <div class="grid2" style="margin-top:12px">
        <button class="btn" onclick="acceptRide('${r.id}')">Accept</button>
        <button class="btn ghost" onclick="declineRide('${r.id}')">Pass</button>
      </div>
    </div>`).join('');
}

window.declineRide = async (id) => {
  try {
    await api(`/api/driver/rides/${id}/decline`, { method: 'POST' });
    state.requests = state.requests.filter((r) => r.id !== id);
    toast('Passed — offered to the next driver.');
    render();
  } catch (e) {
    toast(e.message, true);
    refresh().then(() => render()).catch(() => {});
  }
};

// Opens the phone's native maps app with turn-by-turn directions to a point.
// The Google Maps universal URL launches Google Maps on Android and prompts
// Apple/Google Maps on iOS — no app-specific SDK needed.
function navButton(loc, label) {
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return '';
  const url = `https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}&travelmode=driving`;
  return `<a class="btn ghost" style="margin-top:12px" href="${url}" target="_blank" rel="noopener noreferrer">🧭 ${label}</a>`;
}

function jobCard(job) {
  const enRoute = job.status === 'driver_en_route';
  return `
  <div class="section-title">Current trip 🚦</div>
  <div class="card">
    <div class="row">
      <div>
        <div>${job.kind === 'parcel' ? '<span class="badge">📦 PARCEL</span> ' : ''}<b>${esc(job.pickup)} → ${esc(job.dropoff)}</b></div>
        <div class="muted small">${esc(job.customerName)} · ${job.distanceKm} km</div>
        ${job.kind === 'parcel' && job.recipient ? `<div class="muted small">📦 Hand to <b>${esc(job.recipient.name)}</b> · ${esc(job.recipient.phone)}${job.parcelNote ? ` · ${esc(job.parcelNote)}` : ''}</div>` : ''}
      </div>
      <div style="text-align:right">
        <div><b>${money(job.fare)}</b> ${job.payment === 'cash' ? '💵' : '👛'}</div>
        <div class="small" style="color:var(--accent);font-weight:800">
          ${job.payment === 'cash' ? `collect ${money(job.fare)} cash` : `you earn ${money(job.payout)}`}
        </div>
      </div>
    </div>
    ${job.payment === 'cash' ? `<div class="muted small" style="margin-top:8px">💵 Cash trip — collect the fare from the customer; SewaGo's ${money(job.fare - job.payout)} commission is deducted from your balance on completion.</div>` : ''}
    ${job.pickupLoc ? `<div id="job-map" class="ride-map">${mapPreview(job)}</div>` : ''}
    ${enRoute
      ? `<div class="eta-line" id="job-eta">🕐 ${esc(job.customerName.split(' ')[0])} expects you at ${esc(job.pickup)} in ~${job.driverEtaMin || 1} min</div>
         ${navButton(job.pickupLoc, 'Navigate to pickup')}
         <button class="btn" style="margin-top:8px" onclick="startTrip('${job.id}')">Picked up — start trip</button>`
      : `<div class="progress" style="margin-top:14px"><div id="job-bar" style="width:${Math.round(job.progress * 100)}%"></div></div>
         <div class="muted small" style="margin-top:8px">Trip in progress…</div>
         ${navButton(job.dropoffLoc, 'Navigate to dropoff')}
         <button class="btn" style="margin-top:8px" onclick="completeTrip('${job.id}')">Complete trip</button>`}
  </div>`;
}

function historySection() {
  if (state.history.length === 0) return '';
  return `<div class="section-title">Recent trips 🧾</div>` + state.history.map((h) => `
    <div class="card">
      <div class="row">
        <div>
          <div><b>${esc(h.pickup)} → ${esc(h.dropoff)}</b></div>
          <div class="muted small">${new Date(h.completedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${h.rating ? ' · ' + '⭐'.repeat(h.rating) : ''}</div>
        </div>
        <div style="text-align:right">
          <div style="color:var(--accent);font-weight:900">+${money(h.payout)}</div>
          <div class="muted small">fare ${money(h.fare)}</div>
        </div>
      </div>
    </div>`).join('');
}

/* ---------------- actions ---------------- */

async function refresh() {
  const me = await api('/api/driver/me');
  const hadJob = state.job;
  state.driver = me.driver;
  state.job = me.job;
  state.delivery = me.delivery || null;
  state.history = me.history;
  if (hadJob && !me.job) {
    toast('That trip was cancelled by the customer.', true);
  }
  if (me.driver.online && !me.job && !state.delivery) {
    const fetches = [api('/api/driver/requests')];
    if (me.driver.tier === 'bike') fetches.push(api('/api/driver/deliveries'));
    const [r, del] = await Promise.all(fetches);
    state.requests = r.requests;
    state.deliveries = del ? del.deliveries : [];
  } else {
    state.requests = [];
    state.deliveries = [];
  }
}

window.toggleWithdraw = () => {
  state.showWithdraw = !state.showWithdraw;
  render();
};

window.driverWithdraw = async () => {
  try {
    const data = await api('/api/driver/withdraw', {
      method: 'POST',
      body: {
        amount: $('#wd-amount').value,
        channel: $('#wd-channel').value,
        account: $('#wd-account').value.trim()
      }
    });
    state.driver = data.driver;
    state.showWithdraw = false;
    toast('Payout requested — money arrives once SewaGo approves it 🏦');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.driverRequestOtp = async () => {
  try {
    const data = await api('/api/driver/phone/request-otp', {
      method: 'POST',
      body: { phone: $('#driver-phone').value.trim() }
    });
    state.driver = data.driver;
    toast(data.devCode ? `Sandbox OTP: ${data.devCode}` : 'Verification code sent.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.driverVerifyOtp = async () => {
  try {
    const data = await api('/api/driver/phone/verify', {
      method: 'POST',
      body: { code: $('#driver-otp').value.trim() }
    });
    state.driver = data.driver;
    toast('Phone verified.');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.updateGps = async () => {
  try {
    await ensureLocation();
    toast('Live GPS updated.');
    render();
  } catch (e) {
    state.locationError = e.message || 'Could not read GPS location.';
    toast(state.locationError, true);
    render();
  }
};

window.toggleOnline = async () => {
  try {
    if (!state.driver.online) {
      await ensureLocation();
      startLocationWatch(true);
    }
    const data = await api('/api/driver/online', { method: 'POST', body: { online: !state.driver.online } });
    state.driver = data.driver;
    if (!data.driver.online) stopLocationWatch();
    toast(data.driver.online ? 'You are online — waiting for requests 🟢' : 'You are offline.');
    await refresh();
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.acceptRide = async (id) => {
  try {
    const data = await api(`/api/driver/rides/${id}/accept`, { method: 'POST' });
    startLocationWatch(true);
    state.job = data.job;
    state.requests = [];
    toast('Request accepted — head to the pickup point!');
    render();
  } catch (e) {
    toast(e.message, true);
    try { await refresh(); render(); } catch (_) { /* ignore */ }
  }
};

window.startTrip = async (id) => {
  try {
    const data = await api(`/api/driver/rides/${id}/start`, { method: 'POST' });
    state.job = data.job;
    toast('Trip started — drive safe! 🛣️');
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

window.completeTrip = async (id) => {
  try {
    const data = await api(`/api/driver/rides/${id}/complete`, { method: 'POST' });
    state.driver = data.driver;
    state.job = null;
    toast(data.cash
      ? `Collect ${money(data.fare)} in cash 💵 — ${money(data.commission)} commission deducted from balance`
      : `Trip complete — you earned ${money(data.payout)} 🎉`);
    await refresh();
    render();
  } catch (e) {
    toast(e.message, true);
  }
};

/* ---------------- realtime (push) + adaptive polling ---------------- */

// Pull fresh driver/job/requests state and reconcile the UI. Driven by the
// animation tick during a trip and by instant server pushes otherwise.
async function syncDriverUI() {
  if (!state.driver) return;
  await refresh();
  if (uiKey() !== state._uiKey) {
    render();
  } else if (state.job) {
    // nothing structural changed -> just move the marker / ETA / progress
    updateJobMap(state.job);
    const eta = $('#job-eta');
    if (eta && state.job.driverEtaMin) {
      eta.textContent = `🕐 ${state.job.customerName.split(' ')[0]} expects you at ${state.job.pickup} in ~${state.job.driverEtaMin} min`;
    }
    const bar = $('#job-bar');
    if (bar) bar.style.width = Math.round(state.job.progress * 100) + '%';
  }
}

// SSE: new ride requests and trip changes arrive instantly, so an idle online
// driver no longer polls every 2s just to wait for a request.
let sseSource = null;
function connectEvents() {
  if (!state.token || typeof EventSource === 'undefined') return;
  disconnectEvents();
  sseSource = new EventSource('/api/events?role=driver&token=' + encodeURIComponent(state.token));
  sseSource.onmessage = () => { syncDriverUI().catch(() => {}); };
}
function disconnectEvents() {
  if (sseSource) { sseSource.close(); sseSource = null; }
}

// During a trip we sample every 2s for smooth marker/ETA animation. Idle, we
// lean on push and only poll every ~20s as a safety net if the stream drops.
let idleTicks = 0;
setInterval(() => {
  if (!state.driver) return;
  // Active trip/delivery: fast tick for smooth animation. A visible offer also
  // ticks fast — it expires in ~15s, so the card must clear promptly if it
  // moves to the next driver.
  if (state.job || state.delivery || state.requests.length) {
    idleTicks = 0;
    syncDriverUI().catch(() => {});
  } else if (++idleTicks >= 10) {
    idleTicks = 0;
    syncDriverUI().catch(() => {});
  }
}, 2000);

/* ---------------- boot ---------------- */

(async function boot() {
  if (state.token) {
    try {
      await refresh();
      if (state.driver && state.driver.online) startLocationWatch(true);
      connectEvents();
    } catch (e) {
      state.token = null;
      localStorage.removeItem('sewago_driver_token');
    }
  }
  // Password-reset link from the email: open the reset form with the token in.
  const resetParam = new URLSearchParams(window.location.search).get('reset');
  if (resetParam && !state.driver) {
    window.history.replaceState({}, '', window.location.pathname);
    state.authMode = 'reset';
    state.resetToken = resetParam;
  }
  render();
})();
