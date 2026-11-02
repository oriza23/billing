/**
 * Ambil IP klien untuk pelanggan di walled garden / isolir pool.
 *
 * Tanpa Nginx/reverse proxy: pakai IP sumber koneksi HTTP (req.ip / remoteAddress).
 * Dengan proxy: set TRUST_PROXY=1 di env + app.set('trust proxy') di server.js,
 *               barulah header X-Forwarded-For / X-Real-IP dipakai.
 */

function normalizeIp(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (raw.startsWith('::ffff:')) {
    return raw.slice(7);
  }
  return raw;
}

function readForwardedFor(header) {
  if (!header) {
    return '';
  }
  const first = String(header).split(',')[0].trim();
  return normalizeIp(first);
}

function resolveClientIp(req) {
  const trustProxy = String(process.env.TRUST_PROXY || '') === '1';
  if (trustProxy) {
    const forwarded = readForwardedFor(req.headers['x-forwarded-for']);
    if (forwarded) {
      return forwarded;
    }
    const realIp = normalizeIp(req.headers['x-real-ip']);
    if (realIp) {
      return realIp;
    }
  }
  return normalizeIp(req.ip || req.socket?.remoteAddress);
}

module.exports = { resolveClientIp, normalizeIp };
