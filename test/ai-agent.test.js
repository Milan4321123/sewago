// The model-assisted path for spoken messages the local grammar cannot place.
//
// No API key and no network: the loop takes a provider adapter, so a scripted
// stub exercises the parts that actually matter — that the model has to LOOK at
// the shop before it can propose anything, that what it sees is the shop's real
// data, and that whatever it comes back with is still resolved locally before
// it could touch a shelf.
//
// Run with: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runCommandAgent, findItems, lowStock } = require('../server/aiAgent');
const { commandsFromFields } = require('../server/voiceCommand');

function shop() {
  return {
    id: 'shop1',
    items: [
      { id: 'i1', name: 'Sugar', unit: 'kg', price: 120, stock: 40, salesDaily: {} },
      { id: 'i2', name: 'Chamal Basmati', unit: 'kg', price: 180, stock: 100, salesDaily: {} },
      { id: 'i3', name: 'Musuro Dal', unit: 'kg', price: 160, stock: 25, salesDaily: {} },
      { id: 'i4', name: 'Mas Dal', unit: 'kg', price: 210, stock: 12, salesDaily: {} },
      { id: 'i5', name: 'Lifebuoy Sabun', unit: 'each', price: 45, stock: 2, salesDaily: {} }
    ]
  };
}

// A provider that replies from a script and records what it was told.
function stubAdapter(script) {
  const seen = [];
  let turn = 0;
  return {
    seen,
    turns: () => turn,
    userTurn: (text) => ({ role: 'user', parts: [{ text }] }),
    toolResult: (call, response) => ({ role: 'user', parts: [{ functionResponse: { name: call.name, response } }] }),
    async chat({ history, tools }) {
      // Record the tool results handed back, so the test can assert on grounding.
      for (const entry of history) {
        for (const part of entry.parts || []) {
          if (part.functionResponse) seen.push(part.functionResponse);
        }
      }
      const step = script[turn] || { calls: [] };
      turn += 1;
      return {
        text: step.text || '',
        calls: step.calls || [],
        content: { role: 'model', parts: [] },
        toolNames: tools.map((t) => t.name)
      };
    }
  };
}

test('the model has to look at the shelves, and sees the shop’s real numbers', async () => {
  const store = shop();
  const adapter = stubAdapter([
    { calls: [{ name: 'find_items', args: { query: 'chini' } }] },
    { calls: [{ name: 'propose_actions', args: { actions: [{ intent: 'sold', item: 'Sugar', qty: 2, unit: 'kg' }] } }] }
  ]);

  const { actions, trace, rounds } = await runCommandAgent({ text: 'aaja chini sakiyo', store, adapter });
  assert.equal(rounds, 2);
  assert.deepEqual(trace.map((t) => t.tool), ['find_items']);

  // What came back was the shop's own record, not something invented.
  const [lookup] = adapter.seen;
  assert.ok(lookup, 'the search result must be fed back to the model');
  assert.deepEqual(lookup.response.items[0], { name: 'Sugar', unit: 'kg', price: 120, stock: 40 });
  assert.deepEqual(actions, [{ intent: 'sold', item: 'Sugar', qty: 2, unit: 'kg' }]);
});

test('a rambling message becomes several grounded actions', async () => {
  const store = shop();
  const adapter = stubAdapter([
    { calls: [{ name: 'find_items', args: { query: 'chini' } }, { name: 'find_items', args: { query: 'chamal' } }] },
    {
      calls: [{
        name: 'propose_actions',
        args: {
          actions: [
            { intent: 'sold', item: 'Sugar', qty: 3, unit: 'kg' },
            { intent: 'restock', item: 'Chamal Basmati', qty: 2, unit: 'sack' },
            { intent: 'price', item: 'Lifebuoy Sabun', price: 50 }
          ]
        }
      }]
    }
  ]);

  const { actions } = await runCommandAgent({
    text: 'aaja bihana chini teen kilo bikri bhayo, dui bora chamal aayo, ani sabun ko bhau badhaunu paryo pachas',
    store,
    adapter
  });
  assert.equal(actions.length, 3);

  // The safety boundary: names go through the LOCAL resolver, which is what
  // decides the shelf line — the model never handled an id.
  const resolved = commandsFromFields(actions, store);
  assert.deepEqual(
    resolved.map((c) => [c.intent, c.itemName]),
    [['sold', 'Sugar'], ['restock', 'Chamal Basmati'], ['price', 'Lifebuoy Sabun']]
  );
});

