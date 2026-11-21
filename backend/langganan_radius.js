const { ALL_SERVER } = require('./router_servers');

// Akun RADIUS untuk pelanggan di Data Langganan.
//
// Aturan login yang ditulis ke RADIUS mengikuti pilihan di data langganan:
//   - Router tertentu  -> NAS-IP-Address == IP router itu (menu Router)
//   - ALL ROUTER       -> tanpa batas router
//   - Server tertentu  -> Called-Station-Id == nama server (MikroTik mengirim
//                         Service Name PPPoE / nama server Hotspot di atribut ini)
//   - ALL SERVER       -> tanpa Called-Station-Id, login dari server mana saja
//   - Akun PPP         -> Framed-Protocol == PPP (tidak bisa login di Hotspot)
//   - Akun Hotspot     -> Framed-Protocol != PPP (tidak bisa dial PPPoE,
//                         termasuk di server bertipe both)
//   - Status Non Aktif atau Isolir -> Auth-Type := Reject (login ditolak)
const ALL_ROUTER = 'ALL ROUTER';
const MAX_RADIUS_USERNAME = 64;
const RADIUS_KATEGORI = ['PPP', 'Hotspot'];
const FRAMED_PROTOCOL = 'Framed-Protocol';

// Baris radcheck yang memisahkan PPP dan Hotspot. null bila kategori tidak login RADIUS.
// Operator '!=' lolos bila request tidak mengirim Framed-Protocol (login Hotspot MikroTik).
function protocolCheck(ktg) {
  if (ktg === 'PPP') {
    return [FRAMED_PROTOCOL, '==', 'PPP'];
  }
  if (ktg === 'Hotspot') {
    return [FRAMED_PROTOCOL, '!=', 'PPP'];
  }
  return null;
}

class RadiusSyncError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'RadiusSyncError';
    this.statusCode = statusCode;
  }
}

// Hanya kategori PPP dan Hotspot yang login lewat RADIUS dan punya password.
function usesRadius(customer) {
  return RADIUS_KATEGORI.includes(customer.ktg)
    && Boolean(customer.username)
    && Boolean(customer.password);
}

// Menghapus seluruh baris RADIUS milik username (akun langganan dimiliki penuh
// oleh data langganan, jadi semua barisnya boleh diganti).
async function removeAccount(db, username) {
  if (!username) {
    return;
  }
  await db.execute('DELETE FROM radcheck WHERE username = ?', [username]);
  await db.execute('DELETE FROM radusergroup WHERE username = ?', [username]);
}

// Username RADIUS harus unik di seluruh sistem: tidak boleh bentrok dengan
// langganan lain, voucher Hotspot, atau akun dari halaman PPPoE Pelanggan.
async function assertUsernameFree(db, username, ownId = null) {
  if (username.length > MAX_RADIUS_USERNAME) {
    throw new RadiusSyncError(`Username maksimal ${MAX_RADIUS_USERNAME} karakter agar bisa dipakai di RADIUS`);
  }
  const [others] = await db.execute(
    'SELECT id FROM langganan_pelanggan WHERE username = ? AND id <> ? LIMIT 1',
    [username, ownId ?? 0],
  );
  if (others.length > 0) {
    throw new RadiusSyncError('Username sudah dipakai langganan lain', 409);
  }
  const [used] = await db.execute(
    'SELECT username FROM radcheck WHERE username = ? LIMIT 1',
    [username],
  );
  if (used.length > 0) {
    throw new RadiusSyncError(
      'Username sudah ada di RADIUS (voucher Hotspot atau akun PPPoE Pelanggan). Gunakan username lain atau hapus akun itu dulu',
      409,
    );
  }
}

// Hasil pilihan router untuk kunci NAS.
//   ALL ROUTER / kosong -> tidak dikunci (boleh di semua NAS)
//   nama router dikenal -> dikunci ke IP router itu
//   nama tidak dikenal  -> unknown, jangan dibuka jadi semua NAS
function nasLockForRouter(router, ipByName) {
  const name = typeof router === 'string' ? router.trim() : '';
  if (!name || name === ALL_ROUTER) {
    return { lock: false, ip: '' };
  }
  const ip = String(ipByName.get(name) || '').trim();
  if (!ip) {
    return { lock: true, ip: '', unknown: true };
  }
  return { lock: true, ip };
}

