/* SewaGo Admin — platform control room: live ops, reviews, payments, partners */

const $ = (sel) => document.querySelector(sel);

const state = {
  token: localStorage.getItem('sewago_admin_token'),
  loggedIn: false,
  tab: localStorage.getItem('sewago_admin_tab') || 'live',
  stats: null,
  live: null,
  queue: { restaurants: [], hotels: [] },
  partners: [],
  payments: { pendingWithdrawals: [], stats: {}, revenue: {}, ledger: [] },
  liveTimer: null
};

const LIVE_REFRESH_MS = 8000;

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
  if (res.status === 401 && state.loggedIn) {
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
  return 'Rs ' + Number(n || 0).toLocaleString('en-IN');
}

function ago(sec) {
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
  return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

/* ---------------- data ---------------- */

// Core data behind badges + the Overview/Reviews/Payments/Partners tabs.
async function loadCore() {
  const [o, q, p, pay] = await Promise.all([
    api('/api/admin/overview'),
    api('/api/admin/queue'),
    api('/api/admin/partners'),
    api('/api/admin/payments')
  ]);
  state.stats = o.stats;
  state.queue = q;
  state.partners = p.partners;
  state.payments = pay;
  state.loggedIn = true;
}

async function loadLive() {
  state.live = await api('/api/admin/live');
  state.loggedIn = true;
}

/* ---------------- live ops ---------------- */

function kpi(label, value, accent = false) {
  return `<div class="kpi${accent ? ' accent' : ''}"><div class="v">${value}</div><div class="l">${label}</div></div>`;
}

const RIDE_STATUS = {
  searching: { label: 'Finding driver', cls: 'amber' },
  driver_en_route: { label: 'Driver en route', cls: 'blue' },
  in_progress: { label: 'On trip', cls: 'green' }
};

function liveKpisHtml(L) {
  const k = L.kpis;
  return `<div class="kpi-grid">
    ${kpi('Active rides', k.activeRides, k.activeRides > 0)}
    ${kpi('Drivers online', `${k.driversOnline}<span class="muted" style="font-size:14px;font-weight:700"> · ${k.driversAvailable} free</span>`)}
    ${kpi('Rides today', k.ridesToday)}
    ${kpi('Ride revenue today', money(k.rideRevenueToday), true)}
    ${kpi('Orders today', k.ordersToday)}
    ${kpi('Bookings today', k.bookingsToday)}
    ${kpi('New users today', k.newUsersToday)}
  </div>`;
}

function liveView() {
  const L = state.live;
  if (!L) return `<div class="empty"><div class="big">📡</div>Loading live operations…</div>`;
  return `
  <div class="live-head">
    <div class="section-title" style="margin:0"><span class="dot-live"></span>Live operations</div>
    <div class="muted" id="live-updated">Auto-refreshing · updated ${fmtTime(Date.parse(L.serverTime))}</div>
  </div>
  <div id="live-kpis" style="margin-top:12px">${liveKpisHtml(L)}</div>
  <div id="live-map" class="live-map"></div>
  <div class="map-legend muted small">🟢 pickup · 🏁 dropoff · 🏍️🚗🚐 online driver · dim = idle · tooltip for details</div>
  <div id="live-lists">${liveListsHtml(L)}</div>`;
}

function liveListsHtml(L) {
  return `
  <div class="ops-grid">
    <div class="card">
      <div class="section-title" style="margin-top:0">🚗 Active rides ${L.activeRides.length ? `<span class="badge amber">${L.activeRides.length}</span>` : ''}</div>
      ${L.activeRides.length === 0
        ? `<div class="muted small">No rides in progress right now.</div>`
        : L.activeRides.map((r) => {
          const s = RIDE_STATUS[r.status] || { label: r.status, cls: 'gray' };
          return `
          <div class="list-row">
            <div>
              <div><b>${esc(r.customer)}</b> <span class="badge ${s.cls}">${s.label}</span> <span class="muted small">${r.icon} ${esc(r.tier)}</span></div>
              <div class="muted small">${esc(r.pickup)} → ${esc(r.dropoff)}${r.driver ? ' · 👤 ' + esc(r.driver) : (r.mode === 'live' ? ' · waiting for driver' : '')}</div>
            </div>
            <div class="rt">
              <div><b>${money(r.fare)}</b></div>
              <div class="muted small">${r.status === 'searching' ? 'waiting ' : ''}${ago(r.waitingSec)}${r.driverEtaMin ? ' · ETA ' + r.driverEtaMin + 'm' : ''}</div>
            </div>
          </div>`;
        }).join('')}
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0">🟢 Drivers online <span class="badge gray">${L.drivers.length}</span></div>
      ${L.drivers.length === 0
        ? `<div class="muted small">No drivers online.</div>`
        : L.drivers.map((d) => `
          <div class="list-row">
            <div>
              <div><b>${esc(d.name)}</b> <span class="muted small">${esc(d.tier)} · ${esc(d.plate)} · ⭐ ${d.rating}</span></div>
              <div class="muted small">${d.verified ? '✓ verified' : '⚠️ unverified'} · ${d.hasFreshLocation ? '📍 GPS live' : '📍 no fresh GPS'}</div>
            </div>
            <div class="rt">
              ${d.onTrip ? '<span class="badge blue">ON TRIP</span>'
                : d.available ? '<span class="badge green">AVAILABLE</span>'
                : '<span class="badge amber">IDLE</span>'}
            </div>
          </div>`).join('')}
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0">🍔 Recent food orders</div>
      ${L.recentOrders.length === 0
        ? `<div class="muted small">No orders yet.</div>`
        : L.recentOrders.map((o) => `
          <div class="list-row">
            <div>
              <div><b>${esc(o.restaurant)}</b> <span class="muted small">${esc(o.customer)}</span></div>
              <div class="muted small">${fmtTime(o.createdAt)}</div>
            </div>
            <div class="rt"><div><b>${money(o.total)}</b></div><div class="muted small">${esc(o.status)}</div></div>
          </div>`).join('')}
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0">🏨 Recent bookings</div>
      ${L.recentBookings.length === 0
        ? `<div class="muted small">No bookings yet.</div>`
        : L.recentBookings.map((b) => `
          <div class="list-row">
            <div>
              <div><b>${esc(b.hotel)}</b> <span class="muted small">${esc(b.customer)}</span></div>
              <div class="muted small">${b.nights} night${b.nights === 1 ? '' : 's'} · ${fmtTime(b.createdAt)}</div>
            </div>
            <div class="rt"><div><b>${money(b.total)}</b></div><div class="muted small">${esc(b.status)}</div></div>
          </div>`).join('')}
    </div>
  </div>`;
}

/* ---------------- live map (Leaflet) ---------------- */

let liveMap = null;
let liveLayer = null;
const KATHMANDU = [27.7104, 85.3238];
const TIER_EMOJI = { bike: '🏍️', car: '🚗', xl: '🚐' };

function emojiIcon(emoji, size) {
  return L.divIcon({
    html: `<div style="font-size:${size}px;line-height:1;text-align:center">${emoji}</div>`,
    className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2]
  });
}

