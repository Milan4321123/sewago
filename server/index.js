const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { config, validateProductionConfig } = require('./config');
const { db, save, initDb, flushSaves, backupJsonState, saveHealth } = require('./db');
const sessionTokens = require('./sessionTokens');
const { sweepExpired } = sessionTokens;
const { settleDueBookings } = require('./settlement');
const { recoverAbandonedDeliveries } = require('./orderLogic');
const metrics = require('./metrics');
const logger = require('./logger');
const events = require('./events');
const streamTickets = require('./streamTickets');

validateProductionConfig();

// Last-resort crash guards: log, push the final save out, then let the
// process manager restart us. Never keep running with unknown state.
process.on('uncaughtException', (err) => {
  logger.error('fatal_uncaught_exception', { err: err.message, stack: err.stack });
  Promise.resolve(flushSaves()).catch(() => {}).finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 3000).unref();
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { reason: reason && reason.message ? reason.message : String(reason) });
});

// Die with the harness that spawned us. Test suites spawn this server as a
// child and SIGTERM it in their teardown — but a runner that dies hard
// (SIGKILL, crashed terminal, killed CI job) never runs teardown, and the
// orphaned server then squats on its port and poisons every later run with
// port-in-use / ECONNREFUSED failures. A harness that sets
// EXIT_WHEN_STDIN_CLOSES=1 must also pipe our stdin; the OS closes that pipe
// the moment the runner dies — however it dies — and we exit with it.
// Hard exit on purpose: the data dir is a throwaway and a graceful close
// could hang on open SSE connections.
if (process.env.EXIT_WHEN_STDIN_CLOSES === '1') {
  process.stdin.resume();
  for (const ev of ['end', 'close', 'error']) {
    process.stdin.on(ev, () => process.exit(0));
  }
}

const app = express();
const PORT = config.port;

app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

app.use(compression());
app.use(metrics.metricsMiddleware);

// Per-request ID + structured access log. Every response carries X-Request-Id so
// a customer/driver complaint can be traced to the exact request in the logs.
// To keep volume sane, successful fast requests aren't logged; problems (4xx/5xx)
// and slow requests always are.
app.use((req, res, next) => {
  req.id = crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    if (level === 'info' && ms < 800) return;
    logger[level]('request', { id: req.id, method: req.method, path: req.path, status: res.statusCode, ms, ip: req.ip });
  });
  next();
});

// Security headers on every response. Inline handlers and the Leaflet/CARTO
// map CDN are part of the app, so the CSP allows exactly those and nothing else;
// form-action covers the eSewa checkout form POST.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  // blob: lets the partner portal preview/downscale a picked photo locally
  // (URL.createObjectURL) before uploading it.
  "img-src 'self' data: blob: https://unpkg.com https://*.basemaps.cartocdn.com",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self' https://epay.esewa.com.np https://rc-epay.esewa.com.np"
].join('; ');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=()',
    'Content-Security-Policy': CSP
  });
  if (config.isProduction && config.trustProxy) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.protocol === 'http') return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
  }
  next();
});

app.use(express.json({ limit: '200kb' }));

