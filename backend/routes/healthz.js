/**
 * Endpoint kesehatan publik untuk monitoring (Uptime Kuma, Zabbix, dsb).
 *
 * Tanpa token: hanya `{ status: "ok" }` / 503 `{ status: "degraded" }` — tanpa detail
 * internal (latensi, error, state layanan).
 * Dengan header `X-Health-Token` yang cocok dengan env HEALTH_TOKEN: ditambah detail
 * database/radius seperti endpoint ber-JWT.
 */

const crypto = require('crypto');
const express = require('express');
const pool = require('../../database');
const checks = require('../health_checks');

const router = express.Router();

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function tokenMatches(req) {
  const expected = String(process.env.HEALTH_TOKEN || '').trim();
  if (!expected) {
    return false;
  }
  const given = String(req.headers['x-health-token'] || '').trim();
  if (!given) {
    return false;
  }
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

router.get('/', async (req, res) => {
  const [database, radius] = await Promise.all([checks.checkDatabase(pool), checks.checkRadius()]);
  const result = { database, radius };
  const healthy = checks.isHealthy(result);

  res.setHeader('Cache-Control', 'no-store');
  res.status(healthy ? 200 : 503);
  if (!tokenMatches(req)) {
    return res.json({ success: healthy, status: healthy ? 'ok' : 'degraded' });
  }
  return res.json({
    success: healthy,
    status: healthy ? 'ok' : 'degraded',
    checked_at: new Date().toISOString(),
    web: { status: 'Online' },
    database,
    radius,
  });
});

module.exports = router;
