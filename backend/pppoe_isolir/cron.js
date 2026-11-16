/**
 * Penjadwal isolir otomatis (node-cron).
 *
 * Default: setiap hari jam 00:00 (zona waktu server OS).
 * Nonaktifkan dengan env PPPoE_ISOLIR_CRON=0
 *
 * Catatan: backend/langganan_isolir.js masih menjalankan sweep tiap 60 detik
 * dengan pola Auth-Type Reject. Saat Walled Garden aktif penuh, pertimbangkan
 * mematikan sweep lama atau mengarahkan ke runAutoIsolirBatch di sini.
 */

let cron;
try {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  cron = require('node-cron');
} catch {
  cron = null;
}

const pool = require('../../database');
const { ensurePppoeIsolirSchema } = require('./schema');
const { runAutoIsolirBatch } = require('./service');

const CRON_EXPR = process.env.PPPoE_ISOLIR_CRON_EXPR || '0 0 * * *';

function cronEnabled() {
  return String(process.env.PPPoE_ISOLIR_CRON ?? '1') !== '0';
}

async function tick() {
  await ensurePppoeIsolirSchema(pool);
  const result = await runAutoIsolirBatch(pool);
  if (result.ok.length > 0) {
    console.log(`[PPPoE Isolir Cron] berhasil: ${result.ok.join(', ')}`);
  }
  if (result.gagal.length > 0) {
    console.warn('[PPPoE Isolir Cron] gagal:', result.gagal);
  }
  return result;
}

function startPppoeIsolirCron() {
  if (!cronEnabled()) {
    console.log('[PPPoE Isolir Cron] nonaktif (PPPoE_ISOLIR_CRON=0)');
    return null;
  }
  if (!cron) {
    console.warn('[PPPoE Isolir Cron] node-cron belum terpasang. Jalankan: npm install node-cron');
    return null;
  }

  const task = cron.schedule(CRON_EXPR, () => {
    tick().catch((error) => {
      console.error('[PPPoE Isolir Cron]', error.message);
    });
  }, {
    scheduled: true,
    timezone: process.env.PPPoE_ISOLIR_TZ || undefined,
  });

  if (typeof task.unref === 'function') {
    task.unref();
  }
  console.log(`[PPPoE Isolir Cron] dijadwalkan: ${CRON_EXPR}`);
  return task;
}

module.exports = {
  startPppoeIsolirCron,
  tick,
  CRON_EXPR,
};
