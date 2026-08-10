// Turn one spoken sentence into actions on a real shop.
//
// The item-entry parser next door (./voiceParse) answers "what item is this?".
// This answers the harder question a shopkeeper actually has: "what did they
// just tell me to DO?" — sell, restock, reprice, recount, open, close, or
// simply answer a question about the shelf.
//
// Three things make this worth writing by hand instead of sending every
// sentence to a model:
//
//  1. It works with no API key, which is the shop's normal state. A kirana
//     owner mid-transaction cannot wait on a network round trip, and a shop in
//     a load-shedding neighbourhood cannot depend on one.
//  2. It is deterministic. "चिनी दुई किलो बिक्री भयो" must mean the same thing
//     every single time, because it moves stock.
//  3. It resolves against THIS shop's real inventory, so it can refuse to guess
//     between two similar items instead of silently picking one.
//
// A model still helps with sentences this cannot crack — that lives in ./ai and
// produces commands in exactly this shape, so everything downstream is shared.

const {
  tokenize, wordsToNumber, nearestKeyword, nearKeyword, UNIT_WORDS, PRICE_WORDS
} = require('./voiceParse');

// How sure we must be before an action is allowed to touch stock, and how much
// daylight the best match needs over the runner-up. A shopkeeper saying "दाल"
// in a shop stocking both "मुसुरो दाल" and "मास दाल" must be ASKED, never
// guessed at — a wrong guess here silently corrupts the count of two items.
const MATCH_FLOOR = 0.45;
const AMBIGUOUS_GAP = 0.12;

/* ---------------- what a shopkeeper actually says ---------------- */

// Intent verbs, in Devanagari, romanised Nepali and English — a shopkeeper
// switches between all three mid-sentence and does not notice doing it.
const INTENT_WORDS = {
  sold: [
    'बिक्री', 'बिक्यो', 'बेचें', 'बेचे', 'बेच्यो', 'बेचियो', 'गयो', 'गए', 'दिएँ', 'दिए',
    'bikri', 'bikyo', 'bech', 'bechen', 'becheko', 'gayo', 'gaye', 'sold', 'sell', 'sale', 'out'
  ],
  restock: [
    'आयो', 'आए', 'आएको', 'ल्याएँ', 'ल्याए', 'थपियो', 'थप', 'थपें', 'भित्रियो', 'लोड',
    'aayo', 'aaye', 'aayeko', 'lyaye', 'thap', 'thapiyo', 'thapen',
    'restock', 'came', 'arrived', 'received', 'stocked', 'delivery'
  ],
  price: [
    'मूल्य', 'दाम', 'रेट', 'भाउ', 'mulya', 'daam', 'dam', 'rate', 'bhau', 'price', 'cost'
  ],
  count: [
    'गन्ती', 'गनें', 'बाँकी', 'baaki', 'baki', 'ganti', 'count', 'counted', 'stocktake', 'remaining'
  ],
  ask: ['कति', 'kati', 'howmany', 'howmuch'],
  low: [
    'सकिँदै', 'सकिन', 'सकियो', 'सिद्धिँदै', 'खाली', 'कम', 'नसकिँदै',
    'sakindai', 'sakiyo', 'khali', 'kam', 'low', 'finishing', 'empty', 'reorder'
  ],
  open: ['खोल', 'खोल्नु', 'खुल्ला', 'khol', 'khola', 'open'],
  close: ['बन्द', 'बन्द्', 'band', 'close', 'closed', 'shut'],
  add: ['नयाँ', 'नया', 'naya', 'new', 'add', 'राख', 'rakha', 'rakh']
};

// Built once: word -> intent.
const INTENT_BY_WORD = new Map();
for (const [intent, words] of Object.entries(INTENT_WORDS)) {
  for (const w of words) INTENT_BY_WORD.set(w, intent);
}

// Sentence glue. Splitting on these is what lets one breath carry two jobs:
// "चिनी दुई किलो बिक्री भयो र चामल दश किलो आयो".
const SPLIT_WORDS = new Set(['र', 'ra', 'and', 'अनि', 'ani', 'plus', 'तथा']);

