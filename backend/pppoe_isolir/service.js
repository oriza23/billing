/**
 * Layanan isolir / buka isolir — delegasi ke Full RADIUS (isolir_full_radius.js).
 */

const pool = require('../../database');
const {
  IsolirError,
  isolirPelangganFullRadius,
  bukaIsolirPelangganFullRadius,
} = require('./isolir_full_radius');

async function isolirPelanggan(customerId, options = {}, db = pool) {
  return isolirPelangganFullRadius(customerId, options, db);
}

async function bukaIsolirPelanggan(customerId, options = {}, db = pool) {
  return bukaIsolirPelangganFullRadius(customerId, options, db);
}

async function findDueForAutoIsolir(db = pool) {
  const [rows] = await db.execute(
    `SELECT id, username, jatuh_tempo, tgl_isolir
     FROM langganan_pelanggan
     WHERE ktg = 'PPP'
       AND status = 'Aktif'
       AND (
         (jatuh_tempo IS NOT NULL AND jatuh_tempo < CURDATE())
         OR (tgl_isolir IS NOT NULL AND tgl_isolir <= NOW())
       )`,
  );
  return rows;
}

async function runAutoIsolirBatch(db = pool) {
  const due = await findDueForAutoIsolir(db);
  const results = { ok: [], gagal: [] };

  for (const row of due) {
    const sumber = row.jatuh_tempo && new Date(row.jatuh_tempo) < new Date()
      ? 'jatuh_tempo'
      : 'tgl_isolir';
    try {
      // eslint-disable-next-line no-await-in-loop
      await isolirPelanggan(row.id, { sumber, kick: true }, db);
      results.ok.push(row.username);
    } catch (error) {
      results.gagal.push({ id: row.id, username: row.username, error: error.message });
    }
  }
  return results;
}

module.exports = {
  IsolirError,
  isolirPelanggan,
  bukaIsolirPelanggan,
  findDueForAutoIsolir,
  runAutoIsolirBatch,
};
