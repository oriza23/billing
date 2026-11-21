'use strict';
/**
 * Validasi + render konfigurasi VPN client (WireGuard / OpenVPN / SSTP) untuk koneksi
 * server billing ke MikroTik CHR, serta penulisan berkasnya ke OS.
 *
 * Modul ini SENGAJA hanya memakai modul inti Node (tanpa database/express) karena salinannya
 * juga dipasang root-only oleh deploy/install-vpn-helper.sh dan dipakai helper `sudo`.
 * Helper memvalidasi ulang dan merender sendiri semua berkas dari template, jadi proses
 * aplikasi (non-root) tidak pernah bisa menyuruh root menulis isi sembarang.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PROTOCOLS = ['wireguard', 'openvpn', 'sstp'];
const UNITS = {
  wireguard: 'wg-quick@wg-billing',
  openvpn: 'openvpn-client@raniah-vpn',
  sstp: 'raniah-sstp',
};
const INTERFACES = {
  wireguard: 'wg-billing',
  openvpn: 'raniah-ovpn',
  sstp: 'raniah-sstp',
};
const PATHS = {
  wireguard: '/etc/wireguard/wg-billing.conf',
  ovpn: '/etc/openvpn/client/raniah-vpn.conf',
  ovpnAuth: '/etc/openvpn/client/raniah-vpn.auth',
  sstpPeer: '/etc/ppp/peers/raniah-sstp',
  sstpRoutes: '/etc/ppp/raniah-sstp.routes',
  sstpHook: '/etc/ppp/ip-up.d/raniah-sstp',
  sstpUnit: '/etc/systemd/system/raniah-sstp.service',
};
const SSTPC_CANDIDATES = ['/usr/sbin/sstpc', '/usr/bin/sstpc', '/usr/local/sbin/sstpc', '/usr/local/bin/sstpc'];

// Prefix terkecil yang boleh dirutekan lewat tunnel. /0../7 ditolak karena bisa menelan
// default route server (SSH/web ikut putus), termasuk trik 0.0.0.0/1 + 128.0.0.0/1.
const MIN_ROUTE_PREFIX = 8;
const MAX_ROUTES = 16;
const MAX_OVPN_BYTES = 64 * 1024;
const HEADER = '# RANIAH Billing - dibuat otomatis dari menu Sistem > Koneksi VPN. Jangan diedit manual.';

class VpnValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'VpnValidationError';
    this.status = 400;
    this.field = field || null;
  }
}

function fail(message, field) {
  throw new VpnValidationError(message, field);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// ---------------------------------------------------------------------------
// IPv4 / host helper
// ---------------------------------------------------------------------------
const OCTET = /^(0|[1-9]\d{0,2})$/;

function parseIPv4(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4) {
    return null;
  }
  let number = 0;
  for (const part of parts) {
    if (!OCTET.test(part) || Number(part) > 255) {
      return null;
    }
    number = number * 256 + Number(part);
  }
  return number;
}

function formatIPv4(number) {
  return [
    Math.floor(number / 16777216) % 256,
    Math.floor(number / 65536) % 256,
    Math.floor(number / 256) % 256,
    number % 256,
  ].join('.');
}

function parseCidr(value, { minPrefix = 0 } = {}) {
  const match = /^([0-9.]+)\/(\d{1,2})$/.exec(String(value).trim());
  if (!match) {
    return null;
  }
  const ip = parseIPv4(match[1]);
  const prefix = Number(match[2]);
  if (ip === null || prefix > 32 || prefix < minPrefix) {
    return null;
  }
  const size = 2 ** (32 - prefix);
  const network = Math.floor(ip / size) * size;
  return {
    ip,
    prefix,
    network,
    size,
    cidr: `${formatIPv4(network)}/${prefix}`,
    host: `${formatIPv4(ip)}/${prefix}`,
  };
}

function inCidr(ip, parsed) {
  return ip >= parsed.network && ip < parsed.network + parsed.size;
}

function isHost(host) {
  if (!host || host.length > 253) {
    return false;
  }
  if (/^[0-9.]+$/.test(host)) {
    const ip = parseIPv4(host);
    // Alamat tujuan tidak boleh 0.x, loopback (127/8), atau multicast/reserved (>= 224.0.0.0).
    return ip !== null && ip >= 16777216 && !(ip >= 2130706432 && ip < 2147483648) && ip < 3758096384;
  }
  return host.split('.').every((label) => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

// host[:port] -> { host, port, ip }. Host tidak boleh diawali "-" (cegah injeksi opsi).
function parseHostPort(value, { portRequired = false, defaultPort = null, field, label }) {
  const raw = text(value);
  if (!raw) {
    fail(`${label} wajib diisi.`, field);
  }
  const match = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(raw);
  if (!match || !isHost(match[1])) {
    fail(`${label} tidak valid. Gunakan IPv4 atau domain, mis. chr.contoh.net${portRequired ? ':51820' : ''}.`, field);
  }
  let port = match[2] ? Number(match[2]) : defaultPort;
  if (match[2] && (port < 1 || port > 65535)) {
    fail(`Port ${label} harus 1-65535.`, field);
  }
  if (port === null || port === undefined) {
    if (portRequired) {
      fail(`${label} harus memakai port, mis. ${match[1]}:51820.`, field);
    }
    port = null;
  }
  return { host: match[1], port, ip: /^[0-9.]+$/.test(match[1]) ? parseIPv4(match[1]) : null };
}

function parseRouteList(value, { field, label, required }) {
  const items = text(value).split(/[\s,]+/).filter(Boolean);
  if (items.length === 0) {
    if (required) {
      fail(`${label} wajib diisi, mis. 10.10.99.0/24.`, field);
    }
    return [];
  }
  if (items.length > MAX_ROUTES) {
    fail(`${label} maksimal ${MAX_ROUTES} subnet.`, field);
  }
  const out = [];
  for (const item of items) {
    const parsed = parseCidr(item);
    if (!parsed) {
      fail(`${label} "${item.slice(0, 40)}" tidak valid. Gunakan format IPv4/CIDR, mis. 10.10.99.0/24.`, field);
    }
    if (parsed.prefix < MIN_ROUTE_PREFIX) {
      fail(
        `${label} "${item}" terlalu luas (minimal /${MIN_ROUTE_PREFIX}). Jangan isi 0.0.0.0/0, `
        + 'karena seluruh trafik server akan masuk tunnel dan akses ke VPS terputus.',
        field,
      );
    }
    if (!out.some((existing) => existing.cidr === parsed.cidr)) {
      out.push(parsed);
    }
  }
  return out;
}

function assertNotRoutingEndpoint(endpointIp, routes, { field, label }) {
  if (endpointIp === null) {
    return;
  }
  const hit = routes.find((route) => inCidr(endpointIp, route));
  if (hit) {
    fail(
      `${label} ${hit.cidr} memuat alamat CHR itu sendiri (${formatIPv4(endpointIp)}). `
      + 'Tunnel akan melewati dirinya sendiri dan koneksi terputus. Persempit subnet-nya.',
      field,
    );
  }
}

// ---------------------------------------------------------------------------
// Kunci WireGuard (X25519). Pakai `wg` bila ada, jika tidak pakai crypto Node.
// ---------------------------------------------------------------------------
const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function publicKeyViaCrypto(privateKeyB64) {
  const raw = Buffer.from(privateKeyB64, 'base64');
  if (raw.length !== 32) {
    throw new Error('Private key WireGuard tidak valid.');
  }
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, raw]), format: 'der', type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32).toString('base64');
}

function keypairViaCrypto() {
  const { privateKey } = crypto.generateKeyPairSync('x25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  const raw = Buffer.from(der.subarray(der.length - 32));
  // Clamping sama seperti `wg genkey`.
  raw[0] &= 248;
  raw[31] &= 127;
  raw[31] |= 64;
  const priv = raw.toString('base64');
  return { private_key: priv, public_key: publicKeyViaCrypto(priv) };
}

function wgBinary() {
  for (const dir of ['/usr/bin', '/usr/sbin', '/usr/local/bin']) {
    if (fs.existsSync(path.join(dir, 'wg'))) {
      return path.join(dir, 'wg');
    }
  }
  return null;
}

function generateKeypair({ exec = execFileSync } = {}) {
  const wg = wgBinary();
  if (wg) {
    try {
      const priv = String(exec(wg, ['genkey'], { timeout: 5000 })).trim();
      const pub = String(exec(wg, ['pubkey'], { input: `${priv}\n`, timeout: 5000 })).trim();
      if (WG_KEY_RE.test(priv) && WG_KEY_RE.test(pub)) {
        return { private_key: priv, public_key: pub, source: 'wg' };
      }
    } catch {
      // jatuh ke crypto Node
    }
  }
  return { ...keypairViaCrypto(), source: 'node-crypto' };
}

function derivePublicKey(privateKey, { exec = execFileSync } = {}) {
  if (!WG_KEY_RE.test(privateKey || '')) {
    return '';
  }
  const wg = wgBinary();
  if (wg) {
    try {
      const pub = String(exec(wg, ['pubkey'], { input: `${privateKey}\n`, timeout: 5000 })).trim();
      if (WG_KEY_RE.test(pub)) {
        return pub;
      }
    } catch {
      // fallback
    }
  }
  return publicKeyViaCrypto(privateKey);
}

// ---------------------------------------------------------------------------
// WireGuard
// ---------------------------------------------------------------------------
function validateWireguard(input = {}, existing = null) {
  const endpoint = parseHostPort(input.endpoint, {
    portRequired: true, field: 'endpoint', label: 'Endpoint CHR',
  });
  const serverKey = text(input.server_public_key);
  if (!WG_KEY_RE.test(serverKey)) {
    fail('CHR Public Key tidak valid (harus 44 karakter base64 berakhiran "=").', 'server_public_key');
  }
  const privateKey = text(input.private_key) || existing?.private_key || '';
  if (!privateKey) {
    fail('Private Key wajib diisi. Tekan Generate Keypair untuk membuatnya.', 'private_key');
  }
  if (!WG_KEY_RE.test(privateKey)) {
    fail('Private Key tidak valid (harus 44 karakter base64 berakhiran "=").', 'private_key');
  }
  let preshared = text(input.preshared_key) || existing?.preshared_key || '';
  if (input.clear_preshared_key === true) {
    preshared = '';
  }
  if (preshared && !WG_KEY_RE.test(preshared)) {
    fail('Preshared Key tidak valid (harus 44 karakter base64 berakhiran "=").', 'preshared_key');
  }
  const address = parseCidr(text(input.address), { minPrefix: MIN_ROUTE_PREFIX });
  if (!address) {
    fail('IP Address Client tidak valid. Gunakan format IPv4/CIDR, mis. 10.10.99.2/24.', 'address');
  }
  const routes = parseRouteList(input.allowed_ips, {
    field: 'allowed_ips', label: 'Allowed IPs', required: true,
  });
  assertNotRoutingEndpoint(endpoint.ip, routes, { field: 'allowed_ips', label: 'Allowed IPs' });

  const keepaliveRaw = text(String(input.keepalive ?? ''));
  const keepalive = keepaliveRaw === '' ? 25 : Number(keepaliveRaw);
  if (!Number.isInteger(keepalive) || keepalive < 0 || keepalive > 3600) {
    fail('Persistent Keepalive harus angka 0-3600 detik (disarankan 25).', 'keepalive');
  }
  const mtuRaw = text(String(input.mtu ?? ''));
  let mtu = null;
  if (mtuRaw !== '') {
    mtu = Number(mtuRaw);
    if (!Number.isInteger(mtu) || mtu < 1280 || mtu > 1500) {
      fail('MTU harus angka 1280-1500 (kosongkan untuk default).', 'mtu');
    }
  }
  return {
    endpoint: `${endpoint.host}:${endpoint.port}`,
    server_public_key: serverKey,
    private_key: privateKey,
    preshared_key: preshared,
    address: address.host,
    allowed_ips: routes.map((route) => route.cidr).join(', '),
    keepalive,
    mtu,
  };
}

function renderWireguard(cfg) {
  const lines = [
    HEADER,
    '[Interface]',
    `PrivateKey = ${cfg.private_key}`,
    `Address = ${cfg.address}`,
  ];
  if (cfg.mtu) {
    lines.push(`MTU = ${cfg.mtu}`);
  }
  lines.push(
    '',
    '[Peer]',
    `PublicKey = ${cfg.server_public_key}`,
  );
  if (cfg.preshared_key) {
    lines.push(`PresharedKey = ${cfg.preshared_key}`);
  }
  lines.push(
    `Endpoint = ${cfg.endpoint}`,
    `AllowedIPs = ${cfg.allowed_ips}`,
    `PersistentKeepalive = ${cfg.keepalive}`,
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// OpenVPN
// ---------------------------------------------------------------------------
const OVPN_BLOCKS = new Set([
  'ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'dh', 'pkcs12', 'secret', 'extra-certs', 'crl-verify',
]);
// Direktif yang menjalankan perintah/skrip sebagai root, membaca/menulis berkas, atau membelokkan rute.
const OVPN_DENIED = {
  up: 'menjalankan skrip', down: 'menjalankan skrip', 'up-restart': 'menjalankan skrip',
  'down-pre': 'menjalankan skrip', 'route-up': 'menjalankan skrip', 'route-pre-down': 'menjalankan skrip',
  'tls-verify': 'menjalankan skrip', ipchange: 'menjalankan skrip', 'client-connect': 'menjalankan skrip',
  'client-disconnect': 'menjalankan skrip', 'learn-address': 'menjalankan skrip',
  'auth-user-pass-verify': 'menjalankan skrip', plugin: 'memuat plugin', iproute: 'menjalankan program',
  'script-security': 'mengatur eksekusi skrip', setenv: 'mengatur environment', 'setenv-safe': 'mengatur environment',
  engine: 'memuat engine', management: 'membuka port manajemen', 'management-client-auth': 'port manajemen',
  config: 'memuat berkas lain', cd: 'mengubah direktori', chroot: 'mengubah direktori', daemon: 'mengubah mode proses',
  log: 'menulis berkas log', 'log-append': 'menulis berkas log', syslog: 'mengubah log', writepid: 'menulis berkas',
  status: 'menulis berkas', askpass: 'membaca berkas', capath: 'membaca direktori', 'tls-export-cert': 'menulis berkas',
  'dev-node': 'mengubah perangkat', user: 'mengubah user proses', group: 'mengubah group proses',
  'redirect-gateway': 'mengalihkan seluruh trafik server (default route)', 'redirect-private': 'mengalihkan trafik',
  'http-proxy-user-pass': 'membaca berkas', 'tmp-dir': 'mengubah direktori', 'remap-usr1': 'mengubah sinyal',
};
// Direktif yang merujuk berkas di disk: harus berupa blok inline <ca>...</ca>.
const OVPN_FILE_DIRECTIVES = new Set([
  'ca', 'cert', 'key', 'dh', 'pkcs12', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'crl-verify', 'extra-certs', 'secret',
]);

function sanitizeOvpn(rawText) {
  const source = typeof rawText === 'string' ? rawText.replace(/^\uFEFF/, '') : '';
  if (!source.trim()) {
    fail('Konfigurasi .ovpn wajib diisi (upload file atau tempel isinya).', 'ovpn_config');
  }
  if (Buffer.byteLength(source) > MAX_OVPN_BYTES) {
    fail('Konfigurasi .ovpn terlalu besar (maksimal 64 KB).', 'ovpn_config');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) {
    fail('Konfigurasi .ovpn mengandung karakter kontrol yang tidak valid.', 'ovpn_config');
  }

  const out = [];
  let block = null;
  let deviceType = 'tun';
  let hasRemote = false;
  let needsAuth = false;

  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (block) {
      out.push(line);
      if (line.toLowerCase() === `</${block}>`) {
        block = null;
      }
      continue;
    }
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const open = /^<([A-Za-z0-9-]+)>$/.exec(line);
    if (open) {
      const tag = open[1].toLowerCase();
      if (!OVPN_BLOCKS.has(tag)) {
        fail(`Blok <${tag}> tidak didukung. Hanya sertifikat/kunci inline (<ca>, <cert>, <key>, <tls-crypt>, ...) yang diizinkan.`, 'ovpn_config');
      }
      block = tag;
      out.push(`<${tag}>`);
      continue;
    }
    if (/^<\//.test(line)) {
      fail(`Tag penutup "${line.slice(0, 30)}" tidak berpasangan.`, 'ovpn_config');
    }

    const tokens = line.split(/\s+/);
    const name = tokens[0].toLowerCase();

    if (OVPN_DENIED[name]) {
      fail(`Direktif "${name}" tidak diizinkan (${OVPN_DENIED[name]}) demi keamanan server.`, 'ovpn_config');
    }
    if (OVPN_FILE_DIRECTIVES.has(name)) {
      fail(`Direktif "${name}" merujuk berkas di server. Gunakan blok inline <${name}>...</${name}> di dalam .ovpn.`, 'ovpn_config');
    }
    if ((name === 'http-proxy' || name === 'socks-proxy') && tokens.length > 3
      && !['auto', 'auto-nct'].includes((tokens[3] || '').toLowerCase())) {
      fail(`Direktif "${name}" dengan berkas auth tidak diizinkan.`, 'ovpn_config');
    }
    if (name === 'providers' && tokens.slice(1).some((token) => !['default', 'legacy'].includes(token.toLowerCase()))) {
      fail('Direktif "providers" hanya boleh default/legacy.', 'ovpn_config');
    }
    if (name === 'route' && tokens.length >= 2
      && (tokens[1] === 'default' || (tokens[1] === '0.0.0.0' && (tokens[2] === undefined || tokens[2] === '0.0.0.0' || tokens[2] === '128.0.0.0'))
        || (tokens[1] === '128.0.0.0' && tokens[2] === '128.0.0.0'))) {
      fail('Direktif route default (0.0.0.0/0) tidak diizinkan, trafik server akan masuk tunnel dan akses VPS terputus.', 'ovpn_config');
    }
    if (name === 'auth-user-pass') {
      needsAuth = true;
      out.push('auth-user-pass');
      continue;
    }
    if (name === 'dev' || name === 'dev-type') {
      const value = (tokens[1] || '').toLowerCase();
      if (!/^(tun|tap)\d*$/.test(value) && name === 'dev') {
        fail('Direktif "dev" harus tun atau tap.', 'ovpn_config');
      }
      if (name === 'dev-type' && !/^(tun|tap)$/.test(value)) {
        fail('Direktif "dev-type" harus tun atau tap.', 'ovpn_config');
      }
      // Dinormalkan ke "dev tun|tap": nama interface asli diganti saat render.
      deviceType = value.startsWith('tap') ? 'tap' : 'tun';
      out.push(`${name} ${deviceType}`);
      continue;
    }
    if (name === 'remote') {
      hasRemote = true;
    }
    out.push(tokens.join(' '));
  }
  if (block) {
    fail(`Blok <${block}> tidak ditutup.`, 'ovpn_config');
  }
  if (!hasRemote) {
    fail('Konfigurasi .ovpn harus memuat baris "remote <host> <port>".', 'ovpn_config');
  }
  return {
    config: `${out.join('\n')}\n`,
    deviceType,
    needsAuth,
  };
}

const AUTH_TEXT = /^[^\u0000-\u001f\u007f]{1,128}$/;

function validateOpenvpn(input = {}, existing = null) {
  const supplied = typeof input.ovpn_config === 'string' && input.ovpn_config.trim() !== '';
  const source = supplied ? input.ovpn_config : existing?.ovpn_config || '';
  const { config, needsAuth } = sanitizeOvpn(source);

  const username = text(input.username);
  let password = '';
  if (username) {
    if (!AUTH_TEXT.test(username)) {
      fail('Username OpenVPN tidak valid (maksimal 128 karakter, tanpa baris baru).', 'username');
    }
    password = typeof input.password === 'string' && input.password !== '' ? input.password : existing?.password || '';
    if (!password) {
      fail('Password OpenVPN wajib diisi bila username diisi.', 'password');
    }
    if (!AUTH_TEXT.test(password)) {
      fail('Password OpenVPN tidak valid (maksimal 128 karakter, tanpa baris baru).', 'password');
    }
  } else if (needsAuth) {
    fail('File .ovpn memakai auth-user-pass: isi Username dan Password.', 'username');
  }
  return { ovpn_config: config, username, password };
}

function renderOvpn(cfg) {
  const { config, deviceType, needsAuth } = sanitizeOvpn(cfg.ovpn_config);
  const hasCreds = Boolean(cfg.username && cfg.password);
  if (needsAuth && !hasCreds) {
    fail('File .ovpn memakai auth-user-pass: isi Username dan Password.', 'username');
  }
  const body = [];
  let authWritten = false;
  for (const line of config.trimEnd().split('\n')) {
    // dev/dev-type diganti nama interface tetap, supaya status/ip mudah dilacak.
    if (/^dev(-type)?\s/i.test(line)) {
      continue;
    }
    if (line === 'auth-user-pass') {
      body.push(`auth-user-pass ${PATHS.ovpnAuth}`);
      authWritten = true;
      continue;
    }
    body.push(line);
  }
  if (hasCreds && !authWritten) {
    body.push(`auth-user-pass ${PATHS.ovpnAuth}`);
  }
  return [
    HEADER,
    // pull-filter dievaluasi berurutan: letakkan paling atas agar tidak bisa ditimpa isi .ovpn.
    'pull-filter ignore "redirect-gateway"',
    'pull-filter ignore "redirect-private"',
    'pull-filter ignore "dhcp-option"',
    'pull-filter ignore "dns"',
    'pull-filter ignore "route 0.0.0.0 0.0.0.0"',
    'pull-filter ignore "route 0.0.0.0 128.0.0.0"',
    'pull-filter ignore "route 128.0.0.0 128.0.0.0"',
    `dev ${INTERFACES.openvpn}`,
    `dev-type ${deviceType}`,
    ...body,
    '',
  ].join('\n');
}

function renderOvpnAuth(cfg) {
  return `${cfg.username}\n${cfg.password}\n`;
}

// ---------------------------------------------------------------------------
// SSTP
// ---------------------------------------------------------------------------
const SSTP_USER_RE = /^[A-Za-z0-9._@+-]{1,64}$/;
const SSTP_PASS_RE = /^[\u0020-\u007e]{1,128}$/;

function validateSstp(input = {}, existing = null) {
  const server = parseHostPort(input.server, {
    defaultPort: 443, field: 'server', label: 'Server CHR',
  });
  const username = text(input.username);
  if (!SSTP_USER_RE.test(username)) {
    fail('Username SSTP wajib diisi (huruf, angka, titik, garis bawah, @, +, -; maksimal 64).', 'username');
  }
  const password = typeof input.password === 'string' && input.password !== '' ? input.password : existing?.password || '';
  if (!password) {
    fail('Password SSTP wajib diisi.', 'password');
  }
  if (!SSTP_PASS_RE.test(password)) {
    fail('Password SSTP hanya boleh karakter ASCII yang tercetak (maksimal 128).', 'password');
  }
  const routes = parseRouteList(input.routes, { field: 'routes', label: 'Subnet Route NAS', required: false });
  assertNotRoutingEndpoint(server.ip, routes, { field: 'routes', label: 'Subnet Route NAS' });
  const ignore = input.ignore_cert === true || input.ignore_cert === 'true' || input.ignore_cert === 1;
  return {
    server: `${server.host}:${server.port}`,
    username,
    password,
    routes: routes.map((route) => route.cidr).join(', '),
    ignore_cert: ignore,
  };
}

function pppQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderSstpPeer(cfg) {
  return [
    HEADER,
    `name ${pppQuote(cfg.username)}`,
    `password ${pppQuote(cfg.password)}`,
    'remotename raniah-sstp',
    'linkname raniah-sstp',
    'ipparam raniah-sstp',
    `ifname ${INTERFACES.sstp}`,
    'noauth',
    'refuse-eap',
    'require-mschap-v2',
    'noccp',
    'noipdefault',
    'nodefaultroute',
    'mtu 1400',
    'mru 1400',
    'lcp-echo-interval 30',
    'lcp-echo-failure 4',
    '',
  ].join('\n');
}

function resolveSstpc(existsSync = fs.existsSync) {
  return SSTPC_CANDIDATES.find((candidate) => existsSync(candidate)) || SSTPC_CANDIDATES[0];
}

function renderSstpUnit(cfg, sstpc = SSTPC_CANDIDATES[0]) {
  const certFlag = cfg.ignore_cert ? ' --cert-warn' : '';
  return [
    '[Unit]',
    'Description=RANIAH Billing - SSTP VPN client ke MikroTik CHR',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${sstpc} --log-stderr${certFlag} ${cfg.server} call raniah-sstp`,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function renderSstpRoutes(cfg) {
  const routes = cfg.routes ? cfg.routes.split(/[\s,]+/).filter(Boolean) : [];
  return routes.length ? `${routes.join('\n')}\n` : '';
}

// Dipanggil pppd (via run-parts Debian) setiap link ppp naik; hanya bertindak untuk raniah-sstp.
function renderSstpHook() {
  return [
    '#!/bin/sh',
    HEADER,
    '[ "$PPP_IFACE" = "raniah-sstp" ] || exit 0',
    `ROUTES=${PATHS.sstpRoutes}`,
    '[ -r "$ROUTES" ] || exit 0',
    'while read -r net; do',
    '  case "$net" in',
    '    [0-9]*.[0-9]*.[0-9]*.[0-9]*/[0-9]*) ip route replace "$net" dev "$PPP_IFACE" metric 50 ;;',
    '  esac',
    'done < "$ROUTES"',
    'exit 0',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Ringkasan