// Words that carry no meaning for us but survive tokenisation. 'भयो'/'bhayo'
// ("became") is the single most common one — it turns any verb into past tense.
const FILLER = new Set([
  'भयो', 'भए', 'भो', 'bhayo', 'bhaye', 'bho', 'हो', 'ho', 'छ', 'chha', 'cha', 'छन्',
  'गर', 'गर्नु', 'गरिदेऊ', 'gar', 'garnu', 'garidew', 'देऊ', 'dew', 'दे',
  'को', 'का', 'की', 'ko', 'ka', 'ki', 'लाई', 'lai', 'मा', 'ma',
  'please', 'the', 'a', 'is', 'are', 'me', 'my', 'to', 'of', 'now', 'today'
]);

/* ---------------- Nepali <-> English goods lexicon ---------------- */

// A shop lists "Sugar" and the owner says "चिनी". Without this the command
// layer would be useless in exactly the shops it is built for: the shopkeeper
// speaks Nepali, but half the inventory was typed in English (often by a
// helper, or lifted off the packet).
//
// Only everyday kirana goods — this is a bridge for speech, not a dictionary.
const SYNONYMS = [
  ['sugar', 'चिनी', 'chini', 'cheeni'],
  ['rice', 'चामल', 'chamal', 'chaamal', 'bhat'],
  ['lentil', 'dal', 'दाल', 'daal', 'pulse'],
  ['oil', 'तेल', 'tel', 'cookingoil'],
  ['milk', 'दूध', 'दुध', 'dudh', 'doodh'],
  ['salt', 'नुन', 'nun', 'noon'],
  ['flour', 'पिठो', 'pitho', 'maida', 'मैदा', 'atta', 'आटा'],
  ['egg', 'अण्डा', 'anda', 'andaa', 'eggs'],
  ['tea', 'चिया', 'chiya', 'chia', 'chiyapatti'],
  ['coffee', 'कफी', 'kaphi', 'kafi'],
  ['soap', 'साबुन', 'sabun', 'saabun'],
  ['biscuit', 'बिस्कुट', 'biskut', 'biscuits'],
  ['noodles', 'चाउचाउ', 'चाउ', 'chaudchau', 'chauchau', 'noodle', 'waiwai'],
  ['water', 'पानी', 'pani', 'paani'],
  ['potato', 'आलु', 'alu', 'aalu'],
  ['onion', 'प्याज', 'pyaj', 'pyaaj'],
  ['tomato', 'गोलभेडा', 'golbheda', 'golbheda'],
  ['garlic', 'लसुन', 'lasun'],
  ['ginger', 'अदुवा', 'aduwa'],
  ['chilli', 'खुर्सानी', 'khursani', 'chili', 'chilly'],
  ['turmeric', 'बेसार', 'besar', 'haldi', 'हल्दी'],
  ['ghee', 'घिउ', 'ghiu', 'ghee'],
  ['curd', 'दही', 'dahi', 'yoghurt', 'yogurt'],
  ['bread', 'पाउरोटी', 'pauroti', 'paauroti'],
  ['matchbox', 'सलाई', 'salai', 'match'],
  ['candle', 'मैनबत्ती', 'mainbatti'],
  ['detergent', 'सर्फ', 'surf', 'washingpowder'],
  ['toothpaste', 'दन्तमन्जन', 'colgate', 'manjan'],
  ['cigarette', 'चुरोट', 'churot', 'cigarettes'],
  ['beaten_rice', 'चिउरा', 'chiura', 'cheura'],
  ['gram', 'चना', 'chana'],
  ['soyabean', 'भटमास', 'bhatmas'],
  ['mustard_oil', 'तोरीको', 'tori', 'mustard']
];

const SYNONYM_GROUP = new Map();
for (const group of SYNONYMS) {
  for (const word of group) SYNONYM_GROUP.set(word, group[0]);
}

/* ---------------- text helpers ---------------- */

// Verbs are recognised in whichever script they arrive in — the list above
// spells most of them twice, but a speaker who says a Devanagari word we only
// listed romanised should still be understood.
// Every closed vocabulary gets the same treatment: try the word as spoken, then
// transliterated, then one keystroke off. The length floors below are the whole
// safety story — they decide how short a word has to be before we stop guessing
// at it, because a wrong guess drops a real word out of an item's name.
const INTENT_VOCAB = Object.fromEntries(INTENT_BY_WORD);

