// Turn a spoken phrase into inventory fields.
//
// A shopkeeper in Nepal does not speak clean English or clean Nepali — they say
// "Wai Wai पाँच packet बीस रुपैयाँ". So this parser normalises Devanagari digits,
// Nepali number words and both vocabularies of unit names, then pulls out
// quantity, unit and price and treats whatever is left as the item name.
//
// It is deliberately a heuristic, not an AI call: it runs offline, costs
// nothing, and returns a `needsReview` list so the UI can highlight exactly
// which fields it was unsure about. A mis-hear must cost one tap to correct,
// never a wrong stock number saved silently.

const NEPALI_DIGITS = '०१२३४५६७८९';

// Number words, Nepali (Devanagari + common romanisation) and English.
const NUMBER_WORDS = {
  एक: 1, ek: 1, one: 1,
  दुई: 2, dui: 2, duai: 2, two: 2,
  तीन: 3, teen: 3, tin: 3, three: 3,
  चार: 4, char: 4, four: 4,
  पाँच: 5, पांच: 5, panch: 5, paanch: 5, five: 5,
  छ: 6, chha: 6, cha: 6, six: 6,
  सात: 7, saat: 7, sat: 7, seven: 7,
  आठ: 8, aath: 8, ath: 8, eight: 8,
  नौ: 9, nau: 9, nine: 9,
  दश: 10, दस: 10, das: 10, dus: 10, ten: 10,
  बाह्र: 12, baahra: 12, barha: 12, twelve: 12,
  पन्ध्र: 15, pandhra: 15, fifteen: 15,
  बीस: 20, बिस: 20, bis: 20, bees: 20, twenty: 20,
  पच्चीस: 25, twentyfive: 25,
  तीस: 30, tis: 30, thirty: 30,
  चालीस: 40, chalis: 40, forty: 40,
  पचास: 50, pachas: 50, fifty: 50,
  साठी: 60, sathi: 60, sixty: 60,
  सत्तरी: 70, sattari: 70, seventy: 70,
  असी: 80, asi: 80, eighty: 80,
  नब्बे: 90, nabbe: 90, ninety: 90,
  सय: 100, saya: 100, say: 100, hundred: 100,
  हजार: 1000, hajar: 1000, hazar: 1000, thousand: 1000
};

// Unit vocabulary -> canonical unit key used by the inventory.
//
// Spelled out generously on purpose. Speech recognition returns whatever it
// thinks it heard, and a shopkeeper counting stock says "ota", "wata", "gota"
// and "pcs" interchangeably in the same minute. Anything still missed is caught
// by the near-miss matcher below rather than landing in the item name.
const UNIT_WORDS = {
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  किलो: 'kg', केजी: 'kg', kej: 'kg', keji: 'kg',
  g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g', ग्राम: 'g',
  l: 'l', ltr: 'l', litre: 'l', liter: 'l', litres: 'l', liters: 'l', लिटर: 'l',
  ml: 'ml', मिलि: 'ml', मिली: 'ml',
  packet: 'packet', packets: 'packet', pkt: 'packet', pkts: 'packet', paket: 'packet',
  pack: 'packet', packs: 'packet', प्याकेट: 'packet', पोका: 'packet',
  piece: 'each', pieces: 'each', pcs: 'each', pc: 'each', pes: 'each',
  goto: 'each', gota: 'each', गोटा: 'each',
  ota: 'each', otas: 'each', ओटा: 'each', wata: 'each', watta: 'each', वटा: 'each',
  dozen: 'dozen', dozens: 'dozen', darjan: 'dozen', दर्जन: 'dozen',
  bottle: 'bottle', bottles: 'bottle', botal: 'bottle', बोतल: 'bottle',
  bora: 'sack', boras: 'sack', बोरा: 'sack', sack: 'sack', sacks: 'sack'
};

// Words that mark the number next to them as a PRICE rather than a quantity.
const PRICE_WORDS = new Set([
  'rupees', 'rupee', 'rs', 'rupaiya', 'rupaiyan',
  'रुपैयाँ', 'रुपैया', 'रुपियाँ', 'रुपया', 'रु', 'मूल्य', 'price', 'each', 'per'
]);