// Clears and re-plots all drivers + active rides; returns the points touched so
// the caller can fit bounds on first mount. Keeps the map's current view on
// refresh so staff don't lose their pan/zoom every 8 seconds.
function plotLive(data) {
  if (!liveLayer) return [];
  liveLayer.clearLayers();
  const pts = [];

  (data.drivers || []).forEach((d) => {
    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) return;
    if (d.onTrip) return; // shown via the ride's driver marker instead
    const marker = L.marker([d.lat, d.lng], {
      icon: emojiIcon(TIER_EMOJI[d.tier] || '🚗', 22),
      opacity: d.available ? 1 : 0.45
    }).addTo(liveLayer);
    marker.bindTooltip(`${esc(d.name)} · ${d.available ? 'available' : 'idle'}${d.hasFreshLocation ? '' : ' · GPS stale'}`);
    pts.push([d.lat, d.lng]);
  });

  (data.activeRides || []).forEach((r) => {
    if (r.pickupLoc) {
      L.marker([r.pickupLoc.lat, r.pickupLoc.lng], { icon: emojiIcon('🟢', 15) })
        .addTo(liveLayer).bindTooltip('Pickup · ' + esc(r.pickup));
      pts.push([r.pickupLoc.lat, r.pickupLoc.lng]);
    }
    if (r.dropoffLoc) {
      L.marker([r.dropoffLoc.lat, r.dropoffLoc.lng], { icon: emojiIcon('🏁', 16) })
        .addTo(liveLayer).bindTooltip('Dropoff · ' + esc(r.dropoff));
      pts.push([r.dropoffLoc.lat, r.dropoffLoc.lng]);
    }
    if (r.pickupLoc && r.dropoffLoc) {
      L.polyline([[r.pickupLoc.lat, r.pickupLoc.lng], [r.dropoffLoc.lat, r.dropoffLoc.lng]],
        { color: '#22c55e', weight: 2, opacity: 0.35, dashArray: '5 7' }).addTo(liveLayer);
    }
    if (r.driverCoords) {
      L.marker([r.driverCoords.lat, r.driverCoords.lng], { icon: emojiIcon(r.icon || '🚗', 26) })
        .addTo(liveLayer).bindTooltip(`${esc(r.customer)} · ${esc(r.tier)} · ${RIDE_STATUS[r.status] ? RIDE_STATUS[r.status].label : r.status}`);
      pts.push([r.driverCoords.lat, r.driverCoords.lng]);
    }
  });

  return pts;
}

