// In-process request/error counters for lightweight monitoring.
// For multi-instance deploys, export these to Prometheus/StatsD instead.

const startedAt = Date.now();
const counters = {
  requests: 0,
  errors: 0,
  byStatusClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
  byMethod: {},
  slowestMs: 0
};

// Express middleware: count every request and its response status/latency.
function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  counters.requests += 1;
  counters.byMethod[req.method] = (counters.byMethod[req.method] || 0) + 1;
  res.on('finish', () => {
    const cls = `${Math.floor(res.statusCode / 100)}xx`;
    if (counters.byStatusClass[cls] !== undefined) counters.byStatusClass[cls] += 1;
    if (res.statusCode >= 500) counters.errors += 1;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (ms > counters.slowestMs) counters.slowestMs = Math.round(ms);
  });
  next();
}

function recordError() {
  counters.errors += 1;
}

function snapshot() {
  const mem = process.memoryUsage();
  return {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
    pid: process.pid,
    nodeVersion: process.version,
    memoryMB: {
      rss: Math.round(mem.rss / 1048576),
      heapUsed: Math.round(mem.heapUsed / 1048576)
    },
    requests: counters.requests,
    errors: counters.errors,
    byStatusClass: { ...counters.byStatusClass },
    byMethod: { ...counters.byMethod },
    slowestMs: counters.slowestMs
  };
}

module.exports = { metricsMiddleware, recordError, snapshot };