// Noise words that should never end up in the item name.
// "naya sabun" is a shopkeeper announcing a new item, not an item called
// "Naya Sabun".
const STOP_WORDS = new Set([
  'ko', 'ka', 'ki', 'को', 'का', 'की', 'छ', 'हो', 'and', 'at', 'for', 'the', 'a',
  'naya', 'nayaa', 'नयाँ', 'नया', 'new'
]);

/* ---------------- near-miss keyword matching ----------------
   Units, verbs and filler are small CLOSED sets, so a token one keystroke away
   from one of them is almost certainly that word: "ots" is "ota", "nayan" is
   "naya", "rupess" is "rupees". Item names are open-ended and never get this
   benefit — guessing there would rename someone's stock.

   Without it, every unrecognised word fell through into the item name, so a
   single mis-heard unit turned "naya sabun 20 ots" into an item called
   "sabun ots". One bad syllable should cost nothing. */

// Levenshtein that gives up as soon as it exceeds `max` — these are 3-8
// character words compared against a few dozen keys per token.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Closest entry in a vocabulary, or null when nothing is close enough.
 * `vocab` maps word -> meaning; a tie between two DIFFERENT meanings is
 * refused, because picking one at random is how a parser quietly does the
 * wrong thing.
 */
function nearestKeyword(token, vocab, { minLen = 4 } = {}) {
  if (!token || token.length < minLen) return null;
  if (vocab[token] !== undefined) return vocab[token];
  const max = token.length >= 6 ? 2 : 1;
  let bestDist = max + 1;
  let bestValue = null;
  let tied = false;
  for (const word of Object.keys(vocab)) {
    if (word.length < 3) continue; // "g", "l", "pc" are too short to guess at
    const d = editDistance(token, word, max);
    if (d > max) continue;
    if (d < bestDist) {
      bestDist = d;
      bestValue = vocab[word];
      tied = false;
    } else if (d === bestDist && vocab[word] !== bestValue) {
      tied = true;
    }
  }
  return tied ? null : bestValue;
}

// Set-flavoured version for vocabularies that are just membership tests.
function nearKeyword(token, set, { minLen = 4 } = {}) {
  if (!token || token.length < minLen) return false;
  if (set.has(token)) return true;
  const max = token.length >= 6 ? 2 : 1;
  for (const word of set) {
    if (word.length < 3) continue;
    if (editDistance(token, word, max) <= max) return true;
  }
  return false;
}

function devanagariToAscii(text) {
  let out = '';
  for (const ch of text) {
    const idx = NEPALI_DIGITS.indexOf(ch);
    out += idx >= 0 ? String(idx) : ch;
  }
  return out;
}

// "paanch saya" -> 500, "dui" -> 2. Handles the sy/hazar multiplier pattern
// Nepali speakers use ("तीन सय" = three hundred).
function wordsToNumber(tokens) {
  if (!tokens.length) return null;
  let total = 0;
  let current = 0;
  for (const t of tokens) {
    const v = NUMBER_WORDS[t];
    // Every token must be a number word. Accepting a partial run would let
    // "दुई किलो चिनी" swallow the unit and the item name into the quantity.
    if (v === undefined) return null;
    if (v === 100 || v === 1000) {
      current = (current || 1) * v;
      total += current;
      current = 0;
    } else {
      current += v;
    }
  }
  return total + current;
}