function mountLiveMap(data) {
  if (typeof L === 'undefined' || !data) return;
  const el = document.getElementById('live-map');
  if (!el) return;
  if (liveMap) { liveMap.remove(); liveMap = null; }
  liveMap = L.map(el, { zoomControl: true, attributionControl: false });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(liveMap);
  liveLayer = L.layerGroup().addTo(liveMap);
  const pts = plotLive(data);
  if (pts.length) liveMap.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 15 });
  else liveMap.setView(KATHMANDU, 12);
}

function updateLiveMap(data) {
  if (!liveMap || !liveLayer || !data) return;
  plotLive(data); // preserves the current pan/zoom
}

function destroyLiveMap() {
  if (liveMap) { liveMap.remove(); liveMap = null; liveLayer = null; }
}

// Update just the live tab's dynamic parts on auto-refresh, leaving the map
// instance (and the user's pan/zoom) intact.
function refreshLiveDom() {
  const data = state.live;
  if (!data) return;
  const k = document.getElementById('live-kpis');
  if (k) k.innerHTML = liveKpisHtml(data);
  const lists = document.getElementById('live-lists');
  if (lists) lists.innerHTML = liveListsHtml(data);
  const upd = document.getElementById('live-updated');
  if (upd) upd.textContent = 'Auto-refreshing · updated ' + fmtTime(Date.parse(data.serverTime));
  const tabs = document.getElementById('admin-tabs-slot');
  if (tabs) tabs.innerHTML = tabsBar();
  updateLiveMap(data);
}

// Mount/tear-down the map to match the active tab after a full (re)render.
function afterRender() {
  if (!state.loggedIn) { destroyLiveMap(); return; }
  if (state.tab === 'live') mountLiveMap(state.live);
  else destroyLiveMap();
}

/* ---------------- overview ---------------- */

function statTile(label, value) {
  return `<div class="kpi"><div class="v">${value}</div><div class="l">${label}</div></div>`;
}

