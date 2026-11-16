const pool = require('../../database');

function isolirDebugEnabled() {
  return String(process.env.ALLOW_ISOLIR_DEBUG || '') === '1'
    || process.env.NODE_ENV !== 'production';
}

async function listActiveSessionIps(db = pool, limit = 25) {
  const [rows] = await db.execute(
    `SELECT a.framedipaddress AS ip, a.username, c.pelanggan, c.status, a.acctstarttime
     FROM radacct a
     LEFT JOIN langganan_pelanggan c ON c.username = a.username
     WHERE a.acctstoptime IS NULL
       AND a.framedipaddress IS NOT NULL AND a.framedipaddress <> ''
     ORDER BY a.acctstarttime DESC
     LIMIT ?`,
    [Math.min(Math.max(limit, 1), 100)],
  );
  return rows;
}

function buildDebugMeta(clientIp) {
  return {
    client_ip_detected: clientIp,
    trust_proxy: String(process.env.TRUST_PROXY || '') === '1',
    hint: 'Tanpa Nginx: client_ip_detected harus sama dengan kolom ip di radacct (framedipaddress).',
  };
}

module.exports = {
  isolirDebugEnabled,
  listActiveSessionIps,
  buildDebugMeta,
};
