const express = require('express');
const { db, save, uid } = require('../db');
const { config } = require('../config');
const { authRequired, publicUser } = require('./auth');
const khalti = require('../gateways/khalti');
const esewa = require('../gateways/esewa');
const {
  recordTxn,
  createWithdrawal,
  SANDBOX_PIN,
  WITHDRAW_FEE,
  TOPUP_METHODS,
  WITHDRAW_CHANNELS
} = require('../payments');

const router = express.Router();

const INTENT_TTL_MS = 15 * 60 * 1000;

// Sandbox simulation is allowed everywhere except production (unless the
// pilot override is on). Real gateways are used whenever their keys are set.
function sandboxAllowed() {
  return !config.isProduction || config.allowSandboxProvidersInProduction;
}

// Which processor actually handles a given top-up method right now.
// Falls back to the PIN sandbox in dev so the demo always works.
function gatewayFor(method) {
  if (method === 'khalti' && khalti.enabled()) return 'khalti';
  if (method === 'esewa' && esewa.enabled()) return 'esewa';
  return sandboxAllowed() ? 'sandbox' : null;
}

function appBaseUrl(req) {
  return (config.publicAppUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

// Credit the wallet exactly once per payment, no matter how many times the
// gateway redirect or a retry hits us.
function creditTopup(payment, { gatewayRef = null } = {}) {
  if (payment.status !== 'pending') return payment.status === 'succeeded';
  const user = db.users.find((u) => u.id === payment.userId);
  if (!user) return false;
  payment.status = 'succeeded';
  payment.paidAt = Date.now();
  if (gatewayRef) payment.gatewayRef = gatewayRef;
  user.wallet += payment.amount;
  recordTxn('user', user, {
    type: 'topup',
    label: `Wallet top-up via ${TOPUP_METHODS[payment.method] || payment.method}`,
    amount: payment.amount,
    sign: 1,
    method: payment.method,
    refId: payment.id
  });
  save();
  return true;
}

function failPayment(payment, status) {
  if (payment.status === 'pending') {
    payment.status = status;
    save();
  }
}

router.get('/payments/methods', authRequired, (req, res) => {
  const methods = {};
  for (const [key, label] of Object.entries(TOPUP_METHODS)) {
    const gateway = gatewayFor(key);
    if (!gateway) continue; // not configured and sandbox not allowed
    methods[key] = { label, gateway, sandbox: gateway === 'sandbox' };
  }
  res.json({
    methods,
    channels: WITHDRAW_CHANNELS,
    withdrawFee: WITHDRAW_FEE
  });
});

// Step 1: create a payment intent.
// khalti  -> respond with the hosted-checkout URL to redirect to.
// esewa   -> respond with a signed form the client auto-submits.
// sandbox -> respond with the PIN-confirm challenge (demo only).
router.post('/payments/topup/initiate', authRequired, async (req, res) => {
  const amount = Math.round(Number((req.body || {}).amount));
  const method = (req.body || {}).method;
  if (!(amount >= 50 && amount <= 100000)) {
    return res.status(400).json({ error: 'Top-up must be between Rs 50 and Rs 100,000.' });
  }
  if (!TOPUP_METHODS[method]) return res.status(400).json({ error: 'Pick a valid payment method.' });
  const gateway = gatewayFor(method);
  if (!gateway) {
    return res.status(503).json({ error: `${TOPUP_METHODS[method]} payments are not configured yet — please use another method.` });
  }

  const payment = {
    id: uid(),
    userId: req.user.id,
    amount,
    method,
    gateway,
    status: 'pending',
    createdAt: Date.now()
  };

  try {
    if (gateway === 'khalti') {
      const base = appBaseUrl(req);
      const { pidx, paymentUrl } = await khalti.initiate({
        payment,
        user: req.user,
        returnUrl: `${base}/api/payments/topup/return/khalti`,
        websiteUrl: base
      });
      payment.pidx = pidx;
      db.payments.push(payment);
      save();
      return res.json({ payment: publicPayment(payment), redirectUrl: paymentUrl });
    }
    if (gateway === 'esewa') {
      const base = appBaseUrl(req);
      const { formUrl, fields } = esewa.initiate({
        payment,
        successUrl: `${base}/api/payments/topup/return/esewa`,
        failureUrl: `${base}/api/payments/topup/return/esewa-failed`
      });
      db.payments.push(payment);
      save();
      return res.json({ payment: publicPayment(payment), form: { url: formUrl, fields } });
    }
  } catch (err) {
    console.error(`Top-up initiate failed (${gateway}):`, err.message);
    return res.status(502).json({ error: `${TOPUP_METHODS[method]} is not responding right now — please try again in a moment.` });
  }

  db.payments.push(payment);
  save();
  res.json({
    payment: publicPayment(payment),
    sandbox: `Sandbox gateway — confirm with PIN ${SANDBOX_PIN}. Any other PIN simulates a decline.`
  });
});

function publicPayment(p) {
  return { id: p.id, amount: p.amount, method: p.method, methodLabel: TOPUP_METHODS[p.method], gateway: p.gateway, status: p.status };
}

// Khalti sends the user back here after checkout. Verify with the lookup API
// before crediting — never trust query params alone.
router.get('/payments/topup/return/khalti', async (req, res) => {
  const { pidx, purchase_order_id: orderId } = req.query;
  const payment = db.payments.find((p) => p.id === orderId && p.gateway === 'khalti' && p.pidx === pidx);
  const fail = (reason) => res.redirect(`/?pay=failed&reason=${encodeURIComponent(reason)}`);
  if (!payment || !pidx) return fail('Payment not found.');
  if (payment.status === 'succeeded') return res.redirect(`/?pay=success&amount=${payment.amount}`);
  try {
    const result = await khalti.verify(pidx);
    if (!result.ok) {
      failPayment(payment, result.status === 'User canceled' ? 'cancelled' : 'failed');
      return fail(`Khalti reported: ${result.status}.`);
    }
    if (result.totalAmountRupees !== payment.amount) {
      failPayment(payment, 'failed');
      return fail('Paid amount did not match — contact support.');
    }
    creditTopup(payment, { gatewayRef: result.transactionId });
    return res.redirect(`/?pay=success&amount=${payment.amount}`);
  } catch (err) {
    console.error('Khalti verify failed:', err.message);
    return fail('Verification failed — if you were charged, the amount will be credited after review.');
  }
});

// eSewa success redirect carries a signed base64 payload; check the signature,
// then double-check server-to-server with the status API.
router.get('/payments/topup/return/esewa', async (req, res) => {
  const fail = (reason) => res.redirect(`/?pay=failed&reason=${encodeURIComponent(reason)}`);
  const decoded = esewa.decodeReturnData(req.query.data);
  if (!decoded) return fail('Invalid payment response.');
  const payment = db.payments.find((p) => p.id === decoded.transaction_uuid && p.gateway === 'esewa');
  if (!payment) return fail('Payment not found.');
  if (payment.status === 'succeeded') return res.redirect(`/?pay=success&amount=${payment.amount}`);
  try {
    const result = await esewa.verify({ transactionUuid: payment.id, totalAmount: payment.amount });
    if (!result.ok) {
      failPayment(payment, 'failed');
      return fail(`eSewa reported: ${result.status}.`);
    }
    creditTopup(payment, { gatewayRef: result.refId || decoded.transaction_code });
    return res.redirect(`/?pay=success&amount=${payment.amount}`);
  } catch (err) {
    console.error('eSewa verify failed:', err.message);
    return fail('Verification failed — if you were charged, the amount will be credited after review.');
  }
});

router.get('/payments/topup/return/esewa-failed', (req, res) => {
  // eSewa's failure redirect has no payload we can trust; expire the newest
  // pending eSewa intent lazily via TTL instead of guessing which one failed.
  res.redirect(`/?pay=failed&reason=${encodeURIComponent('Payment was cancelled.')}`);
});

// Step 2 (sandbox only): confirm with the demo PIN.
router.post('/payments/topup/confirm', authRequired, (req, res) => {
  const { paymentId, pin } = req.body || {};
  const payment = db.payments.find((p) => p.id === paymentId && p.userId === req.user.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });
  if (payment.gateway !== 'sandbox') {
    return res.status(400).json({ error: 'This payment is handled by the gateway — complete it on the payment page.' });
  }
  if (payment.status !== 'pending') return res.status(400).json({ error: 'This payment was already processed.' });
  if (Date.now() - payment.createdAt > INTENT_TTL_MS) {
    failPayment(payment, 'expired');
    return res.status(400).json({ error: 'Payment session expired — please start again.' });
  }
  if (String(pin || '').trim() !== SANDBOX_PIN) {
    failPayment(payment, 'failed');
    return res.status(402).json({ error: `Payment declined by ${TOPUP_METHODS[payment.method]} — wrong PIN.` });
  }
  creditTopup(payment);
  res.json({ user: publicUser(req.user) });
});

router.post('/payments/withdraw', authRequired, (req, res) => {
  const result = createWithdrawal('user', req.user, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  save();
  res.json({ withdrawal: result.withdrawal, user: publicUser(req.user) });
});

router.get('/payments/transactions', authRequired, (req, res) => {
  const transactions = db.transactions
    .filter((t) => t.ownerKind === 'user' && t.ownerId === req.user.id)
    .slice(-30)
    .reverse();
  res.json({ transactions });
});

module.exports = router;