function overviewView() {
  const s = state.stats;
  if (!s) return `<div class="empty"><div class="big">📊</div>Loading…</div>`;
  return `
  <div class="section-title" style="margin-top:0">Business overview 📊</div>
  <div class="kpi-grid">
    <div class="kpi accent"><div class="v">${money(s.revenue)}</div><div class="l">Total platform revenue</div></div>
    ${statTile('Customers', s.users)}
    ${statTile('Drivers (online)', `${s.drivers} (${s.driversOnline})`)}
    ${statTile('Partners', s.partners)}
    ${statTile('Rides done / total', `${s.ridesCompleted}/${s.rides}`)}
    ${statTile('Food orders', s.orders)}
    ${statTile('Hotel bookings', s.bookings)}
    ${statTile('Tasks open/active/done', `${s.tasksOpen}/${s.tasksActive}/${s.tasksCompleted}`)}
    ${statTile('Restaurants live', s.restaurantsLive)}
    ${statTile('Hotels live', s.hotelsLive)}
  </div>

  <div class="section-title">Revenue breakdown 💰</div>
  <div class="card">
    <div class="list-row"><div>🚗 Ride commission (20%)</div><div class="rt"><b>${money(s.rideCommission)}</b></div></div>
    <div class="list-row"><div>🍔 Food commission</div><div class="rt"><b>${money(s.foodCommission)}</b></div></div>
    <div class="list-row"><div>🏨 Stay commission</div><div class="rt"><b>${money(s.stayCommission)}</b></div></div>
    <div class="list-row"><div>🧰 Task fees</div><div class="rt"><b>${money(s.taskFees)}</b></div></div>
    <div class="list-row"><div>🏦 Withdrawal fees</div><div class="rt"><b>${money(s.withdrawalFees)}</b></div></div>
    <div class="list-row"><div>🧾 Service fees</div><div class="rt"><b>${money(s.serviceFees || 0)}</b></div></div>
    <div class="list-row"><div>⏱️ Late-cancel fees</div><div class="rt"><b>${money(s.cancelFees || 0)}</b></div></div>
    <div class="list-row"><div>⭐ Featured listings</div><div class="rt"><b>${money(s.promotionFees || 0)}</b></div></div>
    <div class="list-row"><div><b>Total</b></div><div class="rt"><b style="color:var(--accent)">${money(s.revenue)}</b></div></div>
  </div>`;
}

/* ---------------- reviews ---------------- */

function partnerBlock(p) {
  return `
  <div style="background:var(--card2);border-radius:10px;padding:10px 12px;margin-top:10px">
    <div class="small"><b>Submitted by:</b> ${esc(p.name)}</div>
    <div class="muted small">📧 ${esc(p.email)} · 📞 ${esc(p.phone)} ${p.phoneVerified ? '✓' : '⚠️'} · 🧾 Reg/PAN: ${esc(p.regNo)}</div>
    <div class="muted small">KYC: ${esc((p.businessKycStatus || 'pending').toUpperCase())} · Doc: ${esc(p.businessKycDocumentRef || '—')}</div>
    <div class="muted small" style="margin-top:3px">Call the partner and check the registration number before approving.</div>
  </div>`;
}

function reviewActions(kind, id) {
  return `
  <label class="field" style="margin-top:12px"><span>Rejection note (sent to the partner)</span>
    <input id="note-${id}" placeholder="e.g. PAN number could not be verified" />
  </label>
  <div class="grid2">
    <button class="btn" onclick="review('${kind}','${id}','approve')">✓ Approve — go live</button>
    <button class="btn danger" onclick="review('${kind}','${id}','reject')">✕ Reject</button>
  </div>`;
}

function reviewsView() {
  const { restaurants, hotels } = state.queue;
  if (restaurants.length === 0 && hotels.length === 0) {
    return `<div class="section-title" style="margin-top:0">Review queue 🔍</div>
      <div class="empty"><div class="big">✅</div>Review queue is empty — nothing waiting.</div>`;
  }
  return `
  <div class="section-title" style="margin-top:0">Review queue 🔍 <span class="badge amber">${restaurants.length + hotels.length} waiting</span></div>
  ${restaurants.map((r) => `
    <div class="card">
      <div class="row"><div>
        <div style="font-weight:900">${r.icon} ${esc(r.name)} <span class="badge amber">RESTAURANT · PENDING</span></div>
        <div class="muted small">${esc(r.cuisine)} · ${r.etaMinutes} min · delivery ${money(r.deliveryFee)}</div>
      </div></div>
      <div class="muted small" style="margin-top:8px">
        Menu (${r.menu.length} item${r.menu.length === 1 ? '' : 's'}): ${r.menu.length ? r.menu.map((m) => `${esc(m.name)} ${money(m.price)}`).join(' · ') : '⚠️ empty — consider rejecting'}
      </div>
      ${partnerBlock(r.partner)}
      ${reviewActions('restaurants', r.id)}
    </div>`).join('')}
  ${hotels.map((h) => `
    <div class="card">
      <div class="row"><div>
        <div style="font-weight:900">${h.icon} ${esc(h.name)} <span class="badge amber">HOTEL · PENDING</span></div>
        <div class="muted small">${esc(h.area)}${h.area ? ', ' : ''}${esc(h.city)}${h.desc ? ' · ' + esc(h.desc) : ''}</div>
      </div></div>
      <div class="muted small" style="margin-top:8px">
        Rooms (${h.rooms.length}): ${h.rooms.length ? h.rooms.map((room) => `${esc(room.type)} ${money(room.pricePerNight)}/n ×${room.count}`).join(' · ') : '⚠️ none — consider rejecting'}
      </div>
      ${partnerBlock(h.partner)}
      ${reviewActions('hotels', h.id)}
    </div>`).join('')}`;
}