// Samakan radcheck dengan pilihan router di billing.
// Langganan menimpa voucher bila satu username tercatat di keduanya.
// Akun yang hanya ada di halaman PPPoE Pelanggan tidak diubah.
async function syncRouterLocks(db) {
  const [routerRows] = await db.execute('SELECT nama_router, ip_address FROM routers');
  const ipByName = new Map(routerRows.map((row) => [row.nama_router, row.ip_address]));
  const [vouchers] = await db.execute(
    `SELECT username, router FROM hotspot_vouchers
     WHERE username IS NOT NULL AND TRIM(username) <> ''`,
  );
  const [customers] = await db.execute(
    `SELECT username, router FROM langganan_pelanggan
     WHERE ktg IN ('PPP', 'Hotspot') AND username IS NOT NULL AND TRIM(username) <> ''`,
  );

  const desired = new Map();
  for (const row of [...vouchers, ...customers]) {
    desired.set(row.username, nasLockForRouter(row.router, ipByName));
  }

  const summary = { locked: 0, opened: 0, skipped: 0 };
  for (const [username, lock] of desired) {
    if (lock.unknown) {
      summary.skipped += 1;
      continue;
    }
    if (!lock.ip) {
      const [removed] = await db.execute(
        "DELETE FROM radcheck WHERE username = ? AND attribute = 'NAS-IP-Address'",
        [username],
      );
      summary.opened += Number(removed?.affectedRows || 0);
      continue;
    }
    const [current] = await db.execute(
      "SELECT value FROM radcheck WHERE username = ? AND attribute = 'NAS-IP-Address'",
      [username],
    );
    const values = current.map((row) => String(row.value).trim());
    if (values.length === 1 && values[0] === lock.ip) {
      continue;
    }
    await db.execute(
      "DELETE FROM radcheck WHERE username = ? AND attribute = 'NAS-IP-Address'",
      [username],
    );
    await db.execute(
      "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'NAS-IP-Address', '==', ?)",
      [username, lock.ip],
    );
    summary.locked += 1;
  }
  return summary;
}

// Atribut radcheck pembatas NAS & server. Dipakai data langganan dan PPPoE pelanggan.
//   router  : nama router, atau ALL ROUTER (tanpa batas NAS)
//   server  : nama server (PPPoE Service / Hotspot server), atau ALL SERVER
// Router tertentu -> NAS-IP-Address == IP router. Server tertentu -> Called-Station-Id == nama server.
async function buildScopeRows(db, { router, server }) {
  if (!router) {
    throw new RadiusSyncError('Router wajib dipilih');
  }
  const rows = [];
  if (router !== ALL_ROUTER) {
    const [routerRows] = await db.execute(
      'SELECT ip_address FROM routers WHERE BINARY nama_router = ? LIMIT 1',
      [router],
    );
    const nasIp = routerRows[0]?.ip_address || '';
    if (!nasIp) {
      throw new RadiusSyncError(`Router "${router}" tidak ditemukan atau belum punya IP address`);
    }
    rows.push(['NAS-IP-Address', '==', nasIp]);
  }
  if (server && server !== ALL_SERVER) {
    rows.push(['Called-Station-Id', '==', server]);
  }
  return rows;
}

// Baris radcheck + radusergroup yang seharusnya ada untuk pelanggan ini.
async function buildAccountRows(db, customer) {
  const scope = await buildScopeRows(db, { router: customer.router, server: customer.server });

  let groupName = '';
  if (customer.profil_id) {
    const [profileRows] = await db.execute(
      'SELECT group_name FROM langganan_profiles WHERE id = ? LIMIT 1',
      [customer.profil_id],
    );
    groupName = (profileRows[0]?.group_name || '').trim();
  }

  const radcheck = [['Cleartext-Password', ':=', customer.password], ...scope];
  const protocol = protocolCheck(customer.ktg);
  if (protocol) {
    radcheck.push(protocol);
  }
  if (customer.status !== 'Aktif') {
    radcheck.push(['Auth-Type', ':=', 'Reject']);
  }
  return { radcheck, groupName };
}

// Ganti baris Framed-Protocol milik satu username. Dipakai halaman PPPoE Pelanggan,
// yang tidak menulis ulang seluruh radcheck seperti writeAccount.
async function replaceFramedProtocol(db, username, ktg) {
  const row = protocolCheck(ktg);
  if (!username || !row) {
    return;
  }
  await db.execute(
    "DELETE FROM radcheck WHERE username = ? AND attribute = 'Framed-Protocol'",
    [username],
  );
  await db.execute(
    'INSERT INTO radcheck (username, attribute, op, value) VALUES (?, ?, ?, ?)',
    [username, row[0], row[1], row[2]],
  );
}

