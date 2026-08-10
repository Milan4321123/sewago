#!/usr/bin/env node
// Is the AI assistant actually wired up?
//
// "It didn't work" has several very different causes — no key, key in the wrong
// file, a model name your key cannot reach, a server started before the key was
// added — and from the app they all look identical: the feature is just quiet.
// This says which one it is, in one command:
//
//   npm run ai:check
//
// Makes two real calls, so a pass here means a shopkeeper's phone will work too.
require('dotenv').config({ quiet: true });

const ai = require('../server/ai');
const gemini = require('../server/gemini');
const { runCommandAgent } = require('../server/aiAgent');
const { parseCommands, commandsFromFields } = require('../server/voiceCommand');

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const info = (s) => `  ${s}`;
const mask = (v) => (v ? `${v.slice(0, 6)}…${v.slice(-4)} (${v.length} chars)` : '(empty)');

// A stand-in shop, so the check never touches real data.
const STORE = {
  id: 'check',
  items: [
    { id: 'i1', name: 'Sugar', unit: 'kg', price: 120, stock: 40, salesDaily: {} },
    { id: 'i2', name: 'Chamal Basmati', unit: 'kg', price: 180, stock: 100, salesDaily: {} },
    { id: 'i3', name: 'Lifebuoy Sabun', unit: 'each', price: 45, stock: 3, salesDaily: {} }
  ]
};

const SENTENCE = 'aaja bihana dherai grahak aaye, chini ta sakinai lagyo, sabun pani thorai matra bachyo';

// Which models this key is actually entitled to. Model availability changes
// under you — pinned versions get closed to new users — so the fix for a 404 is
// to ask rather than to guess.
async function listModels() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  const base = process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/models';
  const res = await fetch(`${base}?key=${encodeURIComponent(key)}&pageSize=200`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    // Image, speech, music and robotics variants cannot answer a shopkeeper.
    .filter((n) => !/(image|tts|lyria|robotics|computer-use|embedding)/i.test(n));
}

// The free tier's per-minute allowance is small. Worth saying plainly, because
// it is the one failure that is not a misconfiguration — and the app is built
// so it does not matter: the local grammar answers, the model is only ever a
// second opinion.
function explain(message) {
  if (/RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(message)) {
    console.log(info('That is the free tier\'s per-minute quota, not a broken setup.'));
    console.log(info('Wait a minute and run this again. In the app it is harmless:'));
    console.log(info('the local Nepali grammar still answers, and the model is skipped.'));
    return true;
  }
  return false;
}

async function main() {
  console.log('\nSewaGo — AI assistant check\n');

  // 1. What the process can see.
  const gKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  const aKey = process.env.ANTHROPIC_API_KEY || '';
  console.log(info(`GEMINI_API_KEY    ${gKey ? mask(gKey) : '(not set)'}`));
  console.log(info(`ANTHROPIC_API_KEY ${aKey ? mask(aKey) : '(not set)'}`));
  console.log(info(`GEMINI_MODEL      ${gemini.model()}`));
  console.log(info(`AI_PROVIDER       ${process.env.AI_PROVIDER || '(auto)'}`));

  const which = ai.provider();
  if (!which) {
    console.log(`\n${bad('No provider configured — the assistant is off.')}`);
    console.log(info('Put your key in .env (NOT .env.example, which is only a template):'));
    console.log(info('  echo \'GEMINI_API_KEY=AIza...\' >> .env'));
    console.log(info('Get a free key at https://aistudio.google.com/apikey'));
    console.log(info('Then RESTART the server — .env is read once at startup.\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`\n${ok(`Provider: ${which}`)}`);

  // 2. Can we reach it at all?
  if (which === 'gemini') {
    try {
      const reply = await gemini.chat({
        history: [gemini.userTurn('Reply with the single word: OK')],
        // Not 16: current models spend part of the budget thinking before they
        // emit anything, and a tight cap comes back blank — which reads like a
        // failure when the call actually succeeded.
        maxTokens: 256
      });
      const said = reply.text ? JSON.stringify(reply.text.slice(0, 40)) : '(no text, but the call succeeded)';
      console.log(ok(`Reached Gemini (${gemini.model()}) — replied ${said}`));
    } catch (err) {
      console.log(bad(`Could not reach Gemini: ${err.message}`));
      if (explain(err.message)) { /* said above */ } else if (/API_KEY_INVALID|API key not valid/i.test(err.message)) {
        console.log(info('The key itself was rejected. Re-copy it from https://aistudio.google.com/apikey'));
      } else if (/is not found|NOT_FOUND|no longer available/i.test(err.message)) {
        // Guessing a replacement wastes everyone's time — ask the key itself.
        console.log(info(`Your key cannot reach "${gemini.model()}". Asking Google what it can reach…`));
        const usable = await listModels().catch(() => []);
        if (usable.length) {
          console.log(info('Models available to this key (text-capable):'));
          for (const m of usable.slice(0, 12)) console.log(info(`  ${m}`));
          console.log(info(''));
          console.log(info('Unset GEMINI_MODEL in .env to use the default alias (gemini-flash-latest),'));
          console.log(info(`or pin one, e.g.  GEMINI_MODEL=${usable[0]}`));
        }
      } else if (/SERVICE_DISABLED|has not been used/i.test(err.message)) {
        console.log(info('Enable the Generative Language API for this key\'s Google project.'));
      }
      console.log('');
      process.exitCode = 1;
      return;
    }
  }

  // 3. The part that actually matters: tools, and a grounded answer.
  console.log(`\n  Asking it to read a rambling sentence:\n    "${SENTENCE}"`);
  const localOnly = parseCommands(SENTENCE, STORE).commands;
  console.log(info(`Local grammar alone: ${localOnly.length ? JSON.stringify(localOnly.map((c) => c.intent)) : 'nothing'} — this is why the model is asked`));

  try {
    const { actions, trace, rounds } = await runCommandAgent({
      text: SENTENCE,
      store: STORE,
      adapter: which === 'gemini' ? gemini : require('../server/anthropicAdapter')
    });
    for (const step of trace) {
      console.log(info(`  tool ${step.tool}(${JSON.stringify(step.args)}) → ${step.hits} hit(s)`));
    }
    if (!trace.length) {
      console.log(bad('The model proposed without searching the shelves first — grounding is not happening.'));
    } else {
      console.log(ok(`It searched the shelves (${rounds} round(s))`));
    }
    if (!actions.length) {
      console.log(bad('It proposed no actions. The assistant is reachable but not useful on this sentence.'));
      process.exitCode = 1;
      return;
    }
    console.log(ok(`Proposed: ${JSON.stringify(actions)}`));

    // And the safety boundary those proposals still have to pass.
    const resolved = commandsFromFields(actions, STORE);
    for (const c of resolved) {
      if (c.kind === 'shop' || c.intent === 'low') {
        console.log(info(`  ${c.intent} (about the shop itself)`));
        continue;
      }
      const where = c.itemName ? `→ ${c.itemName}`
        : c.needsPick ? `→ asks between ${c.needsPick.map((p) => p.name).join(' / ')}`
          : `→ ${c.error === 'not_found' ? 'not stocked — would be offered as a new item' : 'new item'}`;
      console.log(info(`  ${c.intent} "${c.spoken}" ${where}`));
    }
    console.log(`\n${ok('Working. The shop can be talked to.')}\n`);
  } catch (err) {
    console.log(bad(`The tool loop failed: ${err.message}`));
    explain(err.message);
    console.log('');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(bad(err.stack || err.message));
  process.exitCode = 1;
});
