/* SewaGo Admin — platform control room: overview, live ops, approvals, money, people */

const $ = (sel) => document.querySelector(sel);

const TABS = [
  { id: 'overview', label: 'Overview', ico: '📊' },
  { id: 'live', label: 'Live', ico: '🗺️' },
  { id: 'approvals', label: 'Approvals', ico: '✅' },
  { id: 'money', label: 'Money', ico: '💸' },
  { id: 'people', label: 'People', ico: '👥' }
];

// Old pill-row tab ids may still be sitting in localStorage from before the
// restructure — map them onto the tab that absorbed them.
const LEGACY_TABS = { reviews: 'approvals', payments: 'money', partners: 'approvals' };

function normalizeTab(t) {
  t = LEGACY_TABS[t] || t;
  return TABS.some((x) => x.id === t) ? t : 'live';
}

const state = {
  token: localStorage.getItem('sewago_admin_token'),
  loggedIn: false,
  tab: normalizeTab(localStorage.getItem('sewago_admin_tab')),
  stats: null,
  live: null,
  queue: { restaurants: [], hotels: [], stores: [] },
  partners: [],
  pendingDrivers: [],
  attention: [], // abandoned-delivery incidents awaiting a staff sign-off
  payments: { pendingWithdrawals: [], stats: {}, revenue: {}, ledger: [] },
  approvalOpen: null, // 'kind:id' of the expanded approvals-inbox row
  inlineOpen: null,   // key of the one open .inline-form on the People tab
  ledgerShown: 15,    // Money tab ledger rows currently visible ("show more")
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
  if (sec < 172800) return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
  return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
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

// Core data behind badges + the Overview/Approvals/Money tabs.
async function loadCore() {
  const [o, q, p, pay, ppl, att] = await Promise.all([
    api('/api/admin/overview'),
    api('/api/admin/queue'),
    api('/api/admin/partners'),
    api('/api/admin/payments'),
    api('/api/admin/people?q='), // newest signups → pending driver licenses for the inbox
    api('/api/admin/attention')  // couriers who vanished with collected orders
  ]);
  state.stats = o.stats;
  state.revenueTrend = o.revenueTrend || [];
  state.reconciliation = o.reconciliation || null;
  state.queue = {
    restaurants: q.restaurants || [],
    hotels: q.hotels || [],
    stores: q.stores || []
  };
  state.partners = p.partners;
  state.payments = pay;
  state.attention = att.orders || [];
  // Licenses awaiting a manual decision (drivers self-verify at signup, so
  // these are the rare flagged/rejected-and-resubmitted cases).
  state.pendingDrivers = (ppl.drivers || []).filter((d) => d.verificationStatus === 'pending');
  // Seed the People tab with the newest-signups feed so a persisted 'people'
  // tab never boots blank (a search replaces it with the queried result).
  if (!state.people && !state.peopleQuery) state.people = ppl;
  state.loggedIn = true;
}

async function loadLive() {
  state.live = await api('/api/admin/live');
  state.loggedIn = true;
}

// Any approve/reject touches data shown on several tabs (inbox badge, people
// rows, payout pipeline) — refresh both feeds so whichever tab is open is true.
async function reloadAfterAction() {
  await Promise.all([loadCore(), loadPeople(state.peopleQuery || '')]);
  renderMain();
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
  // The container was just inserted, so Leaflet may have measured it at 0x0 —
  // recompute the size on the next frame or fitBounds picks a world-level zoom.
  setTimeout(() => {
    if (!liveMap) return;
    liveMap.invalidateSize();
    if (pts.length) liveMap.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 15 });
    else liveMap.setView(KATHMANDU, 12);
  }, 50);
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
  const tabs = document.getElementById('admin-tabbar');
  if (tabs) tabs.innerHTML = tabbarButtons();
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

// The books check themselves: the append-only ledger vs the same revenue
// recomputed from booking rows. Any drift means a money path wrote one and not
// the other, so it is shown loudly rather than quietly corrupting the numbers.
function reconciliationRow() {
  const r = state.reconciliation;
  if (!r) return '';
  if (!r.drift) {
    return `<div class="card" style="border:1px solid rgba(34,197,94,0.4)">
      <div class="list-row" style="border:none;padding:0">
        <div>✅ <b>Books reconcile</b><div class="muted small">Ledger matches revenue recomputed from bookings.</div></div>
        <div class="rt"><b style="color:var(--accent)">${money(r.ledgerTotal)}</b></div>
      </div>
    </div>`;
  }
  return `<div class="card" style="border:1px solid #b91c1c;background:rgba(185,28,28,0.12)">
    <div style="font-weight:900;color:#fca5a5">⚠️ Books do not reconcile — drift ${money(r.drift)}</div>
    <div class="muted small" style="margin-top:4px">
      Ledger says <b style="color:var(--text)">${money(r.ledgerTotal)}</b>, recomputing from bookings says
      <b style="color:var(--text)">${money(r.derivedTotal)}</b>. A money path is writing one but not the other — investigate before trusting these figures.
    </div>
  </div>`;
}

