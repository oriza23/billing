/**
 * Orkestrasi isolir / buka isolir Full RADIUS (satu sumber kebenaran).
 * Urutan: radusergroup + radreply → PoD (UDP 3799) → status billing.
 */

const pool = require('../../database');
const { kickRadiusUser } = require('../../utils/radius-pod');
const { readIsolirGroupName } = require('./schema');
const { applyRadiusIsolir, applyRadiusNormal } = require('./radius_isolir');
const { resolveRouterForPod } = require('./router_credentials');

class IsolirError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'IsolirError';
    this.statusCode = statusCode;
  }
}

const SELECT_CUSTOMER = `
  SELECT
    c.id,
    c.username,
    c.status,
    c.ktg,
    c.router,
    c.profil_id,
    c.profil_id_sebelum_isolir,
    p.group_name AS profil_group
  FROM langganan_pelanggan c
  LEFT JOIN langganan_profiles p ON p.id = c.profil_id
  WHERE c.id = ?
  LIMIT 1
`;

const defaultDeps = {
  readIsolirGroupName,
  resolveRouterForPod,
  applyRadiusIsolir,
  applyRadiusNormal,
  kickRadiusUser,
};

async function loadCustomer(db, id, { ktgAllowed = ['PPP'] } = {}) {
  const [rows] = await db.execute(SELECT_CUSTOMER, [id]);
  const row = rows[0];
  if (!row) {
    throw new IsolirError('Pelanggan tidak ditemukan', 404);
  }
  if (!ktgAllowed.includes(row.ktg)) {
    throw new IsolirError(
      ktgAllowed.length === 1 && ktgAllowed[0] === 'PPP'
        ? 'Isolir hanya untuk langganan kategori PPP'
        : `Isolir hanya untuk kategori: ${ktgAllowed.join(', ')}`,
      400,
    );
  }
  if (!String(row.username || '').trim()) {
    throw new IsolirError('Username pelanggan kosong', 400);
  }
  return row;
}

async function loadProfilGroup(db, profilId) {
  if (!profilId) {
    return '';
  }
  const [rows] = await db.execute(
    'SELECT group_name FROM langganan_profiles WHERE id = ? LIMIT 1',
    [profilId],
  );
  return String(rows[0]?.group_name || '').trim();
}

async function disconnectSessionViaRadius(username, mikrotikIp, radiusSecret, deps, shouldKick = true) {
  if (shouldKick === false) {
    return { ok: true, skipped: true };
  }
  try {
    const result = await deps.kickRadiusUser(username, mikrotikIp, radiusSecret);
    if (!result.ok) {
      console.warn('[isolir] RADIUS PoD gagal:', result.error, { username, mikrotikIp });
    }
    return result;
  } catch (error) {
    console.error('[isolir] kickRadiusUser exception:', error.message, { username, mikrotikIp });
    return { ok: false, error: error.message };
  }
}

/**
 * @param {number} customerId
 * @param {{ sumber?: string, kick?: boolean, ktgAllowed?: string[], deps?: object }} [options]
 */
async function isolirPelangganFullRadius(customerId, options = {}, db = pool) {
  const {
    sumber = 'manual',
    kick: shouldKick = true,
    ktgAllowed = ['PPP'],
    deps = defaultDeps,
  } = options;

  const customer = await loadCustomer(db, customerId, { ktgAllowed });
  if (customer.status === 'Isolir') {
    throw new IsolirError('Pelanggan sudah berstatus Isolir', 409);
  }

  const creds = await deps.resolveRouterForPod(db, customer.router);
  if (!creds.ok) {
    throw new IsolirError(creds.message, creds.status);
  }

  const isolirGroup = await deps.readIsolirGroupName(db);
  const radiusResult = await deps.applyRadiusIsolir(db, customer.username, isolirGroup);
  if (!radiusResult.ok) {
    throw new IsolirError(radiusResult.error || 'Gagal mengalihkan grup RADIUS', 502);
  }

  const kickResult = await disconnectSessionViaRadius(
    customer.username,
    creds.host,
    creds.radiusSecret,
    deps,
    shouldKick,
  );

  const profilBackup = customer.profil_id_sebelum_isolir ?? customer.profil_id;
  const [updated] = await db.execute(
    `UPDATE langganan_pelanggan
     SET status = 'Isolir',
         profil_id_sebelum_isolir = ?,
         tgl_isolir_dijalankan = NOW(),
         isolir_sumber = ?
     WHERE id = ? AND status <> 'Isolir'`,
    [profilBackup, sumber, customerId],
  );
  if (updated.affectedRows === 0) {
    throw new IsolirError('Status pelanggan sudah berubah saat diproses', 409);
  }

  return {
    success: true,
    message: `Pelanggan diisolir (grup RADIUS: ${isolirGroup}); sesi diputus via PoD bila NAS merespons`,
    id: customerId,
    username: customer.username,
    status: 'Isolir',
    isolir_group: isolirGroup,
    router: creds.router,
    radius: radiusResult,
    kick: kickResult,
  };
}

/**
 * @param {number} customerId
 * @param {{ kick?: boolean, ktgAllowed?: string[], deps?: object }} [options]
 */
async function bukaIsolirPelangganFullRadius(customerId, options = {}, db = pool) {
  const {
    kick: shouldKick = true,
    ktgAllowed = ['PPP'],
    deps = defaultDeps,
  } = options;

  const customer = await loadCustomer(db, customerId, { ktgAllowed });
  if (customer.status !== 'Isolir') {
    throw new IsolirError('Pelanggan tidak sedang isolir', 409);
  }

  const restoredProfilId = customer.profil_id_sebelum_isolir ?? customer.profil_id;
  const profilGroup = await loadProfilGroup(db, restoredProfilId);
  if (!profilGroup) {
    throw new IsolirError(
      'Profil asli pelanggan tidak ditemukan; tidak bisa mengembalikan grup RADIUS',
      422,
    );
  }

  const creds = await deps.resolveRouterForPod(db, customer.router);
  if (!creds.ok) {
    throw new IsolirError(creds.message, creds.status);
  }

  const radiusResult = await deps.applyRadiusNormal(db, customer.username, profilGroup);
  if (!radiusResult.ok) {
    throw new IsolirError(radiusResult.error || 'Gagal mengembalikan grup RADIUS', 502);
  }

  const kickResult = await disconnectSessionViaRadius(
    customer.username,
    creds.host,
    creds.radiusSecret,
    deps,
    shouldKick,
  );

  await db.execute(
    `UPDATE langganan_pelanggan
     SET status = 'Aktif',
         profil_id = COALESCE(?, profil_id),
         profil_id_sebelum_isolir = NULL,
         tgl_isolir_dijalankan = NULL,
         isolir_sumber = NULL
     WHERE id = ?`,
    [restoredProfilId, customerId],
  );

  return {
    success: true,
    message: `Isolir dibuka (grup RADIUS: ${profilGroup}); sesi diputus via PoD agar redial dengan profil normal`,
    id: customerId,
    username: customer.username,
    status: 'Aktif',
    profil_id: restoredProfilId,
    profil_group: profilGroup,
    router: creds.router,
    radius: radiusResult,
    kick: kickResult,
  };
}

module.exports = {
  IsolirError,
  defaultDeps,
  loadCustomer,
  isolirPelangganFullRadius,
  bukaIsolirPelangganFullRadius,
};
