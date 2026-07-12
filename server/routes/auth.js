const express = require('express');
const crypto = require('crypto');
const { db, save, uid } = require('../db');
const sessionTokens = require('../sessionTokens');
const { hashPassword, verifyPassword } = require('../passwords');
const { recordTxn } = require('../payments');
const { deleteAccount } = require('../accountDeletion');
const {
  normalizePhone,
  requestPhoneOtp,
  verifyPhoneOtp,
  requestLoginOtp,
  verifyLoginOtp,
  requestPasswordReset,
  resetPassword
} = require('../accountSecurity');

const router = express.Router();

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || '',
    phoneVerified: !!user.phoneVerified,
    wallet: user.wallet
  };
}

function issueToken(userId) {
  return sessionTokens.issueToken(db.tokens, userId);
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = sessionTokens.tokenOwner(db.tokens, token);
  const user = userId && db.users.find((u) => u.id === userId);
  if (!user) return res.status(401).json({ error: 'Please log in again.' });
  req.user = user;
  next();
}

router.post('/register', (req, res) => {
  const { name, email, password, phone } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'That email does not look valid.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (db.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  const cleanPhone = normalizePhone(phone);
  if (cleanPhone && db.users.some((u) => normalizePhone(u.phone) === cleanPhone)) {
    return res.status(409).json({ error: 'An account with that phone already exists.' });
  }
  const user = {
    id: uid(),
    name: name.trim(),
    email: email.trim(),
    phone: cleanPhone,
    phoneVerified: false,
    password: hashPassword(password),
    wallet: 5000,
    createdAt: Date.now()
  };
  db.users.push(user);
  recordTxn('user', user, { type: 'bonus', label: 'Welcome bonus 🎁', amount: 5000, sign: 1 });
  const token = issueToken(user.id);
  save();
  res.json({ token, user: publicUser(user) });
});

router.post('/password/request-reset', async (req, res, next) => {
  try {
    const result = await requestPasswordReset('user', (req.body || {}).email);
    save();
    res.json({
      ok: true,
      devResetToken: result.devResetToken,
      expiresAt: result.expiresAt,
      message: result.devResetToken
        ? 'Sandbox reset token generated. In production this is sent by email.'
        : 'If an account exists, reset instructions were sent.'
    });
  } catch (err) {
    next(err);
  }
});

router.post('/password/reset', (req, res) => {
  const result = resetPassword('user', (req.body || {}).token, (req.body || {}).password);
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  res.json({ ok: true });
});

router.post('/phone/request-otp', authRequired, async (req, res, next) => {
  try {
    const result = await requestPhoneOtp('user', req.user, (req.body || {}).phone);
    if (result.error) return res.status(400).json({ error: result.error });
    save();
    res.json({
      user: publicUser(req.user),
      devCode: result.devCode,
      expiresAt: result.expiresAt,
      message: result.devCode ? 'Sandbox OTP generated.' : 'Verification code sent.'
    });
  } catch (err) {
    next(err);
  }
});

router.post('/phone/verify', authRequired, (req, res) => {
  const result = verifyPhoneOtp('user', req.user, (req.body || {}).code);
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  res.json({ user: publicUser(req.user) });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.find((u) => u.email.toLowerCase() === String(email || '').toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.password)) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  const token = issueToken(user.id);
  save();
  res.json({ token, user: publicUser(user) });
});

router.post('/otp/request', async (req, res, next) => {
  try {
    const result = await requestLoginOtp('user', (req.body || {}).phone);
    if (result.error) return res.status(400).json({ error: result.error });
    save();
    res.json({
      phone: result.phone,
      devCode: result.devCode,
      expiresAt: result.expiresAt,
      message: result.devCode ? 'Sandbox OTP generated.' : 'Verification code sent.'
    });
  } catch (err) {
    next(err);
  }
});

router.post('/otp/verify', (req, res) => {
  const body = req.body || {};
  const result = verifyLoginOtp('user', body.phone, body.code);
  if (result.error) return res.status(400).json({ error: result.error });

  let user = result.entity;
  if (!user) {
    const cleanEmail = String(body.email || '').trim().toLowerCase();
    if (cleanEmail && db.users.some((u) => String(u.email || '').toLowerCase() === cleanEmail)) {
      return res.status(409).json({ error: 'That email is already used by another account.' });
    }
    const digits = result.phone.replace(/\D/g, '');
    user = {
      id: uid(),
      name: String(body.name || '').trim() || `SewaGo ${digits.slice(-4)}`,
      email: cleanEmail || `phone-${digits}@sewago.local`,
      phone: result.phone,
      phoneVerified: true,
      phoneVerifiedAt: Date.now(),
      password: hashPassword(crypto.randomBytes(18).toString('hex')),
      wallet: 5000,
      createdAt: Date.now()
    };
    db.users.push(user);
    recordTxn('user', user, { type: 'bonus', label: 'Welcome bonus 🎁', amount: 5000, sign: 1 });
  } else {
    user.phone = result.phone;
    user.phoneVerified = true;
    user.phoneVerifiedAt = Date.now();
  }
  const token = issueToken(user.id);
  save();
  res.json({ token, user: publicUser(user) });
});

router.get('/me', authRequired, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/wallet/topup', authRequired, (req, res) => {
  const amount = Number((req.body || {}).amount) || 0;
  if (amount <= 0 || amount > 100000) {
    return res.status(400).json({ error: 'Top-up amount must be between 1 and 100,000.' });
  }
  req.user.wallet += amount;
  recordTxn('user', req.user, { type: 'topup', label: 'Wallet top-up (demo)', amount, sign: 1, method: 'demo' });
  save();
  res.json({ user: publicUser(req.user) });
});

// Self-service deletion (app-store requirement). Confirm with the password, or
// with a fresh SMS code for phone-only accounts that never chose a password
// (request one via /api/auth/otp/request first).
router.post('/account/delete', authRequired, (req, res) => {
  const body = req.body || {};
  let confirmed = false;
  if (body.password && verifyPassword(String(body.password), req.user.password)) confirmed = true;
  if (!confirmed && body.otpCode && req.user.phoneVerified && req.user.phone) {
    const check = verifyLoginOtp('user', req.user.phone, body.otpCode);
    if (!check.error && check.entity && check.entity.id === req.user.id) confirmed = true;
  }
  if (!confirmed) {
    return res.status(401).json({ error: 'Confirm with your password (or a fresh SMS code) to delete the account.' });
  }
  const result = deleteAccount('user', req.user, { ip: req.ip });
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  res.json({ ok: true, message: 'Your account and personal data have been deleted.' });
});

router.post('/logout', authRequired, (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.slice(7);
  delete db.tokens[token];
  save();
  res.json({ ok: true });
});

module.exports = { router, authRequired, publicUser };
