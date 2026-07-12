require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const STATE_TABLE = 'app_state';

let client;

function required(name, fallbackName = '') {
  const value = process.env[name] || (fallbackName ? process.env[fallbackName] : '');
  if (!value) {
    throw new Error(`${name}${fallbackName ? ` or ${fallbackName}` : ''} is required when DATA_STORE=supabase.`);
  }
  return value;
}

function getClient() {
  if (client) return client;
  client = createClient(
    required('SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      },
      realtime: {
        transport: WebSocket
      }
    }
  );
  return client;
}

function stateId() {
  return process.env.SUPABASE_STATE_ID || 'default';
}

function assertStateTable(error) {
  if (!error) return;
  const message = String(error.message || error);
  if (/522: Connection timed out|Error code 522|Connection timed out/i.test(message)) {
    throw new Error('Supabase project is not responding right now (Cloudflare 522 timeout). Check that the project is active, then retry.');
  }
  if (error.code === '42P01' || /app_state|does not exist/i.test(error.message || '')) {
    throw new Error('Supabase table app_state is missing. Run docs/supabase-schema.sql in the Supabase SQL editor first.');
  }
  throw error;
}

function isTransient(error) {
  const message = String((error && error.message) || error || '');
  return /522: Connection timed out|Error code 522|Connection timed out|fetch failed|network/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestWithRetry(label, fn) {
  const delays = [1000, 3000, 7000];
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    let result;
    try {
      result = await fn();
    } catch (err) {
      result = { error: err };
    }
    if (!result.error) return result;
    lastError = result.error;
    if (!isTransient(lastError) || attempt === delays.length) break;
    await sleep(delays[attempt]);
  }
  assertStateTable(lastError);
  throw lastError;
}

async function loadSupabaseState(defaultData) {
  const supabase = getClient();
  const id = stateId();
  const { data } = await requestWithRetry('load app_state', () => supabase
    .from(STATE_TABLE)
    .select('data')
    .eq('id', id)
    .maybeSingle());
  if (data && data.data) return data.data;

  const now = new Date().toISOString();
  await requestWithRetry('insert app_state', () => supabase
    .from(STATE_TABLE)
    .insert({ id, data: defaultData, version: 1, updated_at: now }));
  return defaultData;
}

async function saveSupabaseState(data) {
  const supabase = getClient();
  const id = stateId();
  const now = new Date().toISOString();
  await requestWithRetry('save app_state', () => supabase
    .from(STATE_TABLE)
    .upsert(
      { id, data, updated_at: now },
      { onConflict: 'id' }
    ));
}

module.exports = { loadSupabaseState, saveSupabaseState };