// 5, not 4: at four characters "rate" is one edit from "rato" (as in रातो चामल)
// and "thap" one from "chap". Short verbs must be said exactly.
function intentOf(token) {
  if (!token) return null;
  const t = transliterate(token);
  return INTENT_BY_WORD.get(token)
    || INTENT_BY_WORD.get(t)
    || nearestKeyword(t, INTENT_VOCAB, { minLen: 5 })
    || null;
}

function isFiller(token) {
  if (!token) return false;
  const t = transliterate(token);
  return FILLER.has(token) || FILLER.has(t) || nearKeyword(t, FILLER, { minLen: 5 });
}

function isPriceWord(token) {
  if (!token) return false;
  const t = transliterate(token);
  return PRICE_WORDS.has(token) || PRICE_WORDS.has(t) || nearKeyword(t, PRICE_WORDS, { minLen: 5 });
}

// A word sitting immediately after a number is almost certainly a unit, and
// that position is strong enough evidence to guess at three-letter words too —
// which is what rescues "20 ots" from becoming part of the item's name.
function unitAfterNumber(token) {
  if (!token) return null;
  const t = transliterate(token);
  return UNIT_WORDS[token] || UNIT_WORDS[t] || nearestKeyword(t, UNIT_WORDS, { minLen: 3 });
}

// Anywhere else there is no positional evidence, so the bar is higher.
function unitWord(token) {
  if (!token) return null;
  const t = transliterate(token);
  return UNIT_WORDS[token] || UNIT_WORDS[t] || nearestKeyword(t, UNIT_WORDS, { minLen: 5 });
}

// Tokens that carry meaning for matching an item name: no numbers, no units,
// no filler, no intent verbs.
function meaningTokens(tokens) {
  return tokens.filter((t) => (
    !isFiller(t)
    && !unitWord(t)
    && !isPriceWord(t)
    && !intentOf(t)
    && !/^\d+(\.\d+)?$/.test(t)
  ));
}

/* ---------------- Devanagari -> Latin ---------------- */

// Nepali shops stock a wall of Latin-script brands — Wai Wai, Colgate, Surf,
// Coca Cola — typed into the inventory exactly as they appear on the packet.
// The owner then says them out loud and the phone hears Devanagari: "वाइ वाइ".
// The synonym list below can bridge everyday goods, but it can never keep up
// with brands, so both sides get transliterated into one alphabet first and the
// lexicon is consulted afterwards. That also means the lexicon only has to
// carry each word once, in whichever script.
const DEVA_CONSONANT = {
  क: 'k', ख: 'kh', ग: 'g', घ: 'gh', ङ: 'ng',
  च: 'ch', छ: 'chh', ज: 'j', झ: 'jh', ञ: 'ny',
  ट: 't', ठ: 'th', ड: 'd', ढ: 'dh', ण: 'n',
  त: 't', थ: 'th', द: 'd', ध: 'dh', न: 'n',
  प: 'p', फ: 'ph', ब: 'b', भ: 'bh', म: 'm',
  य: 'y', र: 'r', ल: 'l', व: 'w', श: 's', ष: 's', स: 's', ह: 'h',
  क्ष: 'ksh', त्र: 'tr', ज्ञ: 'gy', ड़: 'd', ढ़: 'dh'
};
const DEVA_VOWEL = {
  अ: 'a', आ: 'aa', इ: 'i', ई: 'i', उ: 'u', ऊ: 'u',
  ऋ: 'ri', ए: 'e', ऐ: 'ai', ओ: 'o', औ: 'au'
};
const DEVA_MATRA = {
  'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u',
  'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au'
};
const VIRAMA = '्';
const NASALS = new Set(['ं', 'ँ', 'ः']);

function transliterate(word) {
  if (!/[ऀ-ॿ]/.test(word)) return word;
  const chars = [...word];
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (DEVA_CONSONANT[c]) {
      out += DEVA_CONSONANT[c];
      const next = chars[i + 1];
      if (next === VIRAMA) { i += 1; continue; } // conjunct — no vowel between
      if (next && DEVA_MATRA[next]) { out += DEVA_MATRA[next]; i += 1; continue; }
      // Nepali drops the inherent 'a' at the end of a word: दाल is "dal", not
      // "dala". Keeping it would break every match against a romanised name.
      if (i < chars.length - 1) out += 'a';
      continue;
    }
    if (DEVA_VOWEL[c]) { out += DEVA_VOWEL[c]; continue; }
    if (DEVA_MATRA[c]) { out += DEVA_MATRA[c]; continue; }
    if (NASALS.has(c)) { out += 'n'; continue; }
    if (c === VIRAMA) continue;
    out += c;
  }
  return out;
}

