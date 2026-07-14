// Partner-uploaded listing photos (restaurant covers, menu items, hotels,
// rooms). The client downscales to ~1280px JPEG before uploading, so files
// stay small; the server checks real magic bytes (never trusts the header),
// stores them under DATA_DIR/uploads and records ownership in db.uploads so a
// photo can only be attached to listings by the partner who uploaded it.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, uid } = require('./db');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

const MAX_BYTES = 2 * 1024 * 1024; // post-downscale photos are ~100-400 KB
const MAX_PER_DAY = 100; // per partner — plenty for menus, blocks abuse

// Sniff the actual file type. Only formats every browser renders are allowed.
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function savePartnerPhoto(partner, buf) {
  if (!buf || !buf.length) return { error: 'No image received.' };
  if (buf.length > MAX_BYTES) return { error: 'Photo is too large — keep it under 2 MB.' };
  const ext = sniffImage(buf);
  if (!ext) return { error: 'Only JPEG, PNG or WebP photos are accepted.' };

  db.uploads = db.uploads || [];
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = db.uploads.filter((u) => u.ownerId === partner.id && u.createdAt > dayAgo);
  if (recent.length >= MAX_PER_DAY) return { error: 'Daily photo upload limit reached — try again tomorrow.' };

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const name = `${uid()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
  const url = `/uploads/${name}`;
  db.uploads.push({
    id: uid(),
    ownerKind: 'partner',
    ownerId: partner.id,
    url,
    bytes: buf.length,
    createdAt: Date.now()
  });
  return { url };
}

// A photo reference coming back from a form is only accepted if this partner
// uploaded it — otherwise a crafted request could hotlink someone else's file
// or an arbitrary path.
function ownedPhoto(partner, value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (!/^\/uploads\/[\w.-]+$/.test(url)) return '';
  const rec = (db.uploads || []).find((u) => u.url === url && u.ownerId === partner.id);
  return rec ? url : '';
}

const MAX_PHOTOS_PER_LISTING = 5;

// Same ownership rule for a whole gallery: keep only this partner's uploads,
// de-duplicated, capped at 5.
function ownedPhotos(partner, list) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(list) ? list : []) {
    const url = ownedPhoto(partner, value);
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
      if (out.length >= MAX_PHOTOS_PER_LISTING) break;
    }
  }
  return out;
}

module.exports = { savePartnerPhoto, ownedPhoto, ownedPhotos, MAX_PHOTOS_PER_LISTING, UPLOADS_DIR };
