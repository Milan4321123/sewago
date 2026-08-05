// Short-lived, single-use tickets for the SSE stream.
//
// EventSource cannot send an Authorization header, so the realtime endpoint has
// to take its credential in the URL. Putting the 60-day session token there
// means every hop in front of this app — Render's router, nginx, a CDN, any
// reverse proxy — writes a working session token into its access log, where it
// outlives the request by however long that platform keeps logs. Our own logger
// is path-only, but we do not control the ones upstream.
//
// So the client trades its session token (over a normal Authorization header)
// for a ticket that is worth almost nothing if it leaks: it is valid for one
// minute, it is burned the moment it is used, and it grants exactly one thing —
// a subscription to that account's "something changed" nudges.
//
// Deliberately in-memory only: tickets are shorter-lived than any restart, and
// persisting them would put a credential back on disk for no benefit.
const crypto = require('crypto');

const TICKET_TTL_MS = 60 * 1000;
const MAX_LIVE_TICKETS = 20000; // a ceiling, not a policy — see sweep() below

const tickets = new Map(); // ticket -> { role, ownerId, expiresAt }

function sweep(now = Date.now()) {
  for (const [key, rec] of tickets) {
    if (rec.expiresAt <= now) tickets.delete(key);
  }
}

/** Mint a ticket for an already-authenticated caller. */
function issue(role, ownerId) {
  const now = Date.now();
  // Only ever evict what has already expired. Dropping live tickets under
  // pressure would sign out honest clients to make room for a flood.
  if (tickets.size >= MAX_LIVE_TICKETS) sweep(now);
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { role, ownerId, expiresAt: now + TICKET_TTL_MS });
  return { ticket, expiresInSec: Math.floor(TICKET_TTL_MS / 1000) };
}

/**
 * Redeem a ticket for its owner. Single use: a redeemed ticket is gone, so a
 * copy scraped from a log is already spent by the time anyone reads it.
 * Returns { role, ownerId } or null.
 */
function redeem(ticket, role) {
  if (!ticket || typeof ticket !== 'string') return null;
  const rec = tickets.get(ticket);
  if (!rec) return null;
  tickets.delete(ticket);
  if (rec.expiresAt <= Date.now()) return null;
  if (rec.role !== role) return null;
  return { role: rec.role, ownerId: rec.ownerId };
}

function liveCount() {
  sweep();
  return tickets.size;
}

module.exports = { issue, redeem, liveCount, TICKET_TTL_MS };