// ---------------------------------------------------------------------------
function validateProfile(protocol, input, existing) {
  if (!PROTOCOLS.includes(protocol)) {
    fail('Protokol tidak dikenal. Pilih wireguard, openvpn, atau sstp.', 'protocol');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Data konfigurasi tidak valid.', 'config');
  }
  if (protocol === 'wireguard') {
    return validateWireguard(input, existing);
  }
  if (protocol === 'openvpn') {
    return validateOpenvpn(input, existing);
  }
  return validateSstp(input, existing);
}

// ---------------------------------------------------------------------------
// Penulisan ke OS (dipakai langsung saat root, atau oleh helper sudo)
// ---------------------------------------------------------------------------
function writeAtomic(file, content, mode, dirMode) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: dirMode });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function applyToDisk(protocol, cfg, { root = '', exec = execFileSync, existsSync = fs.existsSync } = {}) {
  const at = (target) => path.join(root, target);
  const written = [];
  const put = (target, content, mode, dirMode = 0o755) => {
    writeAtomic(at(target), content, mode, dirMode);
    written.push(target);
  };

  if (protocol === 'wireguard') {
    put(PATHS.wireguard, renderWireguard(cfg), 0o600, 0o700);
  } else if (protocol === 'openvpn') {
    const conf = renderOvpn(cfg);
    if (cfg.username && cfg.password) {
      put(PATHS.ovpnAuth, renderOvpnAuth(cfg), 0o600);
    } else {
      fs.rmSync(at(PATHS.ovpnAuth), { force: true });
    }
    put(PATHS.ovpn, conf, 0o600);
  } else if (protocol === 'sstp') {
    put(PATHS.sstpPeer, renderSstpPeer(cfg), 0o600);
    put(PATHS.sstpRoutes, renderSstpRoutes(cfg), 0o644);
    put(PATHS.sstpHook, renderSstpHook(), 0o755);
    put(PATHS.sstpUnit, renderSstpUnit(cfg, resolveSstpc(existsSync)), 0o644);
    if (!root) {
      exec('systemctl', ['daemon-reload'], { timeout: 15000 });
    }
  } else {
    fail('Protokol tidak dikenal.', 'protocol');
  }
  return written;
}

module.exports = {
  PROTOCOLS,
  UNITS,
  INTERFACES,
  PATHS,
  MIN_ROUTE_PREFIX,
  WG_KEY_RE,
  VpnValidationError,
  parseIPv4,
  parseCidr,
  parseHostPort,
  generateKeypair,
  derivePublicKey,
  publicKeyViaCrypto,
  validateWireguard,
  validateOpenvpn,
  validateSstp,
  validateProfile,
  sanitizeOvpn,
  renderWireguard,
  renderOvpn,
  renderOvpnAuth,
  renderSstpPeer,
  renderSstpUnit,
  renderSstpRoutes,
  renderSstpHook,
  applyToDisk,
};