// Simple in-memory per-IP rate limiting (swap for Redis-backed limiting when scaling out).
function makeLimiter(windowMs, max) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    // Memory cap: evict only entries whose window has already expired. Clearing
    // the whole map would hand every attacker a fresh budget on demand.
    if (hits.size > 20000) {
      for (const [ip, entry] of hits) {
        if (now > entry.resetAt) hits.delete(ip);
      }
    }
    let entry = hits.get(req.ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(req.ip, entry);
    }
    if (++entry.count > max) {
      return res.status(429).json({ error: 'Too many requests — please slow down.' });
    }
    next();
  };
}
// Per-IP request budget (per minute). Raise via env if legitimate users share
// a NAT/proxy IP; the auth limiter below stays strict regardless.
const API_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_API_PER_MIN) || 600;
app.use('/api', makeLimiter(60 * 1000, API_LIMIT_PER_MIN));
// Strict per-IP budget shared by the auth and money paths below (per 10 min).
// Env-tunable for the same NAT reason as above — and because the test suites
// drive one server from one IP and would otherwise trip it as they grow.
const STRICT_LIMIT_PER_10MIN = Number(process.env.RATE_LIMIT_STRICT_PER_10MIN) || 60;
const authLimiter = makeLimiter(10 * 60 * 1000, STRICT_LIMIT_PER_10MIN);
app.use(
  ['/api/auth/login', '/api/auth/register',
    '/api/auth/otp/request', '/api/auth/otp/verify',
    '/api/driver/login', '/api/driver/register', '/api/driver/otp/request', '/api/driver/otp/verify',
    '/api/partner/login', '/api/partner/register', '/api/partner/otp/request', '/api/partner/otp/verify',
    '/api/admin/login'],
  authLimiter
);
// Money movement and phone-verification endpoints get their own strict budget:
// legitimate users touch these a handful of times a day, so a tight cap costs
// them nothing while blunting brute-force OTP guessing and drain-the-wallet loops.
const moneyLimiter = makeLimiter(10 * 60 * 1000, STRICT_LIMIT_PER_10MIN);
app.use(
  ['/api/payments/withdraw', '/api/payments/topup/initiate', '/api/payments/topup/confirm',
    '/api/partner/withdraw', '/api/driver/withdraw',
    '/api/auth/phone/request-otp', '/api/auth/phone/verify',
    '/api/partner/phone/request-otp', '/api/partner/phone/verify',
    '/api/driver/phone/request-otp', '/api/driver/phone/verify',
    // Helper-invite joins are code guesses — same brute-force surface as OTP.
    '/api/stores/helper/join'],
  moneyLimiter
);
// Redeeming a shop's helper invite grants write access to that shop's stock, and
// the code is matched against every shop on the platform — so it needs a budget
// of its own. Deliberately NOT the money limiter: someone fat-fingering an
// invite code must never be able to spend the budget that guards withdrawals.
app.use('/api/stores/helper/join', makeLimiter(10 * 60 * 1000, 30));

// Tells the download page whether a real native app is available to install.
app.get('/api/app-info', (req, res) => {
  res.json({
    androidApkUrl: config.androidApkUrl,
    iosAppStoreUrl: config.iosAppStoreUrl,
    // Clients hide demo credentials / seed-account hints outside development.
    demo: !config.isProduction,
    // The partner app hides the AI stock assistant when no key is configured.
    ai: require('./ai').aiEnabled()
  });
});

app.get('/api/health', (req, res) => {
  const persistence = saveHealth();
  // The save loop silently backing up is the scariest failure (data loss on the
  // next crash), so surface it and fail the health check if writes are stuck.
  const saveStuck = persistence.dirty && persistence.staleMs != null && persistence.staleMs > 30000;
  const ok = !persistence.lastError && !saveStuck;
  res.status(ok ? 200 : 503).json({
    ok,
    env: config.nodeEnv,
    dataStore: config.dataStore,
    serviceArea: config.serviceArea,
    paymentGateways: {
      khalti: config.khaltiSecretKey ? config.khaltiMode : 'off',
      esewa: config.esewaProductCode && config.esewaSecret ? config.esewaMode : 'off'
    },
    otpProvider: config.otpProvider,
    emailProvider: config.emailProvider,
    persistence,
    volume: {
      users: db.users.length,
      drivers: db.drivers.length,
      rides: db.rides.length,
      orders: db.orders.length,
      bookings: db.bookings.length,
      transactions: db.transactions.length,
      ledger: db.platformLedger.length
    },
    realtime: events.stats(),
    uptimeSec: metrics.snapshot().uptimeSec,
    time: new Date().toISOString()
  });
});