function tokenize(text) {
  return devanagariToAscii(String(text || ''))
    .toLowerCase()
    .replace(/[,.!?;:]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// The same tolerance the command layer uses, so the two spoken paths agree on
// what counts as a unit or a price word. No transliteration here — this parser
// already carries both scripts in its vocabulary.
function unitAfterNumber(token) {
  if (!token) return null;
  return UNIT_WORDS[token] || nearestKeyword(token, UNIT_WORDS, { minLen: 3 });
}

function isPriceWord(token) {
  if (!token) return false;
  return PRICE_WORDS.has(token) || nearKeyword(token, PRICE_WORDS, { minLen: 5 });
}

/**
 * Parse one spoken line into inventory fields.
 * Returns { name, qty, unit, price, needsReview[], raw }.
 * Any field it could not find is left null and named in needsReview, so the UI
 * can focus the shopkeeper on exactly what to fix.
 */
function parseItemSpeech(text) {
  const tokens = tokenize(text);
  const used = new Array(tokens.length).fill(false);
  let qty = null;
  let unit = null;
  let price = null;

  const numberAt = (i) => {
    if (used[i]) return null;
    const t = tokens[i];
    if (/^\d+(\.\d+)?$/.test(t)) return { value: parseFloat(t), length: 1 };
    // Try the longest run of number words starting here (e.g. "tin saya").
    for (let len = Math.min(3, tokens.length - i); len >= 1; len -= 1) {
      const v = wordsToNumber(tokens.slice(i, i + len));
      if (v !== null && v !== 0) return { value: v, length: len };
    }
    return null;
  };

  // Pass 1 — a number directly followed by a unit word is the quantity.
  for (let i = 0; i < tokens.length && qty === null; i += 1) {
    const n = numberAt(i);
    if (!n) continue;
    const next = unitAfterNumber(tokens[i + n.length]);
    if (next) {
      qty = n.value;
      unit = next;
      for (let k = i; k < i + n.length + 1; k += 1) used[k] = true;
    }
  }

  // Pass 2 — a number next to a price word is the price ("100 rupees", "rs 100").
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

  // Pass 3 — fall back to bare numbers. The first is the quantity if we still
  // lack one, the last remaining is the price. Spoken orders put the price last.
  const bare = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (used[i]) continue;
    const n = numberAt(i);
    if (n) {
      bare.push({ index: i, ...n });
      i += n.length - 1;
    }
  }
  if (qty === null && bare.length > 1) {
    const first = bare.shift();
    qty = first.value;
    for (let k = first.index; k < first.index + first.length; k += 1) used[k] = true;
  }
  if (price === null && bare.length) {
    const last = bare.pop();
    price = last.value;
    for (let k = last.index; k < last.index + last.length; k += 1) used[k] = true;
  }
  if (qty === null && bare.length) {
    const only = bare.shift();
    qty = only.value;
    for (let k = only.index; k < only.index + only.length; k += 1) used[k] = true;
  }

  // Whatever is left, minus stray unit and noise words, is the item name.
  const nameTokens = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (used[i]) continue;
    const t = tokens[i];
    // A bare unit word is never part of a name — "20 ots 20 rupees per piece"
    // ends on one. Sizes fused into a token ("500ml") are a single word and are
    // not matched here, so names like "DDC Dudh 500ml" survive intact.
    const asUnit = UNIT_WORDS[t] || nearestKeyword(t, UNIT_WORDS, { minLen: 5 });
    if (asUnit) { if (!unit) unit = asUnit; continue; }
    if (isPriceWord(t) || STOP_WORDS.has(t)) continue;
    nameTokens.push(t);
  }
  const name = nameTokens.join(' ').replace(/\s+/g, ' ').trim();

  const needsReview = [];
  if (!name) needsReview.push('name');
  if (qty === null) needsReview.push('qty');
  if (price === null) needsReview.push('price');
  if (!unit) needsReview.push('unit');

  return {
    name: name ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : '',
    qty: qty === null ? null : Math.round(qty * 100) / 100,
    unit: unit || 'each',
    price: price === null ? null : Math.round(price),
    needsReview,
    raw: String(text || '').trim()
  };
}

module.exports = {
  parseItemSpeech,
  // Shared with ./voiceCommand so spoken commands and spoken item lines never
  // drift into two different ideas of what "दुई किलो" means.
  tokenize,
  wordsToNumber,
  devanagariToAscii,
  nearestKeyword,
  nearKeyword,
  UNIT_WORDS,
  NUMBER_WORDS,
  PRICE_WORDS,
  STOP_WORDS
};
