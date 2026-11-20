/**
 * Pemeriksaan kesehatan database & FreeRADIUS.
 *
 * Dipakai bersama oleh endpoint detail ber-JWT (/api/system/health) dan endpoint publik
 * minimal (/healthz). Hasil selalu berupa objek, tidak pernah melempar error.
 */

const { execFile } = require('child_process');

const CHECK_TIMEOUT_MS = 3000;
const RADIUS_SERVICE = 'freeradius';

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkDatabase(pool) {
  const started = Date.now();
  try {
    await withTimeout(pool.query('SELECT 1'), CHECK_TIMEOUT_MS);
    return { status: 'Online', latency_ms: Date.now() - started };
  } catch (error) {
    return { status: 'Offline', detail: error.code || error.message || 'error' };
  }
}

// `systemctl is-active` keluar dengan kode non-zero saat layanan tidak aktif,
// sehingga exec menghasilkan error; stdout tetap berisi state-nya (inactive/failed/dll).
function checkRadius() {
  return new Promise((resolve) => {
    execFile(
      'systemctl',
      ['is-active', RADIUS_SERVICE],
      { timeout: CHECK_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const state = String(stdout || '').trim() || String(stderr || '').trim() || (error ? error.message : 'unknown');
        resolve({
          status: state === 'active' ? 'Online' : 'Offline',
          detail: state,
        });
      },
    );
  });
}

// true bila kedua layanan Online.
function isHealthy(result) {
  return result.database.status === 'Online' && result.radius.status === 'Online';
}

module.exports = {
  CHECK_TIMEOUT_MS,
  checkDatabase,
  checkRadius,
  isHealthy,
};