// Real-time push channel. A connection subscribes to the audiences that concern
// it and then only receives "refresh" nudges — never data — so nothing sensitive
// rides the stream itself.
//
// EventSource cannot send an Authorization header, so the credential has to
// travel in the URL. It is a one-minute single-use ticket rather than the 60-day
// session token, because every proxy in front of this app logs query strings and
// we do not control how long those logs live. Clients call POST /api/events/ticket
// with their normal Authorization header first.
const TOKEN_MAPS_BY_ROLE = {
  user: () => db.tokens,
  driver: () => db.driverTokens,
  partner: () => db.partnerTokens,
  admin: () => db.adminTokens
};

function bearerOwner(req, role) {
  const map = TOKEN_MAPS_BY_ROLE[role];
  if (!map) return null;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return sessionTokens.tokenOwner(map(), header.slice(7));
}

function audiencesFor(role, ownerId) {
  if (role === 'user') return [`user:${ownerId}`];
  if (role === 'driver') {
    const driver = db.drivers.find((d) => d.id === ownerId);
    return [`driver:${ownerId}`, 'drivers:all', driver ? `drivers:${driver.tier}` : null].filter(Boolean);
  }
  if (role === 'partner') return [`partner:${ownerId}`];
  if (role === 'admin') return ownerId === 'admin' ? ['admin'] : null;
  return null;
}

app.post('/api/events/ticket', (req, res) => {
  const role = String((req.body || {}).role || req.query.role || '');
  const ownerId = bearerOwner(req, role);
  if (!ownerId) return res.status(401).json({ error: 'Unauthorized.' });
  res.json(streamTickets.issue(role, ownerId));
});

app.get('/api/events', (req, res) => {
  const role = req.query.role;
  let ownerId = null;
  if (req.query.ticket) {
    const redeemed = streamTickets.redeem(String(req.query.ticket), role);
    ownerId = redeemed ? redeemed.ownerId : null;
  } else if (!config.isProduction && req.query.token) {
    // Dev/test convenience only. In production a session token in a query string
    // is exactly what the ticket exists to prevent, so it is not accepted there.
    const map = TOKEN_MAPS_BY_ROLE[role];
    ownerId = map ? sessionTokens.tokenOwner(map(), req.query.token) : null;
  }
  const audiences = ownerId ? audiencesFor(role, ownerId) : null;
  if (!audiences) return res.status(401).json({ error: 'Unauthorized.' });
  events.subscribe(req, res, audiences);
});

async function start() {
  await initDb();
  // Build the marketplace search + geo index from the freshly loaded state, so
  // the first customer search is fast rather than paying for a lazy rebuild.
  require('./storeSearch').rebuild();

app.use('/api/auth', require('./routes/auth').router);
app.use('/api', require('./routes/rides'));
app.use('/api', require('./routes/food'));
app.use('/api', require('./routes/stays'));
app.use('/api', require('./routes/driver'));
app.use('/api', require('./routes/partner'));
app.use('/api', require('./routes/admin'));
app.use('/api', require('./routes/tasks'));
app.use('/api', require('./routes/stores'));
app.use('/api', require('./routes/payments'));
if (!config.isProduction) app.use('/api/demo', require('./routes/demo'));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.get('/driver', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'driver.html')));
app.get('/partner', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'partner.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/download', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'download.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'terms.html')));
// Partner-uploaded listing photos. Filenames are random and never rewritten,
// so they can be cached hard.
app.use('/uploads', express.static(require('./photos').UPLOADS_DIR, {
  immutable: true,
  maxAge: '30d'
}));
// Icons/images are immutable-ish (long cache); HTML/JS/CSS revalidate via ETag
// so every deploy reaches browsers and the network-first service worker.
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (/\.(png|svg|webmanifest)$/.test(filePath)) {
      res.set('Cache-Control', 'public, max-age=604800');
    } else {
      res.set('Cache-Control', 'no-cache');
    }
  }
}));
app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
  res.status(404).json({ error: 'Not found' });
});

// Central error handler: bad JSON bodies get a 400, everything else a clean 500.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: 'Invalid request body.' });
  }
  logger.error('unhandled_request_error', {
    id: req.id, method: req.method, path: req.path, err: err.message, stack: err.stack
  });
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

