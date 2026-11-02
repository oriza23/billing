const pool = require('../database');
const { disconnectUserRadius } = require('../utils/radius_coa');
const { isolirPelangganFullRadius } = require('./pppoe_isolir/isolir_full_radius');

const SWEEP_INTERVAL_MS = 60 * 1000;
const RADIUS_KATEGORI_SQL = "('PPP', 'Hotspot')";

// Memutus sesi aktif (PoD murni Node.js) per baris radacct — dipakai saat edit data langganan.
async function disconnectUser(db, username, options = {}) {
  return disconnectUserRadius(db, username, options);
}

function disconnectInBackground(username, db = pool) {
  disconnectUser(db, username).catch((error) => {
    console.error(`Gagal memutus sesi ${username}:`, error.message);
  });
}

async function isExpired(db, tglIsolir) {
  if (!tglIsolir) {
    return false;
  }
  const [[row]] = await db.query('SELECT (? <= NOW()) AS expired', [tglIsolir]);
  return Number(row.expired) === 1;
}

/**
 * Pelanggan PPP/Hotspot yang tgl_isolir lewat: Full RADIUS (grup isolir → PoD → status Isolir).
 */
async function isolateExpiredCustomers(db = pool, { isolirFn = isolirPelangganFullRadius } = {}) {
  const [due] = await db.query(
    `SELECT id, username, ktg FROM langganan_pelanggan
     WHERE status = 'Aktif' AND tgl_isolir IS NOT NULL AND tgl_isolir <= NOW()
       AND ktg IN ${RADIUS_KATEGORI_SQL}`,
  );
  const isolated = [];

  for (const customer of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await isolirFn(customer.id, {
        sumber: 'tgl_isolir',
        kick: true,
        ktgAllowed: ['PPP', 'Hotspot'],
      }, db);
      isolated.push(customer.username);
    } catch (error) {
      console.error(`Gagal mengisolir langganan #${customer.id} (${customer.username}):`, error.message);
    }
  }
  return isolated;
}

function startIsolirEnforcement(db = pool) {
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const isolated = await isolateExpiredCustomers(db);
      if (isolated.length > 0) {
        console.log(`Langganan diisolir (Full RADIUS, tgl_isolir): ${isolated.join(', ')}`);
      }
    } catch (error) {
      console.error('Gagal memeriksa masa aktif langganan:', error.message);
    } finally {
      running = false;
    }
  };

  tick();
  const timer = setInterval(tick, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
}

module.exports = {
  disconnectUser,
  disconnectInBackground,
  isExpired,
  isolateExpiredCustomers,
  startIsolirEnforcement,
};