// Nepali glues its postpositions onto the noun: the shopkeeper says "चिनीको
// मूल्य" (sugar's price), and the item is called "चिनी". Stripping happens on
// both the spoken words and the shop's own item names, so even a wrong strip
// lands identically on both sides and still matches.
const SUFFIXES = ['harule', 'haru', 'sanga', 'bata', 'lai', 'ko', 'ka', 'ki', 'le', 'ma'];

function stripSuffix(roman) {
  for (const s of SUFFIXES) {
    if (roman.length > s.length + 2 && roman.endsWith(s)) return roman.slice(0, -s.length);
  }
  return roman;
}

// Map a token to one comparable form, so "चिनी", "chini" and "Sugar" all meet.
function canonical(token) {
  const roman = transliterate(token);
  if (SYNONYM_GROUP.has(roman)) return SYNONYM_GROUP.get(roman);
  const stripped = stripSuffix(roman);
  if (SYNONYM_GROUP.has(stripped)) return SYNONYM_GROUP.get(stripped);
  return stripped;
}

function canonicalSet(tokens) {
  return new Set(meaningTokens(tokens).map(canonical));
}

// Cheap edit distance, capped — spoken item names are short, and this only ever
// breaks ties between candidates that already share tokens.
function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = new Array(cols);
  let cur = new Array(cols);
  for (let j = 0; j < cols; j += 1) prev[j] = j;
  for (let i = 1; i < rows; i += 1) {
    cur[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const swap = prev; prev = cur; cur = swap;
  }
  const dist = prev[cols - 1];
  return 1 - dist / Math.max(a.length, b.length);
}

// How well a spoken phrase names a given item. Token overlap dominates, because
// "चिनी" naming "चिनी सेतो" is a good match while "चिनी" vs "चिया" is not — and
// edit distance alone cannot tell those apart.
function scoreItem(queryTokens, item) {
  const itemTokens = tokenize(item.name);
  const q = canonicalSet(queryTokens);
  const it = canonicalSet(itemTokens);
  if (!q.size || !it.size) return 0;

  let shared = 0;
  for (const token of q) if (it.has(token)) shared += 1;
  if (shared) {
    // Every spoken word landing in the name is a strong signal; extra words in
    // the shop's own name (brand, size) should not be punished much.
    // Coverage carries most of the weight: how much of what they SAID this item
    // accounts for. Precision (how much of the item's own name was hit) has to
    // stay minor, or a long rambling sentence sharing one word with a one-word
    // item name scores like a real match — "aaja bihana dherai grahak aaye,
    // chini ta sakinai lagyo…" resolving confidently to "Sugar" on the strength
    // of a single token, with nothing left over to suggest anything was missed.
    const coverage = shared / q.size;
    const precision = shared / it.size;
    return Math.min(1, 0.65 * coverage + 0.35 * precision + (coverage === 1 ? 0.15 : 0));
  }

  const qs = [...q].join(' ');
  const is = [...it].join(' ');
  if (is.includes(qs) || qs.includes(is)) return 0.72;
  return similarity(qs, is) * 0.8; // never let a pure typo-match outrank a real word match
}

/**
 * Find the item a spoken phrase means, within one shop.
 * Returns { item } when confident, { choices } when two items are too close to
 * call, or {} when nothing is close enough.
 */
function resolveItem(queryTokens, items, { confidentAt = 0 } = {}) {
  const live = items.filter((i) => !i.archived);
  if (!live.length) return {};
  const scored = live
    .map((item) => ({ item, score: scoreItem(queryTokens, item) }))
    .filter((s) => s.score >= MATCH_FLOOR)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return {};
  const near = (gap) => scored.filter((s) => scored[0].score - s.score < gap).slice(0, 4).map((s) => s.item);
  if (scored.length > 1 && scored[0].score - scored[1].score < AMBIGUOUS_GAP) {
    // Two plausible items. Asking costs one tap; guessing costs a wrong count
    // on two items and a shopkeeper who stops trusting the feature.
    return { choices: near(AMBIGUOUS_GAP) };
  }
  // Naming something to sell or restock is naming something you already stock,
  // so the best match wins. Announcing a NEW item is the opposite claim, and a
  // loose match there is dangerous in a way it is not elsewhere: a shop holding
  // "Lifebuoy Sabun" that hears "naya lux sabun" would top up the wrong soap
  // and never create the new one. So an explicit "new" has to be nearly exact,
  // and anything short of that becomes a question.
  if (scored[0].score < confidentAt) return { choices: near(0.25), unsure: true };
  return { item: scored[0].item };
}

