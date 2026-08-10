// Claude behind the same adapter shape ./gemini exposes, so ./aiAgent runs one
// loop regardless of which provider a shop has configured.
//
// Kept separate from ./ai (which still uses plain structured output for the
// inventory drafter) because tool use needs its own message bookkeeping: every
// tool result has to quote the id of the call it answers.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

function enabled() {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function chat({ system, history, tools = [], maxTokens = 1024 }) {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    temperature: 0, // a sentence about stock must not read differently twice
    system,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    })),
    messages: history
  });
  const calls = response.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return { text, calls, content: { role: 'assistant', content: response.content } };
}

const userTurn = (text) => ({ role: 'user', content: text });
const toolResult = (call, response) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(response) }]
});

module.exports = { enabled, chat, userTurn, toolResult, MODEL };