/* ---------------- payments ---------------- */

function paymentsView() {
  const pay = state.payments;
  const pending = pay.pendingWithdrawals;
  return `
  <div class="section-title" style="margin-top:0">Payments 💳</div>
  <div class="kpi-grid">
    ${statTile('Top-ups collected', money(pay.stats.topupVolume))}
    ${statTile('Top-up count', pay.stats.topupCount || 0)}
    ${statTile('Payouts paid', money(pay.stats.withdrawalsPaid))}
    <div class="kpi accent"><div class="v">${money(pay.stats.withdrawalFees)}</div><div class="l">Payout fees earned</div></div>
  </div>

  <div class="section-title">Payout approvals 🏦 ${pending.length ? `<span class="badge amber">${pending.length} waiting</span>` : ''}</div>
  ${pending.length === 0
    ? `<div class="empty"><div class="big">🏦</div>No payouts waiting for approval.</div>`
    : pending.map((w) => `
    <div class="card">
      <div class="row"><div>
        <div><b>${esc(w.ownerName)}</b> <span class="badge gray">${w.ownerKind.toUpperCase()}</span></div>
        <div class="muted small">${money(w.amount)} + ${money(w.fee)} fee → ${esc(w.channelLabel)} · ${esc(w.account)}</div>
      </div><span class="badge amber">PROCESSING</span></div>
      <label class="field" style="margin-top:12px"><span>Rejection note (optional)</span>
        <input id="wnote-${w.id}" placeholder="e.g. account name mismatch" />
      </label>
      <div class="grid2">
        <button class="btn" onclick="reviewWithdrawal('${w.id}','approve')">✓ Mark paid</button>
        <button class="btn danger" onclick="reviewWithdrawal('${w.id}','reject')">✕ Reject & refund</button>
      </div>
    </div>`).join('')}

  <div class="section-title">Revenue ledger 🧾</div>
  ${(pay.ledger && pay.ledger.length) ? `<div class="card">
    ${pay.ledger.slice(0, 30).map((e) => `
      <div class="list-row">
        <div><div>${esc(e.label)}</div><div class="muted small">${esc(e.source)} · ${fmtTime(e.createdAt || e.at)}</div></div>
        <div class="rt"><b style="color:${e.amount < 0 ? 'var(--danger)' : 'var(--accent)'}">${money(e.amount)}</b></div>
      </div>`).join('')}
  </div>` : `<div class="muted small">No revenue entries yet.</div>`}`;
}

/* ---------------- partners ---------------- */