const server = app.listen(PORT, () => {
  console.log(`SewaGo running on http://localhost:${PORT}`);
  console.log('Apps: /  (customer) · /driver · /partner · /admin');
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. SewaGo may already be running at http://localhost:${PORT}.`);
    console.error(`Stop the existing process first, or start with another port: PORT=4001 npm start`);
    process.exit(1);
  }
  throw err;
});

// Sequential dispatch sweep: advances lapsed ride offers to the next-nearest
// driver and re-offers rides whose candidate list had run dry, so dispatch
// keeps moving even when no client happens to be polling.
const dispatch = require('./dispatch');
setInterval(() => {
  try { dispatch.sweep(); } catch (e) { logger.error('dispatch_sweep_failed', { err: e.message }); }
}, 3000).unref();

// Courier batching: groups packed shop orders into multi-stop runs and offers
// each to the nearest suitable rider, cycling on when an offer lapses.
const { sweepDeliveryRuns, recoverAbandonedRuns } = require('./deliveryRuns');
setInterval(() => {
  try {
    // Recover abandoned runs first so their orders are back in the pool before
    // this same pass tries to batch and offer. Abandoned food deliveries ride
    // the same cadence — they used to sit in the hourly housekeeping sweep,
    // which left a vanished courier's order (and the customer's refund) waiting
    // up to an hour past its deadline.
    if (recoverAbandonedDeliveries() + recoverAbandonedRuns() + sweepDeliveryRuns()) save();
  } catch (e) { logger.error('delivery_sweep_failed', { err: e.message }); }
}, 5000).unref();

// Backup at boot and every 6 hours (JSON store only; no-op on Supabase).
try { backupJsonState(); } catch (e) { console.error('Backup failed:', e.message); }
setInterval(() => {
  try { backupJsonState(); } catch (e) { console.error('Backup failed:', e.message); }
}, 6 * 60 * 60 * 1000).unref();

// Hourly housekeeping: expired sessions, OTP codes, reset tokens and stale
// payment intents get dropped so state never grows without bound.
setInterval(() => {
  let dirty = 0;
  for (const map of [db.tokens, db.driverTokens, db.partnerTokens, db.adminTokens]) {
    dirty += sweepExpired(map);
  }
  const now = Date.now();
  const oldOtps = db.otpCodes.length;
  db.otpCodes = db.otpCodes.filter((o) => o.expiresAt > now);
  const oldResets = db.passwordResetTokens.length;
  db.passwordResetTokens = db.passwordResetTokens.filter((t) => t.expiresAt > now);
  dirty += (oldOtps - db.otpCodes.length) + (oldResets - db.passwordResetTokens.length);
  for (const p of db.payments) {
    if (p.status === 'pending' && now - p.createdAt > 15 * 60 * 1000) {
      p.status = 'expired';
      dirty += 1;
    }
  }
  // Group lobbies: an open one whose slot has passed is dead — place() already
  // refuses it — so mark it expired; then drop cancelled/expired lobbies once
  // they are a day old, so the blob-persisted state never grows without bound.
  // (Placed lobbies are left to their order's own lifecycle.)
  for (const g of db.groupOrders) {
    if (g.status === 'open' && g.scheduledFor < now) {
      g.status = 'expired';
      g.expiredAt = now;
      dirty += 1;
    }
  }
  const beforeGroups = db.groupOrders.length;
  db.groupOrders = db.groupOrders.filter((g) => {
    if (g.status === 'cancelled' || g.status === 'expired') {
      return now - (g.expiredAt || g.cancelledAt || g.createdAt) < 24 * 60 * 60 * 1000;
    }
    return true;
  });
  dirty += beforeGroups - db.groupOrders.length;
  // Move stay-booking income from pending to withdrawable once check-in passes.
  // (Abandoned-delivery recovery moved to the 5s courier sweep above — an
  // hourly cadence made customers wait up to an hour past the deadline.)
  dirty += settleDueBookings();
  if (dirty) save();
}, 60 * 60 * 1000).unref();

// Graceful shutdown so in-flight requests finish and the last save() completes.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      try { await flushSaves(); } catch (e) { console.error(e); }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
