const crypto = require('crypto');

// One place for session-token rules across the customer, driver, partner and
// admin apps. Tokens live 60 days; expired ones are swept hourly so the token
// maps cannot grow forever.
const TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;

function issueToken(map, ownerId) {
  const token = crypto.randomBytes(24).toString('hex');
  map[token] = { id: ownerId, expiresAt: Date.now() + TOKEN_TTL_MS };
  return token;
}

// Returns the owner id or null. Legacy records (plain id strings from before
// expiry existed) are upgraded in place with a fresh TTL.
function tokenOwner(map, token) {
  const rec = token ? map[token] : null;
  if (!rec) return null;
  if (typeof rec === 'string') {
    map[token] = { id: rec, expiresAt: Date.now() + TOKEN_TTL_MS };
    return rec;
  }
  if (rec.expiresAt < Date.now()) {
    delete map[token];
    return null;
  }
  return rec.id;
}

function sweepExpired(map) {
  const now = Date.now();
  let removed = 0;
  for (const [token, rec] of Object.entries(map)) {
    if (rec && typeof rec === 'object' && rec.expiresAt < now) {
      delete map[token];
      removed += 1;
    }
  }
  return removed;
}

module.exports = { issueToken, tokenOwner, sweepExpired, TOKEN_TTL_MS };