function partnersView() {
  if (state.partners.length === 0) {
    return `<div class="section-title" style="margin-top:0">Partners 🏪</div>
      <div class="empty"><div class="big">🤝</div>No partners registered yet.</div>`;
  }
  return `
  <div class="section-title" style="margin-top:0">Partners 🏪 <span class="badge gray">${state.partners.length}</span></div>
  ${state.partners.map((p) => `
    <div class="card">
      <div><b>${esc(p.name)}</b> <span class="muted small">· ${p.restaurants} restaurant${p.restaurants === 1 ? '' : 's'}, ${p.hotels} hotel${p.hotels === 1 ? '' : 's'}</span></div>
      <div class="muted small">📧 ${esc(p.email)} · 📞 ${esc(p.phone)} ${p.phoneVerified ? '✓ verified' : '⚠️ unverified'} · 🧾 ${esc(p.regNo)}</div>
      <div class="muted small">KYC: <b style="color:var(--text)">${esc((p.businessKycStatus || 'pending').toUpperCase())}</b> · Doc: ${esc(p.businessKycDocumentRef || '—')}</div>
      ${p.businessKycNote ? `<div class="muted small" style="color:var(--danger);margin-top:4px">${esc(p.businessKycNote)}</div>` : ''}
      <label class="field" style="margin-top:12px"><span>KYC rejection note</span>
        <input id="pnote-${p.id}" placeholder="e.g. certificate photo is unreadable" />
      </label>
      <div class="grid2">
        <button class="btn" onclick="reviewPartnerKyc('${p.id}','approve')" ${p.phoneVerified ? '' : 'disabled'}>✓ Approve KYC</button>
        <button class="btn danger" onclick="reviewPartnerKyc('${p.id}','reject')">✕ Reject KYC</button>
      </div>
    </div>`).join('')}`;
}

/* ---------------- shell ---------------- */

function loginView() {
  return `
  <div class="auth-wrap">
    <div class="auth-hero">
      <div class="logo">🛡️</div>
      <h1>Sewa<em>Go</em> Admin</h1>
      <p>Platform control room — live ops, reviews, payments.</p>
    </div>
    <div class="card">
      <label class="field"><span>Admin email</span>
        <input id="a-email" type="email" placeholder="admin@sewago.app" />
      </label>
      <label class="field"><span>Password</span>
        <input id="a-password" type="password" placeholder="••••••••" onkeydown="if(event.key==='Enter')submitLogin()" />
      </label>
      <button class="btn" onclick="submitLogin()">Log in</button>
      <div class="muted small" style="margin-top:12px;text-align:center">
        Set ADMIN_EMAIL + ADMIN_PASSWORD env vars in production.
      </div>
    </div>
  </div>`;
}

const TABS = [
  ['live', 'Live ops'],
  ['overview', 'Overview'],
  ['reviews', 'Reviews'],
  ['payments', 'Payments'],
  ['partners', 'Partners']
];

function tabBadge(tab) {
  if (tab === 'reviews') return state.queue.restaurants.length + state.queue.hotels.length;
  if (tab === 'payments') return state.payments.pendingWithdrawals.length;
  if (tab === 'live') return state.live ? state.live.kpis.activeRides : 0;
  return 0;
}

function tabsBar() {
  return `<div class="admin-tabs">
    ${TABS.map(([id, label]) => {
      const n = tabBadge(id);
      return `<button class="${state.tab === id ? 'active' : ''}" onclick="setTab('${id}')">${label}${n ? `<span class="tab-badge">${n}</span>` : ''}</button>`;
    }).join('')}
  </div>`;
}

function mainContent() {
  switch (state.tab) {
    case 'overview': return overviewView();
    case 'reviews': return reviewsView();
    case 'payments': return paymentsView();
    case 'partners': return partnersView();
    default: return liveView();
  }
}

function renderMain() {
  const m = $('#admin-main');
  if (m) m.innerHTML = mainContent();
  const t = $('#admin-tabs-slot');
  if (t) t.innerHTML = tabsBar();
  afterRender();
}

