/**
 * Cron isolir otomatis jatuh tempo — Full RADIUS.
 * Jadwal: setiap hari 00:01 ('1 0 * * *').
 *
 * Kolom billing: jatuh_tempo (DATE), bukan tgl_jatuh_tempo.
 * Env: PPPoE_ISOLIR_CRON=0 (nonaktif), PPPoE_ISOLIR_TZ (zona waktu cron).
 */

const pool = require('../database');
const { isolirPelangganFullRadius } = require('../backend/pppoe_isolir/isolir_full_radius');

let cron;
try {
  // eslint-disable-next-line global-require
  cron = require('node-cron');
} catch {
  cron = null;
}

const CRON_SCHEDULE = '1 0 * * *';
const DELAY_MS = 2000;
const LOG = '[Cron Isolir]';

/** @deprecated alias untuk tes / kompatibilitas */
const CRON_EXPR = CRON_SCHEDULE;

const SELECT_MENUNGGAK = `
  SELECT id, username, router, profil_id, profil_id_sebelum_isolir, jatuh_tempo
  FROM langganan_pelanggan
  WHERE ktg = 'PPP'
    AND status = 'Aktif'
    AND jatuh_tempo IS NOT NULL
    AND jatuh_tempo < CURDATE()
    AND username IS NOT NULL AND username <> ''
  ORDER BY jatuh_tempo ASC, id ASC
`;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

let running = false;

async function findMenunggak(db = pool) {
  const [rows] = await db.execute(SELECT_MENUNGGAK);
  return rows;
}

/**
 * Satu putaran: RADIUS profil isolir → PoD → status Isolir, jeda 2 detik antar pelanggan.
 */
async function runDailyIsolir({
  db = pool,
  isolirFn = isolirPelangganFullRadius,
  delayMs = DELAY_MS,
  sleepFn = sleep,
  log = console,
} = {}) {
  if (running) {
    log.warn(`${LOG} putaran sebelumnya masih berjalan, dilewati`);
    return { skipped: true, total: 0, berhasil: 0, gagal: [] };
  }
  running = true;

  const summary = { skipped: false, total: 0, berhasil: 0, gagal: [] };
  try {
    const targets = await findMenunggak(db);
    summary.total = targets.length;
    log.log(`${LOG} mulai: ${targets.length} pelanggan Aktif lewat jatuh_tempo`);

    for (let index = 0; index < targets.length; index += 1) {
      const pelanggan = targets[index];
      try {
        // eslint-disable-next-line no-await-in-loop
        await isolirFn(pelanggan.id, { sumber: 'jatuh_tempo', kick: true }, db);
        summary.berhasil += 1;
        log.log(`${LOG} [${index + 1}/${targets.length}] ${pelanggan.username} diisolir`);
      } catch (error) {
        summary.gagal.push({
          id: pelanggan.id,
          username: pelanggan.username,
          error: error.message,
        });
        log.warn(`${LOG} [${index + 1}/${targets.length}] ${pelanggan.username} gagal: ${error.message}`);
      }

      if (index < targets.length - 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleepFn(delayMs);
      }
    }

    log.log(`${LOG} selesai: ${summary.berhasil} berhasil, ${summary.gagal.length} gagal, dari ${summary.total}`);
    return summary;
  } finally {
    running = false;
  }
}

/** @deprecated alias */
const runIsolirJatuhTempo = runDailyIsolir;

function startCron() {
  if (String(process.env.PPPoE_ISOLIR_CRON ?? '1') === '0') {
    console.log(`${LOG} nonaktif (PPPoE_ISOLIR_CRON=0)`);
    return null;
  }
  if (!cron) {
    console.warn(`${LOG} node-cron belum terpasang. Jalankan: npm install node-cron`);
    return null;
  }

  const task = cron.schedule(CRON_SCHEDULE, () => {
    runDailyIsolir().catch((error) => {
      console.error(`${LOG} gagal total: ${error.message}`);
    });
  }, {
    timezone: process.env.PPPoE_ISOLIR_TZ || undefined,
  });

  console.log(`${LOG} dijadwalkan: ${CRON_SCHEDULE} (jeda ${DELAY_MS} ms antar pelanggan)`);
  return task;
}

/** @deprecated alias */
const startIsolirJatuhTempoCron = startCron;

module.exports = {
  CRON_SCHEDULE,
  CRON_EXPR,
  SELECT_MENUNGGAK,
  DELAY_MS,
  findMenunggak,
  runDailyIsolir,
  runIsolirJatuhTempo,
  startCron,
  startIsolirJatuhTempoCron,
};
