const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { UPLOADS_DIR } = require('./photos');

// Optional AI cleanup for shop item photos.
//
// A shopkeeper photographs a packet of noodles on a cluttered counter under a
// bare bulb. A catalog wants it centred on a clean background. That is what a
// background-removal API does well.
//
// The hard rule here: THIS IS NEVER ALLOWED TO BLOCK LISTING AN ITEM. If no
// provider is configured, or the provider is slow, down, out of credit or
// returns junk, the shopkeeper's original photo is used and the item still goes
// live. An image API outage must not stop a shop from selling.

const PROVIDER = (process.env.PHOTO_AI_PROVIDER || '').toLowerCase(); // '' | 'removebg'
const API_KEY = process.env.PHOTO_AI_KEY || '';
const TIMEOUT_MS = Number(process.env.PHOTO_AI_TIMEOUT_MS) || 8000;

function enabled() {
  return Boolean(PROVIDER && API_KEY);
}

// Uploads are served from /uploads/<file>; map a public URL back to disk.
function localPathFor(url) {
  const name = path.basename(String(url || ''));
  if (!/^[a-z0-9]+\.(jpg|jpeg|png|webp)$/i.test(name)) return null;
  const full = path.join(UPLOADS_DIR, name);
  return full.startsWith(UPLOADS_DIR) && fs.existsSync(full) ? full : null;
}

async function removeBackground(buffer) {
  const form = new FormData();
  form.append('image_file', new Blob([buffer]), 'item.jpg');
  form.append('size', 'auto');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': API_KEY },
      body: form,
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`provider responded ${res.status}`);
    const out = Buffer.from(await res.arrayBuffer());
    if (out.length < 1024) throw new Error('provider returned an empty image');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clean up an uploaded item photo. Always resolves — never throws — returning
 * the URL to use plus whether the cleanup actually happened, so the UI can be
 * honest with the shopkeeper instead of silently pretending.
 */
async function cleanupPhoto(url, { label = '' } = {}) {
  if (!enabled()) {
    return { url, cleaned: false, note: 'Photo saved as taken.' };
  }
  const src = localPathFor(url);
  if (!src) return { url, cleaned: false, note: 'Photo saved as taken.' };
  try {
    const input = fs.readFileSync(src);
    let output;
    if (PROVIDER === 'removebg') output = await removeBackground(input);
    else return { url, cleaned: false, note: 'Photo saved as taken.' };

    const name = `${crypto.randomBytes(12).toString('hex')}.png`;
    fs.writeFileSync(path.join(UPLOADS_DIR, name), output);
    return { url: `/uploads/${name}`, cleaned: true, note: 'Background removed for the shop listing.' };
  } catch (err) {
    // Degrade quietly to the original — the item still lists.
    console.error(`Photo cleanup failed${label ? ` for ${label}` : ''}:`, err.message);
    return { url, cleaned: false, note: 'Photo saved as taken (cleanup unavailable).' };
  }
}

module.exports = { cleanupPhoto, enabled };
