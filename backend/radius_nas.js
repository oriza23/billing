/**
 * Sinkronisasi tabel `routers` (sumber kebenaran di web billing) -> tabel `nas` milik FreeRADIUS.
 *
 * FreeRADIUS (modul sql, `read_clients = yes`) membaca daftar NAS dari tabel `nas`, jadi
 * setiap router yang ditambahkan di web otomatis dikenali sebagai client RADIUS dengan
 * secret-nya sendiri.
 *
 * Aturan:
 *  - Baris `nas` yang dikelola aplikasi ditandai `description = 'billing-router:<id>'`.
 *    Baris tanpa tanda itu (diisi manual) TIDAK pernah diubah atau dihapus.
 *  - Router berstatus selain 'Aktif', ber-IP tidak valid, atau ber-secret > 60 karakter
 *    (batas kolom nas.secret) dilewati dan dilaporkan di `skipped`.
 *  - IP ganda (antar-router atau bentrok dengan baris manual) -> router belakangan dilewati.
 *  - FreeRADIUS hanya membaca `nas` saat start. Bila FREERADIUS_RESTART_ON_SYNC=1, layanan
 *    di-restart otomatis (didebounce) setelah ada perubahan; selain itu restart manual.
 */

const net = require('net');
const { execPrivileged, runPrivileged } = require('./privileged');

const MANAGED_PREFIX = 'billing-router:';
const MAX_SECRET_LENGTH = 60; // nas.secret VARCHAR(60)
const MAX_SHORTNAME_LENGTH = 32; // nas.shortname VARCHAR(32)
const RESTART_DEBOUNCE_MS = 2000;

function isValidIpv4(value) {
  return net.isIPv4(String(value || '').trim());
}

function managedDescription(routerId) {
  return `${MANAGED_PREFIX}${routerId}`;
}