// 14-day revenue bars (inline SVG, ledger-driven). Hover a bar for the day's
// exact numbers; the dots row underneath shows completed rides.
function trendChart() {
  const t = state.revenueTrend || [];
  if (!t.length) return '';
  const W = 560, H = 120, pad = 4;
  const bw = (W - pad * 2) / t.length;
  const max = Math.max(1, ...t.map((d) => d.revenue));
  const bars = t.map((d, i) => {
    const h = Math.max(d.revenue > 0 ? 3 : 0, Math.round((d.revenue / max) * (H - 24)));
    const x = pad + i * bw;
    const label = `${d.day}: Rs ${d.revenue.toLocaleString()} · ${d.rides} ride${d.rides === 1 ? '' : 's'}`;
    return `<g><title>${label}</title>
      <rect x="${(x + bw * 0.15).toFixed(1)}" y="${H - 16 - h}" width="${(bw * 0.7).toFixed(1)}" height="${h}" rx="2" fill="var(--accent)" opacity="${d.revenue ? 0.9 : 0.25}"></rect>
      ${d.rides ? `<circle cx="${(x + bw / 2).toFixed(1)}" cy="${H - 7}" r="2.5" fill="var(--muted)"></circle>` : ''}
    </g>`;
  }).join('');
  const total = t.reduce((s, d) => s + d.revenue, 0);
  return `
  <div class="section-title">Last 14 days · ${money(total)} revenue 📈</div>
  <div class="card" style="overflow-x:auto">
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;max-height:140px;display:block">${bars}</svg>
    <div class="muted small" style="display:flex;justify-content:space-between"><span>${t[0].day}</span><span>today</span></div>
  </div>`;
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

  ${trendChart()}

  ${reconciliationRow()}

  <div class="section-title">Revenue breakdown 💰</div>
  <div class="card">
    <div class="list-row"><div>🚗 Ride commission (20%)</div><div class="rt"><b>${money(s.rideCommission)}</b></div></div>
    <div class="list-row"><div>🍔 Food commission</div><div class="rt"><b>${money(s.foodCommission)}</b></div></div>
    <div class="list-row"><div>🏪 Store commission</div><div class="rt"><b>${money(s.storeCommission || 0)}</b></div></div>
    <div class="list-row"><div>🏨 Stay commission</div><div class="rt"><b>${money(s.stayCommission)}</b></div></div>
    <div class="list-row"><div>🧰 Task fees</div><div class="rt"><b>${money(s.taskFees)}</b></div></div>
    <div class="list-row"><div>🏦 Withdrawal fees</div><div class="rt"><b>${money(s.withdrawalFees)}</b></div></div>
    <div class="list-row"><div>🧾 Service fees</div><div class="rt"><b>${money(s.serviceFees || 0)}</b></div></div>
    <div class="list-row"><div>⏱️ Late-cancel fees</div><div class="rt"><b>${money(s.cancelFees || 0)}</b></div></div>
    <div class="list-row"><div>⭐ Featured listings</div><div class="rt"><b>${money(s.promotionFees || 0)}</b></div></div>
    ${s.courierPayouts ? `<div class="list-row"><div>🛵 Courier payouts <span class="muted small">(cost)</span></div><div class="rt"><b style="color:#f87171">${money(s.courierPayouts)}</b></div></div>` : ''}
    <div class="list-row"><div><b>Total</b></div><div class="rt"><b style="color:var(--accent)">${money(s.revenue)}</b></div></div>
  </div>`;
}

/* ---------------- approvals inbox ---------------- */
/* One queue for everything that waits on a human decision: listing reviews
   (restaurants, hotels, kirana shops), partner business KYC, driver license
   verifications and payout approvals. Oldest first, expandable in place. */

function pendingKycPartners() {
  return state.partners.filter((p) =>
    (p.businessKycStatus || 'pending') === 'pending' &&
    p.businessKycDocumentRef && p.businessKycDocumentRef !== '—');
}

// Flatten every pending decision into one age-sorted list. Rows whose source
// doesn't expose a submission time (KYC, licenses) sink to the bottom.
function approvalItems() {
  const items = [];
  state.queue.restaurants.forEach((r) => items.push({
    kind: 'restaurants', id: r.id, emoji: r.icon || '🍽️', title: esc(r.name),
    sub: `Restaurant · ${esc(r.cuisine)} · ${r.menu.length} menu item${r.menu.length === 1 ? '' : 's'}`,
    at: r.submittedAt || 0, data: r
  }));
  state.queue.hotels.forEach((h) => items.push({
    kind: 'hotels', id: h.id, emoji: h.icon || '🏨', title: esc(h.name),
    sub: `Hotel · ${esc(h.area)}${h.area ? ', ' : ''}${esc(h.city)} · ${h.rooms.length} room type${h.rooms.length === 1 ? '' : 's'}`,
    at: h.submittedAt || 0, data: h
  }));
  state.queue.stores.forEach((s) => items.push({
    kind: 'stores', id: s.id, emoji: s.icon || '🏪', title: esc(s.name),
    sub: `Kirana shop · ${esc(s.area || '—')} · ${s.itemCount} item${s.itemCount === 1 ? '' : 's'} listed`,
    at: s.submittedAt || 0, data: s
  }));
  pendingKycPartners().forEach((p) => items.push({
    kind: 'kyc', id: p.id, emoji: '🧾', title: esc(p.name),
    sub: `Business KYC · Reg/PAN ${esc(p.regNo)}`,
    at: 0, data: p
  }));
  state.pendingDrivers.forEach((d) => items.push({
    kind: 'license', id: d.id, emoji: '🪪', title: esc(d.name),
    sub: `Driver license · ${esc(d.tier)} · ${esc(d.plate || '—')}`,
    at: 0, data: d
  }));
  state.payments.pendingWithdrawals.forEach((w) => items.push({
    kind: 'payout', id: w.id, emoji: '🏦', title: esc(w.ownerName),
    sub: `Payout · ${money(w.amount)} + ${money(w.fee)} fee → ${esc(w.channelLabel)}`,
    at: w.createdAt || 0, data: w
  }));
  (state.attention || []).forEach((o) => items.push({
    kind: 'attention', id: o.id, emoji: '🚨', title: esc(o.restaurantName),
    sub: `Abandoned delivery · ${money(o.total)} · 🛵 ${esc(o.courier ? o.courier.name : 'unknown courier')}`,
    at: o.abandonedAt || 0, data: o
  }));
  return items.sort((a, b) => (a.at || Infinity) - (b.at || Infinity));
}

// Age chip that heats up as an item sits unhandled: amber after 6h, red after 24h.
function ageChip(ts) {
  if (!ts) return '<span class="age">—</span>';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  const cls = sec >= 24 * 3600 ? ' late' : sec >= 6 * 3600 ? ' warn' : '';
  return `<span class="age${cls}">${ago(sec)}</span>`;
}

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

function kycDetail(p) {
  return `
  <div class="muted small">📧 ${esc(p.email)} · 📞 ${esc(p.phone)} ${p.phoneVerified ? '✓' : '⚠️ unverified'} · 🧾 Reg/PAN: ${esc(p.regNo)}</div>
  <div class="muted small">Doc: ${esc(p.businessKycDocumentRef || '—')} · ${p.restaurants} restaurant${p.restaurants === 1 ? '' : 's'}, ${p.hotels} hotel${p.hotels === 1 ? '' : 's'}</div>
  ${p.businessKycNote ? `<div class="muted small" style="color:var(--danger);margin-top:4px">${esc(p.businessKycNote)}</div>` : ''}
  ${p.phoneVerified ? '' : `<div class="muted small" style="color:var(--amber);margin-top:4px">Phone must be verified before KYC can be approved.</div>`}
  <div class="muted small" style="margin-top:4px">Call the partner and check the registration number before approving.</div>
  <label class="field" style="margin-top:12px"><span>KYC rejection note</span>
    <input id="pnote-${p.id}" placeholder="e.g. certificate photo is unreadable" />
  </label>
  <div class="grid2">
    <button class="btn" onclick="reviewPartnerKyc('${p.id}','approve')" ${p.phoneVerified ? '' : 'disabled'}>✓ Approve KYC</button>
    <button class="btn danger" onclick="reviewPartnerKyc('${p.id}','reject')">✕ Reject KYC</button>
  </div>`;
}

function licenseDetail(d) {
  return `
  <div class="muted small">${esc(d.tier)} · ${esc(d.vehicle || '—')} · ${esc(d.plate || '—')} · 📞 ${esc(d.phone)}</div>
  <div class="muted small">⭐ ${d.rating || '—'} · ${d.tripsCompleted} trips${d.runNoShows ? ` · ⚠️ ${d.runNoShows} run no-show${d.runNoShows === 1 ? '' : 's'}` : ''}</div>
  <label class="field" style="margin-top:12px"><span>Rejection note (sent to the driver)</span>
    <input id="dnote-${d.id}" placeholder="e.g. license photo unreadable" />
  </label>
  <div class="grid2">
    <button class="btn" onclick="decideDriverVerification('${d.id}','approve')">✓ Approve license</button>
    <button class="btn danger" onclick="decideDriverVerification('${d.id}','reject')">✕ Reject</button>
  </div>`;
}

function payoutDetail(w) {
  return `
  <div class="muted small">${w.ownerKind.toUpperCase()} · ${money(w.amount)} + ${money(w.fee)} fee → ${esc(w.channelLabel)} · ${esc(w.account)}</div>
  <label class="field" style="margin-top:12px"><span>Transfer reference (required to mark paid)</span>
    <input id="wref-${w.id}" placeholder="e.g. eSewa ref 8817-…" />
  </label>
  <label class="field"><span>Rejection note</span>
    <input id="wnote-${w.id}" placeholder="e.g. account name mismatch" />
  </label>
  <div class="grid2">
    <button class="btn" onclick="reviewWithdrawal('${w.id}','approve')">✓ Mark paid</button>
    <button class="btn danger" onclick="reviewWithdrawal('${w.id}','reject')">✕ Reject & refund</button>
  </div>`;
}

// Abandoned-delivery incident. Money is already resolved by the time one lands
// here (customer refunded, restaurant paid, courier billed) — this row exists
// so a human closes the loop on the physical goods and the courier who took them.
function attentionDetail(o) {
  return `
  <div class="muted small">${esc(o.items)}</div>
  <div class="muted small">${money(o.total)} · ${o.payment === 'cash' ? 'CASH — customer had not paid' : 'PAID IN APP — customer auto-refunded'} · courier billed ${money(o.total)}</div>
  <div style="background:var(--card2);border-radius:10px;padding:10px 12px;margin-top:10px">
    <div class="small">🛵 <b>${esc(o.courier ? o.courier.name : 'Unknown courier')}</b>${o.courier ? ` · 📞 ${esc(o.courier.phone)} · owes <b style="color:var(--danger)">${money(o.courier.owes)}</b>${o.courier.suspended ? ' · <span style="color:var(--danger)">SUSPENDED</span>' : ''}` : ''}</div>
    ${o.customer ? `<div class="muted small">👤 ${esc(o.customer.name)} · 📞 ${esc(o.customer.phone)}</div>` : ''}
    <div class="muted small" style="margin-top:3px">Call the courier about the food; suspend them or settle their debt from the 👥 People tab.</div>
  </div>
  <label class="field" style="margin-top:12px"><span>Resolution note (kept on the audit trail)</span>
    <input id="anote-${o.id}" placeholder="e.g. goods written off, courier suspended" />
  </label>
  <button class="btn" style="margin-top:4px" onclick="resolveAttention('${o.id}')">✓ Dealt with — clear</button>`;
}

function approvalDetail(item) {
  const d = item.data;
  if (item.kind === 'restaurants') {
    return `
    <div class="muted small">${esc(d.cuisine)} · ${d.etaMinutes} min · delivery ${money(d.deliveryFee)}</div>
    <div class="muted small" style="margin-top:6px">
      Menu (${d.menu.length} item${d.menu.length === 1 ? '' : 's'}): ${d.menu.length ? d.menu.map((m) => `${esc(m.name)} ${money(m.price)}`).join(' · ') : '⚠️ empty — consider rejecting'}
    </div>
    ${partnerBlock(d.partner)}
    ${reviewActions('restaurants', d.id)}`;
  }
  if (item.kind === 'hotels') {
    return `
    <div class="muted small">${esc(d.area)}${d.area ? ', ' : ''}${esc(d.city)}${d.desc ? ' · ' + esc(d.desc) : ''}</div>
    <div class="muted small" style="margin-top:6px">
      Rooms (${d.rooms.length}): ${d.rooms.length ? d.rooms.map((room) => `${esc(room.type)} ${money(room.pricePerNight)}/n ×${room.count}`).join(' · ') : '⚠️ none — consider rejecting'}
    </div>
    ${partnerBlock(d.partner)}
    ${reviewActions('hotels', d.id)}`;
  }
  if (item.kind === 'stores') {
    return `
    <div class="muted small">${esc(d.area || '—')} · ${d.itemCount} item${d.itemCount === 1 ? '' : 's'} listed${d.itemCount ? '' : ' · ⚠️ empty — consider rejecting'}</div>
    ${partnerBlock(d.partner)}
    ${reviewActions('stores', d.id)}`;
  }
  if (item.kind === 'kyc') return kycDetail(d);
  if (item.kind === 'license') return licenseDetail(d);
  if (item.kind === 'attention') return attentionDetail(d);
  return payoutDetail(d);
}

window.resolveAttention = async (id) => {
  try {
    const note = ($(`#anote-${id}`) || { value: '' }).value.trim();
    await api(`/api/admin/orders/${id}/attention/resolve`, { method: 'POST', body: { note } });
    state.approvalOpen = null;
    toast('Incident cleared ✓');
    await reloadAfterAction();
  } catch (e) {
    toast(e.message, true);
  }
};

