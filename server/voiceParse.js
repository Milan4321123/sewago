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
const UNIT_WORDS = {
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', किलो: 'kg', केजी: 'kg', kej: 'kg',
  g: 'g', gm: 'g', gram: 'g', grams: 'g', ग्राम: 'g',
  l: 'l', ltr: 'l', litre: 'l', liter: 'l', litres: 'l', लिटर: 'l',
  ml: 'ml', मिलि: 'ml', मिली: 'ml',
  packet: 'packet', packets: 'packet', pkt: 'packet', प्याकेट: 'packet', पोका: 'packet',
  piece: 'each', pieces: 'each', pcs: 'each', pc: 'each',
  goto: 'each', गोटा: 'each', ota: 'each', ओटा: 'each', wata: 'each', वटा: 'each',
  dozen: 'dozen', दर्जन: 'dozen',
  bottle: 'bottle', bottles: 'bottle', बोतल: 'bottle',
  bora: 'sack', बोरा: 'sack', sack: 'sack'
};

// Words that mark the number next to them as a PRICE rather than a quantity.
const PRICE_WORDS = new Set([
  'rupees', 'rupee', 'rs', 'rupaiya', 'rupaiyan',
  'रुपैयाँ', 'रुपैया', 'रुपियाँ', 'रुपया', 'रु', 'मूल्य', 'price', 'each', 'per'
]);

// Noise words that should never end up in the item name.
const STOP_WORDS = new Set(['ko', 'ka', 'ki', 'को', 'का', 'की', 'छ', 'हो', 'and', 'at', 'for', 'the', 'a']);

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
    const next = tokens[i + n.length];
    if (next && UNIT_WORDS[next]) {
      qty = n.value;
      unit = UNIT_WORDS[next];
      for (let k = i; k < i + n.length + 1; k += 1) used[k] = true;
    }
  }

  // Pass 2 — a number next to a price word is the price ("100 rupees", "rs 100").
  for (let i = 0; i < tokens.length && price === null; i += 1) {
    const n = numberAt(i);
    if (!n) continue;
    const after = tokens[i + n.length];
    const before = i > 0 ? tokens[i - 1] : null;
    if ((after && PRICE_WORDS.has(after)) || (before && PRICE_WORDS.has(before))) {
      price = n.value;
      for (let k = i; k < i + n.length; k += 1) used[k] = true;
      if (after && PRICE_WORDS.has(after)) used[i + n.length] = true;
      if (before && PRICE_WORDS.has(before)) used[i - 1] = true;
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
    if (UNIT_WORDS[t] && !nameTokens.length) { if (!unit) unit = UNIT_WORDS[t]; continue; }
    if (PRICE_WORDS.has(t) || STOP_WORDS.has(t)) continue;
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
  UNIT_WORDS,
  NUMBER_WORDS,
  PRICE_WORDS,
  STOP_WORDS
};