test('an item the model invented is refused, not created behind the shopkeeper', async () => {
  const store = shop();
  const adapter = stubAdapter([
    { calls: [{ name: 'propose_actions', args: { actions: [{ intent: 'sold', item: 'Basmati Gold Premium', qty: 5 }] } }] }
  ]);
  const { actions } = await runCommandAgent({ text: 'something odd', store, adapter });
  const [resolved] = commandsFromFields(actions, store);
  assert.equal(resolved.error, 'not_found', 'a name the shop does not stock cannot become a stock movement');
  assert.equal(resolved.itemId, undefined);
});

test('the model still cannot pick between two items that are too alike', async () => {
  const store = shop();
  const adapter = stubAdapter([
    { calls: [{ name: 'propose_actions', args: { actions: [{ intent: 'sold', item: 'dal', qty: 2 }] } }] }
  ]);
  const { actions } = await runCommandAgent({ text: 'dal bikri bhayo', store, adapter });
  const [resolved] = commandsFromFields(actions, store);
  assert.ok(resolved.needsPick, 'a vague name from the model is still a question');
  assert.deepEqual(resolved.needsPick.map((c) => c.name).sort(), ['Mas Dal', 'Musuro Dal']);
});

test('a model that only chats, or never decides, changes nothing', async () => {
  const store = shop();
  const chatty = stubAdapter([{ text: 'Namaste! How can I help?', calls: [] }]);
  assert.deepEqual((await runCommandAgent({ text: 'hello', store, adapter: chatty })).actions, []);

  // Searching forever without proposing must end, not spin.
  const looping = stubAdapter(Array.from({ length: 10 }, () => (
    { calls: [{ name: 'find_items', args: { query: 'chini' } }] }
  )));
  const out = await runCommandAgent({ text: 'hmm', store, adapter: looping, maxRounds: 3 });
  assert.deepEqual(out.actions, []);
  assert.equal(out.rounds, 3);
  assert.equal(out.note, 'no_proposal');
});

// --- the Gemini wire format ------------------------------------------------
// No key and no network: fetch is stubbed, so what is checked is the request
// this codebase actually builds and its reading of the reply. Gemini speaks the
// OpenAPI dialect for tool parameters, which is easy to get subtly wrong and
// fails at runtime rather than at load.
test('the Gemini request is shaped the way Google expects', async () => {
  const gemini = require('../server/gemini');
  const realFetch = globalThis.fetch;
  const realKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  let sent = null;
  let calledUrl = null;
  globalThis.fetch = async (url, opts) => {
    calledUrl = url;
    sent = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            role: 'model',
            parts: [
              { text: 'looking that up' },
              { functionCall: { name: 'find_items', args: { query: 'chini' } } }
            ]
          }
        }]
      })
    };
  };
  try {
    const reply = await gemini.chat({
      system: 'be useful',
      history: [gemini.userTurn('chini kati chha')],
      tools: [{
        name: 'find_items',
        description: 'search',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { query: { type: 'string' }, limit: { type: 'integer' } },
          required: ['query']
        }
      }]
    });

    assert.match(calledUrl, /generativelanguage\.googleapis\.com/);
    // The default must stay an ALIAS, never a pinned version: Google closes
    // specific models to new users without notice, and that is exactly how this
    // broke in the field ("gemini-2.5-flash is no longer available to new users").
    assert.match(calledUrl, /gemini-[a-z-]*latest:/, 'default model must be a -latest alias');
    assert.match(calledUrl, /:generateContent\?key=test-key$/);
    assert.equal(sent.systemInstruction.parts[0].text, 'be useful');
    assert.equal(sent.generationConfig.temperature, 0, 'stock movements must not vary run to run');

    // Types uppercased, and additionalProperties dropped — Gemini rejects it.
    const params = sent.tools[0].functionDeclarations[0].parameters;
    assert.equal(params.type, 'OBJECT');
    assert.equal(params.properties.query.type, 'STRING');
    assert.equal(params.properties.limit.type, 'INTEGER');
    assert.deepEqual(params.required, ['query']);
    assert.ok(!('additionalProperties' in params));

    assert.equal(reply.text, 'looking that up');
    assert.deepEqual(reply.calls, [{ name: 'find_items', args: { query: 'chini' } }]);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = realKey;
  }
});

