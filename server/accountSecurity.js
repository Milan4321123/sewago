const crypto = require('crypto');
const { db, uid } = require('./db');
const { hashPassword } = require('./passwords');
const { sendPasswordResetEmail } = require('./email');

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'sandbox';

const KINDS = {
  user: { collection: 'users', tokenKey: 'tokens' },
  driver: { collection: 'drivers', tokenKey: 'driverTokens' },
  partner: { collection: 'partners', tokenKey: 'partnerTokens' }
};

function now() {
  return Date.now();
}

function otpProvider() {
  return process.env.OTP_PROVIDER || 'sandbox';
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[\s-]/g, '').trim();
}

function validPhone(phone) {
  return /^\+?\d{7,15}$/.test(phone);
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function collectionFor(kind) {
  const meta = KINDS[kind];
  if (!meta) throw new Error(`Unknown account kind: ${kind}`);
  return db[meta.collection];
}

function findByEmail(kind, email) {
  const clean = String(email || '').trim().toLowerCase();
  return collectionFor(kind).find((entity) => String(entity.email || '').toLowerCase() === clean);
}

function findByPhone(kind, phone) {
  const clean = normalizePhone(phone);
  return collectionFor(kind).find((entity) => normalizePhone(entity.phone) === clean);
}

function clearTokens(kind, ownerId) {
  const tokenKey = KINDS[kind].tokenKey;
  for (const [token, id] of Object.entries(db[tokenKey] || {})) {
    if (id === ownerId) delete db[tokenKey][token];
  }
}

async function sendSms(to, body) {
  const provider = otpProvider();
  if (provider === 'sandbox') return { sandbox: true };

  if (provider === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!sid || !token || !from) {
      throw new Error('Twilio OTP is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER.');
    }
    const form = new URLSearchParams({ To: to, From: from, Body: body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || 'Twilio failed to send the OTP SMS.');
    }
    return { providerMessageId: data.sid };
  }

  if (provider === 'webhook') {
    const url = process.env.SMS_WEBHOOK_URL;
    if (!url) throw new Error('SMS webhook OTP is not configured. Set SMS_WEBHOOK_URL.');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.SMS_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}` } : {})
      },
      body: JSON.stringify({ to, message: body, purpose: 'otp' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || 'SMS webhook failed to send the OTP SMS.');
    return { providerMessageId: data.id || data.messageId };
  }

  throw new Error(`Unsupported OTP_PROVIDER=${provider}. Use sandbox, twilio, or webhook.`);
}

async function deliverOtp(phone, code) {
  const body = `Your SewaGo verification code is ${code}. It expires in 10 minutes.`;
  const delivery = await sendSms(phone, body);
  return {
    provider: otpProvider(),
    devCode: delivery.sandbox ? code : undefined,
    providerMessageId: delivery.providerMessageId
  };
}

function storeOtp(ownerKind, ownerId, phone, code) {
  const otp = {
    id: uid(),
    ownerKind,
    ownerId,
    phone,
    codeHash: digest(code),
    expiresAt: now() + OTP_TTL_MS,
    attempts: 0,
    createdAt: now()
  };
  db.otpCodes = (db.otpCodes || []).filter((o) => !(o.ownerKind === ownerKind && o.ownerId === ownerId));
  db.otpCodes.push(otp);
  return otp;
}

function checkOtpCooldown(ownerKind, ownerId) {
  const existing = (db.otpCodes || []).find((o) => o.ownerKind === ownerKind && o.ownerId === ownerId);
  if (existing && existing.createdAt && now() - existing.createdAt < OTP_RESEND_MS) {
    const seconds = Math.ceil((OTP_RESEND_MS - (now() - existing.createdAt)) / 1000);
    return { error: `Please wait ${seconds}s before requesting another code.` };
  }
  return { ok: true };
}

function checkOtp(ownerKind, ownerId, code) {
  const otp = (db.otpCodes || []).find((o) => o.ownerKind === ownerKind && o.ownerId === ownerId);
  if (!otp) return { error: 'Request a verification code first.' };
  if (otp.expiresAt < now()) return { error: 'That verification code expired. Request a new one.' };
  otp.attempts += 1;
  if (otp.attempts > 5) return { error: 'Too many attempts. Request a new code.' };
  if (digest(String(code || '').trim()) !== otp.codeHash) return { error: 'Verification code is incorrect.' };
  db.otpCodes = db.otpCodes.filter((o) => o.id !== otp.id);
  return { otp };
}

async function requestPhoneOtp(kind, entity, phone) {
  const clean = normalizePhone(phone || entity.phone);
  if (!validPhone(clean)) return { error: 'A valid phone number is required.' };
  const existing = findByPhone(kind, clean);
  if (existing && existing.id !== entity.id) {
    return { error: 'That phone number is already registered.' };
  }

  const cooldown = checkOtpCooldown(kind, entity.id);
  if (cooldown.error) return cooldown;
  entity.phone = clean;
  entity.phoneVerified = false;
  const code = otpProvider() === 'sandbox'
    ? (process.env.OTP_SANDBOX_CODE || '123456')
    : String(crypto.randomInt(100000, 1000000));
  const otp = storeOtp(kind, entity.id, clean, code);
  const delivery = await deliverOtp(clean, code);
  return {
    phone: clean,
    expiresAt: otp.expiresAt,
    devCode: delivery.devCode,
    provider: delivery.provider,
    providerMessageId: delivery.providerMessageId
  };
}

function verifyPhoneOtp(kind, entity, code) {
  const result = checkOtp(kind, entity.id, code);
  if (result.error) return result;
  const otp = result.otp;
  entity.phone = otp.phone;
  entity.phoneVerified = true;
  entity.phoneVerifiedAt = now();
  return { phone: entity.phone };
}

async function requestLoginOtp(kind, phone) {
  const clean = normalizePhone(phone);
  if (!validPhone(clean)) return { error: 'A valid phone number is required.' };
  if (kind !== 'user' && !findByPhone(kind, clean)) {
    // Do not expose whether a driver/partner phone exists.
    return { phone: clean, hidden: true };
  }
  const cooldown = checkOtpCooldown(`${kind}_login`, clean);
  if (cooldown.error) return cooldown;
  const code = otpProvider() === 'sandbox'
    ? (process.env.OTP_SANDBOX_CODE || '123456')
    : String(crypto.randomInt(100000, 1000000));
  const otp = storeOtp(`${kind}_login`, clean, clean, code);
  const delivery = await deliverOtp(clean, code);
  return {
    phone: clean,
    expiresAt: otp.expiresAt,
    devCode: delivery.devCode,
    provider: delivery.provider,
    providerMessageId: delivery.providerMessageId
  };
}

function verifyLoginOtp(kind, phone, code) {
  const clean = normalizePhone(phone);
  if (!validPhone(clean)) return { error: 'A valid phone number is required.' };
  const result = checkOtp(`${kind}_login`, clean, code);
  if (result.error) return result;
  return { phone: clean, entity: findByPhone(kind, clean) };
}

async function requestPasswordReset(kind, email) {
  const entity = findByEmail(kind, email);
  // Always return ok so account existence is not exposed.
  if (!entity) return { ok: true };

  const token = crypto.randomBytes(24).toString('hex');
  const reset = {
    id: uid(),
    ownerKind: kind,
    ownerId: entity.id,
    tokenHash: digest(token),
    expiresAt: now() + RESET_TTL_MS,
    usedAt: null,
    createdAt: now()
  };
  db.passwordResetTokens = (db.passwordResetTokens || [])
    .filter((r) => !(r.ownerKind === kind && r.ownerId === entity.id && !r.usedAt));
  db.passwordResetTokens.push(reset);
  // Real providers get the link by email; delivery failures are logged, never
  // surfaced, so the response can't be used to probe which accounts exist.
  if (EMAIL_PROVIDER !== 'sandbox') {
    await sendPasswordResetEmail(kind, entity, token, reset.expiresAt);
  }
  return {
    ok: true,
    expiresAt: reset.expiresAt,
    devResetToken: EMAIL_PROVIDER === 'sandbox' ? token : undefined
  };
}

function resetPassword(kind, token, password) {
  if (!password || String(password).length < 6) {
    return { error: 'Password must be at least 6 characters.' };
  }
  const tokenHash = digest(String(token || '').trim());
  const reset = (db.passwordResetTokens || []).find(
    (r) => r.ownerKind === kind && r.tokenHash === tokenHash && !r.usedAt
  );
  if (!reset || reset.expiresAt < now()) return { error: 'Reset link is invalid or expired.' };

  const entity = collectionFor(kind).find((x) => x.id === reset.ownerId);
  if (!entity) return { error: 'Account no longer exists.' };
  entity.password = hashPassword(password);
  reset.usedAt = now();
  clearTokens(kind, entity.id);
  return { ok: true };
}

module.exports = {
  OTP_PROVIDER: otpProvider(),
  EMAIL_PROVIDER,
  normalizePhone,
  validPhone,
  findByPhone,
  requestPhoneOtp,
  verifyPhoneOtp,
  requestLoginOtp,
  verifyLoginOtp,
  requestPasswordReset,
  resetPassword
};
