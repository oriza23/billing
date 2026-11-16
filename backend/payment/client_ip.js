/**
 * Ambil IP klien untuk pelanggan di walled garden / isolir pool, serta log audit.
 *
 * Tanpa Nginx/reverse proxy: pakai IP sumber koneksi HTTP (req.ip / remoteAddress).
 * Dengan proxy: set TRUST_PROXY=1 di env + app.set('trust proxy') di server.js,
 *               barulah header X-Forwarded-For / X-Real-IP dipakai.
 *
 * Bila koneksi masuk dari loopback (Nginx di mesin yang sama) tetapi header
 * X-Forwarded-For / X-Real-IP ada, IP klien diambil dari header — walau TRUST_PROXY belum diset.
 */

function normalizeIp(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (raw.startsWith('::ffff:')) {
    return raw.slice(7);
  }
  if (raw === '::1' || raw === '0:0:0:0:0:0:0:1') {
    return '127.0.0.1';
  }
  return raw;
}

function isLoopback(ip) {
  const n = normalizeIp(ip);
  return n === '127.0.0.1';
}

function readForwardedFor(header) {
  if (!header) {
    return '';
  }
  const first = String(header).split(',')[0].trim();
  return normalizeIp(first);
}

function readProxyClientIp(req) {
  const forwarded = readForwardedFor(req.headers['x-forwarded-for']);
  if (forwarded && !isLoopback(forwarded)) {
    return forwarded;
  }
  const realIp = normalizeIp(req.headers['x-real-ip']);
  if (realIp && !isLoopback(realIp)) {
    return realIp;
  }
  const cf = normalizeIp(req.headers['cf-connecting-ip']);
  if (cf && !isLoopback(cf)) {
    return cf;
  }
  return '';
}

function resolveClientIp(req) {
  const trustProxy = String(process.env.TRUST_PROXY || '') === '1';
  if (trustProxy) {
    const fromHeader = readProxyClientIp(req);
    if (fromHeader) {
      return fromHeader;
    }
  }

  const direct = normalizeIp(req.ip || req.socket?.remoteAddress);

  // Nginx/Caddy di localhost sering mengisi X-Forwarded-For walau TRUST_PROXY belum diset.
  if (isLoopback(direct)) {
    const fromHeader = readProxyClientIp(req);
    if (fromHeader) {
      return fromHeader;
    }
  }

  return direct;
}

module.exports = { resolveClientIp, normalizeIp, isLoopback, readProxyClientIp };