function queueRowHtml(item) {
  const key = item.kind + ':' + item.id;
  const open = state.approvalOpen === key;
  return `
  <div class="queue-row" onclick="toggleApproval('${key}')">
    <div class="emoji">${item.emoji}</div>
    <div><h4>${item.title}</h4><div class="sub">${item.sub}</div></div>
    ${ageChip(item.at)}
  </div>
  ${open ? `<div class="queue-detail">${approvalDetail(item)}</div>` : ''}`;
}

function approvalsView() {
  const items = approvalItems();
  if (!items.length) {
    return `<div class="section-title" style="margin-top:0">Approvals ✅</div>
      <div class="empty"><div class="big">✅</div>Inbox zero — nothing is waiting on a decision.</div>`;
  }
  return `
  <div class="section-title" style="margin-top:0">Approvals ✅ <span class="badge amber">${items.length} waiting</span></div>
  <div class="muted small" style="margin:0 2px 10px">Listings, KYC, licenses and payouts — oldest first. Tap a row to review in place.</div>
  <div class="card">${items.map(queueRowHtml).join('')}</div>`;
}

window.toggleApproval = (key) => {
  state.approvalOpen = state.approvalOpen === key ? null : key;
  renderMain();
};

/* ---------------- money ---------------- */
/* Payment KPIs + payout pipeline + the revenue ledger. Approvals happen in the
   inbox; this tab is for reading the money, not mutating it. */

