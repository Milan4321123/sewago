// Khalti ePayment (KPG-2) integration.
// Docs: https://docs.khalti.com/khalti-epayment/
// Flow: initiate -> user pays on Khalti's hosted page -> Khalti redirects to our
// return_url with ?pidx= -> we verify with the lookup API before crediting.
const { config } = require('../config');

const BASES = {
  live: 'https://khalti.com/api/v2',
  test: 'https://dev.khalti.com/api/v2'
};

function enabled() {
  return Boolean(config.khaltiSecretKey);
}

function base() {
  return BASES[config.khaltiMode] || BASES.test;
}

async function khaltiFetch(path, body) {
  const res = await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${config.khaltiSecretKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail || data.error_key || JSON.stringify(data).slice(0, 200);
    throw new Error(`Khalti ${path} failed (${res.status}): ${detail}`);
  }
  return data;
}

// Returns { pidx, paymentUrl } — amounts are rupees here, paisa on the wire.
async function initiate({ payment, user, returnUrl, websiteUrl }) {
  const data = await khaltiFetch('/epayment/initiate/', {
    return_url: returnUrl,
    website_url: websiteUrl,
    amount: payment.amount * 100,
    purchase_order_id: payment.id,
    purchase_order_name: `SewaGo wallet top-up`,
    customer_info: {
      name: user.name,
      phone: user.phone || undefined,
      email: user.email || undefined
    }
  });
  return { pidx: data.pidx, paymentUrl: data.payment_url };
}

// Server-to-server verification — never trust the redirect params alone.
// Returns { ok, status, totalAmountRupees, transactionId }.
async function verify(pidx) {
  const data = await khaltiFetch('/epayment/lookup/', { pidx });
  return {
    ok: data.status === 'Completed',
    status: data.status,
    totalAmountRupees: Math.round(Number(data.total_amount || 0) / 100),
    transactionId: data.transaction_id || null
  };
}

module.exports = { enabled, initiate, verify, name: 'khalti', label: 'Khalti' };
