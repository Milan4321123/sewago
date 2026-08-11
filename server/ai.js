const Anthropic = require('@anthropic-ai/sdk');
const gemini = require('./gemini');
const anthropicAdapter = require('./anthropicAdapter');
const { runCommandAgent } = require('./aiAgent');
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

// A small stable taxonomy keeps AI-created items useful as navigation chips.
// Free-form labels quickly fragment into "Drinks", "Beverages", "Cold drink",
// etc., which looks intelligent in a draft but makes the actual shop harder to
// browse. "Other" is an honest fallback when none of these fit.
const INVENTORY_CATEGORIES = [
  'Rice & Grains', 'Spices & Oil', 'Snacks', 'Drinks', 'Dairy & Eggs',
  'Vegetables', 'Household', 'Personal Care', 'Baby & Health', 'Other'
];

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
          category: { type: 'string', enum: INVENTORY_CATEGORIES }
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
  `- CATEGORY: always choose exactly one of: ${INVENTORY_CATEGORIES.join(', ')}.`,
  '  Use the product itself and the shop context, not just one ambiguous word in its name.',
  '',
  'Every row is a draft the shopkeeper reviews before saving — never invent restocks or price',
  'changes they did not ask for. Set "note" to ONE short sentence explaining what you did.'
].join('\n');

// Which model provider this server has, if any.
//
// Gemini wins a tie on purpose: its free tier is what makes an AI assistant
// realistic for a neighbourhood shop in Kathmandu, and this feature is worth
// nothing to them if it only works on a paid plan. AI_PROVIDER forces one.
function provider() {
  const forced = String(process.env.AI_PROVIDER || '').toLowerCase();
  if (forced === 'gemini') return gemini.enabled() ? 'gemini' : null;
  if (forced === 'anthropic') return anthropicAdapter.enabled() ? 'anthropic' : null;
  if (gemini.enabled()) return 'gemini';
  if (anthropicAdapter.enabled()) return 'anthropic';
  return null;
}

function adapterFor(name) {
  return name === 'gemini' ? gemini : anthropicAdapter;
}

function aiEnabled() {
  return provider() !== null;
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
  if (provider() === 'gemini') return draftInventoryGemini({ prompt, store });
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

// Same job on Gemini. Structured output arrives as a tool call rather than a
// JSON body — one tool, called once, which is the shape Gemini is happiest
// producing and needs no fence-stripping either.
const DRAFT_ITEMS_TOOL = {
  name: 'propose_items',
  description: 'Return the draft item rows for the shopkeeper to review.',
  parameters: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'One short sentence on what you did.' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            unit: { type: 'string', enum: Object.keys(UNITS) },
            price: { type: 'integer' },
            stock: { type: 'number' },
            category: { type: 'string', enum: INVENTORY_CATEGORIES }
          },
          required: ['name', 'unit', 'price', 'stock']
        }
      }
    },
    required: ['items']
  }
};

async function draftInventoryGemini({ prompt, store }) {
  const reply = await gemini.chat({
    system: SYSTEM_PROMPT,
    history: [gemini.userTurn(`${inventorySummary(store)}\n\nShopkeeper's request:\n${prompt}`)],
    tools: [DRAFT_ITEMS_TOOL],
    maxTokens: 4096
  });
  const call = reply.calls.find((c) => c.name === 'propose_items');
  if (!call) return { error: 'The assistant returned nothing usable — try again.' };
  const items = Array.isArray(call.args.items) ? call.args.items : [];
  return { items, note: call.args.note || '' };
}

/* ---------------- spoken messages the local grammar could not place -------- */

/**
 * Best-effort commands for a message the local grammar could not place.
 *
 * Runs the grounded loop in ./aiAgent: the model searches the shop's shelves,
 * reads back real names and counts, then proposes actions BY NAME. Those names
 * are resolved locally afterwards, so nothing here can reach an item id or move
 * stock on its own.
 *
 * Returns { commands } — possibly empty, which simply means the local reading
 * stands.
 */
async function draftCommands({ text, store }) {
  const name = provider();
  if (!name) return { commands: [] };
  const { actions } = await runCommandAgent({ text, store, adapter: adapterFor(name) });
  return { commands: Array.isArray(actions) ? actions : [] };
}

module.exports = { aiEnabled, provider, draftInventory, draftCommands };
