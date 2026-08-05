// Driver cash-commission collection: a cash trip makes the driver owe the
// platform its commission; once they pass the credit limit they are taken
// offline and blocked from going back online until an admin records the cash
// settlement (which pays down the debt and books it as collected revenue).
//
// Runs with a low CASH_CREDIT_LIMIT so a single cash trip trips the gate.
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { freePort } = require('./freePort');

// Assigned in before(): the OS picks a free port, so parallel checkouts
// (agent worktrees, a second clone) can run this suite at the same time.
let PORT;
let BASE;
const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'test-admin-pass';

let server;
let dataDir;
let adminToken;

async function api(pathname, { method = 'GET', token = null, body = null } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function registerUser(name) {
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const { data } = await api('/auth/register', { method: 'POST', body: { name, email, password: 'secret1' } });
  return { token: data.token, user: data.user };
}

async function onboardDriver(lat, lng) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const reg = await api('/driver/register', {
    method: 'POST',
    body: {
      name: 'Cash Driver', email: `cd-${stamp}@test.local`, password: 'driver-secret',
      phone: `+9779${stamp.slice(-9)}`, tier: 'bike', vehicle: 'Bike', plate: `TE ${stamp.slice(-4)}`,
      licenseId: `LIC-${stamp.slice(-8)}`, licenseCode: '123456'
    }
  });
  const token = reg.data.token;
  const otp = await api('/driver/phone/request-otp', { method: 'POST', token, body: {} });
  await api('/driver/phone/verify', { method: 'POST', token, body: { code: otp.data.devCode } });
  await api('/driver/location', { method: 'POST', token, body: { lat, lng, accuracy: 10 } });
  await api('/driver/online', { method: 'POST', token, body: { online: true } });
  return { token, id: reg.data.driver.id };
}

before(async () => {
  PORT = await freePort();
  BASE = `http://localhost:${PORT}/api`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sewago-cash-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATA_STORE: 'json', DATA_DIR: dataDir,
      ADMIN_EMAIL, ADMIN_PASSWORD, OTP_PROVIDER: 'sandbox', EMAIL_PROVIDER: 'sandbox',
      DRIVER_LICENSE_DEMO_CODE: '123456',
      CASH_CREDIT_LIMIT: '30', // one ~Rs 200 cash fare => ~Rs 40 commission trips it
      LOG_LEVEL: 'error'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (e) { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const login = await api('/admin/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  adminToken = login.data.token;
});

after(async () => {
  if (server) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    await exited;
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a cash trip over the credit limit forces settlement, which collects the commission', async () => {
  // Driver online near Thamel; customer books a cash ride from there.
  const driver = await onboardDriver(27.7152, 85.3123);
  const { token: rider } = await registerUser('cashrider');
  const booked = await api('/rides', {
    method: 'POST', token: rider,
    body: { pickup: { lat: 27.7154, lng: 85.3123, name: 'Thamel' }, dropoff: { lat: 27.6893, lng: 85.3436, name: 'New Baneshwor' }, tier: 'bike', payment: 'cash' }
  });
  assert.equal(booked.status, 200, JSON.stringify(booked.data));
  const rideId = booked.data.ride.id;
  assert.equal(booked.data.ride.mode, 'live', 'a real online driver should take the ride');

  // Driver runs the trip to completion.
  assert.equal((await api(`/driver/rides/${rideId}/accept`, { method: 'POST', token: driver.token })).status, 200);
  assert.equal((await api(`/driver/rides/${rideId}/start`, { method: 'POST', token: driver.token })).status, 200);
  const done = await api(`/driver/rides/${rideId}/complete`, { method: 'POST', token: driver.token });
  assert.equal(done.status, 200, JSON.stringify(done.data));

  // Commission owed pushed past the Rs 30 limit -> auto-offline + must settle.
  assert.equal(done.data.mustSettle, true, 'crossing the limit must flag settlement');
  assert.ok(done.data.owed > 30, `owed should exceed the limit: ${done.data.owed}`);
  const me = await api('/driver/me', { token: driver.token });
  assert.ok(me.data.driver.commissionOwed > 0);
  assert.equal(me.data.driver.mustSettle, true);

  // Going back online is refused until settled.
  await api('/driver/location', { method: 'POST', token: driver.token, body: { lat: 27.7152, lng: 85.3123, accuracy: 10 } });
  const online = await api('/driver/online', { method: 'POST', token: driver.token, body: { online: true } });
  assert.equal(online.status, 402, 'a driver over the cash limit cannot go online');

  // Admin records the cash the driver hands over -> collects the commission.
  const owedBefore = me.data.driver.commissionOwed;
  const settle = await api(`/admin/drivers/${driver.id}/settle-cash`, { method: 'POST', token: adminToken });
  assert.equal(settle.status, 200, JSON.stringify(settle.data));
  assert.equal(settle.data.settled, owedBefore, 'the full owed amount is collected by default');
  assert.equal(settle.data.driver.commissionOwed, 0, 'debt cleared after settlement');

  // Now the driver can go online again.
  const backOnline = await api('/driver/online', { method: 'POST', token: driver.token, body: { online: true } });
  assert.equal(backOnline.status, 200, `settled driver should be able to go online: ${JSON.stringify(backOnline.data)}`);

  // Settling a driver who owes nothing is refused.
  const noop = await api(`/admin/drivers/${driver.id}/settle-cash`, { method: 'POST', token: adminToken });
  assert.equal(noop.status, 400);
});
