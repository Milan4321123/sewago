const express = require('express');
const { seedDemoData } = require('../demoData');

const router = express.Router();

router.post('/seed', (req, res) => {
  const summary = seedDemoData();
  res.json({
    ok: true,
    summary,
    note: 'Demo data refreshed. Only records with demo-* IDs were replaced.'
  });
});

module.exports = router;