// Menimpa akun RADIUS pelanggan sesuai data langganan terbaru. Dipanggil di
// dalam transaksi yang sama dengan penyimpanan data langganan.
async function writeAccount(db, customer) {
  await removeAccount(db, customer.username);
  if (!usesRadius(customer)) {
    return;
  }

  const { radcheck, groupName } = await buildAccountRows(db, customer);
  for (const [attribute, op, value] of radcheck) {
    await db.execute(
      'INSERT INTO radcheck (username, attribute, op, value) VALUES (?, ?, ?, ?)',
      [customer.username, attribute, op, value],
    );
  }
  if (groupName) {
    await db.execute(
      'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
      [customer.username, groupName],
    );
  }
}

// Profil langganan berubah nama grup RADIUS-nya: perbarui grup semua pelanggan
// yang sudah punya akun. groupName kosong berarti grup dicabut.
async function syncProfileGroup(db, profilId, groupName) {
  await db.execute(
    `DELETE ug FROM radusergroup ug
     INNER JOIN langganan_pelanggan c ON c.username = ug.username
     WHERE c.profil_id = ? AND c.ktg IN ('PPP', 'Hotspot')`,
    [profilId],
  );
  if (!groupName) {
    return;
  }
  await db.execute(
    `INSERT INTO radusergroup (username, groupname, priority)
     SELECT DISTINCT c.username, ?, 1 FROM langganan_pelanggan c
     WHERE c.profil_id = ? AND c.ktg IN ('PPP', 'Hotspot')
       AND EXISTS (
         SELECT 1 FROM radcheck r
         WHERE r.username = c.username AND r.attribute = 'Cleartext-Password'
       )`,
    [groupName, profilId],
  );
}

// Username akun PPP: langganan kategori PPP, plus akun PPPoE Pelanggan
// (ada password di radcheck, bukan voucher, bukan langganan Hotspot/kategori lain).
const PPP_USERNAME_SQL = `
  SELECT username FROM langganan_pelanggan
  WHERE ktg = 'PPP' AND username IS NOT NULL AND TRIM(username) <> ''
  UNION
  SELECT c.username FROM radcheck c
  WHERE c.attribute = 'Cleartext-Password'
    AND NOT EXISTS (SELECT 1 FROM hotspot_vouchers v WHERE v.username = c.username)
    AND NOT EXISTS (
      SELECT 1 FROM langganan_pelanggan p
      WHERE p.username = c.username AND p.ktg <> 'PPP'
    )`;

const HOTSPOT_USERNAME_SQL = `
  SELECT username FROM hotspot_vouchers
  WHERE username IS NOT NULL AND TRIM(username) <> ''
  UNION
  SELECT username FROM langganan_pelanggan
  WHERE ktg = 'Hotspot' AND username IS NOT NULL AND TRIM(username) <> ''`;

// Tulis ulang Framed-Protocol untuk satu kelompok username. Aman diulang:
// baris lama atribut itu dihapus, lalu satu baris yang benar disisipkan.
async function rewriteProtocol(db, usernameSql, op) {
  await db.execute(
    `DELETE FROM radcheck
     WHERE attribute = 'Framed-Protocol'
       AND username IN (SELECT username FROM (${usernameSql}) protokol_user)`,
  );
  await db.execute(
    `INSERT INTO radcheck (username, attribute, op, value)
     SELECT u.username, 'Framed-Protocol', ?, 'PPP'
     FROM (${usernameSql}) u
     WHERE EXISTS (
       SELECT 1 FROM radcheck r
       WHERE r.username = u.username AND r.attribute = 'Cleartext-Password'
     )`,
    [op],
  );
}

// Akun yang sudah ada sebelum pemisah protokol: Hotspot tidak boleh punya
// Framed-Protocol == PPP, dan akun PPP harus punya Framed-Protocol == PPP.
// Langganan PPP ditulis belakangan supaya menang bila satu username tercatat ganda.
async function ensureProtocolSeparation(db) {
  const conn = typeof db.getConnection === 'function' ? await db.getConnection() : db;
  const ownConnection = conn !== db;
  try {
    if (ownConnection) {
      await conn.beginTransaction();
    }
    await rewriteProtocol(conn, HOTSPOT_USERNAME_SQL, '!=');
    await rewriteProtocol(conn, PPP_USERNAME_SQL, '==');
    if (ownConnection) {
      await conn.commit();
    }
  } catch (error) {
    if (ownConnection) {
      await conn.rollback().catch(() => {});
    }
    throw error;
  } finally {
    if (ownConnection) {
      conn.release();
    }
  }
}