const LEDGER_PAGE = 20;

function moneyView() {
  const pay = state.payments;
  const pending = pay.pendingWithdrawals;
  const ledger = pay.ledger || [];
  const shown = Math.min(state.ledgerShown, ledger.length);
  return `
  <div class="section-title" style="margin-top:0">Money 💸</div>
  <div class="kpi-grid">
    ${statTile('Top-ups collected', money(pay.stats.topupVolume))}
    ${statTile('Top-up count', pay.stats.topupCount || 0)}
    ${statTile('Payouts paid', money(pay.stats.withdrawalsPaid))}
    <div class="kpi accent"><div class="v">${money(pay.stats.withdrawalFees)}</div><div class="l">Payout fees earned</div></div>
  </div>

  <div class="section-title">Payout pipeline 🏦 ${pending.length ? `<span class="badge amber">${pending.length} waiting</span>` : ''}</div>
  ${pending.length === 0
    ? `<div class="empty"><div class="big">🏦</div>No payouts waiting for approval.</div>`
    : `<div class="card">
      ${pending.map((w) => `
        <div class="list-row">
          <div>
            <div><b>${esc(w.ownerName)}</b> <span class="badge gray">${w.ownerKind.toUpperCase()}</span></div>
            <div class="muted small">${money(w.amount)} + ${money(w.fee)} fee → ${esc(w.channelLabel)} · ${esc(w.account)}</div>
          </div>
          <span class="badge amber">PROCESSING</span>
        </div>`).join('')}
      <button class="btn ghost" style="margin-top:10px" onclick="setTab('approvals')">Approve or reject in the ✅ Approvals inbox →</button>
    </div>`}

  <div class="section-title">Revenue ledger 🧾</div>
  ${ledger.length ? `<div class="card">
    ${ledger.slice(0, shown).map((e) => `
      <div class="list-row">
        <div><div>${esc(e.label)}</div><div class="muted small">${esc(e.source)} · ${fmtTime(e.createdAt || e.at)}</div></div>
        <div class="rt"><b style="color:${e.amount < 0 ? 'var(--danger)' : 'var(--accent)'}">${money(e.amount)}</b></div>
      </div>`).join('')}
    ${shown < ledger.length
      ? `<button class="btn ghost" style="margin-top:10px" onclick="showMoreLedger()">Show ${Math.min(LEDGER_PAGE, ledger.length - shown)} more (${ledger.length - shown} hidden)</button>`
      : ''}
  </div>` : `<div class="muted small">No revenue entries yet.</div>`}`;
}

