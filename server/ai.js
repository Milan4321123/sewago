const Anthropic = require('@anthropic-ai/sdk');
const { UNITS, reorderSuggestions } = require('./stores');

// Agentic inventory assistant for shopkeepers.
//
// One job: turn whatever the shopkeeper types — a pasted supplier list, "restock
// everything running low", "set up a typical cold store" — into DRAFT item rows.
// Nothing here ever writes to the store: the client shows the drafts in the same
// editable review table the voice flow uses, and commits through the existing
// bulk endpoint (where dupe name+unit = restock, exactly right for restocks).
//
// Structured outputs pin the response to ITEMS_SCHEMA, so the reply text is
// guaranteed-valid JSON — no fence-stripping, no retry-on-parse-error loops.

// The model may only answer in this shape. Units mirror ./stores UNITS.
const ITEMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'note'],
  properties: {
    note: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'unit', 'price', 'stock', 'category'],
        properties: {
          name: { type: 'string' },
          unit: { enum: ['each', 'kg', 'g', 'l', 'ml', 'packet', 'dozen', 'bottle', 'sack'] },
          price: { type: 'integer' },
          stock: { type: 'number' },
          category: { type: 'string' }
        }
      }
    }
  }
};

const SYSTEM_PROMPT = [
  'You are the inventory assistant for a Nepali kirana (neighbourhood general store) on SewaGo.',
  'Prices are in NPR and must be realistic for Kathmandu retail. You understand item names in',
  'Nepali, romanized Nepali, and English (e.g. "chini" = sugar, "dudh" = milk, "chamal" = rice),',
  'but write item names the way a shop lists them (e.g. "Wai Wai Chicken", "DDC Dudh 500ml").',
  '',
  'You are given the CURRENT inventory (name, unit, price, stock, and days of cover for items',
  'running low). From the shopkeeper\'s request you can:',
  '- Draft NEW items from a description or pasted list ("stock a cold store", a supplier bill).',
  '- Propose RESTOCKS ("restock everything running low"): reuse the existing name and unit',
  '  exactly so the rows merge into the existing lines, set stock to the suggested reorder',
  '  quantity, and keep the current price.',
  '- Adjust PRICES: reuse the existing name and unit exactly, set the new price, stock 0.',
  '',
  'Every row is a draft the shopkeeper reviews before saving — never invent restocks or price',
  'changes they did not ask for. Set "note" to ONE short sentence explaining what you did.'
].join('\n');

function aiEnabled() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Compact one-line-per-item picture of the shop, plus the reorder maths the
// dashboard already computes — enough for "restock what's low" to be answerable.
function inventorySummary(store) {
  const items = store.items.filter((i) => !i.archived);
  if (!items.length) return 'The shop has no items yet.';
  const cover = new Map(reorderSuggestions(store, 100).map((s) => [s.itemId, s]));
  const lines = items.map((i) => {
    const unitLabel = (UNITS[i.unit] || UNITS.each).label;
    const s = cover.get(i.id);
    const low = s
      ? ` — LOW: ${s.daysLeft === null ? 'no recent sales' : `${s.daysLeft} days of cover left`}, suggested reorder ${s.suggestedQty}`
      : '';
    return `${i.name} | unit: ${i.unit} (${unitLabel}) | Rs ${i.price} | stock: ${i.stock}${low}`;
  });
  return `Current inventory (${items.length} items):\n${lines.join('\n')}`;
}

/**
 * Draft inventory rows from a free-text prompt. Returns { items, note } or
 * { error } when the model declines; network/API failures throw and the route
 * turns them into a 502.
 */
async function draftInventory({ prompt, store }) {
  // Constructed per-call: new Anthropic() throws when the key is missing, and
  // aiEnabled() is the gate the route checks first.
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 4096,
    output_config: { format: { type: 'json_schema', schema: ITEMS_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${inventorySummary(store)}\n\nShopkeeper's request:\n${prompt}`
      }
    ]
  });
  if (response.stop_reason === 'refusal') {
    return { error: 'The assistant could not help with that request — try rephrasing it.' };
  }
  // Structured outputs guarantee the text block is valid JSON per ITEMS_SCHEMA;
  // find() skips any (empty) thinking blocks that precede it.
  const text = response.content.find((b) => b.type === 'text');
  if (!text) return { error: 'The assistant returned nothing usable — try again.' };
  const parsed = JSON.parse(text.text);
  return { items: parsed.items, note: parsed.note };
}

/* ---------------- spoken commands the local grammar could not place --------- */

// The offline parser in ./voiceCommand handles the sentences a shopkeeper says
// a hundred times a day, and handles them with no key and no network. This is
// only for the rest: an unusual phrasing, a sentence that rambles, a mix of
// three languages in one breath.
//
// The model's job is deliberately small — name the item and say what happened.
// It never sees ids and never decides anything: which shelf line that name
// means, whether two lines are too alike to choose between, and whether the
// numbers are sane are all settled locally afterwards, against the shop's own
// record. So a bad guess here becomes a question or a refusal, never a wrong
// stock movement.
const COMMANDS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['commands'],
  properties: {
    commands: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['intent', 'item'],
        properties: {
          intent: { enum: ['sold', 'restock', 'count', 'price', 'add', 'ask', 'low', 'open', 'close'] },
          // Copied from the inventory listing when it names something already
          // stocked; otherwise whatever the shopkeeper called it.
          item: { type: 'string' },
          qty: { type: 'number' },
          unit: { enum: ['each', 'kg', 'g', 'l', 'ml', 'packet', 'dozen', 'bottle', 'sack'] },
          price: { type: 'integer' }
        }
      }
    }
  }
};

const COMMAND_PROMPT = [
  'You turn one spoken sentence from a Nepali kirana shopkeeper into commands on their shop.',
  'They speak Nepali, romanized Nepali and English, often mixed inside one sentence.',
  '',
  'Intents: sold (stock leaves), restock (stock arrives), count (the shelf was counted and',
  'this is the new total), price (new selling price), add (something not stocked yet),',
  'ask (how much of an item is left), low (what is running out), open/close (the shop).',
  '',
  'Rules:',
  '- One sentence can carry several commands. Return one per thing that happened.',
  '- When the shopkeeper means something already in the inventory below, copy that item',
  '  name EXACTLY as listed. Do not translate it and do not tidy it up.',
  '- Only set qty/price to numbers actually said. Never invent them.',
  '- If the sentence is not an instruction about the shop, return an empty list.'
].join('\n');

/**
 * Best-effort commands for a sentence the local grammar could not place.
 * Returns { commands } — possibly empty. Callers resolve the names themselves.
 */
async function draftCommands({ text, store }) {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 1024,
    output_config: { format: { type: 'json_schema', schema: COMMANDS_SCHEMA } },
    system: COMMAND_PROMPT,
    messages: [
      { role: 'user', content: `${inventorySummary(store)}\n\nShopkeeper said:\n${text}` }
    ]
  });
  if (response.stop_reason === 'refusal') return { commands: [] };
  const block = response.content.find((b) => b.type === 'text');
  if (!block) return { commands: [] };
  return { commands: JSON.parse(block.text).commands || [] };
}

module.exports = { aiEnabled, draftInventory, draftCommands };
