// Google Gemini, spoken to over plain REST.
//
// No SDK on purpose: this is two endpoints and a JSON body, and the runtime
// already has fetch. One less dependency to keep current, and the wire format
// stays visible right here when something misbehaves.
//
// Gemini is the provider a Nepali kirana can actually afford — the free tier
// covers a shop's whole day of talking to its inventory. That is why the model
// name is configurable rather than hard-coded: whichever free model is current
// should be selectable without a code change.

// Read per call, not at load: env is what a deployment tunes, and a value
// frozen at require() time is the kind of thing that works in dev and quietly
// ignores the production setting. The endpoint is overridable so a deployment
// behind an in-country proxy can point elsewhere.
const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const endpoint = () => process.env.GEMINI_ENDPOINT || DEFAULT_ENDPOINT;
const model = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function apiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

function enabled() {
  return !!apiKey();
}

// Gemini describes tool parameters in the OpenAPI dialect (uppercase types),
// not the JSON Schema spelling the rest of this codebase uses.
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toUpperCase();
    else if (k === 'properties') {
      out.properties = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toGeminiSchema(s)]));
    } else if (k === 'items') out.items = toGeminiSchema(v);
    else if (k === 'enum') out.enum = v;
    else if (k === 'additionalProperties') continue; // not part of the dialect
    else out[k] = v;
  }
  return out;
}

/**
 * One turn of a conversation.
 *
 * `history` is the running list of Gemini `contents`. Returns the model's text
 * plus any tool calls it wants made, and the content block to append to the
 * history so the next turn sees what it said.
 */
async function chat({ system, history, tools = [], maxTokens = 1024, timeoutMs = 20000 }) {
  const body = {
    contents: history,
    generationConfig: {
      maxOutputTokens: maxTokens,
      // Stock movements must not vary between two identical sentences.
      temperature: 0
    }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools.length) {
    body.tools = [{
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: toGeminiSchema(t.parameters)
      }))
    }];
  }

  // A shopkeeper is standing at the counter; a hung request is worse than none.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${endpoint()}/${encodeURIComponent(model())}:generateContent?key=${encodeURIComponent(apiKey())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Surface Google's own message — a wrong GEMINI_MODEL or an unenabled key
    // is the likeliest failure and its message says exactly which.
    const detail = await res.text().catch(() => '');
    const err = new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const candidate = (data.candidates || [])[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  const calls = parts
    .filter((p) => p.functionCall)
    .map((p) => ({ name: p.functionCall.name, args: p.functionCall.args || {} }));
  const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('').trim();
  return { text, calls, content: candidate && candidate.content ? candidate.content : { role: 'model', parts } };
}

// History builders, so callers never hand-write Gemini's wire shape.
// `toolResult` takes the call it answers — Gemini matches on the name, other
// providers match on an id, so the whole call is passed either way.
const userTurn = (text) => ({ role: 'user', parts: [{ text }] });
const toolResult = (call, response) => ({
  role: 'user',
  parts: [{ functionResponse: { name: call.name, response } }]
});

module.exports = { enabled, chat, userTurn, toolResult, model };
