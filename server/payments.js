const { db, uid } = require('./db');

// Sandbox payment provider: shaped like a real gateway (intent -> confirm),
// so swapping in eSewa/Khalti/Stripe SDKs later only touches this file.
const SANDBOX_PIN = process.env.PAYMENT_SANDBOX_PIN || '1234';
const WITHDRAW_FEE = 10; // flat fee per withdrawal (platform revenue)
const MAX_WITHDRAWALS_PER_DAY = 5; // caps how fast a hijacked account can be drained
const TOPUP_METHODS = { esewa: 'eSewa', khalti: 'Khalti', card: 'Debit / credit card' };
const WITHDRAW_CHANNELS = { esewa: 'eSewa', khalti: 'Khalti', bank: 'Bank transfer' };

function balanceOf(kind, entity) {
  return kind === 'user' ? entity.wallet : (entity.earnings || 0);
}

// Append a ledger entry AFTER the wallet/earnings mutation so balanceAfter is correct.
function recordTxn(kind, entity, { type, label, amount, sign, method = null, refId = null, status = 'completed' }) {
  const txn = {
    id: uid(),
    ownerKind: kind,
    ownerId: entity.id,
    type,
    label,
    amount: Math.round(amount),
    sign,
    method,
    refId,
    status,
    balanceAfter: balanceOf(kind, entity),
    createdAt: Date.now()
  };
  db.transactions.push(txn);
  return txn;
}

// Platform revenue ledger: one entry per rupee SewaGo earns (or refunds).
// Every commission, fee and reversal lands here so admin revenue is an audit
// trail instead of a number recomputed from bookings.
// source: ride_commission | food_commission | stay_commission | task_fee | withdraw_fee
// Negative amounts are reversals (refunds / cancellations).
function recordPlatformRevenue({ source, label, amount, refId = null }) {
  const entry = {
    id: uid(),
    source,
    label,
    amount: Math.round(amount),
    refId,
    createdAt: Date.now()
  };
  db.platformLedger.push(entry);
  return entry;
}

function platformRevenueTotals() {
  const totals = { total: 0 };
  for (const e of db.platformLedger) {
    totals[e.source] = (totals[e.source] || 0) + e.amount;
    totals.total += e.amount;
  }
  return totals;
}

// Deducts immediately; the payout stays "processing" until admin approves it.
// Payouts move money out of the platform, so they carry extra guards: the
// account must be phone-verified and can only request a few per day.
function createWithdrawal(kind, entity, { amount, channel, account }) {
  if (!entity.phoneVerified) {
    return { error: 'Verify your phone number first — payouts are only sent from phone-verified accounts.' };
  }
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = db.withdrawals.filter(
    (w) => w.ownerKind === kind && w.ownerId === entity.id && w.createdAt > dayAgo
  );
  if (recent.length >= MAX_WITHDRAWALS_PER_DAY) {
    return { error: `Withdrawal limit reached (${MAX_WITHDRAWALS_PER_DAY} per day) — please try again tomorrow.` };
  }
  const amt = Math.round(Number(amount));
  if (!(amt >= 100 && amt <= 200000)) return { error: 'Withdrawal must be between Rs 100 and Rs 200,000.' };
  if (!WITHDRAW_CHANNELS[channel]) return { error: 'Pick a valid payout channel.' };
  const acct = String(account || '').trim();
  if (acct.length < 4 || acct.length > 40) return { error: 'A valid account / wallet ID is required.' };
  const total = amt + WITHDRAW_FEE;
  if (balanceOf(kind, entity) < total) {
    return { error: `Not enough balance — you need the amount plus the Rs ${WITHDRAW_FEE} payout fee.` };
  }
  if (kind === 'user') entity.wallet -= total;
  else entity.earnings = (entity.earnings || 0) - total;
  const withdrawal = {
    id: uid(),
    ownerKind: kind,
    ownerId: entity.id,
    ownerName: entity.name,
    amount: amt,
    fee: WITHDRAW_FEE,
    channel,
    account: acct,
    status: 'processing',
    createdAt: Date.now()
  };
  db.withdrawals.push(withdrawal);
  recordTxn(kind, entity, {
    type: 'withdrawal',
    label: `Withdrawal to ${WITHDRAW_CHANNELS[channel]} (…${acct.slice(-4)})`,
    amount: total,
    sign: -1,
    method: channel,
    refId: withdrawal.id,
    status: 'processing'
  });
  recordPlatformRevenue({
    source: 'withdraw_fee',
    label: `Payout fee — ${entity.name}`,
    amount: WITHDRAW_FEE,
    refId: withdrawal.id
  });
  return { withdrawal };
}

module.exports = {
  recordTxn,
  recordPlatformRevenue,
  platformRevenueTotals,
  createWithdrawal,
  SANDBOX_PIN,
  WITHDRAW_FEE,
  TOPUP_METHODS,
  WITHDRAW_CHANNELS
};
