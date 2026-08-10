// A grounded loop for turning a rambling spoken message into shop actions.
//
// The hand-written grammar in ./voiceCommand handles the sentences a shopkeeper
// says all day. This is for the rest — "आज बिहान चिनी सकियो अनि दुई बोरा चामल
// आयो, अनि साबुनको भाउ बढाउनु पर्‍यो" — where the shape is a story rather than a
// command.
//
// Why a loop instead of one prompt:
//
//   Pasting the whole inventory into a prompt works for a demo shop and falls
//   apart at five hundred lines — it is slow, it costs tokens on every single
//   utterance, and the model still has to guess which "दाल" was meant. Instead
//   the model is given SEARCH over the shelves and has to go look. It asks for
//   what it needs, sees the shop's real names, prices and counts, and only then
//   proposes anything. Context gets built from the shop rather than dumped on
//   the model.
//
// What the model is NOT allowed to do is just as important. It never receives
// item ids and it never writes. It proposes actions by NAME; those names go
// back through the same local resolver the spoken path uses, which decides
// which shelf line is meant, refuses to choose between two that are too alike,
// and rejects anything that is not really stocked. Then the shopkeeper confirms.
// A confused model produces a question or a shrug, never a wrong stock number.

const { scoreItem, MATCH_FLOOR } = require('./voiceCommand');
const { UNITS, lowStockThreshold } = require('./stores');

// Enough turns to look something up, look up a second thing, then answer.
// Beyond that it is looping, not thinking.
const MAX_ROUNDS = 5;
const MAX_HITS = 8;

const SYSTEM = [
  'You help a Nepali kirana (neighbourhood general store) owner run their shop by voice.',
  'They speak Nepali, romanized Nepali and English, usually mixed together in one sentence,',
  'and they ramble: several things that happened, in the order they remember them.',
  '',
  'You cannot see the shop. Use find_items to look up anything they mention BEFORE proposing',
  'it — that is how you learn the real name, unit, price and stock. Use list_low_stock when',
  'they ask what is running out or what to order.',
  '',
  'Then call propose_actions ONCE with everything that should happen:',
  '- sold: stock left the shop (a sale over the counter)',
  '- restock: stock arrived',
  '- count: they counted the shelf and this is the new total',
  '- price: a new selling price',
  '- add: something the shop does not stock yet (needs a price)',
  '- ask: they asked how much of something is left',
  '- low: they asked what is running out',
  '- open / close: the shop itself',
  '',
  'Rules:',
  '- Use the EXACT item name find_items returned. Do not translate or tidy it.',
  '- Only use numbers they actually said. Never invent a quantity or a price.',
  '- If find_items returns nothing for something they want to add, propose it as "add".',
  '- If they only chatted and asked for nothing, call propose_actions with an empty list.'
].join('\n');

const TOOLS = [
  {
    name: 'find_items',
    description: "Search this shop's shelves by name. Returns the real name, unit, price and stock of anything close.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Item name as the shopkeeper said it, in any script.' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_low_stock',
    description: 'List the items running low, lowest first.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'propose_actions',
    description: 'Report everything the shopkeeper asked for. Call this exactly once, last.',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              intent: {
                type: 'string',
                enum: ['sold', 'restock', 'count', 'price', 'add', 'ask', 'low', 'open', 'close']
              },
              item: { type: 'string', description: 'Exact name from find_items, or what they called it for a new item.' },
              qty: { type: 'number' },
              unit: { type: 'string', enum: Object.keys(UNITS) },
              price: { type: 'integer' }
            },
            required: ['intent', 'item']
          }
        }
      },
      required: ['actions']
    }
  }
];

// The shop's own matcher, exposed to the model as a search tool — so what it
// sees is exactly what the local resolver would match later.
function findItems(store, query) {
  const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  return store.items
    .filter((i) => !i.archived)
    .map((item) => ({ item, score: scoreItem(tokens, item) }))
    .filter((s) => s.score >= MATCH_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HITS)
    .map(({ item }) => ({
      name: item.name,
      unit: item.unit,
      price: item.price,
      stock: item.stock
    }));
}

function lowStock(store) {
  return store.items
    .filter((i) => !i.archived && (Number(i.stock) || 0) <= lowStockThreshold(i))
    .sort((a, b) => (Number(a.stock) || 0) - (Number(b.stock) || 0))
    .slice(0, 10)
    .map((i) => ({ name: i.name, unit: i.unit, stock: i.stock, price: i.price }));
}

/**
 * Run the loop.
 *
 * `adapter` is any provider exposing chat/userTurn/toolResult — ./gemini and
 * ./anthropicAdapter both do, and tests pass a stub. Returns the raw proposed
 * actions; the caller resolves them against the shop.
 */
async function runCommandAgent({ text, store, adapter, maxRounds = MAX_ROUNDS }) {
  const history = [adapter.userTurn(`The shopkeeper said:\n"${text}"`)];
  const trace = [];

  for (let round = 0; round < maxRounds; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    const reply = await adapter.chat({ system: SYSTEM, history, tools: TOOLS });
    if (!reply.calls.length) {
      // Talked instead of acting — nothing to do, and nothing is safer.
      return { actions: [], trace, rounds: round + 1, note: reply.text };
    }
    history.push(reply.content);

    const done = reply.calls.find((c) => c.name === 'propose_actions');
    if (done) {
      const actions = Array.isArray(done.args && done.args.actions) ? done.args.actions : [];
      return { actions, trace, rounds: round + 1 };
    }

    for (const call of reply.calls) {
      let result;
      if (call.name === 'find_items') result = { items: findItems(store, call.args.query) };
      else if (call.name === 'list_low_stock') result = { items: lowStock(store) };
      else result = { error: `Unknown tool ${call.name}` };
      trace.push({ tool: call.name, args: call.args, hits: (result.items || []).length });
      history.push(adapter.toolResult(call, result));
    }
  }
  // Out of rounds without a proposal: return nothing rather than a half-formed
  // guess. The local grammar's reading still stands.
  return { actions: [], trace, rounds: maxRounds, note: 'no_proposal' };
}

module.exports = { runCommandAgent, findItems, lowStock, SYSTEM, TOOLS, MAX_ROUNDS };