// Nama server di menu Router berubah: Called-Station-Id yang menunjuk ke nama
// lama ikut diganti, hanya untuk akun yang memang terikat ke router pemilik
// server itu. Server lain yang kebetulan bernama sama tidak disentuh.
// Dipanggil SETELAH baris router_servers diubah, di transaksi yang sama.
async function renameServerBindings(db, { oldName, newName, routerName, routerIp }) {
  const result = { radcheck: 0, radgroupcheck: 0, langganan: 0, voucher: 0 };
  if (!oldName || !newName || oldName === newName) {
    return result;
  }
  const ip = String(routerIp || '').trim();

  const [[{ n }]] = await db.execute(
    'SELECT COUNT(*) AS n FROM router_servers WHERE nama = ?',
    [oldName],
  );
  // Nama lama masih dipakai server di router lain: akun ALL ROUTER (tanpa NAS-IP)
  // tetap memakai nama itu, karena masih valid di router yang tidak diganti.
  const stillUsed = Number(n) > 0;

  const add = (total, header) => total + Number(header?.affectedRows || 0);

  const [langganan] = await db.execute(
    'UPDATE langganan_pelanggan SET server = ? WHERE server = ? AND router = ?',
    [newName, oldName, routerName],
  );
  result.langganan = add(result.langganan, langganan);
  const [voucher] = await db.execute(
    'UPDATE hotspot_vouchers SET server = ? WHERE server = ? AND router = ?',
    [newName, oldName, routerName],
  );
  result.voucher = add(result.voucher, voucher);

  if (!stillUsed) {
    const [langgananAll] = await db.execute(
      'UPDATE langganan_pelanggan SET server = ? WHERE server = ? AND router = ?',
      [newName, oldName, ALL_ROUTER],
    );
    result.langganan = add(result.langganan, langgananAll);
    const [voucherAll] = await db.execute(
      'UPDATE hotspot_vouchers SET server = ? WHERE server = ? AND router = ?',
      [newName, oldName, ALL_ROUTER],
    );
    result.voucher = add(result.voucher, voucherAll);
  }

  // Akun yang dikunci ke IP router ini (bukan ALL ROUTER).
  if (ip) {
    const [byNas] = await db.execute(
      `UPDATE radcheck SET value = ?
       WHERE attribute = 'Called-Station-Id' AND value = ?
         AND username IN (
           SELECT username FROM (
             SELECT username FROM radcheck WHERE attribute = 'NAS-IP-Address' AND value = ?
           ) nas_user
         )`,
      [newName, oldName, ip],
    );
    result.radcheck = add(result.radcheck, byNas);
  }

  // Akun yang baris billing-nya baru saja dipindah ke nama baru (termasuk ALL ROUTER
  // bila nama lama sudah tidak dipakai server mana pun).
  const [byBilling] = await db.execute(
    `UPDATE radcheck SET value = ?
     WHERE attribute = 'Called-Station-Id' AND value = ?
       AND (
         username IN (SELECT username FROM langganan_pelanggan WHERE server = ? AND router = ?)
         OR username IN (SELECT username FROM hotspot_vouchers WHERE server = ? AND router = ?)
         OR username IN (SELECT username FROM langganan_pelanggan WHERE server = ? AND router = ?)
         OR username IN (SELECT username FROM hotspot_vouchers WHERE server = ? AND router = ?)
       )`,
    [
      newName, oldName,
      newName, routerName, newName, routerName,
      newName, ALL_ROUTER, newName, ALL_ROUTER,
    ],
  );
  result.radcheck = add(result.radcheck, byBilling);

  if (!stillUsed) {
    // Akun PPPoE Pelanggan ALL ROUTER: hanya ada di radcheck, tanpa baris billing.
    const [open] = await db.execute(
      `UPDATE radcheck SET value = ?
       WHERE attribute = 'Called-Station-Id' AND value = ?
         AND username NOT IN (
           SELECT username FROM (
             SELECT username FROM radcheck WHERE attribute = 'NAS-IP-Address'
           ) nas_user
         )`,
      [newName, oldName],
    );
    result.radcheck = add(result.radcheck, open);
    // Grup tidak menyimpan router. Hanya diganti bila tidak ada server lain
    // yang masih memakai nama lama.
    const [group] = await db.execute(
      "UPDATE radgroupcheck SET value = ? WHERE attribute = 'Called-Station-Id' AND value = ?",
      [newName, oldName],
    );
    result.radgroupcheck = add(result.radgroupcheck, group);
  }

  return result;
}

module.exports = {
  ALL_ROUTER,
  MAX_RADIUS_USERNAME,
  RadiusSyncError,
  usesRadius,
  removeAccount,
  assertUsernameFree,
  buildAccountRows,
  buildScopeRows,
  nasLockForRouter,
  syncRouterLocks,
  protocolCheck,
  replaceFramedProtocol,
  ensureProtocolSeparation,
  renameServerBindings,
  writeAccount,
  syncProfileGroup,
};