window.showMoreLedger = () => {
  state.ledgerShown += LEDGER_PAGE;
  renderMain();
};

/* ---------------- people (customers + drivers + partner directory) ---------------- */

async function loadPeople(q) {
  state.people = await api('/api/admin/people?q=' + encodeURIComponent(q || ''));
  state.loggedIn = true;
}

/* One .inline-form is open at a time (state.inlineOpen). Each caller renders
   its own inputs; Confirm calls a submit handler that reads them by id. */
function inlineFormHtml(label, inner, confirmCall, confirmLabel) {
  return `<div class="inline-form">
    <span>${label}</span>
    ${inner}
    <button class="btn compact" onclick="${confirmCall}">${confirmLabel}</button>
    <button class="btn ghost compact" onclick="closeInline()">Cancel</button>
  </div>`;
}

window.openInline = (key) => {
  state.inlineOpen = state.inlineOpen === key ? null : key;
  renderMain();
};

window.closeInline = () => {
  state.inlineOpen = null;
  renderMain();
};

function userRow(u) {
  const creditKey = 'wallet+:' + u.id;
  const debitKey = 'wallet-:' + u.id;
  const susKey = 'suspend-users:' + u.id;
  return `
  <div class="card" style="margin-top:10px">
    <div class="list-row" style="border:none;padding:0">
      <div>
        <b>${esc(u.name)}</b> ${u.suspended ? '<span class="badge red">SUSPENDED</span>' : ''}
        <div class="muted small">📧 ${esc(u.email)} · 📞 ${esc(u.phone)} ${u.phoneVerified ? '✓' : '⚠️'}</div>
      </div>
      <div class="rt"><b>${money(u.wallet)}</b><div class="muted small">wallet</div></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="btn ghost compact" onclick="openInline('${creditKey}')">➕ Credit</button>
      <button class="btn ghost compact" onclick="openInline('${debitKey}')">➖ Debit</button>
      ${u.suspended
        ? `<button class="btn ghost compact" onclick="suspendPerson('users','${u.id}','unsuspend')">✓ Reinstate</button>`
        : `<button class="btn ghost compact danger" onclick="openInline('${susKey}')">⛔ Suspend</button>`}
    </div>
    ${state.inlineOpen === creditKey ? inlineFormHtml(
      'Goodwill credit — amount and reason go on the audit trail and the customer\'s receipt',
      `<input id="inf-amount" type="number" placeholder="Rs" /><input id="inf-reason" placeholder="Reason (min 5 chars)" />`,
      `submitWalletAdjust('${u.id}',1)`, '➕ Credit') : ''}
    ${state.inlineOpen === debitKey ? inlineFormHtml(
      'Correction debit — amount and reason go on the audit trail and the customer\'s receipt',
      `<input id="inf-amount" type="number" placeholder="Rs" /><input id="inf-reason" placeholder="Reason (min 5 chars)" />`,
      `submitWalletAdjust('${u.id}',-1)`, '➖ Debit') : ''}
    ${state.inlineOpen === susKey ? inlineFormHtml(
      'Suspension reason (kept on the audit trail)',
      `<input id="inf-reason" placeholder="e.g. repeated chargebacks" />`,
      `suspendPerson('users','${u.id}','suspend')`, '⛔ Suspend') : ''}
  </div>`;
}

