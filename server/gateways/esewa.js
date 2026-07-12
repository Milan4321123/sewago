// eSewa ePay v2 integration.
// Docs: https://developer.esewa.com.np/pages/Epay
// Flow: we build a signed form (HMAC-SHA256) the browser POSTs to eSewa ->
// user pays -> eSewa redirects to success_url with ?data=<base64 JSON> ->
// we verify the signature AND double-check with the status API before crediting.
const crypto = require('crypto');
const { config } = require('../config');

const FORM_URLS = {
  live: 'https://epay.esewa.com.np/api/epay/main/v2/form',
  test: 'https://rc-epay.esewa.com.np/api/epay/main/v2/form'
};
const STATUS_URLS = {
  live: 'https://epay.esewa.com.np/api/epay/transaction/status/',
  test: 'https://rc.esewa.com.np/api/epay/transaction/status/'
};

function enabled() {
  return Boolean(config.esewaProductCode && config.esewaSecret);
}

function mode() {
  return config.esewaMode === 'live' ? 'live' : 'test';
}

function sign(message) {
  return crypto.createHmac('sha256', config.esewaSecret).update(message).digest('base64');
}

// eSewa signs a comma-joined "key=value" string of signed_field_names, in order.
function signFields(fields, names) {
  return sign(names.map((n) => `${n}=${fields[n]}`).join(','));
}

// Returns { formUrl, fields } — the client renders a hidden form and submits it.
function initiate({ payment, successUrl, failureUrl }) {
  const total = String(payment.amount);
  const fields = {
    amount: total,
    tax_amount: '0',
    total_amount: total,
    transaction_uuid: payment.id,
    product_code: config.esewaProductCode,
    product_service_charge: '0',
    product_delivery_charge: '0',
    success_url: successUrl,
    failure_url: failureUrl,
    signed_field_names: 'total_amount,transaction_uuid,product_code'
  };
  fields.signature = signFields(fields, ['total_amount', 'transaction_uuid', 'product_code']);
  return { formUrl: FORM_URLS[mode()], fields };
}

// Decode the ?data= payload from the success redirect and check its signature.
// Returns null when the payload is malformed or tampered with.
function decodeReturnData(dataB64) {
  try {
    const decoded = JSON.parse(Buffer.from(String(dataB64), 'base64').toString('utf8'));
    const names = String(decoded.signed_field_names || '').split(',').filter(Boolean);
    if (!names.length || !decoded.signature) return null;
    const expected = signFields(decoded, names);
    const a = Buffer.from(String(decoded.signature));
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return decoded;
  } catch (_) {
    return null;
  }
}

// Server-to-server double check. Returns { ok, status, refId }.
async function verify({ transactionUuid, totalAmount }) {
  const params = new URLSearchParams({
    product_code: config.esewaProductCode,
    total_amount: String(totalAmount),
    transaction_uuid: transactionUuid
  });
  const res = await fetch(`${STATUS_URLS[mode()]}?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`eSewa status check failed (${res.status})`);
  return {
    ok: data.status === 'COMPLETE',
    status: data.status || 'UNKNOWN',
    refId: data.ref_id || null
  };
}

module.exports = { enabled, initiate, decodeReturnData, verify, name: 'esewa', label: 'eSewa' };
