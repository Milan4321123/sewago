const fs = require('fs');
const path = require('path');
const { loadSupabaseState } = require('../server/storage/supabaseStateStore');
const { migrate, seed, DB_PATH } = require('../server/db');

function checkEnv() {
  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_KEY) {
    missing.push('SUPABASE_SERVICE_ROLE_KEY');
  }
  if (missing.length) {
    console.error(`Supabase pull is missing: ${missing.join(', ')}`);
    console.error('');
    console.error('Add these to .env from your Supabase project settings:');
    console.error('  SUPABASE_URL=https://your-project-ref.supabase.co');
    console.error('  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key');
    process.exit(1);
  }
}

(async () => {
  checkEnv();
  const data = migrate(await loadSupabaseState(migrate(seed())));
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  console.log(`Pulled Supabase state "${process.env.SUPABASE_STATE_ID || 'default'}" to ${path.relative(process.cwd(), DB_PATH)}.`);
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
