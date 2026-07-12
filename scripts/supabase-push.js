const fs = require('fs');
const path = require('path');
const { saveSupabaseState } = require('../server/storage/supabaseStateStore');
const { migrate, seed, DB_PATH } = require('../server/db');

function checkEnv() {
  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_KEY) {
    missing.push('SUPABASE_SERVICE_ROLE_KEY');
  }
  if (missing.length) {
    console.error(`Supabase push is missing: ${missing.join(', ')}`);
    console.error('');
    console.error('Add these to .env from your Supabase project settings:');
    console.error('  SUPABASE_URL=https://your-project-ref.supabase.co');
    console.error('  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key');
    console.error('');
    console.error('Use the service_role key, not the anon public key. Keep it server-side only.');
    process.exit(1);
  }
}

function readLocalState() {
  if (fs.existsSync(DB_PATH)) {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  }
  return seed();
}

(async () => {
  checkEnv();
  const data = migrate(readLocalState());
  await saveSupabaseState(data);
  console.log(`Pushed local app state to Supabase state "${process.env.SUPABASE_STATE_ID || 'default'}".`);
  console.log(`Source: ${path.relative(process.cwd(), DB_PATH)}`);
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
