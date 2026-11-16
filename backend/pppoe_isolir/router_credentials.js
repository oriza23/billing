/**
 * Kredensial RouterOS API untuk pelanggan: router pelanggan, atau router Aktif pertama
 * bila ALL ROUTER. Dipakai endpoint isolir dan cron isolir jatuh tempo.
 */

async function resolveRouterCredentials(db, routerName) {
  let router = null;
  if (routerName && routerName !== 'ALL ROUTER') {
    const [rows] = await db.execute(
      'SELECT nama_router, ip_address, api_user, api_password, secret FROM routers WHERE BINARY nama_router = ? LIMIT 1',
      [routerName],
    );
    router = rows[0] || null;
  }
  if (!router) {
    const [rows] = await db.execute(
      "SELECT nama_router, ip_address, api_user, api_password, secret FROM routers WHERE status = 'Aktif' ORDER BY id ASC LIMIT 1",
    );
    router = rows[0] || null;
  }
  if (!router?.ip_address) {
    return { ok: false, status: 422, message: 'Router pelanggan tidak ditemukan atau IP kosong' };
  }

  const host = String(router.ip_address).trim();
  const user = String(router.api_user || process.env.MIKROTIK_API_USER || '').trim();
  const pass = router.api_password ?? process.env.MIKROTIK_API_PASSWORD ?? '';

  if (!user || pass === '') {
    return {
      ok: false,
      status: 422,
      message: 'Kredensial API MikroTik belum diisi (routers.api_user/api_password atau env MIKROTIK_API_*)',
    };
  }

  const radiusSecret = String(router.secret || process.env.RADIUS_SECRET || '').trim();

  return {
    ok: true,
    host,
    user,
    pass: String(pass),
    radiusSecret,
    router: router.nama_router,
  };
}

/** NAS untuk RADIUS PoD: cukup IP + secret (tanpa kredensial RouterOS API). */
async function resolveRouterForPod(db, routerName) {
  let router = null;
  if (routerName && routerName !== 'ALL ROUTER') {
    const [rows] = await db.execute(
      'SELECT nama_router, ip_address, secret FROM routers WHERE BINARY nama_router = ? LIMIT 1',
      [routerName],
    );
    router = rows[0] || null;
  }
  if (!router) {
    const [rows] = await db.execute(
      "SELECT nama_router, ip_address, secret FROM routers WHERE status = 'Aktif' ORDER BY id ASC LIMIT 1",
    );
    router = rows[0] || null;
  }
  if (!router?.ip_address) {
    return { ok: false, status: 422, message: 'Router pelanggan tidak ditemukan atau IP kosong' };
  }

  const host = String(router.ip_address).trim();
  const radiusSecret = String(router.secret || process.env.RADIUS_SECRET || '').trim();
  if (!radiusSecret) {
    return {
      ok: false,
      status: 422,
      message: 'Secret RADIUS kosong (routers.secret atau env RADIUS_SECRET)',
    };
  }

  return {
    ok: true,
    host,
    radiusSecret,
    router: router.nama_router,
  };
}

module.exports = { resolveRouterCredentials, resolveRouterForPod };
