// Server-Sent Events hub: pushes "something changed, refresh" nudges to clients
// so status updates and new ride requests are instant instead of waiting for the
// next poll — and idle clients (especially online drivers waiting for a request)
// stop polling entirely. Clients still fetch authoritative state over REST; a
// push only tells them when to. SSE (not raw WebSocket) because it's one-way,
// rides on the existing HTTP server + CSP, and reconnects automatically.
//
// No dependency on db/routes: routes call publish(); this stays a dumb fan-out.

const clients = new Set(); // { res, audiences:Set<string> }
let heartbeat = null;

function startHeartbeat() {
  if (heartbeat) return;
  // Comment pings keep the connection alive through idle-timeout proxies.
  heartbeat = setInterval(() => {
    for (const c of clients) {
      try { c.res.write(': ping\n\n'); } catch (e) { /* dropped on next write */ }
    }
  }, 25000);
  if (heartbeat.unref) heartbeat.unref();
}

// Register an SSE connection for the given audience tags (e.g. 'user:<id>',
// 'driver:<id>', 'drivers:bike', 'admin'). Returns nothing; cleanup is automatic.
function subscribe(req, res, audiences) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' // don't let nginx buffer the stream
  });
  res.write('retry: 3000\n\n'); // client reconnect backoff
  if (res.flushHeaders) res.flushHeaders();

  const client = { res, audiences: new Set(audiences) };
  clients.add(client);
  startHeartbeat();

  const drop = () => clients.delete(client);
  req.on('close', drop);
  req.on('error', drop);
}

function publish(audience, payload) {
  if (clients.size === 0) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) {
    if (!c.audiences.has(audience)) continue;
    try { c.res.write(frame); } catch (e) { clients.delete(c); }
  }
}

// Fan out to several audiences at once (deduped so a client on two of them gets
// one message).
function publishTo(audiences, payload) {
  if (clients.size === 0) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  const want = new Set(audiences);
  for (const c of clients) {
    let hit = false;
    for (const a of want) { if (c.audiences.has(a)) { hit = true; break; } }
    if (!hit) continue;
    try { c.res.write(frame); } catch (e) { clients.delete(c); }
  }
}

function stats() {
  return { connections: clients.size };
}

module.exports = { subscribe, publish, publishTo, stats };