function managedRouterId(description) {
  const text = String(description || '');
  if (!text.startsWith(MANAGED_PREFIX)) {
    return null;
  }
  const id = Number(text.slice(MANAGED_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Alasan router tidak bisa disinkronkan, atau '' bila valid.
function routerProblem(router) {
  if (String(router.status || 'Aktif') !== 'Aktif') {
    return 'Router tidak aktif';
  }
  if (!isValidIpv4(router.ip_address)) {
    return 'IP address bukan IPv4 yang valid';
  }
  const secret = String(router.secret || '');
  if (!secret) {
    return 'Secret kosong';
  }
  if (secret.length > MAX_SECRET_LENGTH) {
    return `Secret lebih dari ${MAX_SECRET_LENGTH} karakter (batas kolom nas.secret)`;
  }
  return '';
}

/**
 * Hitung perubahan yang diperlukan (fungsi murni, tanpa akses DB).
 * @param {Array} routers  baris tabel routers
 * @param {Array} nasRows  baris tabel nas
 */
function planNasSync(routers, nasRows) {
  const managedByRouter = new Map();
  const takenIps = new Map(); // nasname -> pemilik ('manual' atau id router)
  for (const row of nasRows) {
    const routerId = managedRouterId(row.description);
    if (routerId) {
      managedByRouter.set(routerId, row);
    } else {
      takenIps.set(String(row.nasname).trim(), 'manual');
    }
  }

  const plan = { inserts: [], updates: [], deletes: [], unchanged: 0, skipped: [] };
  const keptRouterIds = new Set();

  const ordered = [...routers].sort((a, b) => Number(a.id) - Number(b.id));
  for (const router of ordered) {
    const problem = routerProblem(router);
    if (problem) {
      plan.skipped.push({ router_id: router.id, nama_router: router.nama_router, reason: problem });
      continue;
    }

    const nasname = String(router.ip_address).trim();
    const owner = takenIps.get(nasname);
    if (owner !== undefined) {
      plan.skipped.push({
        router_id: router.id,
        nama_router: router.nama_router,
        reason: owner === 'manual'
          ? 'IP sudah terdaftar manual di tabel nas'
          : `IP sama dengan router id ${owner}`,
      });
      continue;
    }
    takenIps.set(nasname, router.id);
    keptRouterIds.add(Number(router.id));

    const desired = {
      router_id: Number(router.id),
      nasname,
      shortname: String(router.nama_router || '').trim().slice(0, MAX_SHORTNAME_LENGTH) || nasname,
      secret: String(router.secret),
      description: managedDescription(router.id),
    };

    const current = managedByRouter.get(Number(router.id));
    if (!current) {
      plan.inserts.push(desired);
    } else if (
      String(current.nasname).trim() !== desired.nasname
      || String(current.shortname || '') !== desired.shortname
      || String(current.secret) !== desired.secret
    ) {
      plan.updates.push({ ...desired, id: current.id });
    } else {
      plan.unchanged += 1;
    }
  }

  for (const [routerId, row] of managedByRouter) {
    if (!keptRouterIds.has(routerId)) {
      plan.deletes.push({ id: row.id, router_id: routerId, nasname: row.nasname });
    }
  }
  return plan;
}

async function applyPlan(db, plan) {
  for (const row of plan.deletes) {
    await db.execute('DELETE FROM nas WHERE id = ?', [row.id]);
  }
  for (const row of plan.updates) {
    await db.execute(
      'UPDATE nas SET nasname = ?, shortname = ?, secret = ? WHERE id = ?',
      [row.nasname, row.shortname, row.secret, row.id],
    );
  }
  for (const row of plan.inserts) {
    await db.execute(
      'INSERT INTO nas (nasname, shortname, type, secret, description) VALUES (?, ?, ?, ?, ?)',
      [row.nasname, row.shortname, 'other', row.secret, row.description],
    );
  }
}

// Sinkronisasi diserialkan agar dua perubahan router beruntun tidak menghasilkan baris ganda.
let queue = Promise.resolve();

function runExclusive(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function ensureNasTable(db) {
  // Skema standar FreeRADIUS (PostgreSQL). Tidak berefek bila tabel sudah ada.
  await db.query(
    `CREATE TABLE IF NOT EXISTS nas (
      id SERIAL PRIMARY KEY,
      nasname VARCHAR(128) NOT NULL,
      shortname VARCHAR(32),
      type VARCHAR(30) DEFAULT 'other',
      ports INTEGER,
      secret VARCHAR(60) NOT NULL DEFAULT 'secret',
      server VARCHAR(64),
      community VARCHAR(50),
      description VARCHAR(200) DEFAULT 'RADIUS Client'
    )`,
  );
  await db.query('CREATE INDEX IF NOT EXISTS nas_nasname ON nas (nasname)');
}

async function loadState(db) {
  const [routers] = await db.execute(
    'SELECT id, nama_router, ip_address, secret, status FROM routers ORDER BY id ASC',
  );
  const [nasRows] = await db.execute(
    'SELECT id, nasname, shortname, secret, description FROM nas ORDER BY id ASC',
  );
  return { routers, nasRows };
}

function summarize(plan) {
  return {
    inserted: plan.inserts.length,
    updated: plan.updates.length,
    deleted: plan.deletes.length,
    unchanged: plan.unchanged,
    skipped: plan.skipped,
    changed: plan.inserts.length + plan.updates.length + plan.deletes.length > 0,
  };
}

// Lihat selisih tanpa mengubah apa pun.
async function previewNasSync(db) {
  const { routers, nasRows } = await loadState(db);
  return summarize(planNasSync(routers, nasRows));
}

async function syncNasFromRouters(db) {
  return runExclusive(async () => {
    const { routers, nasRows } = await loadState(db);
    const plan = planNasSync(routers, nasRows);

    if (plan.inserts.length + plan.updates.length + plan.deletes.length > 0) {
      if (typeof db.getConnection === 'function') {
        const conn = await db.getConnection();
        try {
          await conn.beginTransaction();
          await applyPlan(conn, plan);
          await conn.commit();
        } catch (error) {
          await conn.rollback().catch(() => {});
          throw error;
        } finally {
          conn.release();
        }
      } else {
        await applyPlan(db, plan);
      }
    }
    return summarize(plan);
  });
}

let restartTimer = null;

function restartEnabled() {
  return String(process.env.FREERADIUS_RESTART_ON_SYNC || '') === '1';
}

function serviceName() {
  const name = String(process.env.FREERADIUS_SERVICE || 'freeradius').trim();
  return /^[A-Za-z0-9_.@-]+$/.test(name) ? name : 'freeradius';
}

function scheduleFreeradiusRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    execPrivileged('systemctl', ['restart', serviceName()], { timeout: 30_000 }, (error) => {
      if (error) {
        console.error('[radius-nas] restart FreeRADIUS gagal:', error.message);
      } else {
        console.log('[radius-nas] FreeRADIUS di-restart untuk memuat daftar NAS terbaru');
      }
    });
  }, RESTART_DEBOUNCE_MS);
  restartTimer.unref?.();
}

/**
 * Dipanggil setelah router dibuat/diubah/dihapus. Tidak pernah melempar error:
 * kegagalan sinkronisasi tidak boleh membatalkan penyimpanan router.
 */
async function syncAfterRouterChange(db) {
  try {
    const result = await syncNasFromRouters(db);
    let reload = 'tidak_perlu';
    if (result.changed) {
      if (restartEnabled()) {
        scheduleFreeradiusRestart();
        reload = 'dijadwalkan';
      } else {
        reload = 'manual';
      }
    }
    return { ok: true, ...result, reload };
  } catch (error) {
    console.error('[radius-nas] sinkronisasi gagal:', error.message);
    return { ok: false, error: error.message };
  }
}

function vpnRouterMark(kind, peerId) {
  if (kind === 'chr') {
    return `chr_client:${peerId}`;
  }
  return `vpn-peer:${kind}:${peerId}`;
}

async function reloadFreeradius() {
  const unit = serviceName();
  try {
    await runPrivileged('systemctl', ['reload', unit], { timeout: 20_000 });
    return 'reload';
  } catch (reloadError) {
    try {
      await runPrivileged('systemctl', ['restart', unit], { timeout: 30_000 });
      return 'restart';
    } catch (restartError) {
      console.error('[radius-nas] FreeRADIUS tidak dimuat ulang:', restartError.message || reloadError.message);
      return 'gagal';
    }
  }
}

async function writeVpnRouter(db, { kind, peer }) {
  const mark = vpnRouterMark(kind, peer.id);
  const ip = String(peer.address || '').split('/')[0].trim();
  const secret = String(peer.radius_secret || '');
  const [rows] = await db.execute(
    'SELECT id, nama_router FROM routers WHERE deskripsi = ? LIMIT 1',
    [mark],
  );
  const current = rows[0];
  let nama = String(peer.name || ip).trim().slice(0, 100) || ip;
  const [clash] = await db.execute(
    'SELECT id FROM routers WHERE nama_router = ? AND id <> ? LIMIT 1',
    [nama, current ? current.id : 0],
  );
  if (clash.length) {
    const suffix = ` ${ip}`;
    nama = `${nama.slice(0, 100 - suffix.length)}${suffix}`;
  }
  const status = peer.enabled === false ? 'Nonaktif' : 'Aktif';
  if (!current) {
    const [ipOwner] = await db.execute('SELECT id, deskripsi FROM routers WHERE ip_address = ? LIMIT 1', [ip]);
    if (ipOwner.length && String(ipOwner[0].deskripsi || '') !== mark) {
      console.warn(`[radius-nas] IP ${ip} sudah dipakai router id ${ipOwner[0].id}; peer VPN tidak menimpa baris itu.`);
      return;
    }
    await db.execute(
      'INSERT INTO routers (nama_router, ip_address, secret, deskripsi, status) VALUES (?, ?, ?, ?, ?)',
      [nama, ip, secret, mark, status],
    );
    return;
  }
  if (current.nama_router !== nama) {
    await db.execute('UPDATE langganan_pelanggan SET router = ? WHERE router = ?', [nama, current.nama_router]).catch(() => {});
    await db.execute('UPDATE hotspot_vouchers SET router = ? WHERE router = ?', [nama, current.nama_router]).catch(() => {});
  }
  await db.execute(
    'UPDATE routers SET nama_router = ?, ip_address = ?, secret = ?, deskripsi = ?, status = ? WHERE id = ?',
    [nama, ip, secret, mark, status, current.id],
  );
}

async function syncVpnPeer(db, spec) {
  try {
    await writeVpnRouter(db, spec);
    const result = await syncAfterRouterChange(db);
    const reload = await reloadFreeradius();
    return { ok: true, ...result, reload };
  } catch (error) {
    console.error('[radius-nas] sinkronisasi peer VPN gagal:', error.message);
    return { ok: false, error: error.message };
  }
}

async function syncChrClient(db, nas) {
  const mark = vpnRouterMark('chr', nas.id);
  if (!String(nas.ip || '').trim()) {
    try {
      await db.execute('DELETE FROM routers WHERE deskripsi = ?', [mark]);
      const result = await syncAfterRouterChange(db);
      const reload = await reloadFreeradius();
      return { ok: true, ...result, reload };
    } catch (error) {
      console.error('[radius-nas] lepas NAS CHR gagal:', error.message);
      return { ok: false, error: error.message };
    }
  }
  return syncVpnPeer(db, {
    kind: 'chr',
    peer: {
      id: nas.id,
      name: nas.name,
      address: nas.ip,
      radius_secret: nas.radius_secret,
      enabled: true,
    },
  });
}

async function forgetVpnPeer(db, { kind, peerId }) {
  try {
    await db.execute('DELETE FROM routers WHERE deskripsi = ?', [vpnRouterMark(kind, peerId)]);
    const result = await syncAfterRouterChange(db);
    const reload = await reloadFreeradius();
    return { ok: true, ...result, reload };
  } catch (error) {
    console.error('[radius-nas] hapus NAS peer VPN gagal:', error.message);
    return { ok: false, error: error.message };
  }
}

module.exports = {
  MANAGED_PREFIX,
  MAX_SECRET_LENGTH,
  isValidIpv4,
  routerProblem,
  planNasSync,
  ensureNasTable,
  previewNasSync,
  syncNasFromRouters,
  syncAfterRouterChange,
  reloadFreeradius,
  syncVpnPeer,
  syncChrClient,
  forgetVpnPeer,
};
