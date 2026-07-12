const { db, uid } = require('./db');

// Append-only audit trail of every sensitive staff action. Entries are never
// mutated or deleted in normal operation; older ones are trimmed from memory
// only past a hard cap (full history belongs in an append-only store/WORM log
// in production).
const MAX_IN_MEMORY = 5000;

function logAudit({ actor, action, targetType = null, targetId = null, meta = {}, ip = null }) {
  db.auditLog = db.auditLog || [];
  const entry = {
    id: uid(),
    at: Date.now(),
    actorRole: actor ? actor.role : 'unknown',
    actorId: actor ? actor.id : null,
    actorEmail: actor ? actor.email : null,
    action,
    targetType,
    targetId,
    meta,
    ip
  };
  db.auditLog.push(entry);
  if (db.auditLog.length > MAX_IN_MEMORY) {
    db.auditLog.splice(0, db.auditLog.length - MAX_IN_MEMORY);
  }
  return entry;
}

function recentAudit(limit = 100, filter = {}) {
  db.auditLog = db.auditLog || [];
  let rows = db.auditLog;
  if (filter.action) rows = rows.filter((e) => e.action === filter.action);
  if (filter.actorRole) rows = rows.filter((e) => e.actorRole === filter.actorRole);
  return rows.slice(-limit).reverse();
}

module.exports = { logAudit, recentAudit };
