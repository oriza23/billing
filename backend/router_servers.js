const pool = require('../database');

// Server = nama server di MikroTik. MikroTik mengirimnya ke RADIUS sebagai
// Called-Station-Id: nama server Hotspot (IP > Hotspot > Servers > Name) atau
// Service Name PPPoE (PPP > PPPoE Servers > Service Name).
const ALL_SERVER = 'ALL SERVER';
// Nilai yang disimpan di kolom router_servers.jenis. 'both' = satu server yang
// melayani Hotspot sekaligus PPPoE.
const JENIS_SERVER = ['hotspot', 'pppoe', 'both'];
// Layanan yang bisa diminta saat memfilter / memvalidasi server.
const JENIS_LAYANAN = ['hotspot', 'pppoe'];
const MAX_SERVER_NAME = 100;
const JENIS_CHECK_NAME = 'router_servers_jenis_check';

async function ensureTable() {
  // utf8mb4_bin: nama server dibedakan huruf besar kecil, sama seperti RADIUS.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS router_servers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      router_id INT NOT NULL,
      jenis VARCHAR(10) NOT NULL,
      nama VARCHAR(${MAX_SERVER_NAME}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_router_jenis_nama (router_id, jenis, nama)
    )`,
  );
  await ensureJenisConstraint();
}

// Migrasi idempoten: kolom jenis hanya boleh hotspot, pppoe, atau both. CHECK lama
// (mis. hanya hotspot/pppoe) dibuang dulu supaya nilai 'both' tidak ditolak.
async function ensureJenisConstraint() {
  const [checks] = await pool.query(
    `SELECT conname FROM pg_constraint
     WHERE conrelid = 'router_servers'::regclass AND contype = 'c'`,
  );
  for (const { conname } of checks) {
    await pool.query(`ALTER TABLE router_servers DROP CONSTRAINT IF EXISTS "${conname}"`);
  }
  await pool.query(
    `ALTER TABLE router_servers ADD CONSTRAINT ${JENIS_CHECK_NAME}
     CHECK (jenis IN (${JENIS_SERVER.map((item) => `'${item}'`).join(', ')}))`,
  );
}

// Terima 'hotspot' | 'pppoe' | 'both', 'hotspot,pppoe', atau array layanan
// (['hotspot', 'pppoe']) dan kembalikan nilai simpan: 'hotspot' | 'pppoe' | 'both'.
// null bila kosong atau ada nilai tak dikenal.
function normalizeJenis(input) {
  let items;
  if (Array.isArray(input)) {
    items = input;
  } else if (typeof input === 'string') {
    items = input.split(',');
  } else {
    return null;
  }

  const set = new Set();
  for (const raw of items) {
    const item = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (item === 'both') {
      set.add('hotspot');
      set.add('pppoe');
    } else if (JENIS_LAYANAN.includes(item)) {
      set.add(item);
    } else {
      return null;
    }
  }
  if (set.size === 0) {
    return null;
  }
  return set.size === 2 ? 'both' : [...set][0];
}

// Jenis yang bentrok bila nama yang sama dipakai di router yang sama.
function jenisBentrok(jenis) {
  return jenis === 'both' ? [...JENIS_SERVER] : [jenis, 'both'];
}

// true bila router sudah punya server bernama sama yang melayani layanan yang
// sama (mis. "A" hotspot lalu "A" both). exceptId dipakai saat edit.
async function serverNameTaken(db, { routerId, nama, jenis, exceptId = 0 }) {
  const bentrok = jenisBentrok(jenis);
  const [rows] = await db.execute(
    `SELECT id FROM router_servers
     WHERE router_id = ? AND nama = ? AND id <> ?
       AND jenis IN (${bentrok.map(() => '?').join(', ')}) LIMIT 1`,
    [routerId, nama, exceptId, ...bentrok],
  );
  return Array.isArray(rows) && rows.length > 0;
}

// Nama server valid: tidak kosong, maksimal 100 karakter, tanpa karakter kontrol,
// dan bukan kata cadangan ALL SERVER.
function validServerName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= MAX_SERVER_NAME
    // eslint-disable-next-line no-control-regex
    && !/[\u0000-\u001f\u007f]/.test(name)
    && name.toUpperCase() !== ALL_SERVER;
}

// true bila server adalah ALL SERVER atau terdaftar untuk layanan tersebut
// (server bertipe 'both' berlaku untuk hotspot maupun pppoe).
// Router spesifik membatasi pencarian ke server milik router itu; ALL ROUTER
// (atau kosong) memeriksa server di semua router.
async function serverAllowed(db, { jenis, routerName, server }) {
  if (server === ALL_SERVER) {
    return true;
  }
  if (!JENIS_LAYANAN.includes(jenis) || !server) {
    return false;
  }

  const params = [jenis, server];
  let routerFilter = '';
  if (routerName && routerName !== 'ALL ROUTER') {
    routerFilter = 'AND BINARY r.nama_router = ?';
    params.push(routerName);
  }
  const [rows] = await db.execute(
    `SELECT s.id FROM router_servers s
     JOIN routers r ON r.id = s.router_id
     WHERE s.jenis IN (?, 'both') AND s.nama = ? ${routerFilter} LIMIT 1`,
    params,
  );
  return rows.length > 0;
}

module.exports = {
  ALL_SERVER,
  JENIS_SERVER,
  JENIS_LAYANAN,
  MAX_SERVER_NAME,
  ensureTable,
  ensureJenisConstraint,
  normalizeJenis,
  serverNameTaken,
  validServerName,
  serverAllowed,
};
