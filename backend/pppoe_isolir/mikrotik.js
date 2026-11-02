/**
 * Orkestrasi isolir MikroTik: RouterOS API (v6/v7, port 8728) + CoA/RADIUS.
 *
 * Lapisan rendah: ./mikrotik_ros_api.js (node-routeros)
 * Kredensial: routers.api_user / api_password / api_port atau env MIKROTIK_API_*
 */

const { disconnectUser } = require('../langganan_isolir');
const { GROUP_ATTRIBUTE } = require('../radius_group');
const {
  apiCredentials,
  resolveRosConnectionOptions,
  setPppSecretProfileOnRouter,
  removePppActiveByUsernameOnRouter,
} = require('./mikrotik_ros_api');

async function loadRouterForCustomer(db, customer) {
  if (!customer?.router || customer.router === 'ALL ROUTER') {
    const [rows] = await db.execute(
      "SELECT id, nama_router, ip_address, secret, api_user, api_password, api_port FROM routers WHERE status = 'Aktif' ORDER BY id ASC LIMIT 1",
    );
    return rows[0] || null;
  }
  const [rows] = await db.execute(
    'SELECT id, nama_router, ip_address, secret, api_user, api_password, api_port FROM routers WHERE BINARY nama_router = ? LIMIT 1',
    [customer.router],
  );
  return rows[0] || null;
}

/** @alias setPppSecretProfileOnRouter */
async function setPppSecretProfile(router, username, profileName) {
  return setPppSecretProfileOnRouter(router, username, profileName);
}

/** @alias removePppActiveByUsernameOnRouter */
async function removePppActiveByUsername(router, username) {
  return removePppActiveByUsernameOnRouter(router, username);
}

async function writeUserRadReplyGroup(db, username, groupName) {
  if (!username) {
    return;
  }
  await db.execute(
    'DELETE FROM radreply WHERE username = ? AND attribute = ?',
    [username, GROUP_ATTRIBUTE],
  );
  if (groupName) {
    await db.execute(
      "INSERT INTO radreply (username, attribute, op, value) VALUES (?, ?, ':=', ?)",
      [username, GROUP_ATTRIBUTE, groupName],
    );
  }
}

async function applyMikrotikIsolation(db, customer, profileName) {
  const router = await loadRouterForCustomer(db, customer);
  await writeUserRadReplyGroup(db, customer.username, profileName);

  const secret = router
    ? await setPppSecretProfile(router, customer.username, profileName)
    : { ok: false, skipped: true, reason: 'Router tidak ditemukan' };

  return { router: router?.nama_router || null, secret };
}

async function applyMikrotikNormalProfile(db, customer, profileName) {
  const router = await loadRouterForCustomer(db, customer);
  await writeUserRadReplyGroup(db, customer.username, profileName || '');

  const secret = router && profileName
    ? await setPppSecretProfile(router, customer.username, profileName)
    : { ok: false, skipped: true, reason: 'Router atau nama profil kosong' };

  return { router: router?.nama_router || null, secret };
}

async function kickPppoeSession(db, username, customer = null) {
  const coa = await disconnectUser(db, username);
  let mikrotik = { removed: 0, gagal: 0, skipped: true };

  if (customer) {
    const router = await loadRouterForCustomer(db, customer);
    if (router && resolveRosConnectionOptions(router)) {
      mikrotik = await removePppActiveByUsername(router, username);
      mikrotik.skipped = false;
    }
  }

  return {
    diputus: coa.diputus + (mikrotik.removed || 0),
    gagal: coa.gagal + (mikrotik.gagal || 0),
    coa,
    mikrotik,
  };
}

module.exports = {
  loadRouterForCustomer,
  setPppSecretProfile,
  removePppActiveByUsername,
  writeUserRadReplyGroup,
  applyMikrotikIsolation,
  applyMikrotikNormalProfile,
  kickPppoeSession,
  apiCredentials,
  resolveRosConnectionOptions,
};