function driverRow(d) {
  const ver = d.verificationStatus;
  const settleKey = 'settle:' + d.id;
  const dlKey = 'dl-reject:' + d.id;
  const susKey = 'suspend-drivers:' + d.id;
  return `
  <div class="card" style="margin-top:10px">
    <div class="list-row" style="border:none;padding:0">
      <div>
        <b>${esc(d.name)}</b>
        <span class="muted small">· ${esc(d.tier)} · ${esc(d.vehicle || '—')} · ${esc(d.plate || '—')}</span>
        ${d.suspended ? '<span class="badge red">SUSPENDED</span>' : ''}
        <div class="muted small">
          ${d.online ? '🟢 online' : '⚪ offline'}${d.online && !d.locationFresh ? ' (GPS stale)' : ''}
          · ⭐ ${d.rating || '—'} · ${d.tripsCompleted} trips
          · license: <b style="color:${ver === 'verified' ? 'var(--accent)' : ver === 'rejected' ? '#f87171' : '#fbbf24'}">${esc(ver.toUpperCase())}</b>
        </div>
      </div>
      <div class="rt">
        ${d.commissionOwed > 0
          ? `<b style="color:#f87171">–${money(d.commissionOwed)}</b><div class="muted small">owes SewaGo</div>`
          : `<b>${money(d.earnings)}</b><div class="muted small">earnings</div>`}
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      ${d.commissionOwed > 0 ? `<button class="btn compact" onclick="openInline('${settleKey}')">💵 Record cash settlement</button>` : ''}
      ${ver !== 'verified' ? `<button class="btn ghost compact" onclick="decideDriverVerification('${d.id}','approve')">✓ Approve license</button>` : ''}
      ${ver !== 'rejected' ? `<button class="btn ghost compact danger" onclick="openInline('${dlKey}')">✕ Reject license</button>` : ''}
      ${d.suspended
        ? `<button class="btn ghost compact" onclick="suspendPerson('drivers','${d.id}','unsuspend')">✓ Reinstate</button>`
        : `<button class="btn ghost compact danger" onclick="openInline('${susKey}')">⛔ Suspend</button>`}
    </div>
    ${state.inlineOpen === settleKey ? inlineFormHtml(
      `Cash collected at the SewaGo point (owes ${money(d.commissionOwed)}) — leave blank to settle it all`,
      `<input id="inf-amount" type="number" placeholder="${d.commissionOwed}" />`,
      `submitSettleCash('${d.id}')`, '💵 Record') : ''}
    ${state.inlineOpen === dlKey ? inlineFormHtml(
      'Rejection note (sent to the driver)',
      `<input id="dnote-${d.id}" placeholder="e.g. license photo unreadable" />`,
      `decideDriverVerification('${d.id}','reject')`, '✕ Reject') : ''}
    ${state.inlineOpen === susKey ? inlineFormHtml(
      'Suspension reason (kept on the audit trail)',
      `<input id="inf-reason" placeholder="e.g. rider complaints" />`,
      `suspendPerson('drivers','${d.id}','suspend')`, '⛔ Suspend') : ''}
  </div>`;
}

