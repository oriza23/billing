const express = require('express');
const pool = require('../../database');
const { checkDatabase, checkRadius } = require('../health_checks');

const router = express.Router();

router.get('/health', async (req, res) => {
  const [database, radius] = await Promise.all([checkDatabase(pool), checkRadius()]);

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    checked_at: new Date().toISOString(),
    // Endpoint ini merespons, berarti Web Backend online.
    web: { status: 'Online' },
    database,
    radius,
  });
});

module.exports = router;
