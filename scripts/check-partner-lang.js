#!/usr/bin/env node
/*
 * Keeps public/partner-lang.js honest against public/partner.js.
 *
 * The t() layer falls back to English silently, so a reworded source string
 * with a stale dictionary key never *breaks* — it just quietly shows English
 * in a Nepali UI. That drift happened four separate times while the portal
 * was being localized, which is exactly often enough to automate the check.
 *
 * Fails (exit 1) on:
 *   - a t('…') literal in partner.js with no dictionary entry
 *   - a dictionary key defined twice (the second silently wins)
 *   - a dead dictionary key: never used as a literal and not in the dynamic
 *     allowlist below
 *   - a {placeholder} present on one side of an entry but not the other
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'partner.js'), 'utf8');
const dictSrc = fs.readFileSync(path.join(ROOT, 'public', 'partner-lang.js'), 'utf8');

// Strings that reach t() through variables rather than literals. When you add
// a new dynamic lookup (a status map, a label table), list its values here.
const DYNAMIC_KEYS = [
  // ORDER_STATUS_LINE values
  '🕐 Waiting for you to confirm', '👨‍🍳 Preparing — courier being arranged',
  '🛵 On the way to the customer', '✅ Delivered', '❌ Cancelled',
  // PIPE_LABELS / PIPE_EMPTY
  'New', 'In progress', 'Ready', 'Done',
  'No new orders — they appear here instantly.', 'Nothing being prepared right now.',
  'Nothing waiting for handover or delivery.', 'Finished orders show up here.',
  // STORE_NEXT_ACTION labels
  '✅ Accept order', '📦 Mark ready', '🤝 Handed over',
  // decideStoreOrder toast map
  'Order accepted 👍', 'Order rejected — customer refunded', 'Marked ready',
  'Handed over — income settled 💰',
  // reviewIntro(where) arguments
  'Shops', 'Food', 'Stays',
  // removeListingBlock labels
  'Remove this restaurant', 'Remove this hotel',
  // t(status.toUpperCase()) — businessKycStatus
  'PENDING', 'APPROVED', 'REJECTED',
  // unit labels (server UNITS + client UNIT_LABELS feed t())
  'pcs', 'kg', 'g', 'litre', 'ml', 'packet', 'dozen', 'bottle', 'sack', 'bora',
  // categoryChips() / itemRow() — category values come from inventory data
  'Rice & Grains', 'Spices & Oil', 'Snacks', 'Drinks', 'Dairy & Eggs',
  'Vegetables', 'Household', 'Personal Care', 'Baby & Health'
];

// Every literal first argument of a t( call, both quote styles, unescaped.
function extractUsedKeys(src) {
  const used = new Set();
  const re = /\bt\(\s*(['"])((?:\\.|(?!\1).)*?)\1/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    used.add(m[2].replace(/\\(['"\\])/g, '$1'));
  }
  return used;
}

// The dictionary itself, plus a duplicate scan over its source text.
function loadDict(src) {
  const sandbox = {};
  new Function('window', src)(sandbox);
  const dict = sandbox.SEWAGO_NE || {};
  const seen = new Map();
  const dupes = [];
  const re = /^\s*(['"])((?:\\.|(?!\1).)*?)\1\s*:/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const key = m[2].replace(/\\(['"\\])/g, '$1');
    if (seen.has(key)) dupes.push(key);
    seen.set(key, true);
  }
  return { dict, dupes };
}

function placeholders(s) {
  return (String(s).match(/\{[a-zA-Z0-9_]+\}/g) || []).sort().join(',');
}

const used = extractUsedKeys(appSrc);
const { dict, dupes } = loadDict(dictSrc);
const dictKeys = new Set(Object.keys(dict));
const allowed = new Set([...used, ...DYNAMIC_KEYS]);

const missing = [...used].filter((k) => !dictKeys.has(k));
const dead = [...dictKeys].filter((k) => !allowed.has(k));
const badPlaceholders = [...dictKeys]
  .filter((k) => placeholders(k) !== placeholders(dict[k]))
  .map((k) => `${k} → ${dict[k]}`);

let failed = false;
function report(label, list) {
  if (!list.length) return;
  failed = true;
  console.error(`\n${label} (${list.length}):`);
  for (const item of list) console.error(`  - ${item}`);
}

report('t() keys missing from partner-lang.js (English will show in the Nepali UI)', missing);
report('Duplicate keys in partner-lang.js (the later value silently wins)', dupes);
report('Dead dictionary keys (never used; delete or add to DYNAMIC_KEYS)', dead);
report('Placeholder mismatch between key and translation', badPlaceholders);

if (failed) process.exit(1);
console.log(`partner-lang OK: ${used.size} literal keys, ${dictKeys.size} dictionary entries, ${DYNAMIC_KEYS.length} dynamic.`);