function render() {
  const app = $('#app');
  if (!state.loggedIn) {
    app.innerHTML = loginView();
    return;
  }
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">Sewa<em>Go</em> <span class="muted" style="font-size:13px;font-weight:700">ADMIN</span></div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn ghost compact" onclick="refresh()">↻ Refresh</button>
        <button class="btn danger compact" onclick="doLogout()">Log out</button>
      </div>
    </header>
    <main>
      <div id="admin-tabs-slot">${tabsBar()}</div>
      <div id="admin-main">${mainContent()}</div>
    </main>`;
  afterRender();
}

/* ---------------- live auto-refresh ---------------- */

function startLiveTimer() {
  stopLiveTimer();
  state.liveTimer = setInterval(async () => {
    if (state.tab !== 'live' || !state.loggedIn) return;
    try {
      await loadLive();
      if (state.tab === 'live') refreshLiveDom();
    } catch (e) { /* transient; next tick retries */ }
  }, LIVE_REFRESH_MS);
}

function stopLiveTimer() {
  if (state.liveTimer) clearInterval(state.liveTimer);
  state.liveTimer = null;
}

// SSE push: rides/orders/bookings changes refresh the live view instantly. The
// timer above stays as a safety net (and covers time-based sim-ride transitions).
let sseSource = null;
function connectEvents() {
  if (!state.token || typeof EventSource === 'undefined') return;
  disconnectEvents();
  sseSource = new EventSource('/api/events?role=admin&token=' + encodeURIComponent(state.token));
  sseSource.onmessage = async () => {
    if (state.tab !== 'live' || !state.loggedIn) return;
    try {
      await loadLive();
      if (state.tab === 'live') refreshLiveDom();
    } catch (e) { /* ignore */ }
  };
}
function disconnectEvents() {
  if (sseSource) { sseSource.close(); sseSource = null; }
}

/* ---------------- actions ---------------- */

window.setTab = async (tab) => {
  state.tab = tab;
  localStorage.setItem('sewago_admin_tab', tab);
  renderMain();
  try {
    if (tab === 'live') await loadLive();
    else await loadCore();
    if (state.tab === tab) renderMain();
  } catch (e) { toast(e.message, true); }
};

window.submitLogin = async () => {
  try {
    const data = await api('/api/admin/login', {
      method: 'POST',
      body: { email: $('#a-email').value.trim(), password: $('#a-password').value }
    });
    state.token = data.token;
    localStorage.setItem('sewago_admin_token', data.token);
    await Promise.all([loadCore(), loadLive()]);
    toast('Welcome back 🛡️');
    render();
    startLiveTimer();
    connectEvents();
  } catch (e) {
    toast(e.message, true);
  }
};

window.review = async (kind, id, action) => {
  try {
    const note = $(`#note-${id}`) ? $(`#note-${id}`).value.trim() : '';
    if (action === 'reject' && !note) {
      toast('Add a short rejection note so the partner knows what to fix.', true);
      return;
    }
    await api(`/api/admin/${kind}/${id}/${action}`, { method: 'POST', body: { note } });
    await loadCore();
    toast(action === 'approve' ? 'Approved — it is now live in the app ✅' : 'Rejected — the partner has been notified.');
    renderMain();
  } catch (e) {
    toast(e.message, true);
  }
};

window.reviewWithdrawal = async (id, action) => {
  try {
    const note = $(`#wnote-${id}`) ? $(`#wnote-${id}`).value.trim() : '';
    await api(`/api/admin/withdrawals/${id}/${action}`, { method: 'POST', body: { note } });
    await loadCore();
    toast(action === 'approve' ? 'Payout marked as paid ✅' : 'Payout rejected — amount refunded.');
    renderMain();
  } catch (e) {
    toast(e.message, true);
  }
};

window.reviewPartnerKyc = async (id, action) => {
  try {
    const note = $(`#pnote-${id}`) ? $(`#pnote-${id}`).value.trim() : '';
    if (action === 'reject' && !note) {
      toast('Add a rejection note for the partner.', true);
      return;
    }
    await api(`/api/admin/partners/${id}/kyc/${action}`, { method: 'POST', body: { note } });
    await loadCore();
    toast(action === 'approve' ? 'Partner KYC approved.' : 'Partner KYC rejected.');
    renderMain();
  } catch (e) {
    toast(e.message, true);
  }
};

window.refresh = async () => {
  try {
    await Promise.all([loadCore(), loadLive()]);
    renderMain();
    toast('Refreshed.');
  } catch (e) {
    toast(e.message, true);
  }
};

function logoutLocal() {
  stopLiveTimer();
  disconnectEvents();
  state.token = null;
  state.loggedIn = false;
  localStorage.removeItem('sewago_admin_token');
  render();
}

window.doLogout = async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  logoutLocal();
};

/* ---------------- boot ---------------- */

(async function boot() {
  if (state.token) {
    try {
      await Promise.all([loadCore(), loadLive()]);
      render();
      startLiveTimer();
      connectEvents();
      return;
    } catch (e) {
      state.token = null;
      localStorage.removeItem('sewago_admin_token');
    }
  }
  render();
})();
