const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { config, validateProductionConfig } = require('./config');
const { db, save, initDb, flushSaves, backupJsonState, saveHealth } = require('./db');
const sessionTokens = require('./sessionTokens');
const { sweepExpired } = sessionTokens;
const metrics = require('./metrics');
const logger = require('./logger');
const events = require('./events');

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
  "img-src 'self' data: https://unpkg.com https://*.basemaps.cartocdn.com",
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
const authLimiter = makeLimiter(10 * 60 * 1000, 60);
app.use(
  ['/api/auth/login', '/api/auth/register',
    '/api/auth/otp/request', '/api/auth/otp/verify',
    '/api/driver/login', '/api/driver/register', '/api/driver/otp/request', '/api/driver/otp/verify',
    '/api/partner/login', '/api/partner/register', '/api/partner/otp/request', '/api/partner/otp/verify',
    '/api/admin/login'],
  authLimiter
);

// Tells the download page whether a real native app is available to install.
app.get('/api/app-info', (req, res) => {
  res.json({
    androidApkUrl: config.androidApkUrl,
    iosAppStoreUrl: config.iosAppStoreUrl
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

// Real-time push channel. EventSource can't send an Authorization header, so the
// session token comes as a query param (path-only logging keeps it out of logs).
// A connection subscribes to the audiences that concern it and then only receives
// "refresh" nudges — never data — so nothing sensitive rides the stream.
app.get('/api/events', (req, res) => {
  const token = req.query.token;
  const role = req.query.role;
  let audiences = null;
  if (role === 'user') {
    const id = sessionTokens.tokenOwner(db.tokens, token);
    if (id) audiences = [`user:${id}`];
  } else if (role === 'driver') {
    const id = sessionTokens.tokenOwner(db.driverTokens, token);
    if (id) {
      const driver = db.drivers.find((d) => d.id === id);
      audiences = [`driver:${id}`, 'drivers:all', driver ? `drivers:${driver.tier}` : null].filter(Boolean);
    }
  } else if (role === 'partner') {
    const id = sessionTokens.tokenOwner(db.partnerTokens, token);
    if (id) audiences = [`partner:${id}`];
  } else if (role === 'admin') {
    if (sessionTokens.tokenOwner(db.adminTokens, token) === 'admin') audiences = ['admin'];
  }
  if (!audiences) return res.status(401).json({ error: 'Unauthorized.' });
  events.subscribe(req, res, audiences);
});

async function start() {
  await initDb();

app.use('/api/auth', require('./routes/auth').router);
app.use('/api', require('./routes/rides'));
app.use('/api', require('./routes/food'));
app.use('/api', require('./routes/stays'));
app.use('/api', require('./routes/driver'));
app.use('/api', require('./routes/partner'));
app.use('/api', require('./routes/admin'));
app.use('/api', require('./routes/tasks'));
app.use('/api', require('./routes/payments'));
if (!config.isProduction) app.use('/api/demo', require('./routes/demo'));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.get('/driver', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'driver.html')));
app.get('/partner', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'partner.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/download', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'download.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'terms.html')));
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
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
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
