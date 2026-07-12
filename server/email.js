// Transactional email delivery. Same adapter pattern as the SMS side in
// accountSecurity.js: sandbox is a no-op (the API response carries the token
// for local testing), and real providers are selected with EMAIL_PROVIDER.
//
//   EMAIL_PROVIDER=resend    — https://resend.com  (EMAIL_PROVIDER_API_KEY, EMAIL_FROM)
//   EMAIL_PROVIDER=sendgrid  — https://sendgrid.com (EMAIL_PROVIDER_API_KEY, EMAIL_FROM)
//   EMAIL_PROVIDER=webhook   — POST to EMAIL_WEBHOOK_URL (optional EMAIL_WEBHOOK_TOKEN),
//                              for shops that already run their own mail relay.
const { config } = require('./config');
const logger = require('./logger');

function emailProvider() {
  return process.env.EMAIL_PROVIDER || 'sandbox';
}

function fromAddress() {
  return process.env.EMAIL_FROM || 'no-reply@sewago.app';
}

async function sendEmail({ to, subject, text, html }) {
  const provider = emailProvider();
  if (provider === 'sandbox') return { sandbox: true };

  if (provider === 'resend') {
    const key = process.env.EMAIL_PROVIDER_API_KEY;
    if (!key) throw new Error('Resend email is not configured. Set EMAIL_PROVIDER_API_KEY.');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromAddress(), to: [to], subject, text, html })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Resend failed to send the email (${res.status}).`);
    return { providerMessageId: data.id };
  }

  if (provider === 'sendgrid') {
    const key = process.env.EMAIL_PROVIDER_API_KEY;
    if (!key) throw new Error('SendGrid email is not configured. Set EMAIL_PROVIDER_API_KEY.');
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromAddress() },
        subject,
        content: [
          { type: 'text/plain', value: text },
          ...(html ? [{ type: 'text/html', value: html }] : [])
        ]
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SendGrid failed to send the email (${res.status}): ${body.slice(0, 200)}`);
    }
    return { providerMessageId: res.headers.get('x-message-id') };
  }

  if (provider === 'webhook') {
    const url = process.env.EMAIL_WEBHOOK_URL;
    if (!url) throw new Error('Webhook email is not configured. Set EMAIL_WEBHOOK_URL.');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.EMAIL_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.EMAIL_WEBHOOK_TOKEN}` } : {})
      },
      body: JSON.stringify({ to, from: fromAddress(), subject, text, html, purpose: 'transactional' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || 'Email webhook failed to send the email.');
    return { providerMessageId: data.id || data.messageId };
  }

  throw new Error(`Unsupported EMAIL_PROVIDER=${provider}. Use sandbox, resend, sendgrid, or webhook.`);
}

// Where each app lives, so the reset link opens the right workspace.
const RESET_PATHS = { user: '/', driver: '/driver', partner: '/partner' };

function resetLink(kind, token) {
  const base = (config.publicAppUrl || `http://localhost:${config.port}`).replace(/\/$/, '');
  return `${base}${RESET_PATHS[kind] || '/'}?reset=${encodeURIComponent(token)}`;
}

// Fire-and-forget from the caller's perspective: the reset endpoint must answer
// the same way whether or not the account exists, so delivery failures are
// logged for ops instead of surfaced to the requester.
async function sendPasswordResetEmail(kind, entity, token, expiresAt) {
  const link = resetLink(kind, token);
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));
  try {
    const result = await sendEmail({
      to: entity.email,
      subject: 'Reset your SewaGo password',
      text:
        `Hi ${entity.name || 'there'},\n\n` +
        `Tap the link below to choose a new SewaGo password. It expires in ${minutes} minutes.\n\n` +
        `${link}\n\n` +
        `If you did not ask for this, you can ignore this email — your password is unchanged.`,
      html:
        `<p>Hi ${escapeHtml(entity.name || 'there')},</p>` +
        `<p>Tap the button below to choose a new SewaGo password. It expires in <b>${minutes} minutes</b>.</p>` +
        `<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#22c55e;color:#04130a;` +
        `border-radius:10px;text-decoration:none;font-weight:700">Reset password</a></p>` +
        `<p style="color:#667">Or paste this link into your browser:<br>${link}</p>` +
        `<p style="color:#667">If you did not ask for this, ignore this email — your password is unchanged.</p>`
    });
    if (!result.sandbox) {
      logger.info('password_reset_email_sent', { kind, to: maskEmail(entity.email), providerMessageId: result.providerMessageId });
    }
    return result;
  } catch (err) {
    logger.error('password_reset_email_failed', { kind, to: maskEmail(entity.email), err: err.message });
    return { error: err.message };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

module.exports = { sendEmail, sendPasswordResetEmail, emailProvider };