test('a Gemini error says what Google said, so a bad key or model is obvious', async () => {
  const gemini = require('../server/gemini');
  const realFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = 'test-key';
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    text: async () => '{"error":{"message":"models/gemini-9-turbo is not found"}}'
  });
  try {
    await assert.rejects(
      () => gemini.chat({ history: [gemini.userTurn('hi')] }),
      /gemini-9-turbo is not found/
    );
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

// --- the whole chain, over a real socket -----------------------------------
// A fake Gemini stood up on localhost, so ai.js -> aiAgent -> gemini.js -> HTTP
// -> parse -> local resolver all run for real. This is the closest thing to
// "it works with a key" that can be proved without one.
test('a rambling message becomes shop actions, end to end, against a live endpoint', async () => {
  const http = require('node:http');
  const { freePort } = require('./net');

  // Answers the way Gemini would: search first, then propose.
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const sent = JSON.parse(body);
      const looked = JSON.stringify(sent.contents).includes('functionResponse');
      const parts = looked
        ? [{
          functionCall: {
            name: 'propose_actions',
            args: {
              actions: [
                { intent: 'sold', item: 'Sugar', qty: 3, unit: 'kg' },
                { intent: 'restock', item: 'Chamal Basmati', qty: 2, unit: 'sack' }
              ]
            }
          }
        }]
        : [{ functionCall: { name: 'find_items', args: { query: 'chini chamal' } } }];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts } }] }));
    });
  });

  const port = await freePort();
  await new Promise((r) => upstream.listen(port, '127.0.0.1', r));
  const saved = { key: process.env.GEMINI_API_KEY, ep: process.env.GEMINI_ENDPOINT };
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_ENDPOINT = `http://127.0.0.1:${port}/v1beta/models`;

  try {
    // Required after the env is set so provider() sees the key.
    const ai = require('../server/ai');
    assert.equal(ai.provider(), 'gemini', 'a Gemini key alone must switch the provider on');

    const store = shop();
    const { commands } = await ai.draftCommands({
      text: 'aaja bihana chini teen kilo bikri bhayo ani dui bora chamal aayo',
      store
    });
    assert.equal(commands.length, 2, JSON.stringify(commands));

    // And the model's names still land on real shelf lines through the local
    // resolver, which is the only thing allowed to decide that.
    const resolved = commandsFromFields(commands, store);
    assert.deepEqual(
      resolved.map((c) => [c.intent, c.itemName, c.qty]),
      [['sold', 'Sugar', 3], ['restock', 'Chamal Basmati', 2]]
    );
  } finally {
    await new Promise((r) => upstream.close(r));
    if (saved.key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.key;
    if (saved.ep === undefined) delete process.env.GEMINI_ENDPOINT; else process.env.GEMINI_ENDPOINT = saved.ep;
  }
});

test('the search tool answers the way the shop would', async () => {
  const store = shop();
  // Nepali in, the shop's English line out — the same bridge the spoken path uses.
  assert.equal(findItems(store, 'चिनी')[0].name, 'Sugar');
  assert.equal(findItems(store, 'chini')[0].name, 'Sugar');
  assert.deepEqual(findItems(store, 'nothing like this'), []);
  // Ambiguity is not hidden from the model — it gets both and can ask.
  assert.equal(findItems(store, 'dal').length, 2);

  const low = lowStock(store);
  assert.equal(low[0].name, 'Lifebuoy Sabun', 'the emptiest shelf comes first');
});
