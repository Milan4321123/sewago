// Per-row Supabase persistence. Instead of one giant JSONB blob re-uploaded on
// every save, each record is a row in `app_records (collection, id, data)`, and
// each save writes only the rows that actually changed. This removes the
// single-blob scaling ceiling (a new ride writes ~2 rows, not the whole state)
// and gives real Postgres rows that can be indexed and queried directly later.
//
// Requires the app_records table from docs/supabase-schema.sql. Opt in with
// DATA_STORE=supabase_rows. On first boot it auto-imports an existing app_state
// blob (from the old DATA_STORE=supabase mode), so cutover is a config flip with
// the blob left intact for rollback.
require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const rowSync = require('./rowSync');

const RECORDS_TABLE = 'app_records';
const STATE_TABLE = 'app_state'; // legacy blob, read once for migration
const PAGE = 1000; // Supabase caps selects at 1000 rows/page
const WRITE_CHUNK = 500;

let client;
// The last-synced index, so diff() only emits rows that changed since it.
let syncedIndex = new Map();

function required(name, fallbackName = '') {
  const value = process.env[name] || (fallbackName ? process.env[fallbackName] : '');
  if (!value) {
    throw new Error(`${name}${fallbackName ? ` or ${fallbackName}` : ''} is required when DATA_STORE=supabase_rows.`);
  }
  return value;
}

function getClient() {
  if (client) return client;
  client = createClient(
    required('SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false }, realtime: { transport: WebSocket } }
  );
  return client;
}

function stateId() {
  return process.env.SUPABASE_STATE_ID || 'default';
}

function assertTable(error) {
  if (!error) return;
  const message = String(error.message || error);
  if (error.code === '42P01' || /app_records|does not exist/i.test(message)) {
    throw new Error('Supabase table app_records is missing. Run docs/supabase-schema.sql in the SQL editor first.');
  }
  throw error;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Read every row, paging past the 1000-row cap.
async function readAllRows(supabase) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(RECORDS_TABLE)
      .select('collection,id,data')
      .range(from, from + PAGE - 1);
    if (error) assertTable(error);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

async function loadState(defaultData) {
  const supabase = getClient();

  const rows = await readAllRows(supabase);
  if (rows.length > 0) {
    syncedIndex = rowSync.buildIndex(rows);
    return rowSync.reconstruct(rows);
  }

  // No rows yet — one-time migrate from the legacy blob if present, else seed.
  // Leaving syncedIndex empty makes the first save() write every row.
  const { data: blob } = await supabase.from(STATE_TABLE).select('data').eq('id', stateId()).maybeSingle();
  syncedIndex = new Map();
  return blob && blob.data ? blob.data : defaultData;
}

async function saveState(db) {
  const supabase = getClient();
  // Diff synchronously against the last-synced index so the write set is a
  // consistent point-in-time snapshot even though the writes below are async.
  const { upserts, deletes, nextIndex } = rowSync.diff(syncedIndex, db);
  if (upserts.length === 0 && deletes.length === 0) return;

  const now = new Date().toISOString();
  for (const batch of chunk(upserts, WRITE_CHUNK)) {
    const { error } = await supabase
      .from(RECORDS_TABLE)
      .upsert(batch.map((r) => ({ collection: r.collection, id: r.id, data: r.data, updated_at: now })),
        { onConflict: 'collection,id' });
    if (error) assertTable(error);
  }

  // Deletes grouped by collection so we can use a single .in() per collection.
  const byCollection = new Map();
  for (const d of deletes) {
    if (!byCollection.has(d.collection)) byCollection.set(d.collection, []);
    byCollection.get(d.collection).push(d.id);
  }
  for (const [collection, ids] of byCollection) {
    for (const idBatch of chunk(ids, WRITE_CHUNK)) {
      const { error } = await supabase.from(RECORDS_TABLE).delete().eq('collection', collection).in('id', idBatch);
      if (error) assertTable(error);
    }
  }

  // Only advance the synced index after the writes land, so a failed flush
  // retries the same rows next interval rather than dropping them.
  syncedIndex = nextIndex;
}

module.exports = { loadState, saveState };
