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

// Debit a customer wallet, drawing down any held (freshly topped-up) balance
// first so the withdrawal hold reflects money still in the wallet. Without this
// the hold amount would outlive the funds it covers and wrongly block payouts of
// the user's older, already-withdrawable balance. All wallet spends go through
// here so no future path can forget it.
function debitWallet(user, amount) {
  user.wallet -= amount;
  if (user.heldBalance) {
    user.heldBalance = Math.max(0, user.heldBalance - amount);
  }
}

// The mirror of debitWallet, for money coming BACK to a customer: refunds,
// reversals, cancelled escrows.
//
// Spending releases the hold (above), which is right — the fresh money left the
// wallet. But a refund undoes the spend, so it has to undo the release too.
// Without this, the hold was two calls away from meaningless: top up by card,
// post a task, cancel it, and the money came back withdrawable with no
// counterparty and nothing to review — then charge the card back.
//
// Never re-hold past the window's high-water mark. Refunding money that was
// never fresh (an old balance spent and returned) must not freeze it, so the
// cap is what was actually held during this window, not the sum of everything
// that flows back. Wallets topped up before heldPeak existed have no mark to
// restore to; they keep the old behaviour and age out with their own window.
function creditWallet(user, amount) {
  user.wallet += amount;
  if ((user.heldUntil || 0) <= Date.now()) return;
  const peak = user.heldPeak || 0;
  if (peak <= 0) return;
  user.heldBalance = Math.min(user.wallet, (user.heldBalance || 0) + amount, peak);
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
  // Freshly topped-up money is held for a cooling period (anti-laundering /
  // card-chargeback). Only funds beyond the still-held amount are withdrawable.
  if (kind === 'user' && (entity.heldUntil || 0) > Date.now()) {
    // Held can never exceed the wallet (debitWallet keeps it in step); clamp
    // defensively so `available` never goes negative and blocks old funds.
    const held = Math.min(entity.heldBalance || 0, entity.wallet);
    const available = entity.wallet - held;
    if (total > available) {
      const hrs = Math.max(1, Math.ceil((entity.heldUntil - Date.now()) / 3600000));
      return { error: `Recently added funds are held for about ${hrs} more hour(s) before they can be withdrawn.` };
    }
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
  debitWallet,
  creditWallet,
  createWithdrawal,
  SANDBOX_PIN,
  WITHDRAW_FEE,
  TOPUP_METHODS,
  WITHDRAW_CHANNELS
};