/* ---------------- one clause -> one command ---------------- */

// Pull the numbers out of a clause: how many, in what unit, and at what price.
// The unit-attached number is the quantity ("दुई किलो"), a number sitting next
// to a price word is the price ("सय रुपैयाँ"), and a lone number is a quantity
// unless we already have one.
function extractNumbers(tokens) {
  const used = new Array(tokens.length).fill(false);
  let qty = null;
  let unit = null;
  let price = null;

  const numberAt = (i) => {
    if (used[i]) return null;
    if (/^\d+(\.\d+)?$/.test(tokens[i])) return { value: parseFloat(tokens[i]), length: 1 };
    for (let len = Math.min(3, tokens.length - i); len >= 1; len -= 1) {
      // "छ" is both the number six and the verb "is". As the last word of a
      // clause it is always the verb — "चिनी कति छ" is a question, not 6.
      if (len === 1 && (tokens[i] === 'छ' || tokens[i] === 'chha') && i === tokens.length - 1) return null;
      const v = wordsToNumber(tokens.slice(i, i + len));
      if (v !== null && v !== 0) return { value: v, length: len };
    }
    return null;
  };

  for (let i = 0; i < tokens.length && qty === null; i += 1) {
    const n = numberAt(i);
    if (!n) continue;
    const next = unitAfterNumber(tokens[i + n.length]);
    if (next) {
      qty = n.value;
      unit = next;
      for (let k = i; k <= i + n.length; k += 1) used[k] = true;
    }
  }
  for (let i = 0; i < tokens.length && price === null; i += 1) {
    const n = numberAt(i);
    if (!n) continue;
    const after = tokens[i + n.length];
    const before = i > 0 ? tokens[i - 1] : null;
    if (isPriceWord(after) || isPriceWord(before)) {
      price = n.value;
      for (let k = i; k < i + n.length; k += 1) used[k] = true;
      if (isPriceWord(after)) used[i + n.length] = true;
      if (isPriceWord(before)) used[i - 1] = true;
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    if (used[i]) continue;
    const n = numberAt(i);
    if (!n) continue;
    if (qty === null) {
      qty = n.value;
    } else if (price === null) {
      price = n.value;
    } else {
      continue;
    }
    for (let k = i; k < i + n.length; k += 1) used[k] = true;
    i += n.length - 1;
  }
  const rest = tokens.filter((t, i) => !used[i]);
  return { qty, unit, price, rest };
}

function detectIntent(tokens) {
  // A question beats a statement: "चिनी कति छ" contains no verb but must never
  // be treated as a stock movement.
  if (tokens.some((t) => intentOf(t) === 'ask')) return 'ask';
  for (const t of tokens) {
    const intent = intentOf(t);
    if (intent && intent !== 'ask') return intent;
  }
  return null;
}

// Split one utterance into clauses on "and"-words.
function splitClauses(tokens) {
  const clauses = [];
  let current = [];
  for (const t of tokens) {
    if (SPLIT_WORDS.has(t) || SPLIT_WORDS.has(transliterate(t))) {
      if (current.length) clauses.push(current);
      current = [];
    } else {
      current.push(t);
    }
  }
  if (current.length) clauses.push(current);
  return clauses;
}

/**
 * Parse a whole utterance into resolved commands against one shop.
 *
 * Every command carries what it will do in plain terms plus the item it
 * resolved to, so the caller can show the shopkeeper exactly what is about to
 * happen and get one confirmation for the batch.
 */
// People pause, and speech recognition turns the pause into a comma. Without
// treating that as a boundary, "chini bikri bhayo, chamal aayo" is one long
// clause and only the first verb is ever seen.
const SEGMENT_SPLIT = /[,;।|\n]+/;

function parseCommands(text, store) {
  const items = (store && store.items) || [];
  const allTokens = tokenize(text);
  if (!allTokens.length) return { commands: [] };

  // Shop-wide commands are about the shop, not an item, so they are read from
  // the whole sentence before it is chopped into clauses.
  const wholeIntent = detectIntent(allTokens);
  if ((wholeIntent === 'open' || wholeIntent === 'close') && !meaningTokens(allTokens).length) {
    return { commands: [{ intent: wholeIntent, kind: 'shop' }] };
  }
  if (wholeIntent === 'low') {
    return { commands: [{ intent: 'low', kind: 'query' }] };
  }

  const commands = [];
  const clauses = String(text)
    .split(SEGMENT_SPLIT)
    .flatMap((segment) => splitClauses(tokenize(segment)));
  for (const clause of clauses) {
    const intent = detectIntent(clause);
    const { qty, unit, price, rest } = extractNumbers(clause);
    const nameTokens = meaningTokens(rest);

    if (intent === 'open' || intent === 'close') {
      commands.push({ intent, kind: 'shop' });
      continue;
    }
    if (intent === 'low') {
      commands.push({ intent: 'low', kind: 'query' });
      continue;
    }
    if (!nameTokens.length) continue; // nothing nameable in this clause

    // No verb at all: "चिनी कति" is a question, and a bare item with a count is
    // a stock-take ("चिनी पन्ध्र") — the two most common things said with no verb.
    const effective = intent || (qty !== null ? 'count' : 'ask');
    commands.push(resolveClause({ intent: effective, nameTokens, qty, unit, price }, items));
  }
  return { commands };
}

// Turn one understood clause into a resolved command. Shared by the spoken
// grammar above and the model-assisted path below, so a sentence that needed
// help arrives downstream in exactly the same shape as one that did not — and
// gets the same refusal to guess between two similar items.
const ADD_CONFIDENT_AT = 0.9;

function resolveClause({ intent, nameTokens, qty = null, unit = null, price = null }, items) {
  const spoken = nameTokens.join(' ');
  const resolved = resolveItem(nameTokens, items, {
    confidentAt: intent === 'add' ? ADD_CONFIDENT_AT : 0
  });
  const base = {
    intent,
    kind: intent === 'ask' ? 'query' : 'stock',
    spoken,
    qty,
    unit,
    price
  };
  if (resolved.item) {
    return { ...base, itemId: resolved.item.id, itemName: resolved.item.name, unitOf: resolved.item.unit };
  }
  if (resolved.choices) {
    return {
      ...base,
      // `canBeNew` lets the question offer "no, it is a new item" alongside the
      // shelves it might have meant.
      canBeNew: !!resolved.unsure && price !== null,
      needsPick: resolved.choices.map((i) => ({ id: i.id, name: i.name, unit: i.unit, stock: i.stock, price: i.price }))
    };
  }
  if (intent === 'add' || (price !== null && qty !== null)) {
    // Not on the shelves and priced — the shopkeeper is listing something new.
    return { ...base, intent: 'add', kind: 'new' };
  }
  return { ...base, error: 'not_found' };
}

/**
 * Build resolved commands from fields a model produced.
 *
 * The model only has to name the item and the intent; every check that protects
 * the shelf — does this item exist here, is it ambiguous, is the number sane —
 * still happens locally against the shop's own record.
 */
function commandsFromFields(rows, store) {
  const items = (store && store.items) || [];
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const intent = String((row && row.intent) || '');
    if (intent === 'open' || intent === 'close') { out.push({ intent, kind: 'shop' }); continue; }
    if (intent === 'low') { out.push({ intent: 'low', kind: 'query' }); continue; }
    const name = String((row && row.item) || '').trim();
    if (!name || !intent) continue;
    const qty = Number(row.qty);
    const price = Number(row.price);
    out.push(resolveClause({
      intent,
      nameTokens: tokenize(name),
      qty: Number.isFinite(qty) && qty > 0 ? qty : null,
      unit: row.unit || null,
      price: Number.isFinite(price) && price > 0 ? price : null
    }, items));
  }
  return out;
}

module.exports = {
  parseCommands,
  commandsFromFields,
  resolveItem,
  scoreItem,
  MATCH_FLOOR
};
