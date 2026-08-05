// The realtime stream's credential.
//
// EventSource cannot set an Authorization header, so /api/events takes its
// credential in the URL — and every proxy in front of this app writes query
// strings into an access log we do not control. So what travels there must be a
// one-minute single-use ticket, never the 60-day session token.
//
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { freePort } = require('./net');

const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'test-admin-pass';

// One server in development mode (where the legacy ?token= path is still
// allowed for dev tooling) and one pretending to be production (where it must
// not be), because that difference is the whole point of the change.
const servers = {};

async function boot(key, extraEnv) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `sewago-sse-${key}-`));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, PORT: String(port), DATA_STORE: 'json', DATA_DIR: dataDir,
      ADMIN_EMAIL, ADMIN_PASSWORD, OTP_PROVIDER: 'sandbox', EMAIL_PROVIDER: 'sandbox',
      LOG_LEVEL: 'error', ...extraEnv
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  const base = `http://localhost:${port}/api`;
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch (e) { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  servers[key] = { proc, dataDir, base };
  return servers[key];
}

async function api(base, pathname, { method = 'GET', token = null, body = null } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// An SSE connection never "finishes", so fetch its head with a short abort and
// report only what the server decided: the status code and content type.
async function openStream(base, query) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${base}/events?${query}`, { signal: ctrl.signal });
    const out = { status: res.status, type: res.headers.get('content-type') || '' };
    ctrl.abort(); // let go of the stream; we only needed the handshake
    return out;
  } catch (e) {
    return { status: 0, type: '', aborted: true };
  } finally {
    clearTimeout(timer);
  }
}

async function registerCustomer(base, tag) {
  const email = `sse-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const { data } = await api(base, '/auth/register', {
    method: 'POST', body: { name: 'Stream Tester', email, password: 'secret1' }
  });
  return data.token;
}

before(async () => {
  await boot('dev', { NODE_ENV: 'development' });
  // A production server needs the escape hatches the real deploy sets, or it
  // refuses to boot on a JSON store with sandbox providers.
  await boot('prod', {
    NODE_ENV: 'production',
    ALLOW_JSON_DB_IN_PRODUCTION: 'true',
    ALLOW_SANDBOX_PROVIDERS_IN_PRODUCTION: 'true',
    ALLOW_DEMO_VERIFICATION_IN_PRODUCTION: 'true',
    TRUST_PROXY: '', // else production answers plain HTTP with a 301 to https
    // The repo's own .env is loaded by the child; blank these so a developer's
    // real provider settings cannot fail this boot.
    EMAIL_FROM: 'test@sewago.local',
    KHALTI_SECRET_KEY: '', ESEWA_PRODUCT_CODE: '', ESEWA_SECRET: '',
    ADMIN_PASSWORD
  });
});

after(async () => {
  for (const s of Object.values(servers)) {
    if (s.proc) {
      const exited = new Promise((r) => s.proc.once('exit', r));
      s.proc.kill('SIGTERM');
      await exited;
    }
    if (s.dataDir) fs.rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('a ticket is minted from a header-authenticated session and opens the stream once', async () => {
  const { base } = servers.dev;
  const token = await registerCustomer(base, 'once');

  const minted = await api(base, '/events/ticket', { method: 'POST', token, body: { role: 'user' } });
  assert.equal(minted.status, 200, JSON.stringify(minted.data));
  assert.match(minted.data.ticket, /^[a-f0-9]{48}$/, 'a random opaque ticket');
  assert.notEqual(minted.data.ticket, token, 'the ticket is not the session token');
  assert.ok(minted.data.expiresInSec > 0 && minted.data.expiresInSec <= 120, 'short lived');

  const first = await openStream(base, `role=user&ticket=${minted.data.ticket}`);
  assert.equal(first.status, 200, 'the ticket opens the stream');
  assert.match(first.type, /text\/event-stream/);

  // Burned on use: a copy scraped from a proxy log is already spent.
  const replay = await openStream(base, `role=user&ticket=${minted.data.ticket}`);
  assert.equal(replay.status, 401, 'the same ticket cannot be used twice');
});

test('minting a ticket requires a real session, and the ticket is bound to its role', async () => {
  const { base } = servers.dev;
  const token = await registerCustomer(base, 'bound');

  assert.equal((await api(base, '/events/ticket', { method: 'POST', body: { role: 'user' } })).status, 401,
    'no token, no ticket');
  assert.equal((await api(base, '/events/ticket', { method: 'POST', token: 'not-a-real-token', body: { role: 'user' } })).status, 401,
    'a made-up token mints nothing');
  // A customer token must not mint a driver or admin ticket.
  for (const role of ['driver', 'partner', 'admin']) {
    assert.equal((await api(base, '/events/ticket', { method: 'POST', token, body: { role } })).status, 401,
      `a customer session cannot mint a ${role} ticket`);
  }

  // And a valid user ticket cannot be redeemed as another audience.
  const { data } = await api(base, '/events/ticket', { method: 'POST', token, body: { role: 'user' } });
  assert.equal((await openStream(base, `role=admin&ticket=${data.ticket}`)).status, 401,
    'the ticket only opens the audience it was minted for');
});

test('garbage and expired-looking tickets are refused', async () => {
  const { base } = servers.dev;
  for (const q of ['role=user', 'role=user&ticket=', 'role=user&ticket=deadbeef', 'ticket=deadbeef']) {
    assert.equal((await openStream(base, q)).status, 401, `refused: ${q}`);
  }
});

test('in production a session token in the query string does not open the stream', async () => {
  // The entire reason the ticket exists. If this regresses, every proxy in front
  // of the app goes back to logging working 60-day session tokens.
  const { base } = servers.prod;
  const token = await registerCustomer(base, 'prod');

  const viaToken = await openStream(base, `role=user&token=${token}`);
  assert.equal(viaToken.status, 401, 'the session token is not a stream credential in production');

  const minted = await api(base, '/events/ticket', { method: 'POST', token, body: { role: 'user' } });
  assert.equal(minted.status, 200, JSON.stringify(minted.data));
  assert.equal((await openStream(base, `role=user&ticket=${minted.data.ticket}`)).status, 200,
    'the ticket is the supported way in');
});