// Compact partner directory card. KYC decisions live in the Approvals inbox;
// this is the reference view (contact, status, listing counts).
function partnerCard(p) {
  return `
  <div class="card" style="margin-top:10px">
    <div><b>${esc(p.name)}</b> <span class="muted small">· ${p.restaurants} restaurant${p.restaurants === 1 ? '' : 's'}, ${p.hotels} hotel${p.hotels === 1 ? '' : 's'}</span></div>
    <div class="muted small">📧 ${esc(p.email)} · 📞 ${esc(p.phone)} ${p.phoneVerified ? '✓ verified' : '⚠️ unverified'} · 🧾 ${esc(p.regNo)}</div>
    <div class="muted small">KYC: <b style="color:var(--text)">${esc((p.businessKycStatus || 'pending').toUpperCase())}</b> · Doc: ${esc(p.businessKycDocumentRef || '—')}</div>
    ${p.businessKycNote ? `<div class="muted small" style="color:var(--danger);margin-top:4px">${esc(p.businessKycNote)}</div>` : ''}
  </div>`;
}

// Partners come from the core feed, so filter them client-side with the same
// search box that drives the server-side customer/driver lookup.
function filteredPartners() {
  const q = (state.peopleQuery || '').trim().toLowerCase();
  if (!q) return state.partners;
  return state.partners.filter((p) =>
    [p.name, p.email, p.phone, p.regNo].some((f) => f && String(f).toLowerCase().includes(q)));
}

function peopleView() {
  const p = state.people;
  const partners = filteredPartners();
  return `
  <div class="section-title" style="margin-top:0">People 👥</div>
  <div class="card">
    <label class="field" style="margin:0"><span>Search customers, drivers & partners (name, email, phone, plate)</span>
      <input id="people-q" value="${esc(state.peopleQuery || '')}" placeholder="e.g. 98… or aarav"
        onkeydown="if(event.key==='Enter')searchPeople()" />
    </label>
    <button class="btn compact" style="margin-top:10px" onclick="searchPeople()">Search</button>
  </div>
  ${!p ? `<div class="empty"><div class="big">👥</div>Loading…</div>` : `
    <div class="section-title">Customers (${p.users.length}${state.peopleQuery ? ' matching' : ' newest'})</div>
    ${p.users.length ? p.users.map(userRow).join('') : `<div class="empty">No customers found.</div>`}
    <div class="section-title">Drivers (${p.drivers.length}${state.peopleQuery ? ' matching' : ' newest'})</div>
    ${p.drivers.length ? p.drivers.map(driverRow).join('') : `<div class="empty">No drivers found.</div>`}
    <div class="section-title">Partners (${partners.length}${state.peopleQuery ? ' matching' : ''})</div>
    ${partners.length ? partners.map(partnerCard).join('') : `<div class="empty">No partners found.</div>`}
    <div class="muted small" style="margin:8px 2px 0">Pending business KYC is reviewed in the ✅ Approvals inbox.</div>
  `}`;
}

window.searchPeople = async () => {
  state.peopleQuery = ($('#people-q') || { value: '' }).value.trim();
  try {
    await loadPeople(state.peopleQuery);
    renderMain();
  } catch (e) { toast(e.message, true); }
};

window.suspendPerson = async (kind, id, action) => {
  const note = action === 'suspend' ? (($('#inf-reason') || { value: '' }).value || '').trim() : '';
  if (action === 'suspend' && !note) return toast('Suspension needs a reason.', true);
  try {
    await api(`/api/admin/${kind}/${id}/${action}`, { method: 'POST', body: { note } });
    toast(action === 'suspend' ? 'Account suspended ⛔' : 'Account reinstated ✓');
    state.inlineOpen = null;
    await reloadAfterAction();
  } catch (e) { toast(e.message, true); }
};

window.submitSettleCash = async (id) => {
  const raw = (($('#inf-amount') || { value: '' }).value || '').trim();
  const body = raw ? { amount: Math.round(Number(raw)) } : {};
  try {
    const res = await api(`/api/admin/drivers/${id}/settle-cash`, { method: 'POST', body });
    toast(`Recorded ${money(res.settled)} cash settlement ✓`);
    state.inlineOpen = null;
    await reloadAfterAction();
  } catch (e) { toast(e.message, true); }
};

// Shared by the Approvals inbox and the People tab — both render the
// rejection note into #dnote-<id>, so one reader covers both surfaces.
window.decideDriverVerification = async (id, action) => {
  const noteEl = $(`#dnote-${id}`);
  const note = noteEl ? noteEl.value.trim() : '';
  if (action === 'reject' && !note) return toast('Rejection needs a note for the driver.', true);
  try {
    await api(`/api/admin/drivers/${id}/verification/${action}`, { method: 'POST', body: { note } });
    toast(action === 'approve' ? 'Driver license approved ✓' : 'Driver license rejected.');
    state.inlineOpen = null;
    state.approvalOpen = null;
    await reloadAfterAction();
  } catch (e) { toast(e.message, true); }
};

