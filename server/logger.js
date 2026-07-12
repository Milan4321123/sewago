// Structured JSON logging. One line per event so logs are greppable and
// ingestible by any aggregator (Loki, Datadog, CloudWatch, `jq`). Set LOG_LEVEL
// to debug|info|warn|error (default info). Errors/warnings go to stderr so they
// survive stdout redirection and surface in most hosting dashboards.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  let line;
  try {
    line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  } catch (e) {
    // Never let a logging failure (circular field, etc.) crash a request.
    line = JSON.stringify({ t: new Date().toISOString(), level, msg, logError: e.message });
  }
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

module.exports = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields)
};
