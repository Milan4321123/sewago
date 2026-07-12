const { seedDemoData } = require('../server/demoData');
const { initDb, flushSaves } = require('../server/db');

(async () => {
  await initDb();
  const summary = seedDemoData();
  await flushSaves();
  console.log(JSON.stringify(summary, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