window.submitWalletAdjust = async (userId, sign) => {
  const amount = Math.round(Number((($('#inf-amount') || { value: '' }).value || '').trim())) * sign;
  const reason = (($('#inf-reason') || { value: '' }).value || '').trim();
  try {
    await api('/api/admin/wallet-adjust', { method: 'POST', body: { userId, amount, reason } });
    toast('Wallet adjusted — the customer sees it as a receipt line ✓');
    state.inlineOpen = null;
    await reloadAfterAction();
  } catch (e) { toast(e.message, true); }
};

/* ---------------- shell ---------------- */

function loginView() {
  return `
  <div class="auth-wrap">
    <div class="auth-hero">
      <div class="logo">🛡️</div>
      <h1>Sewa<em>Go</em> Admin</h1>
      <p>Platform control room — live ops, approvals, money.</p>
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

function tabBadge(tab) {
  if (tab === 'approvals') return approvalItems().length;
  if (tab === 'live') return state.live ? state.live.kpis.activeRides : 0;
  return 0;
}

function tabbarButtons() {
  return TABS.map((t) => {
    const n = tabBadge(t.id);
    return `<button class="${state.tab === t.id ? 'active' : ''}" onclick="setTab('${t.id}')">
      <span class="ico">${t.ico}${n ? `<span class="tab-badge">${n}</span>` : ''}</span>${t.label}
    </button>`;
  }).join('');
}

function mainContent() {
  switch (state.tab) {
    case 'overview': return overviewView();
    case 'approvals': return approvalsView();
    case 'money': return moneyView();
    case 'people': return peopleView();
    default: return liveView();
  }
}

function renderMain() {
  const m = $('#admin-main');
  if (m) {
    m.innerHTML = mainContent();
    // Glide-in only on real tab changes — background re-renders from polling,
    // SSE or row toggles must not replay the animation.
    m.classList.remove('page-enter');
    if (state._pageAnim) {
      void m.offsetWidth; // restart the CSS animation on the same element
      m.classList.add('page-enter');
      state._pageAnim = false;
    }
  }
  const t = $('#admin-tabbar');
  if (t) t.innerHTML = tabbarButtons();
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
      <div class="brand"><img class="brand-mark" src="/icon.svg" alt="" />Sewa<em>Go</em> <span class="muted" style="font-size:13px;font-weight:700">ADMIN</span></div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn ghost compact" onclick="refresh()">↻ Refresh</button>
        <button class="btn danger compact" onclick="doLogout()">Log out</button>
      </div>
    </header>
    <main id="admin-main">${mainContent()}</main>
    <nav class="tabbar" id="admin-tabbar">${tabbarButtons()}</nav>`;
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
  state._pageAnim = state.tab !== tab;
  state.tab = tab;
  localStorage.setItem('sewago_admin_tab', tab);
  renderMain();
  try {
    if (tab === 'live') await loadLive();
    else if (tab === 'people') await loadPeople(state.peopleQuery || '');
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

// Listing reviews (restaurants / hotels / stores) from the Approvals inbox.
window.review = async (kind, id, action) => {
  try {
    const note = $(`#note-${id}`) ? $(`#note-${id}`).value.trim() : '';
    if (action === 'reject' && !note) {
      toast('Add a short rejection note so the partner knows what to fix.', true);
      return;
    }
    await api(`/api/admin/${kind}/${id}/${action}`, { method: 'POST', body: { note } });
    state.approvalOpen = null;
    toast(action === 'approve' ? 'Approved — it is now live in the app ✅' : 'Rejected — the partner has been notified.');
    await reloadAfterAction();
  } catch (e) {
    toast(e.message, true);
  }
};

window.reviewWithdrawal = async (id, action) => {
  try {
    const ref = ($(`#wref-${id}`) || { value: '' }).value.trim();
    const note = ($(`#wnote-${id}`) || { value: '' }).value.trim();
    // Money actions need a paper trail both ways: a transfer reference to mark
    // paid, a note to reject.
    if (action === 'approve' && !ref) {
      toast('Enter the transfer reference — it proves the money actually moved.', true);
      return;
    }
    if (action === 'reject' && !note) {
      toast('Add a rejection note for the requester.', true);
      return;
    }
    await api(`/api/admin/withdrawals/${id}/${action}`, {
      method: 'POST',
      body: action === 'approve' ? { payoutRef: ref } : { note }
    });
    state.approvalOpen = null;
    toast(action === 'approve' ? 'Payout marked as paid ✅' : 'Payout rejected — amount refunded.');
    await reloadAfterAction();
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
    state.approvalOpen = null;
    toast(action === 'approve' ? 'Partner KYC approved.' : 'Partner KYC rejected.');
    await reloadAfterAction();
  } catch (e) {
    toast(e.message, true);
  }
};

window.refresh = async () => {
  try {
    await Promise.all([loadCore(), loadLive(), loadPeople(state.peopleQuery || '')]);
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
