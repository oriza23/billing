/**
 * Header keamanan untuk semua respons (API, /uploads, dan frontend dist).
 *
 * Dipasang paling awal di server.js supaya ikut terkirim pada respons error sekalipun.
 * CSP sengaja memakai 'unsafe-inline' untuk script & style karena index.html hasil build
 * memuat skrip tema inline dan React menulis atribut style inline.
 */

const TILE_OPENSTREETMAP = 'https://tile.openstreetmap.org';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `img-src 'self' data: blob: ${TILE_OPENSTREETMAP}`,
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
].join('; ');

// HSTS hanya dikirim bila permintaan memang lewat HTTPS (langsung atau reverse proxy).
function isHttps(req) {
  if (req.secure) {
    return true;
  }
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return forwarded === 'https';
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  if (isHttps(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

module.exports = securityHeaders;
module.exports.CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY;
module.exports.isHttps = isHttps;
