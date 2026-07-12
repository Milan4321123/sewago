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
  showWithdraw: false
};

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

async function reload() {
  const me = await api('/api/partner/me');
  state.partner = me.partner;
  state.restaurants = me.restaurants;
  state.hotels = me.hotels;
  state.transactions = me.transactions || [];
  state.promoteWeekPrice = me.promoteWeekPrice || 500;
  await reloadOrders();
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
  eventSource.onmessage = async () => {
    await reloadOrders();
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
      <div class="logo">🏪</div>
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
        partner.demo@sewago.app
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
  reloadOrders().then(() => render()).catch(() => {});
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
  const ready = partnerReady();
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">Sewa<em>Go</em> <span class="muted" style="font-size:13px;font-weight:700">PARTNER</span></div>
      <span class="badge">${esc(state.partner.name)}</span>
    </header>
    <main>
      <div class="muted small" style="margin-bottom:14px">
        New listings go to the <b style="color:var(--text)">SewaGo review team</b> first (we verify your documents and may call you). Once approved they appear in the customer app — restaurants in <b style="color:var(--text)">Food</b>, hotels in <b style="color:var(--text)">Stays</b>.
      </div>
      ${kycCard()}
      ${ordersSection()}
      ${earningsCard()}

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

function kycCard() {
  const p = state.partner;
  const status = p.businessKycStatus || 'pending';
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
    <label class="field" style="margin-top:12px"><span>Phone</span>
      <input id="partner-phone" value="${esc(p.phone || '')}" placeholder="e.g. 9841000000" />
    </label>
    <div class="grid2">
      <button class="btn ghost" onclick="partnerRequestOtp()">Send OTP</button>
      <label class="field"><span>OTP code</span><input id="partner-otp" placeholder="123456" /></label>
    </div>
    <button class="btn" onclick="partnerVerifyOtp()">Verify phone</button>
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
    <button class="btn" onclick="submitPartnerKyc()">Submit KYC for review</button>
  </div>`;
}

function earningsCard() {
  const p = state.partner;
  return `
  <div class="card">
    <div class="row">
      <div>
        <div class="muted small">Earnings balance</div>
        <div style="font-size:24px;font-weight:900">${money(p.earnings || 0)}</div>
      </div>
      <span style="font-size:28px">💰</span>
    </div>
    <div class="muted small" style="margin-top:6px">
      You receive <b style="color:var(--text)">85%</b> of food subtotals and <b style="color:var(--text)">90%</b> of bookings, credited instantly (reversed on cancellations).
    </div>
    <button class="btn ghost" style="margin-top:12px" onclick="toggleWithdraw()">🏦 Withdraw earnings</button>
    ${state.showWithdraw ? `
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
        icon: $('#r-icon').value
      }
    });
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
    <div class="row">
      <div>
        <div style="font-weight:900">${r.icon} ${esc(r.name)} ${reviewStatusBadge(r)}</div>
        <div class="muted small">${esc(r.cuisine)} · ${r.etaMinutes} min · delivery ${money(r.deliveryFee)}</div>
      </div>
      <button class="btn danger compact" onclick="deleteRestaurant('${r.id}')">Remove</button>
    </div>
    ${reviewStatusLine(r, 'restaurants')}
    ${promoBlock('restaurants', r)}
    <div class="divider"></div>
    ${r.menu.length === 0 ? `<div class="muted small" style="margin-bottom:10px">⚠️ No menu items yet — customers can't order until you add some.</div>` : ''}
    ${r.menu.map((m) => `
      <div class="row" style="margin-bottom:8px">
        <div>
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
        desc: $(`#mi-desc-${rid}`).value.trim()
      }
    });
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
        icon: $('#h-icon').value
      }
    });
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
    <div class="row">
      <div>
        <div style="font-weight:900">${h.icon} ${esc(h.name)} ${reviewStatusBadge(h)}</div>
        <div class="muted small">${esc(h.area)}${h.area ? ', ' : ''}${esc(h.city)}${h.desc ? ' · ' + esc(h.desc) : ''}</div>
      </div>
      <button class="btn danger compact" onclick="deleteHotel('${h.id}')">Remove</button>
    </div>
    ${reviewStatusLine(h, 'hotels')}
    ${promoBlock('hotels', h)}
    <div class="divider"></div>
    ${h.rooms.length === 0 ? `<div class="muted small" style="margin-bottom:10px">⚠️ No room types yet — customers can't book until you add some.</div>` : ''}
    ${h.rooms.map((room) => `
      <div class="row" style="margin-bottom:8px">
        <div>
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
        amenities: $(`#ro-amen-${hid}`).value
      }
    });
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
