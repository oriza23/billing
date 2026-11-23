'use strict';
/**
 * Validasi + render konfigurasi VPN client (WireGuard / OpenVPN / SSTP / L2TP) untuk koneksi
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

const PROTOCOLS = ['wireguard', 'openvpn', 'sstp', 'l2tp'];
const UNITS = {
  wireguard: 'wg-quick@wg-billing',
  openvpn: 'openvpn-client@raniah-vpn',
  sstp: 'raniah-sstp',
  l2tp: 'raniah-l2tp',
  server: 'wg-quick@wg-server',
  'ovpn-server': 'openvpn-server@raniah-server',
  'l2tp-server': 'xl2tpd',
};
// Unit pendamping yang ikut dimatikan saat protokolnya dilepas (daemon-nya hanya dipakai protokol itu).
const COMPANION_UNITS = {
  l2tp: ['xl2tpd'],
};
const INTERFACES = {
  wireguard: 'wg-billing',
  openvpn: 'raniah-ovpn',
  sstp: 'raniah-sstp',
  l2tp: 'raniah-l2tp',
  server: 'wg-server',
  'ovpn-server': 'tun-ovpn-srv',
  'l2tp-server': 'xl2tp-server',
};
const PATHS = {
  wireguard: '/etc/wireguard/wg-billing.conf',
  ovpn: '/etc/openvpn/client/raniah-vpn.conf',
  ovpnAuth: '/etc/openvpn/client/raniah-vpn.auth',
  sstpPeer: '/etc/ppp/peers/raniah-sstp',
  sstpRoutes: '/etc/ppp/raniah-sstp.routes',
  sstpHook: '/etc/ppp/ip-up.d/raniah-sstp',
  sstpUnit: '/etc/systemd/system/raniah-sstp.service',
  // /etc/xl2tpd/xl2tpd.conf dan /etc/ppp/options.l2tpd.client adalah path bawaan xl2tpd. Skrip
  // runner sengaja di /etc: service billing hanya boleh menulis /etc (ProtectSystem=strict).
  l2tpdConf: '/etc/xl2tpd/xl2tpd.conf',
  l2tpOptions: '/etc/ppp/options.l2tpd.client',
  l2tpRoutes: '/etc/ppp/raniah-l2tp.routes',
  l2tpHook: '/etc/ppp/ip-up.d/raniah-l2tp',
  l2tpRunner: '/etc/xl2tpd/raniah-l2tp-run.sh',
  l2tpIpsec: '/etc/swanctl/conf.d/raniah-l2tp.conf',
  l2tpUnit: '/etc/systemd/system/raniah-l2tp.service',
  wgOverride: '/etc/systemd/system/wg-quick@wg-billing.service.d/override.conf',
  ovpnOverride: '/etc/systemd/system/openvpn-client@raniah-vpn.service.d/override.conf',
  wgServer: '/etc/wireguard/wg-server.conf',
  wgServerOverride: '/etc/systemd/system/wg-quick@wg-server.service.d/override.conf',
  wgServerUfw: '/etc/wireguard/wg-server.ufw',
  ovpnServer: '/etc/openvpn/server/raniah-server.conf',
  ovpnServerPki: '/etc/openvpn/server/raniah-pki',
  ovpnServerCa: '/etc/openvpn/server/raniah-pki/ca.crt',
  ovpnServerCert: '/etc/openvpn/server/raniah-pki/server.crt',
  ovpnServerKey: '/etc/openvpn/server/raniah-pki/server.key',
  ovpnServerDh: '/etc/openvpn/server/raniah-pki/dh.pem',
  ovpnServerAuth: '/etc/openvpn/server/raniah-auth.sh',
  ovpnServerUsers: '/etc/openvpn/server/raniah-users',
  ovpnServerCcd: '/etc/openvpn/server/ccd',
  ovpnServerStatus: '/run/openvpn-server/status-raniah.log',
  ovpnServerOverride: '/etc/systemd/system/openvpn-server@raniah-server.service.d/override.conf',
  ovpnServerUfw: '/etc/openvpn/server/raniah-server.ufw',
  l2tpServerOptions: '/etc/ppp/options.xl2tpd',
  l2tpServerChap: '/etc/ppp/chap-secrets',
  l2tpServerUfw: '/etc/xl2tpd/raniah-l2tp-server.ufw',
};
const SERVER_DEFAULT_PORT = 51820;
const SERVER_DEFAULT_ADDRESS = '10.220.0.1/24';
const SERVER_MAX_PEERS = 200;
const OVPN_SERVER_DEFAULT_PORT = 1194;
const OVPN_SERVER_DEFAULT_NETWORK = '10.221.0.0/24';
const CYCLE_PROTOCOLS = [...PROTOCOLS, 'server', 'ovpn-server', 'l2tp-server'];
const HUB_PROTOCOLS = ['server', 'ovpn-server', 'l2tp-server'];
const L2TP_SERVER_DEFAULT_PORT = 1701;
const L2TP_SERVER_DEFAULT_NETWORK = '10.222.0.0/24';
// keepalive tidak boleh digandakan dengan ping / ping-exit / ping-restart (error OpenVPN).
const OVPN_LIVENESS = ['keepalive', 'ping', 'ping-exit', 'ping-restart'];
const OVPN_RESILIENCE_ALWAYS = ['resolv-retry infinite', 'persist-key', 'persist-tun'];
const OVPN_DEFAULT_KEEPALIVE = 'keepalive 10 30';
// Tuning latensi/RTO untuk RADIUS lewat tunnel. Hanya ditambahkan bila .ovpn belum mengaturnya.
// MTU 1400 + mssfix 1360 aman melewati jalur PPPoE tanpa fragmentasi. Buffer 384 KiB masih di bawah
// net.core.{r,w}mem_max yang diset install.sh (/etc/sysctl.d/99-raniah-vpn.conf).
const OVPN_TUNING = [
  { names: ['tun-mtu', 'link-mtu'], line: 'tun-mtu 1400' },
  { names: ['mssfix'], line: 'mssfix 1360' },
  { names: ['sndbuf'], line: 'sndbuf 393216' },
  { names: ['rcvbuf'], line: 'rcvbuf 393216' },
];
const OVPN_FAST_IO = { names: ['fast-io'], line: 'fast-io' };
// Keamanan: cipher data hanya AEAD AES-GCM dan TLS minimal 1.2. Bila .ovpn sudah memilih cipher
// sendiri (mis. profil CHR lama dengan "cipher AES-256-CBC") pilihannya dihormati agar koneksi
// yang sudah jalan tidak putus; tls-version-min di bawah 1.2 selalu dinaikkan.
const OVPN_DEFAULT_DATA_CIPHERS = 'data-ciphers AES-256-GCM:AES-128-GCM';
const OVPN_CIPHER_DIRECTIVES = ['data-ciphers', 'ncp-ciphers', 'data-ciphers-fallback', 'cipher'];
const OVPN_TLS_MIN = '1.2';
// WireGuard: MTU 1380 aman melewati PPPoE; keepalive 15 detik menjaga NAT mapping tetap hidup.
const WG_DEFAULT_MTU = 1380;
const WG_DEFAULT_KEEPALIVE = 15;
// pppd (SSTP dan L2TP): deteksi link mati 5 dtk x 3 = 15 dtk, lalu systemd menyambung ulang 3 dtk kemudian.
const PPP_MTU = 1400;
const PPP_LCP_ECHO_INTERVAL = 5;
const PPP_LCP_ECHO_FAILURE = 3;
const PPP_RESTART_SEC = 3;
const SSTPC_CANDIDATES = ['/usr/sbin/sstpc', '/usr/bin/sstpc', '/usr/local/sbin/sstpc', '/usr/local/bin/sstpc'];
const PPPD_CANDIDATES = ['/usr/sbin/pppd', '/usr/bin/pppd', '/usr/local/sbin/pppd'];

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
  const keepalive = keepaliveRaw === '' ? WG_DEFAULT_KEEPALIVE : Number(keepaliveRaw);
  if (!Number.isInteger(keepalive) || keepalive < 0 || keepalive > 3600) {
    fail(`Persistent Keepalive harus angka 0-3600 detik (disarankan ${WG_DEFAULT_KEEPALIVE}).`, 'keepalive');
  }
  const mtuRaw = text(String(input.mtu ?? ''));
  let mtu = null;
  if (mtuRaw !== '') {
    mtu = Number(mtuRaw);
    if (!Number.isInteger(mtu) || mtu < 1280 || mtu > 1500) {
      fail(`MTU harus angka 1280-1500 (kosongkan untuk default ${WG_DEFAULT_MTU}).`, 'mtu');
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
  // MTU manual menang; kosong berarti default 1380 (bukan default wg-quick yang mengikuti MTU WAN).
  lines.push(`MTU = ${cfg.mtu || WG_DEFAULT_MTU}`);
  lines.push(
    '',
    '[Peer]',
    `PublicKey = ${cfg.server_public_key}`,
  );
  if (cfg.preshared_key) {
    lines.push(`PresharedKey = ${cfg.preshared_key}`);
  }
  const keepalive = Number(cfg.keepalive) > 0 ? Number(cfg.keepalive) : WG_DEFAULT_KEEPALIVE;
  lines.push(
    `Endpoint = ${cfg.endpoint}`,
    `AllowedIPs = ${cfg.allowed_ips}`,
    `PersistentKeepalive = ${keepalive}`,
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

function ovpnBodyHas(body, directive) {
  const key = directive.split(/\s+/)[0].toLowerCase();
  return body.some((line) => {
    const t = String(line).trim().toLowerCase();
    return t === key || t.startsWith(`${key} `);
  });
}

// Hanya baris aktif (komentar sudah dibuang di sanitizeOvpn).
function ovpnHasLivenessDirective(body) {
  return body.some((line) => {
    const name = String(line).trim().split(/\s+/)[0]?.toLowerCase();
    return OVPN_LIVENESS.includes(name);
  });
}

function ovpnResilienceExtras(body) {
  const extras = [];
  if (!ovpnHasLivenessDirective(body)) {
    extras.push(OVPN_DEFAULT_KEEPALIVE);
  }
  for (const line of OVPN_RESILIENCE_ALWAYS) {
    if (!ovpnBodyHas(body, line)) {
      extras.push(line);
    }
  }
  return extras;
}

// Baris aktif saja (isi blok inline <ca>...</ca> dilewati).
function ovpnActiveLines(body) {
  const active = [];
  let block = null;
  for (const raw of body) {
    const line = String(raw).trim();
    if (block) {
      if (line.toLowerCase() === `</${block}>`) block = null;
      continue;
    }
    const open = /^<([A-Za-z0-9-]+)>$/.exec(line);
    if (open) {
      block = open[1].toLowerCase();
      continue;
    }
    if (line) active.push(line);
  }
  return active;
}

// true bila semua remote efektif memakai UDP (proto global, atau argumen ke-4 "remote host port proto").
function ovpnIsUdp(body) {
  let proto = 'udp';
  const remoteProtos = [];
  for (const line of ovpnActiveLines(body)) {
    const tokens = line.split(/\s+/);
    const name = tokens[0].toLowerCase();
    if (name === 'proto') proto = (tokens[1] || '').toLowerCase();
    if (name === 'remote') remoteProtos.push((tokens[3] || '').toLowerCase());
  }
  const effective = (remoteProtos.length ? remoteProtos : ['']).map((item) => item || proto);
  return effective.every((item) => item.startsWith('udp'));
}

function ovpnTuningExtras(body) {
  const active = ovpnActiveLines(body);
  const has = (names) => active.some((line) => names.includes(line.split(/\s+/)[0].toLowerCase()));
  const extras = [];
  for (const item of OVPN_TUNING) {
    if (!has(item.names)) extras.push(item.line);
  }
  // fast-io hanya sah untuk UDP; dengan TCP OpenVPN menolak opsinya.
  if (ovpnIsUdp(body) && !has(OVPN_FAST_IO.names)) extras.push(OVPN_FAST_IO.line);
  if (!has(OVPN_CIPHER_DIRECTIVES)) extras.push(OVPN_DEFAULT_DATA_CIPHERS);
  if (!has(['tls-version-min'])) extras.push(`tls-version-min ${OVPN_TLS_MIN}`);
  return extras;
}

// tls-version-min < 1.2 (1.0/1.1) dinaikkan ke 1.2; nilai lain (1.2, 1.3) dibiarkan.
function ovpnHardenLine(line) {
  const tokens = line.split(/\s+/);
  if (tokens[0].toLowerCase() === 'tls-version-min' && Number.parseFloat(tokens[1]) < Number(OVPN_TLS_MIN)) {
    return ['tls-version-min', OVPN_TLS_MIN, ...tokens.slice(2)].join(' ');
  }
  return line;
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
    body.push(ovpnHardenLine(line));
  }
  if (hasCreds && !authWritten) {
    body.push(`auth-user-pass ${PATHS.ovpnAuth}`);
  }
  const resilience = [...ovpnResilienceExtras(body), ...ovpnTuningExtras(body)];
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
    ...resilience,
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
  // --cert-warn aktif secara default: sertifikat bawaan CHR umumnya self-signed.
  let ignore = true;
  if (input.ignore_cert !== undefined && input.ignore_cert !== null) {
    ignore = input.ignore_cert === true || input.ignore_cert === 'true' || input.ignore_cert === 1;
  } else if (existing && typeof existing.ignore_cert === 'boolean') {
    ignore = existing.ignore_cert;
  }
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

function renderSstpPeer(cfg, sstpc = SSTPC_CANDIDATES[0]) {
  // pppd membuka pty dan menjalankan sstpc di atasnya (--nolaunchpppd: sstpc tidak
  // memanggil pppd lagi). stderr sstpc tetap ke journal, bukan ke pty.
  const certFlag = cfg.ignore_cert ? ' --cert-warn' : '';
  const pty = `${sstpc} --log-stderr --log-level 2 --tls-ext${certFlag} --nolaunchpppd ${cfg.server}`;
  return [
    HEADER,
    // nopersist: pppd keluar saat putus. systemd (Restart=always) yang menyambung ulang.
    // persist membuat pppd membuka ulang /dev/pts yang sudah ditutup sstpc
    // ("Device or resource busy") dan menimpa pesan TLS/sertifikat/auth yang asli.
    `pty ${pppQuote(pty)}`,
    `name ${pppQuote(cfg.username)}`,
    `password ${pppQuote(cfg.password)}`,
    'remotename raniah-sstp',
    'linkname raniah-sstp',
    'ipparam raniah-sstp',
    `ifname ${INTERFACES.sstp}`,
    'noauth',
    // Tanpa require-mschap-v2: CHR dengan profil bawaan menawarkan mschap2/chap/pap, pppd
    // memilih yang cocok. EAP ditolak karena SSTP MikroTik tidak memakainya.
    'refuse-eap',
    // MPPE (bila profil CHR mewajibkannya) tetap bisa dinegosiasikan lewat CCP.
    'nobsdcomp',
    'nodeflate',
    'noipdefault',
    'nodefaultroute',
    'nopersist',
    `mtu ${PPP_MTU}`,
    `mru ${PPP_MTU}`,
    `lcp-echo-interval ${PPP_LCP_ECHO_INTERVAL}`,
    `lcp-echo-failure ${PPP_LCP_ECHO_FAILURE}`,
    '',
  ].join('\n');
}

function resolveSstpc(existsSync = fs.existsSync) {
  return SSTPC_CANDIDATES.find((candidate) => existsSync(candidate)) || SSTPC_CANDIDATES[0];
}

function resolvePppd(existsSync = fs.existsSync) {
  return PPPD_CANDIDATES.find((candidate) => existsSync(candidate)) || PPPD_CANDIDATES[0];
}

// Pesan ini muncul di journalctl bila /dev/ppp tidak ada (umum di kontainer LXC/Proxmox).
const SSTP_NO_PPP_MESSAGE = '/dev/ppp tidak ada. Pada kontainer LXC/Proxmox teruskan device ppp dari host ke kontainer.';

function renderSstpUnit(cfg, pppd = PPPD_CANDIDATES[0]) {
  // pppd proses utama, tetap di foreground (nodetach). sstpc ada di opsi pty peer file.
  // cfg tetap dipakai pemanggil; server dan kredensial hanya ada di peer, bukan di unit.
  void cfg;
  return [
    '[Unit]',
    'Description=RANIAH Billing - SSTP VPN client ke MikroTik CHR',
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Type=simple',
    'KillMode=control-group',
    'TimeoutStopSec=5',
    `ExecStartPre=/bin/sh -c 'test -c /dev/ppp || { echo "${SSTP_NO_PPP_MESSAGE}" >&2; exit 1; }'`,
    `ExecStart=${pppd} call raniah-sstp nodetach`,
    `ExecStopPost=-/sbin/ip link delete ${INTERFACES.sstp}`,
    'Restart=always',
    `RestartSec=${PPP_RESTART_SEC}`,
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

function renderWgUnitOverride() {
  return [
    HEADER,
    '[Unit]',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
  ].join('\n');
}

function renderOvpnUnitOverride() {
  return [
    HEADER,
    '[Unit]',
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Restart=always',
    'RestartSec=5',
    '',
  ].join('\n');
}

function reloadSystemd(exec, root) {
  if (!root) {
    exec('systemctl', ['daemon-reload'], { timeout: 15000 });
  }
}

// Dipanggil pppd (via run-parts Debian) setiap link ppp naik; hanya bertindak untuk interface-nya.
function renderPppRouteHook(iface, routesFile) {
  return [
    '#!/bin/sh',
    HEADER,
    `[ "$PPP_IFACE" = "${iface}" ] || exit 0`,
    `ROUTES=${routesFile}`,
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

function renderSstpHook() {
  return renderPppRouteHook(INTERFACES.sstp, PATHS.sstpRoutes);
}

// ---------------------------------------------------------------------------
// L2TP: xl2tpd + pppd, IPsec PSK opsional lewat strongSwan (swanctl)
// ---------------------------------------------------------------------------
const L2TP_PORT = 1701;
const L2TP_LAC = 'raniah-l2tp';
// Nilai ditulis di dalam "..." pada swanctl.conf, jadi spasi, tanda kutip, dan backslash dilarang.
const IPSEC_PSK_RE = /^[\u0021\u0023-\u005b\u005d-\u007e]{1,128}$/;
// xl2tpd membaca xl2tpd.conf (komentar diawali ";"), pppd membaca options (komentar "#").
const L2TP_CONF_HEADER = '; RANIAH Billing - dibuat otomatis dari menu Sistem > Koneksi VPN. Jangan diedit manual.';

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

// Nama field API: server, username, password, ipsec_secret (alias ipsecSecret), routes (alias nasSubnet).
function validateL2tp(input = {}, existing = null) {
  const server = parseHostPort(input.server, {
    defaultPort: L2TP_PORT, field: 'server', label: 'Server CHR',
  });
  if (server.port !== L2TP_PORT) {
    fail(`xl2tpd hanya memakai UDP ${L2TP_PORT} ke CHR. Kosongkan port atau isi :${L2TP_PORT}.`, 'server');
  }
  const username = text(input.username);
  if (!SSTP_USER_RE.test(username)) {
    fail('Username L2TP wajib diisi (huruf, angka, titik, garis bawah, @, +, -; maksimal 64).', 'username');
  }
  const password = typeof input.password === 'string' && input.password !== '' ? input.password : existing?.password || '';
  if (!password) {
    fail('Password L2TP wajib diisi.', 'password');
  }
  if (!SSTP_PASS_RE.test(password)) {
    fail('Password L2TP hanya boleh karakter ASCII yang tercetak (maksimal 128).', 'password');
  }
  const routes = parseRouteList(firstDefined(input.routes, input.nasSubnet, input.nas_subnet), {
    field: 'routes', label: 'Subnet Route NAS', required: false,
  });
  assertNotRoutingEndpoint(server.ip, routes, { field: 'routes', label: 'Subnet Route NAS' });

  // IPsec PSK opsional: kosong = L2TP murni. Kolom dikosongkan = pakai yang tersimpan,
  // kecuali clear_ipsec_secret (sama seperti preshared key WireGuard).
  const suppliedSecret = firstDefined(input.ipsec_secret, input.ipsecSecret);
  let ipsecSecret = typeof suppliedSecret === 'string' && suppliedSecret.trim() !== ''
    ? suppliedSecret.trim()
    : existing?.ipsec_secret || '';
  if (input.clear_ipsec_secret === true || input.clearIpsecSecret === true) {
    ipsecSecret = '';
  }
  if (ipsecSecret && !IPSEC_PSK_RE.test(ipsecSecret)) {
    fail('IPsec Pre-Shared Key hanya boleh karakter ASCII tercetak tanpa spasi, tanda kutip, atau backslash (maksimal 128).', 'ipsec_secret');
  }
  return {
    server: `${server.host}:${server.port}`,
    username,
    password,
    routes: routes.map((route) => route.cidr).join(', '),
    ipsec_secret: ipsecSecret,
  };
}

function l2tpHost(cfg) {
  return String(cfg.server).replace(/:\d+$/, '');
}

// Section [lac raniah-l2tp]: xl2tpd hanya membuka sesi bila diperintah (autodial = no); sambung
// ulang ditangani systemd lewat raniah-l2tp.service.
function renderL2tpXl2tpd(cfg) {
  return [
    L2TP_CONF_HEADER,
    '[global]',
    `port = ${L2TP_PORT}`,
    '',
    `[lac ${L2TP_LAC}]`,
    `lns = ${l2tpHost(cfg)}`,
    `pppoptfile = ${PATHS.l2tpOptions}`,
    'length bit = yes',
    'autodial = no',
    'redial = no',
    '',
  ].join('\n');
}

function renderL2tpOptions(cfg) {
  return [
    HEADER,
    `ifname ${INTERFACES.l2tp}`,
    `name ${pppQuote(cfg.username)}`,
    `password ${pppQuote(cfg.password)}`,
    `remotename ${L2TP_LAC}`,
    `ipparam ${L2TP_LAC}`,
    'noauth',
    'refuse-eap',
    // MPPE (bila profil CHR mewajibkannya) tetap bisa dinegosiasikan lewat CCP.
    'nobsdcomp',
    'nodeflate',
    'noipdefault',
    // Rute ke subnet NAS dipasang hook ip-up.d. Default route dan DNS server tidak disentuh:
    // tanpa defaultroute dan tanpa usepeerdns (DNS lokal tidak ditimpa).
    'nodefaultroute',
    // nopersist: pppd keluar saat putus; systemd (Restart=always) yang menyambung ulang.
    'nopersist',
    `mtu ${PPP_MTU}`,
    `mru ${PPP_MTU}`,
    `lcp-echo-interval ${PPP_LCP_ECHO_INTERVAL}`,
    `lcp-echo-failure ${PPP_LCP_ECHO_FAILURE}`,
    '',
  ].join('\n');
}

function validateL2tpServer(input, { avoidCidrs = [SERVER_DEFAULT_ADDRESS, OVPN_SERVER_DEFAULT_NETWORK, '10.210.0.0/24'] } = {}) {
  const source = input || {};
  const endpointRaw = String(source.public_endpoint || '').trim();
  let endpoint = '';
  if (endpointRaw) {
    if (endpointRaw.includes(':')) {
      fail('Endpoint publik diisi tanpa port. Port ada di kolom tersendiri.', 'public_endpoint');
    }
    endpoint = parseHostPort(endpointRaw, {
      portRequired: false, field: 'public_endpoint', label: 'Endpoint publik',
    }).host;
  }
  const port = source.listen_port == null || source.listen_port === ''
    ? L2TP_SERVER_DEFAULT_PORT
    : Number(source.listen_port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('Port UDP harus 1-65535.', 'listen_port');
  }
  const networkText = String(source.network || L2TP_SERVER_DEFAULT_NETWORK).trim();
  const parsed = parseCidr(networkText, { minPrefix: 16 });
  if (!parsed || parsed.ip !== parsed.network || parsed.prefix > 30) {
    fail('Subnet harus alamat jaringan /16 sampai /30, misalnya 10.222.0.0/24.', 'network');
  }
  if (!isHost(formatIPv4(parsed.network + 1))) {
    fail('Subnet tidak boleh memakai alamat loopback, 0.0.0.0, atau multicast.', 'network');
  }
  for (const other of avoidCidrs) {
    if (other && cidrOverlaps(parsed.cidr, other)) {
      fail('Subnet L2TP bentrok dengan subnet VPN lain.', 'network');
    }
  }
  return {
    public_endpoint: endpoint,
    listen_port: port,
    network: parsed.cidr,
    server_ip: formatIPv4(parsed.network + 1),
    range_start: formatIPv4(parsed.network + 2),
    range_end: formatIPv4(parsed.network + parsed.size - 2),
  };
}

function validateL2tpPeer(input, existing = null) {
  const source = input || {};
  const name = String(source.name || '').trim();
  if (!PEER_NAME_RE.test(name)) {
    fail('Nama router 1-40 karakter: huruf, angka, spasi, titik, garis, atau garis bawah.', 'name');
  }
  const username = String(source.username || '').trim();
  if (!OVPN_USER_RE.test(username)) {
    fail('Username 1-32 karakter: huruf, angka, titik, garis, atau garis bawah.', 'username');
  }
  let password = source.password == null ? '' : String(source.password);
  if (!password && existing?.password) {
    password = existing.password;
  }
  if (!password) {
    password = generateOvpnPassword();
  }
  if (!OVPN_PASS_RE.test(password)) {
    fail('Password 8-64 karakter huruf dan angka.', 'password');
  }
  const enabled = source.enabled == null
    ? (existing ? existing.enabled !== false : true)
    : source.enabled === true || source.enabled === 1 || source.enabled === '1';
  return { name, username, password, enabled };
}

function allocateL2tpAddress(networkText, usedAddresses) {
  return allocateOvpnAddress(networkText, usedAddresses);
}

function renderL2tpServerConf(server) {
  const cfg = validateL2tpServer(server, { avoidCidrs: [] });
  return [
    '; Dibuat otomatis oleh RANIAH. L2TP server murni, tanpa IPsec.',
    '[global]',
    `port = ${cfg.listen_port}`,
    `auth file = ${PATHS.l2tpServerChap}`,
    `; raniah-subnet ${cfg.network}`,
    '',
    '[lns default]',
    `ip range = ${cfg.range_start}-${cfg.range_end}`,
    `local ip = ${cfg.server_ip}`,
    'require chap = yes',
    'refuse pap = yes',
    'require authentication = yes',
    `pppoptfile = ${PATHS.l2tpServerOptions}`,
    'length bit = yes',
    '',
  ].join('\n');
}

function renderL2tpServerOptions() {
  return [
    '# Dibuat otomatis oleh RANIAH. Opsi PPP untuk L2TP server.',
    'require-mschap-v2',
    'mtu 1400',
    'mru 1400',
    'lcp-echo-interval 10',
    'lcp-echo-failure 3',
    'nodefaultroute',
    'lock',
    'nobsdcomp',
    'novj',
    'novjccomp',
    '',
  ].join('\n');
}

function renderL2tpChapSecrets(peers, existing = '') {
  const enabled = (Array.isArray(peers) ? peers : []).filter((peer) => peer.enabled);
  const ours = new Set(enabled.map((peer) => peer.username));
  const kept = String(existing || '').split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return false;
    }
    const user = trimmed.split(/\s+/)[0];
    return user && !ours.has(user);
  });
  const lines = ['# RANIAH L2TP server. Baris peer aktif ditulis ulang otomatis.'];
  for (const peer of enabled) {
    lines.push(`${peer.username} * ${peer.password} ${peer.address}`);
  }
  return [...lines, ...kept, ''].join('\n');
}

function renderL2tpServerScript(server, peer) {
  const cfg = validateL2tpServer(server, { avoidCidrs: [] });
  if (!cfg.public_endpoint) {
    fail('Isi endpoint publik sebelum menyalin script.', 'public_endpoint');
  }
  validateL2tpPeer(peer, peer);
  const lines = [
    `/interface l2tp-client add name="l2tp-raniah" connect-to="${cfg.public_endpoint}" user="${peer.username}" password="${peer.password}" use-ipsec=no allow=mschap2 add-default-route=no disabled=no comment="Auto by Billing"`,
    ...renderRadiusClientLines(cfg.server_ip, peer.address, peer),
    ':do { /ip hotspot profile set [find] use-radius=yes } on-error={}',
  ];
  return `${lines.join('\n')}\n`;
}

function l2tpServerFirewallSpec(confText) {
  const portMatch = /^port = (\d+)$/m.exec(String(confText || ''));
  const netMatch = /^; raniah-subnet (\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})$/m.exec(String(confText || ''));
  if (!portMatch || !netMatch) {
    return null;
  }
  const port = Number(portMatch[1]);
  const parsed = parseCidr(netMatch[1], { minPrefix: 16 });
  if (!parsed || port < 1 || port > 65535) {
    return null;
  }
  return { port, network: parsed.cidr };
}

function applyL2tpServerToDisk(server, peers, { root = '', exec = execFileSync } = {}) {
  const cfg = validateL2tpServer(server, { avoidCidrs: [] });
  const list = Array.isArray(peers) ? peers : [];
  if (list.length > SERVER_MAX_PEERS) {
    fail(`Maksimal ${SERVER_MAX_PEERS} peer L2TP.`, 'peers');
  }
  const users = new Set();
  const addresses = new Set();
  const network = parseCidr(cfg.network, { minPrefix: 16 });
  const checked = list.map((peer) => {
    const row = validateL2tpPeer(peer, peer);
    if (users.has(row.username)) {
      fail(`Username ${row.username} dobel.`, 'username');
    }
    users.add(row.username);
    const ip = parseIPv4(String(peer.address || '').split('/')[0]);
    if (ip === null || ip <= network.network + 1 || ip >= network.network + network.size - 1) {
      fail(`Alamat ${peer.address || ''} di luar subnet L2TP Server.`, 'address');
    }
    if (addresses.has(ip)) {
      fail(`Alamat ${peer.address} dobel.`, 'address');
    }
    addresses.add(ip);
    return { ...row, address: formatIPv4(ip) };
  });
  const at = (target) => path.join(root, target);
  const written = [];
  const put = (target, content, mode, dirMode = 0o755) => {
    writeAtomic(at(target), content, mode, dirMode);
    written.push(target);
  };
  let existingChap = '';
  try {
    existingChap = fs.readFileSync(at(PATHS.l2tpServerChap), 'utf8');
  } catch {
    existingChap = '';
  }
  put(PATHS.l2tpdConf, renderL2tpServerConf(cfg), 0o644);
  put(PATHS.l2tpServerOptions, renderL2tpServerOptions(), 0o644);
  put(PATHS.l2tpServerChap, renderL2tpChapSecrets(checked, existingChap), 0o600);
  reloadSystemd(exec, root);
  return written;
}

function renderL2tpRoutes(cfg) {
  return renderSstpRoutes(cfg);
}

function renderL2tpHook() {
  return renderPppRouteHook(INTERFACES.l2tp, PATHS.l2tpRoutes);
}

// swanctl.conf: IKEv1 + PSK, transport mode khusus UDP 1701 (L2TP/IPsec RFC 3193). Penawaran
// proposal dibuat longgar supaya cocok dengan profil bawaan CHR (aes/3des + sha1, modp1024/2048).
// start_action = none: tunnel dinaikkan eksplisit oleh runner agar kegagalannya tercatat di journal.
function renderL2tpIpsec(cfg) {
  return [
    HEADER,
    'connections {',
    `  ${L2TP_LAC} {`,
    '    version = 1',
    `    remote_addrs = ${l2tpHost(cfg)}`,
    '    proposals = aes256-sha1-modp2048,aes128-sha1-modp2048,aes256-sha1-modp1024,aes128-sha1-modp1024,3des-sha1-modp1024',
    '    dpd_delay = 30s',
    '    keyingtries = 1',
    '    local {',
    '      auth = psk',
    '    }',
    '    remote {',
    '      auth = psk',
    '    }',
    '    children {',
    `      ${L2TP_LAC} {`,
    '        mode = transport',
    `        local_ts = dynamic[udp/${L2TP_PORT}]`,
    `        remote_ts = dynamic[udp/${L2TP_PORT}]`,
    '        esp_proposals = aes256-sha1,aes128-sha1,3des-sha1',
    '        start_action = none',
    '      }',
    '    }',
    '  }',
    '}',
    'secrets {',
    `  ike-${L2TP_LAC} {`,
    `    secret = "${cfg.ipsec_secret}"`,
    '  }',
    '}',
    '',
  ].join('\n');
}

// Dijalankan root oleh raniah-l2tp.service. Tidak memuat nilai konfigurasi dari pengguna:
// server/kredensial hanya ada di xl2tpd.conf dan options.l2tpd.client.
//   start : (IPsec bila ada) -> perintah "c raniah-l2tp" ke xl2tpd -> pantau interface ppp.
//           Keluar non-nol saat sesi putus/tidak naik, supaya systemd (Restart=always) menyambung ulang.
//   stop  : putuskan sesi L2TP dan IPsec (ExecStopPost, jalan di semua jalur berhenti).
function renderL2tpRunner() {
  return String.raw`#!/bin/sh
${HEADER}
CTL=/var/run/xl2tpd/l2tp-control
LAC=${L2TP_LAC}
IFACE=${INTERFACES.l2tp}
IPSEC_CONF=${PATHS.l2tpIpsec}

# Tulis perintah ke FIFO kontrol xl2tpd. Tanpa pembaca (xl2tpd mati) open() menggantung, maka timeout.
ctl() {
  timeout 5 sh -c 'printf "%s\n" "$1" > "$2"' sh "$1" "$CTL"
}

ipsec_down() {
  if [ -f "$IPSEC_CONF" ] && command -v swanctl >/dev/null 2>&1; then
    swanctl --terminate --ike "$LAC" >/dev/null 2>&1
  fi
  return 0
}

ipsec_up() {
  if ! command -v swanctl >/dev/null 2>&1; then
    echo "IPsec gagal: swanctl tidak ditemukan. Pasang: apt install -y strongswan-swanctl charon-systemd" >&2
    return 1
  fi
  systemctl start strongswan-swanctl.service >/dev/null 2>&1 || systemctl start strongswan.service >/dev/null 2>&1 || true
  i=0
  while [ ! -S /var/run/charon.vici ] && [ "$i" -lt 15 ]; do sleep 1; i=$((i + 1)); done
  if ! swanctl --load-all --noprompt; then
    echo "IPsec gagal: swanctl --load-all menolak konfigurasi $IPSEC_CONF" >&2
    return 1
  fi
  swanctl --terminate --ike "$LAC" >/dev/null 2>&1
  if ! swanctl --initiate --child "$LAC" --timeout 20; then
    echo "IPsec gagal: negosiasi IKE/ESP ke CHR tidak berhasil. Periksa IPsec Pre-Shared Key, UDP 500/4500 dan use-ipsec=yes di CHR." >&2
    return 1
  fi
  return 0
}

start() {
  i=0
  while [ ! -p "$CTL" ] && [ "$i" -lt 20 ]; do sleep 1; i=$((i + 1)); done
  if [ ! -p "$CTL" ]; then
    echo "xl2tpd belum siap: $CTL tidak ada. Pastikan paket xl2tpd terpasang dan xl2tpd.service berjalan." >&2
    exit 1
  fi
  if [ -f "$IPSEC_CONF" ]; then
    ipsec_up || exit 1
  fi
  ctl "d $LAC" >/dev/null 2>&1
  if ! ctl "c $LAC"; then
    echo "Gagal mengirim perintah dial ke xl2tpd ($CTL)." >&2
    exit 1
  fi
  echo "Dial $LAC dikirim ke xl2tpd, memantau interface $IFACE."
  up=0
  waited=0
  while :; do
    sleep 5
    if ip link show "$IFACE" >/dev/null 2>&1; then
      up=1
      waited=0
    elif [ "$up" = 1 ]; then
      echo "Interface $IFACE hilang (koneksi putus). systemd akan menyambung ulang." >&2
      exit 1
    else
      waited=$((waited + 5))
      if [ "$waited" -ge 60 ]; then
        echo "Interface $IFACE belum naik setelah 60 detik. Dial diulang." >&2
        exit 1
      fi
    fi
  done
}

stop() {
  ctl "d $LAC" >/dev/null 2>&1
  ipsec_down
  ip link delete "$IFACE" 2>/dev/null || true
  exit 0
}

case "$1" in
  start) start ;;
  stop) stop ;;
  *) echo "Pemakaian: $0 start|stop" >&2; exit 2 ;;
esac
`;
}

function renderL2tpUnit() {
  return [
    '[Unit]',
    'Description=RANIAH Billing - L2TP VPN client ke MikroTik CHR',
    'After=network-online.target xl2tpd.service',
    'Wants=network-online.target xl2tpd.service',
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Type=simple',
    'KillMode=control-group',
    'TimeoutStopSec=5',
    `ExecStartPre=/bin/sh -c 'test -c /dev/ppp || { echo "${SSTP_NO_PPP_MESSAGE}" >&2; exit 1; }'`,
    // xl2tpd hanya membaca xl2tpd.conf saat start, dan restart membuang sisa sesi sebelumnya.
    'ExecStartPre=/bin/systemctl restart xl2tpd.service',
    `ExecStart=${PATHS.l2tpRunner} start`,
    `ExecStopPost=${PATHS.l2tpRunner} stop`,
    `ExecStopPost=-/sbin/ip link delete ${INTERFACES.l2tp}`,
    'Restart=always',
    `RestartSec=${PPP_RESTART_SEC}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Ringkasan
// ---------------------------------------------------------------------------
function validateProfile(protocol, input, existing) {
  if (!PROTOCOLS.includes(protocol)) {
    fail('Protokol tidak dikenal. Pilih wireguard, openvpn, sstp, atau l2tp.', 'protocol');
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
  if (protocol === 'l2tp') {
    return validateL2tp(input, existing);
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

// Berkas bawaan paket (mis. /etc/xl2tpd/xl2tpd.conf) disimpan sekali sebagai *.pre-raniah
// sebelum ditimpa. Berkas buatan kita sendiri (berpenanda HEADER) tidak dicadangkan.
function backupOnce(file) {
  try {
    if (!fs.existsSync(file) || fs.existsSync(`${file}.pre-raniah`)) {
      return;
    }
    if (fs.readFileSync(file, 'utf8').includes('RANIAH Billing')) {
      return;
    }
    fs.copyFileSync(file, `${file}.pre-raniah`);
  } catch {
    // cadangan bersifat best-effort
  }
}

// ---------------------------------------------------------------------------
// WireGuard server (hub untuk MikroTik NAS). Interface wg-server, terpisah dari wg-billing.
// ---------------------------------------------------------------------------
const PEER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;

function generatePresharedKey() {
  const key = crypto.randomBytes(32).toString('base64');
  if (!WG_KEY_RE.test(key)) {
    fail('Gagal membuat Preshared Key.', 'preshared_key');
  }
  return key;
}

function assertServerAddress(addressText) {
  const address = parseCidr(addressText, { minPrefix: 16 });
  if (!address || address.prefix > 30) {
    fail('Subnet server tidak valid. Gunakan IPv4/CIDR prefix /16 sampai /30, mis. 10.220.0.1/24.', 'address');
  }
  if (address.ip === address.network || address.ip === address.network + address.size - 1) {
    fail('Alamat server tidak boleh alamat network atau broadcast.', 'address');
  }
  if (address.ip < 16777216 || (address.ip >= 2130706432 && address.ip < 2147483648) || address.ip >= 3758096384) {
    fail('Subnet server tidak boleh 0.0.0.0, loopback, atau multicast.', 'address');
  }
  return address;
}

function validateServer(input = {}, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Data server tidak valid.', 'server');
  }
  const endpointRaw = text(input.public_endpoint ?? input.publicEndpoint ?? existing?.public_endpoint ?? '');
  let endpointHost = '';
  if (endpointRaw) {
    if (endpointRaw.includes(':')) {
      fail('Endpoint publik diisi tanpa port. Port ada di kolom tersendiri.', 'public_endpoint');
    }
    endpointHost = parseHostPort(endpointRaw, {
      portRequired: false, field: 'public_endpoint', label: 'Endpoint publik',
    }).host;
  }
  const portRaw = input.listen_port ?? input.listenPort ?? existing?.listen_port ?? SERVER_DEFAULT_PORT;
  const listenPort = Number(portRaw);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    fail('Port listen harus 1-65535.', 'listen_port');
  }
  const address = assertServerAddress(text(input.address || input.subnet || '') || existing?.address || SERVER_DEFAULT_ADDRESS);
  const privateKey = text(input.private_key) || existing?.private_key || '';
  if (!WG_KEY_RE.test(privateKey)) {
    fail('Private key server tidak valid.', 'private_key');
  }
  let publicKey = '';
  try {
    publicKey = derivePublicKey(privateKey);
  } catch {
    publicKey = '';
  }
  if (!WG_KEY_RE.test(publicKey)) {
    fail('Private key server tidak valid.', 'private_key');
  }
  return {
    public_endpoint: endpointHost,
    listen_port: listenPort,
    address: address.host,
    network: address.cidr,
    private_key: privateKey,
    public_key: publicKey,
    mtu: WG_DEFAULT_MTU,
  };
}

function validatePeer(input = {}, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Data peer tidak valid.', 'peer');
  }
  const name = text(input.name ?? existing?.name);
  if (!PEER_NAME_RE.test(name)) {
    fail('Nama router hanya huruf, angka, spasi, titik, strip, dan garis bawah (maks. 40 karakter).', 'name');
  }
  let publicKey = text(input.public_key);
  let privateKey = existing?.private_key || '';
  if (!publicKey && !existing?.public_key) {
    const pair = generateKeypair();
    publicKey = pair.public_key;
    privateKey = pair.private_key;
  } else if (!publicKey) {
    publicKey = existing.public_key;
  } else if (!WG_KEY_RE.test(publicKey)) {
    fail('Public key peer tidak valid (44 karakter base64 berakhiran "=").', 'public_key');
  } else if (publicKey !== existing?.public_key) {
    privateKey = '';
  }
  let preshared = text(input.preshared_key);
  if (!preshared && input.generate_psk === true) {
    preshared = generatePresharedKey();
  } else if (!preshared && input.clear_preshared_key !== true) {
    preshared = existing?.preshared_key || '';
  }
  if (input.clear_preshared_key === true) {
    preshared = '';
  }
  if (preshared && !WG_KEY_RE.test(preshared)) {
    fail('Preshared Key tidak valid (44 karakter base64 berakhiran "=").', 'preshared_key');
  }
  const enabled = input.enabled === undefined
    ? (existing ? Number(existing.enabled) !== 0 : true)
    : input.enabled === true || input.enabled === 1 || input.enabled === '1';
  return {
    name,
    public_key: publicKey,
    private_key: privateKey || '',
    preshared_key: preshared || '',
    enabled,
  };
}

function allocatePeerAddress(serverAddress, usedAddresses = []) {
  const server = assertServerAddress(serverAddress);
  const used = new Set();
  for (const item of usedAddresses) {
    const parsed = parseCidr(String(item).includes('/') ? String(item) : `${item}/32`, { minPrefix: 0 });
    if (parsed) {
      used.add(parsed.ip);
    }
  }
  used.add(server.ip);
  for (let ip = server.network + 1; ip < server.network + server.size - 1; ip += 1) {
    if (!used.has(ip)) {
      return `${formatIPv4(ip)}/32`;
    }
  }
  fail('Subnet VPN server sudah penuh. Tidak ada IP untuk peer baru.', 'address');
  return '';
}

function assertPeerAddress(serverAddress, peerAddress) {
  const server = assertServerAddress(serverAddress);
  const peer = parseCidr(peerAddress, { minPrefix: 32 });
  if (!peer || peer.prefix !== 32) {
    fail('Alamat peer harus IPv4/32.', 'address');
  }
  if (!inCidr(peer.ip, server) || peer.ip === server.ip || peer.ip === server.network || peer.ip === server.network + server.size - 1) {
    fail('Alamat peer harus host di dalam subnet server, selain alamat server itu sendiri.', 'address');
  }
  return `${formatIPv4(peer.ip)}/32`;
}

function validateServerBundle(payload) {
  const server = validateServer(payload?.server, payload?.server);
  const list = payload?.peers;
  if (list !== undefined && !Array.isArray(list)) {
    fail('Daftar peer tidak valid.', 'peers');
  }
  const peersIn = list || [];
  if (peersIn.length > SERVER_MAX_PEERS) {
    fail(`Maksimal ${SERVER_MAX_PEERS} peer.`, 'peers');
  }
  const peers = [];
  const seen = new Set();
  for (const raw of peersIn) {
    const peer = validatePeer(raw, raw);
    const address = assertPeerAddress(server.address, raw.address);
    if (seen.has(peer.public_key)) {
      fail('Public key peer duplikat.', 'public_key');
    }
    seen.add(peer.public_key);
    peers.push({ ...peer, address });
  }
  return { server, peers };
}

function renderWgServer(server, peers) {
  const lines = [
    HEADER,
    '[Interface]',
    `Address = ${server.address}`,
    `ListenPort = ${server.listen_port}`,
    `PrivateKey = ${server.private_key}`,
    `MTU = ${server.mtu}`,
    '',
  ];
  for (const peer of peers) {
    if (!peer.enabled) {
      continue;
    }
    lines.push('[Peer]', `PublicKey = ${peer.public_key}`);
    if (peer.preshared_key) {
      lines.push(`PresharedKey = ${peer.preshared_key}`);
    }
    lines.push(`AllowedIPs = ${peer.address}`, '');
  }
  return `${lines.join('\n')}`;
}

function renderMikrotikScript(server, peer) {
  const serverNet = assertServerAddress(server.address);
  const peerNet = parseCidr(peer.address, { minPrefix: 32 });
  const routerAddress = `${formatIPv4(peerNet.ip)}/${serverNet.prefix}`;
  const privateKey = peer.private_key || 'ISI_PRIVATE_KEY_ROUTER';
  const psk = peer.preshared_key ? ` preshared-key="${peer.preshared_key}"` : '';
  const lines = [
    '# RANIAH Billing - tempel di terminal MikroTik RouterOS v7',
    `# Router: ${peer.name}`,
    `# Server: ${server.public_endpoint}:${server.listen_port}  tunnel ${server.address}`,
    `/interface wireguard add name=wg-raniah listen-port=13231 mtu=${server.mtu} private-key="${privateKey}" comment="Auto by Billing"`,
    `/ip address add address=${routerAddress} interface=wg-raniah`,
    `/interface wireguard peers add interface=wg-raniah name=billing public-key="${server.public_key}" endpoint-address=${server.public_endpoint} endpoint-port=${server.listen_port} allowed-address=${formatIPv4(serverNet.ip)}/32 persistent-keepalive=15s${psk}`,
    ...renderRadiusClientLines(formatIPv4(serverNet.ip), formatIPv4(peerNet.ip), peer),
    '',
  ];
  return lines.join('\n');
}

const OVPN_USER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const OVPN_PASS_RE = /^[A-Za-z0-9]{8,64}$/;

function prefixToMask(prefix) {
  const bits = '1'.repeat(prefix).padEnd(32, '0');
  const parts = [0, 8, 16, 24].map((offset) => Number.parseInt(bits.slice(offset, offset + 8), 2));
  return parts.join('.');
}

function maskToPrefix(maskText) {
  const parts = String(maskText || '').split('.');
  if (parts.length !== 4) {
    return null;
  }
  const bits = parts.map((part) => {
    const n = Number(part);
    if (!/^\d{1,3}$/.test(part) || n > 255) {
      return null;
    }
    return n.toString(2).padStart(8, '0');
  });
  if (bits.some((part) => part === null)) {
    return null;
  }
  const joined = bits.join('');
  if (!/^1*0*$/.test(joined)) {
    return null;
  }
  const zero = joined.indexOf('0');
  return zero === -1 ? 32 : zero;
}

function cidrOverlaps(leftText, rightText) {
  const left = parseCidr(leftText, { minPrefix: 0 });
  const right = parseCidr(rightText, { minPrefix: 0 });
  if (!left || !right) {
    return false;
  }
  return left.network < right.network + right.size && right.network < left.network + left.size;
}

function validateOvpnServer(input, { avoidCidr = null } = {}) {
  const source = input || {};
  const endpointRaw = String(source.public_endpoint || '').trim();
  let endpoint = '';
  if (endpointRaw) {
    if (endpointRaw.includes(':')) {
      fail('Endpoint publik diisi tanpa port. Port ada di kolom tersendiri.', 'public_endpoint');
    }
    endpoint = parseHostPort(endpointRaw, {
      portRequired: false, field: 'public_endpoint', label: 'Endpoint publik',
    }).host;
  }
  const port = source.listen_port == null || source.listen_port === ''
    ? OVPN_SERVER_DEFAULT_PORT
    : Number(source.listen_port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('Port TCP harus 1-65535.', 'listen_port');
  }
  const networkText = String(source.network || OVPN_SERVER_DEFAULT_NETWORK).trim();
  const parsed = parseCidr(networkText, { minPrefix: 16 });
  if (!parsed) {
    fail('Subnet harus IPv4 dengan prefix /16 sampai /30, misalnya 10.221.0.0/24.', 'network');
  }
  if (parsed.ip !== parsed.network || parsed.prefix > 30) {
    fail('Isi alamat jaringan dengan prefix /16 sampai /30, misalnya 10.221.0.0/24.', 'network');
  }
  if (!isHost(formatIPv4(parsed.network + 1))) {
    fail('Subnet tidak boleh memakai alamat loopback, 0.0.0.0, atau multicast.', 'network');
  }
  if (avoidCidr && cidrOverlaps(parsed.cidr, avoidCidr)) {
    fail('Subnet OpenVPN bentrok dengan subnet WireGuard Server.', 'network');
  }
  return {
    public_endpoint: endpoint,
    listen_port: port,
    network: parsed.cidr,
    netmask: prefixToMask(parsed.prefix),
    server_ip: formatIPv4(parsed.network + 1),
  };
}

function generateOvpnPassword() {
  let password = '';
  while (password.length < 16) {
    password += crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  }
  return password.slice(0, 16);
}

function validateOvpnPeer(input, existing = null) {
  const source = input || {};
  const name = String(source.name || '').trim();
  if (!PEER_NAME_RE.test(name)) {
    fail('Nama router 1-40 karakter: huruf, angka, spasi, titik, garis, atau garis bawah.', 'name');
  }
  const username = String(source.username || '').trim();
  if (!OVPN_USER_RE.test(username)) {
    fail('Username 1-32 karakter: huruf, angka, titik, garis, atau garis bawah.', 'username');
  }
  let password = source.password == null ? '' : String(source.password);
  if (!password && existing?.password) {
    password = existing.password;
  }
  if (!password) {
    password = generateOvpnPassword();
  }
  if (!OVPN_PASS_RE.test(password)) {
    fail('Password 8-64 karakter huruf dan angka.', 'password');
  }
  const enabled = source.enabled == null
    ? (existing ? existing.enabled !== false : true)
    : source.enabled === true || source.enabled === 1 || source.enabled === '1';
  return { name, username, password, enabled };
}

function allocateOvpnAddress(networkText, usedAddresses) {
  const parsed = parseCidr(networkText, { minPrefix: 16 });
  if (!parsed) {
    fail('Subnet OpenVPN Server tidak valid.', 'network');
  }
  const used = new Set((usedAddresses || []).map((value) => parseIPv4(String(value || '').split('/')[0])).filter((value) => value !== null));
  const serverIp = parsed.network + 1;
  for (let ip = parsed.network + 2; ip < parsed.network + parsed.size - 1; ip += 1) {
    if (ip !== serverIp && !used.has(ip)) {
      return formatIPv4(ip);
    }
  }
  fail('Tidak ada alamat kosong di subnet OpenVPN Server.', 'address');
  return '';
}

function renderOvpnAuthScript() {
  return [
    '#!/bin/sh',
    'set -u',
    'FILE=${1:-}',
    '[ -n "$FILE" ] && [ -f "$FILE" ] || exit 1',
    'USER=$(sed -n "1p" "$FILE")',
    'PASS=$(sed -n "2p" "$FILE")',
    'case "$USER" in',
    '  *[!A-Za-z0-9._-]*|"") exit 1 ;;',
    'esac',
    'CRED="/etc/openvpn/server/raniah-users/$USER"',
    '[ -f "$CRED" ] || exit 1',
    'STORED=$(cat "$CRED")',
    '[ "$PASS" = "$STORED" ] && exit 0',
    'exit 1',
    '',
  ].join('\n');
}

function renderOvpnServer(server) {
  const cfg = validateOvpnServer(server);
  return [
    '# Dibuat otomatis oleh RANIAH. OpenVPN server untuk MikroTik RouterOS v6.',
    'proto tcp-server',
    `port ${cfg.listen_port}`,
    'dev tun-ovpn-srv',
    'topology subnet',
    `server ${cfg.network.split('/')[0]} ${cfg.netmask}`,
    `ca ${PATHS.ovpnServerCa}`,
    `cert ${PATHS.ovpnServerCert}`,
    `key ${PATHS.ovpnServerKey}`,
    `dh ${PATHS.ovpnServerDh}`,
    'cipher AES-256-CBC',
    'data-ciphers AES-256-CBC',
    'data-ciphers-fallback AES-256-CBC',
    'auth SHA1',
    'tls-version-min 1.0',
    'tls-cipher DEFAULT:@SECLEVEL=0',
    'keepalive 10 30',
    'persist-key',
    'persist-tun',
    'verify-client-cert none',
    'username-as-common-name',
    'script-security 2',
    `auth-user-pass-verify ${PATHS.ovpnServerAuth} via-file`,
    `client-config-dir ${PATHS.ovpnServerCcd}`,
    `status ${PATHS.ovpnServerStatus} 5`,
    'status-version 2',
    'verb 3',
    '',
  ].join('\n');
}

function renderOvpnServerOverride() {
  return [
    '[Unit]',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'ExecStartPre=/bin/mkdir -p /run/openvpn-server',
    'LimitNPROC=infinity',
    'TasksMax=infinity',
    '',
  ].join('\n');
}

const RADIUS_SECRET_RE = /^[A-Za-z0-9]{20,32}$/;

function generateRadiusSecret() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(24);
  let secret = '';
  for (let i = 0; i < 24; i += 1) {
    secret += alphabet[bytes[i] % alphabet.length];
  }
  return secret;
}

const CHR_RADIUS_ADDRESS = '10.210.0.2';

function validateChrNas(input) {
  const source = input || {};
  const name = String(source.nama_router || source.name || '').trim();
  if (!PEER_NAME_RE.test(name)) {
    fail('Nama router 1-40 karakter: huruf, angka, spasi, titik, garis, atau garis bawah.', 'nama_router');
  }
  const rawIp = String(source.ip_vpn_nas ?? source.ip ?? '').trim();
  if (rawIp) {
    if (!isHost(rawIp) || rawIp.includes('/')) {
      fail('IP VPN NAS harus IPv4, misalnya 10.210.0.3.', 'ip_vpn_nas');
    }
  }
  return { nama_router: name, ip_vpn_nas: rawIp };
}

function renderChrMikrotikScript({ name, radiusAddress, secret, nasIp }) {
  const address = String(radiusAddress || CHR_RADIUS_ADDRESS).trim();
  if (!isHost(address)) {
    fail('Alamat RADIUS tidak valid.', 'radius_address');
  }
  const radiusSecret = String(secret || '');
  if (!RADIUS_SECRET_RE.test(radiusSecret)) {
    fail('RADIUS secret belum siap.', 'radius_secret');
  }
  const src = nasIp ? ` src-address=${nasIp}` : '';
  return [
    `# RANIAH RADIUS untuk ${name} lewat Hub CHR (RouterOS v6/v7)`,
    `/radius add service=ppp,hotspot address=${address} secret="${radiusSecret}" timeout=3000ms${src} comment="Auto by Billing"`,
    '/radius incoming set accept=yes port=3799',
    '/ppp aaa set use-radius=yes accounting=yes interim-update=5m',
    ':do { /ip hotspot profile set [find] use-radius=yes } on-error={}',
    '',
  ].join('\n');
}

function renderRadiusClientLines(serverIp, peerIp, peer) {
  const secret = String(peer?.radius_secret || '');
  if (!RADIUS_SECRET_RE.test(secret)) {
    fail('RADIUS secret peer belum siap.', 'radius_secret');
  }
  return [
    `/radius add service=ppp,hotspot address=${serverIp} secret="${secret}" timeout=3000ms src-address=${peerIp} comment="Auto by Billing"`,
    '/radius incoming set accept=yes port=3799',
    '/ppp aaa set use-radius=yes accounting=yes interim-update=5m',
  ];
}

function renderOvpnMikrotikScript(server, peer) {
  const cfg = validateOvpnServer(server);
  if (!cfg.public_endpoint) {
    fail('Isi endpoint publik sebelum menyalin script.', 'public_endpoint');
  }
  const checked = validateOvpnPeer(peer, peer);
  const iface = 'ovpn-raniah';
  return [
    `# RANIAH OpenVPN client untuk ${checked.name} (RouterOS v6)`,
    `/interface ovpn-client add name=${iface} connect-to=${cfg.public_endpoint} port=${cfg.listen_port} mode=ip user=${checked.username} password=${checked.password} cipher=aes256 auth=sha1 add-default-route=no disabled=no certificate=none comment="Auto by Billing"`,
    ...renderRadiusClientLines(cfg.server_ip, peer.address, peer),
    '',
  ].join('\n');
}

function ovpnServerFirewallSpec(confText) {
  const portMatch = /^port (\d+)$/m.exec(String(confText || ''));
  const serverMatch = /^server (\d{1,3}(?:\.\d{1,3}){3}) (\d{1,3}(?:\.\d{1,3}){3})$/m.exec(String(confText || ''));
  if (!portMatch || !serverMatch) {
    return null;
  }
  const port = Number(portMatch[1]);
  const prefix = maskToPrefix(serverMatch[2]);
  const parsed = prefix == null ? null : parseCidr(`${serverMatch[1]}/${prefix}`, { minPrefix: 16 });
  if (!parsed || port < 1 || port > 65535) {
    return null;
  }
  return { port, network: parsed.cidr };
}

function ensureOvpnPki(dir, { exec = execFileSync, existsSync = fs.existsSync } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const caKey = path.join(dir, 'ca.key');
  const caCrt = path.join(dir, 'ca.crt');
  const serverKey = path.join(dir, 'server.key');
  const serverCrt = path.join(dir, 'server.crt');
  const serverCsr = path.join(dir, 'server.csr');
  const dh = path.join(dir, 'dh.pem');
  const ready = [caKey, caCrt, serverKey, serverCrt, dh].every((file) => existsSync(file));
  if (ready) {
    return;
  }
  if (!existsSync('/usr/bin/openssl')) {
    const error = new Error('openssl belum terpasang. Jalankan: sudo apt-get install -y openssl');
    error.status = 503;
    throw error;
  }
  const run = (args) => exec('openssl', args, { timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!existsSync(caKey)) {
    run(['genrsa', '-out', caKey, '2048']);
    fs.chmodSync(caKey, 0o600);
  }
  if (!existsSync(caCrt)) {
    run(['req', '-x509', '-new', '-nodes', '-key', caKey, '-sha256', '-days', '3650', '-subj', '/CN=RANIAH-OVPN-CA', '-out', caCrt]);
    fs.chmodSync(caCrt, 0o644);
  }
  if (!existsSync(serverKey)) {
    run(['genrsa', '-out', serverKey, '2048']);
    fs.chmodSync(serverKey, 0o600);
  }
  if (!existsSync(serverCrt)) {
    run(['req', '-new', '-key', serverKey, '-subj', '/CN=raniah-ovpn-server', '-out', serverCsr]);
    const ext = path.join(dir, 'server.ext');
    fs.writeFileSync(ext, 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n', { mode: 0o644 });
    run(['x509', '-req', '-in', serverCsr, '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial', '-out', serverCrt, '-days', '3650', '-sha256', '-extfile', ext]);
    fs.chmodSync(serverCrt, 0o644);
  }
  if (!existsSync(dh)) {
    run(['dhparam', '-dsaparam', '-out', dh, '2048']);
    fs.chmodSync(dh, 0o644);
  }
}

function replaceNamedFiles(dir, files, mode, dirMode) {
  fs.mkdirSync(dir, { recursive: true, mode: dirMode });
  fs.chmodSync(dir, dirMode);
  const keep = new Set(Object.keys(files));
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!keep.has(name) && OVPN_USER_RE.test(name)) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    }
  }
  for (const [name, content] of Object.entries(files)) {
    writeAtomic(path.join(dir, name), content.endsWith('\n') ? content : `${content}\n`, mode, dirMode);
  }
}

function applyOvpnServerToDisk(server, peers, { root = '', exec = execFileSync, existsSync = fs.existsSync } = {}) {
  const cfg = validateOvpnServer(server);
  const list = Array.isArray(peers) ? peers : [];
  if (list.length > SERVER_MAX_PEERS) {
    fail(`Maksimal ${SERVER_MAX_PEERS} peer OpenVPN.`, 'peers');
  }
  const users = new Set();
  const addresses = new Set();
  const checked = list.map((peer) => {
    const row = validateOvpnPeer(peer, peer);
    if (users.has(row.username)) {
      fail(`Username ${row.username} dobel.`, 'username');
    }
    users.add(row.username);
    const ip = parseIPv4(String(peer.address || '').split('/')[0]);
    const network = parseCidr(cfg.network, { minPrefix: 16 });
    if (ip === null || ip <= network.network + 1 || ip >= network.network + network.size - 1) {
      fail(`Alamat ${peer.address || ''} di luar subnet OpenVPN Server.`, 'address');
    }
    if (addresses.has(ip)) {
      fail(`Alamat ${peer.address} dobel.`, 'address');
    }
    addresses.add(ip);
    return { ...row, address: formatIPv4(ip) };
  });
  const at = (target) => path.join(root, target);
  ensureOvpnPki(at(PATHS.ovpnServerPki), { exec, existsSync });
  const written = [];
  const put = (target, content, mode, dirMode = 0o755) => {
    writeAtomic(at(target), content, mode, dirMode);
    written.push(target);
  };
  put(PATHS.ovpnServer, renderOvpnServer(cfg), 0o600, 0o700);
  put(PATHS.ovpnServerAuth, renderOvpnAuthScript(), 0o755);
  put(PATHS.ovpnServerOverride, renderOvpnServerOverride(), 0o644);
  const userFiles = {};
  const ccdFiles = {};
  for (const peer of checked) {
    if (!peer.enabled) {
      continue;
    }
    userFiles[peer.username] = `${peer.password}\n`;
    ccdFiles[peer.username] = `ifconfig-push ${peer.address} ${cfg.netmask}\n`;
  }
  replaceNamedFiles(at(PATHS.ovpnServerUsers), userFiles, 0o600, 0o700);
  replaceNamedFiles(at(PATHS.ovpnServerCcd), ccdFiles, 0o644, 0o755);
  written.push(PATHS.ovpnServerUsers, PATHS.ovpnServerCcd);
  reloadSystemd(exec, root);
  return written;
}

function serverFirewallSpec(confText) {
  const portMatch = /^ListenPort = (\d+)$/m.exec(String(confText || ''));
  const addressMatch = /^Address = ([0-9.]+\/\d+)$/m.exec(String(confText || ''));
  if (!portMatch || !addressMatch) {
    return null;
  }
  const port = Number(portMatch[1]);
  const address = parseCidr(addressMatch[1], { minPrefix: 16 });
  if (!address || port < 1 || port > 65535) {
    return null;
  }
  return { port, network: address.cidr };
}

function defaultReadText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function defaultWriteText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
}

async function syncServerFirewall(mode, deps, exec) {
  const readText = deps.readText || defaultReadText;
  const writeText = deps.writeText || defaultWriteText;
  const previous = String(readText(PATHS.wgServerUfw) || '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (const rule of previous) {
    if (/^\d{1,5}\/udp$/.test(rule)) {
      // eslint-disable-next-line no-await-in-loop
      await exec('ufw', ['--force', 'delete', 'allow', rule], { timeout: 20000 });
    } else if (/^from \d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(rule)) {
      // eslint-disable-next-line no-await-in-loop
      await exec('ufw', ['--force', 'delete', 'allow', 'from', rule.slice(5)], { timeout: 20000 });
    }
  }
  if (mode !== 'up') {
    writeText(PATHS.wgServerUfw, '');
    return;
  }
  const spec = serverFirewallSpec(readText(PATHS.wgServer));
  if (!spec) {
    throw cycleError(500, 'wg-server.conf belum ada. Simpan pengaturan VPN Server dulu.');
  }
  const portRule = `${spec.port}/udp`;
  const opened = await exec('ufw', ['allow', portRule, 'comment', 'WireGuard VPN server'], { timeout: 20000 });
  if (!opened.ok) {
    const detail = (opened.stderr || opened.stdout || '').trim().slice(0, 200);
    throw cycleError(500, `ufw gagal membuka ${portRule}${detail ? `: ${detail}` : ''}.`);
  }
  const subnet = await exec('ufw', ['allow', 'from', spec.network, 'comment', 'Subnet VPN server'], { timeout: 20000 });
  if (!subnet.ok) {
    const detail = (subnet.stderr || subnet.stdout || '').trim().slice(0, 200);
    throw cycleError(500, `ufw gagal mengizinkan subnet ${spec.network}${detail ? `: ${detail}` : ''}.`);
  }
  writeText(PATHS.wgServerUfw, `${portRule}\nfrom ${spec.network}\n`);
}

async function syncOvpnServerFirewall(mode, deps, exec) {
  const readText = deps.readText || defaultReadText;
  const writeText = deps.writeText || defaultWriteText;
  const previous = String(readText(PATHS.ovpnServerUfw) || '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (const rule of previous) {
    if (/^\d{1,5}\/tcp$/.test(rule)) {
      // eslint-disable-next-line no-await-in-loop
      await exec('ufw', ['--force', 'delete', 'allow', rule], { timeout: 20000 });
    } else if (/^from \d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(rule)) {
      // eslint-disable-next-line no-await-in-loop
      await exec('ufw', ['--force', 'delete', 'allow', 'from', rule.slice(5)], { timeout: 20000 });
    }
  }
  if (mode !== 'up') {
    writeText(PATHS.ovpnServerUfw, '');
    return;
  }
  const spec = ovpnServerFirewallSpec(readText(PATHS.ovpnServer));
  if (!spec) {
    throw cycleError(500, 'raniah-server.conf belum ada. Simpan pengaturan OpenVPN Server dulu.');
  }
  const portRule = `${spec.port}/tcp`;
  const opened = await exec('ufw', ['allow', portRule, 'comment', 'OpenVPN VPN server'], { timeout: 20000 });
  if (!opened.ok) {
    const detail = (opened.stderr || opened.stdout || '').trim().slice(0, 200);
    throw cycleError(500, `ufw gagal membuka ${portRule}${detail ? `: ${detail}` : ''}.`);
  }
  const subnet = await exec('ufw', ['allow', 'from', spec.network, 'comment', 'Subnet OpenVPN server'], { timeout: 20000 });
  if (!subnet.ok) {
    const detail = (subnet.stderr || subnet.stdout || '').trim().slice(0, 200);
    throw cycleError(500, `ufw gagal mengizinkan subnet ${spec.network}${detail ? `: ${detail}` : ''}.`);
  }
  writeText(PATHS.ovpnServerUfw, `${portRule}\nfrom ${spec.network}\n`);
}

async function syncL2tpServerFirewall(mode, deps, exec) {
  const readText = deps.readText || defaultReadText;
  const writeText = deps.writeText || defaultWriteText;
  const previous = String(readText(PATHS.l2tpServerUfw) || '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (const rule of previous) {
    if (/^\d{1,5}\/udp$/.test(rule)) {
      // eslint-disable-next-line no-await-in-loop
      await exec('ufw', ['--force', 'delete', 'allow', rule], { timeout: 20000 });
    } else if (/^from \d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(rule)) {
      // eslint-disable-next-line no-await-in-loop
      await exec('ufw', ['--force', 'delete', 'allow', 'from', rule.slice(5)], { timeout: 20000 });
    }
  }
  if (mode !== 'up') {
    writeText(PATHS.l2tpServerUfw, '');
    return;
  }
  const spec = l2tpServerFirewallSpec(readText(PATHS.l2tpdConf));
  if (!spec) {
    throw cycleError(500, 'xl2tpd.conf mode server belum ada. Simpan pengaturan L2TP Server dulu.');
  }
  const portRule = `${spec.port}/udp`;
  const opened = await exec('ufw', ['allow', portRule, 'comment', 'L2TP VPN server'], { timeout: 20000 });
  if (!opened.ok) {
    const detail = (opened.stderr || opened.stdout || '').trim().slice(0, 200);
    throw cycleError(500, `ufw gagal membuka ${portRule}${detail ? `: ${detail}` : ''}.`);
  }
  const subnet = await exec('ufw', ['allow', 'from', spec.network, 'comment', 'Subnet L2TP server'], { timeout: 20000 });
  if (!subnet.ok) {
    const detail = (subnet.stderr || subnet.stdout || '').trim().slice(0, 200);
    throw cycleError(500, `ufw gagal mengizinkan subnet ${spec.network}${detail ? `: ${detail}` : ''}.`);
  }
  writeText(PATHS.l2tpServerUfw, `${portRule}\nfrom ${spec.network}\n`);
}

function l2tpConfIsServer(deps) {
  const readText = deps.readText || defaultReadText;
  return String(readText(PATHS.l2tpdConf) || '').includes('[lns default]');
}

function applyServerToDisk(server, peers, { root = '', exec = execFileSync } = {}) {
  const bundle = validateServerBundle({ server, peers });
  const at = (target) => path.join(root, target);
  const written = [];
  const put = (target, content, mode, dirMode = 0o755) => {
    writeAtomic(at(target), content, mode, dirMode);
    written.push(target);
  };
  put(PATHS.wgServer, renderWgServer(bundle.server, bundle.peers), 0o600, 0o700);
  put(PATHS.wgServerOverride, renderWgUnitOverride(), 0o644);
  reloadSystemd(exec, root);
  return written;
}

// Aksi yang boleh diminta aplikasi ke helper root. Tidak ada argumen bebas: pola pkill dan
// nama interface dikunci di tabel ini, bukan dari input pengguna.
const CYCLE_ACTIONS = ['stop', 'start', 'restart', 'disable'];
const IFACE_GONE_POLLS = 20;
const IFACE_GONE_INTERVAL_MS = 250;
// Pola pkill sengaja sempit. "raniah-vpn" tanpa path akan mengenai helper itu sendiri
// (/usr/local/lib/raniah-vpn dan raniah-vpn-helper) sehingga OpenVPN memakai path berkas conf.
const TEARDOWN = {
  wireguard: { pkill: [] },
  openvpn: { pkill: ['/etc/openvpn/client/raniah-vpn.conf'] },
  sstp: { pkill: ['raniah-sstp'] },
  l2tp: { pkill: ['options.l2tpd.client'] },
  server: { pkill: [] },
  'ovpn-server': { pkill: ['/etc/openvpn/server/raniah-server.conf'] },
  'l2tp-server': { pkill: ['options.xl2tpd'] },
};

function cycleError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function l2tpUnitState(result) {
  return String(result?.stdout || '').trim();
}

// xl2tpd di Debian adalah unit SysV. `systemctl disable --now` hanya memanggil
// systemd-sysv-install dan TIDAK menjalankan ExecStop, lalu tetap keluar 0.
// Tanpa `systemctl stop` + pkill, daemon tetap hidup dan UI terus membaca Aktif.
async function stopL2tpServer(deps = {}) {
  const exec = deps.exec || defaultCycleExec;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const unit = UNITS['l2tp-server'];
  const notes = [];
  const runQuiet = async (file, args, timeout = 20000) => {
    const result = await exec(file, args, { timeout });
    if (!result.ok) {
      const detail = String(result.stderr || result.stdout || '').trim();
      if (detail && file !== 'pkill') {
        notes.push(`${file} ${args.join(' ')}: ${detail.slice(0, 180)}`);
      }
    }
    return result;
  };
  await runQuiet('systemctl', ['disable', '--now', unit]);
  await runQuiet('systemctl', ['stop', unit]);
  await runQuiet('systemctl', ['reset-failed', unit], 8000);
  await runQuiet('pkill', ['-x', 'xl2tpd'], 8000);
  await runQuiet('pkill', ['-f', 'options.xl2tpd'], 8000);
  await runQuiet('systemctl', ['stop', unit]);
  await runQuiet('systemctl', ['reset-failed', unit], 8000);
  await syncL2tpServerFirewall('down', deps, exec);
  let state = '';
  for (let i = 0; i < IFACE_GONE_POLLS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const probe = await exec('systemctl', ['is-active', unit], { timeout: 8000 });
    state = l2tpUnitState(probe);
    // Proses nyata yang jadi patokan: proses yatim di luar systemd tetap harus mati.
    // eslint-disable-next-line no-await-in-loop
    const alive = await exec('pgrep', ['-x', 'xl2tpd'], { timeout: 5000 });
    if ((state === 'inactive' || state === 'unknown' || state === 'dead') && !alive.ok) {
      return { ok: true, state };
    }
    if (i === 4 || i === 10) {
      // eslint-disable-next-line no-await-in-loop
      await runQuiet('pkill', ['-x', 'xl2tpd'], 8000);
      // eslint-disable-next-line no-await-in-loop
      await runQuiet('systemctl', ['stop', unit]);
    }
    if (i < IFACE_GONE_POLLS - 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(IFACE_GONE_INTERVAL_MS);
    }
  }
  const extra = notes.slice(0, 2).join(' | ');
  throw cycleError(500, `xl2tpd masih ${state || 'active'} setelah stop L2TP Server.${extra ? ` ${extra}` : ''}`);
}

const L2TP_RUN_DIRS = ['/run/xl2tpd', '/var/run/xl2tpd'];
const L2TP_START_POLLS = 24;
const L2TP_START_INTERVAL_MS = 250;

async function l2tpProcessAlive(exec) {
  const probe = await exec('pgrep', ['-x', 'xl2tpd'], { timeout: 5000 });
  return Boolean(probe.ok);
}

// xl2tpd listening pada UDP `port`. Dicek lewat `ss -ulpn` (root melihat nama proses).
async function l2tpPortListening(exec, port) {
  const probe = await exec('ss', ['-ulpn'], { timeout: 8000 });
  if (!probe.ok) return false;
  const portPattern = new RegExp(`[:\\]]${port}\\s`);
  return String(probe.stdout || '').split('\n').some((line) => portPattern.test(line) && line.includes('xl2tpd'));
}

// Ringkas log mentah jadi satu baris yang muat di popup frontend.
function compactLog(text, maxLines = 6, maxChars = 420) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.slice(-maxLines).join(' | ').slice(-maxChars);
}

async function collectL2tpFailureLog(exec) {
  const parts = [];
  const journal = await exec('journalctl', ['-u', 'xl2tpd', '-n', '12', '--no-pager', '-o', 'cat'], { timeout: 8000 });
  const journalText = compactLog(journal.stdout || journal.stderr);
  if (journalText) parts.push(`journalctl: ${journalText}`);
  // Uji foreground singkat: xl2tpd -D mencetak alasan gagal (conf salah, fifo tidak bisa dibuat, dll).
  // Dihentikan lewat timeout bila ternyata bisa jalan, lalu dibersihkan pkill.
  const trial = await exec('/usr/sbin/xl2tpd', ['-D', '-c', PATHS.l2tpdConf], { timeout: 2500 });
  const trialText = compactLog(`${trial.stdout || ''}\n${trial.stderr || ''}`);
  if (trialText) parts.push(`xl2tpd -D: ${trialText}`);
  await exec('pkill', ['-x', 'xl2tpd'], { timeout: 8000 });
  return parts.join(' || ');
}

// Start L2TP Server dengan bukti nyata. Unit xl2tpd adalah SysV: `systemctl enable --now` tidak
// menjalankan daemon, dan `systemctl start` keluar 0 walau /usr/sbin/xl2tpd langsung mati
// (mis. /run/xl2tpd tidak ada). Sukses hanya bila proses hidup DAN UDP port listening.
async function startL2tpServer(deps = {}) {
  const exec = deps.exec || defaultCycleExec;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const readText = deps.readText || defaultReadText;
  const unit = UNITS['l2tp-server'];
  const spec = l2tpServerFirewallSpec(readText(PATHS.l2tpdConf));
  if (!spec) {
    throw cycleError(500, 'xl2tpd.conf mode server belum ada. Simpan pengaturan L2TP Server dulu.');
  }

  await exec('mkdir', ['-p', ...L2TP_RUN_DIRS], { timeout: 5000 });
  // Bersihkan instance lama termasuk proses yatim (mis. `xl2tpd -D` manual di luar systemd).
  await exec('systemctl', ['stop', unit], { timeout: 20000 });
  await exec('pkill', ['-x', 'xl2tpd'], { timeout: 8000 });
  await exec('pkill', ['-f', 'options.xl2tpd'], { timeout: 8000 });
  for (let i = 0; i < IFACE_GONE_POLLS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await l2tpProcessAlive(exec))) break;
    if (i === 8) {
      // eslint-disable-next-line no-await-in-loop
      await exec('pkill', ['-9', '-x', 'xl2tpd'], { timeout: 8000 });
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(IFACE_GONE_INTERVAL_MS);
  }
  await exec('systemctl', ['reset-failed', unit], { timeout: 8000 });
  await exec('mkdir', ['-p', ...L2TP_RUN_DIRS], { timeout: 5000 });
  await exec('systemctl', ['enable', unit], { timeout: 20000 });
  const started = await exec('systemctl', ['restart', unit], { timeout: 25000 });

  let alive = false;
  let listening = false;
  for (let i = 0; i < L2TP_START_POLLS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    alive = await l2tpProcessAlive(exec);
    // eslint-disable-next-line no-await-in-loop
    listening = alive && (await l2tpPortListening(exec, spec.port));
    if (alive && listening) break;
    if (i < L2TP_START_POLLS - 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(L2TP_START_INTERVAL_MS);
    }
  }
  if (!alive || !listening) {
    const reason = !alive ? 'proses xl2tpd tidak berjalan' : `xl2tpd tidak listening di UDP ${spec.port}`;
    const unitDetail = started.ok ? '' : String(started.stderr || started.stdout || '').trim().slice(0, 160);
    const log = await collectL2tpFailureLog(exec);
    throw cycleError(
      500,
      `L2TP Server gagal start: ${reason}.${unitDetail ? ` systemctl: ${unitDetail}.` : ''}${log ? ` ${log}` : ''}`,
    );
  }
  await syncL2tpServerFirewall('up', deps, exec);
  return { ok: true, port: spec.port };
}

function defaultCycleExec(file, args, { timeout = 20000 } = {}) {
  try {
    const stdout = execFileSync(file, args, {
      timeout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, code: 0, stdout: String(stdout || ''), stderr: '' };
  } catch (error) {
    return {
      ok: false,
      code: typeof error.status === 'number' ? error.status : 1,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || error.message || ''),
    };
  }
}

// Stop bersih: hentikan unit (dan companion), bunuh proses yatim, hapus interface, lalu tunggu
// sampai kernel tidak lagi punya nama interface itu. Start hanya jalan setelah itu.
async function cycleVpn(protocol, action, deps = {}) {
  if (!CYCLE_PROTOCOLS.includes(protocol)) {
    throw cycleError(400, 'Protokol tidak dikenal.');
  }
  if (!CYCLE_ACTIONS.includes(action)) {
    throw cycleError(400, 'Aksi VPN tidak dikenal.');
  }
  if (protocol === 'l2tp-server' && (action === 'stop' || action === 'disable')) {
    await stopL2tpServer(deps);
    return { ok: true, protocol, action };
  }
  const exec = deps.exec || defaultCycleExec;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // Kedua hub (WireGuard dan OpenVPN) boleh hidup bersamaan. Keduanya mematikan VPN Client.
  if (HUB_PROTOCOLS.includes(protocol) && (action === 'start' || action === 'restart')) {
    for (const client of PROTOCOLS) {
      // eslint-disable-next-line no-await-in-loop
      await cycleVpn(client, 'disable', deps);
    }
  }
  if (protocol === 'l2tp-server' && (action === 'start' || action === 'restart')) {
    await startL2tpServer({ ...deps, exec, sleep });
    return { ok: true, protocol, action };
  }
  const unit = UNITS[protocol];
  const iface = INTERFACES[protocol];
  const companions = COMPANION_UNITS[protocol] || [];
  const patterns = TEARDOWN[protocol].pkill;

  if (action !== 'start') {
    const verb = action === 'disable' ? ['disable', '--now'] : ['stop'];
    await exec('systemctl', [...verb, unit], { timeout: 20000 });
    await exec('systemctl', ['reset-failed', unit], { timeout: 8000 });
    for (const companion of companions) {
      // xl2tpd milik L2TP Server tidak boleh ikut mati saat client L2TP di-disable.
      if (protocol === 'l2tp' && companion === 'xl2tpd' && l2tpConfIsServer(deps)) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await exec('systemctl', [...verb, companion], { timeout: 20000 });
      // eslint-disable-next-line no-await-in-loop
      await exec('systemctl', ['reset-failed', companion], { timeout: 8000 });
    }
    for (const pattern of patterns) {
      // pkill keluar 1 bila tidak ada proses: itu sukses untuk teardown.
      // eslint-disable-next-line no-await-in-loop
      await exec('pkill', ['-f', pattern], { timeout: 8000 });
    }
    await exec('ip', ['link', 'delete', iface], { timeout: 8000 });
  }

  if (action === 'stop' || action === 'disable' || action === 'restart' || action === 'start') {
    let gone = false;
    for (let i = 0; i < IFACE_GONE_POLLS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const show = await exec('ip', ['link', 'show', iface], { timeout: 4000 });
      if (!show.ok) {
        gone = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await exec('ip', ['link', 'delete', iface], { timeout: 8000 });
      if (i < IFACE_GONE_POLLS - 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(IFACE_GONE_INTERVAL_MS);
      }
    }
    if (!gone) {
      throw cycleError(500, `Interface ${iface} masih ada setelah teardown. Start dibatalkan supaya tidak bentrok "File exists".`);
    }
  }

  if (action === 'start' || action === 'restart') {
    if (protocol === 'ovpn-server') {
      const reloaded = await exec('systemctl', ['daemon-reload'], { timeout: 15000 });
      if (!reloaded.ok) {
        const detail = (reloaded.stderr || reloaded.stdout || '').trim().slice(0, 240);
        throw cycleError(500, `systemctl daemon-reload gagal${detail ? `: ${detail}` : ''}.`);
      }
    }
    const startArgs = HUB_PROTOCOLS.includes(protocol) && action === 'start'
      ? ['enable', '--now', unit]
      : ['start', unit];
    const started = await exec('systemctl', startArgs, { timeout: 20000 });
    if (!started.ok) {
      const detail = (started.stderr || started.stdout || '').trim().slice(0, 240);
      throw cycleError(500, `systemctl ${startArgs[0]} ${unit} gagal${detail ? `: ${detail}` : ''}.`);
    }
  }
  if (protocol === 'server' && (action === 'stop' || action === 'disable')) {
    await syncServerFirewall('down', deps, exec);
  }
  if (protocol === 'server' && (action === 'start' || action === 'restart')) {
    await syncServerFirewall('up', deps, exec);
  }
  if (protocol === 'ovpn-server' && (action === 'stop' || action === 'disable')) {
    await syncOvpnServerFirewall('down', deps, exec);
  }
  if (protocol === 'ovpn-server' && (action === 'start' || action === 'restart')) {
    await syncOvpnServerFirewall('up', deps, exec);
  }
  return { ok: true, protocol, action };
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
    put(PATHS.wgOverride, renderWgUnitOverride(), 0o644);
    reloadSystemd(exec, root);
  } else if (protocol === 'openvpn') {
    const conf = renderOvpn(cfg);
    if (cfg.username && cfg.password) {
      put(PATHS.ovpnAuth, renderOvpnAuth(cfg), 0o600);
    } else {
      fs.rmSync(at(PATHS.ovpnAuth), { force: true });
    }
    put(PATHS.ovpn, conf, 0o600);
    put(PATHS.ovpnOverride, renderOvpnUnitOverride(), 0o644);
    reloadSystemd(exec, root);
  } else if (protocol === 'sstp') {
    put(PATHS.sstpPeer, renderSstpPeer(cfg, resolveSstpc(existsSync)), 0o600);
    put(PATHS.sstpRoutes, renderSstpRoutes(cfg), 0o644);
    put(PATHS.sstpHook, renderSstpHook(), 0o755);
    put(PATHS.sstpUnit, renderSstpUnit(cfg, resolvePppd(existsSync)), 0o644);
    reloadSystemd(exec, root);
  } else if (protocol === 'l2tp') {
    backupOnce(at(PATHS.l2tpdConf));
    put(PATHS.l2tpdConf, renderL2tpXl2tpd(cfg), 0o644);
    put(PATHS.l2tpOptions, renderL2tpOptions(cfg), 0o600);
    put(PATHS.l2tpRoutes, renderL2tpRoutes(cfg), 0o644);
    put(PATHS.l2tpHook, renderL2tpHook(), 0o755);
    put(PATHS.l2tpRunner, renderL2tpRunner(), 0o755);
    if (cfg.ipsec_secret) {
      put(PATHS.l2tpIpsec, renderL2tpIpsec(cfg), 0o600);
    } else {
      // L2TP murni: buang sisa konfigurasi IPsec supaya runner tidak menaikkan IPsec.
      fs.rmSync(at(PATHS.l2tpIpsec), { force: true });
    }
    put(PATHS.l2tpUnit, renderL2tpUnit(), 0o644);
    reloadSystemd(exec, root);
  } else {
    fail('Protokol tidak dikenal.', 'protocol');
  }
  return written;
}

module.exports = {
  PROTOCOLS,
  UNITS,
  COMPANION_UNITS,
  INTERFACES,
  PATHS,
  CYCLE_ACTIONS,
  CYCLE_PROTOCOLS,
  SERVER_DEFAULT_PORT,
  SERVER_DEFAULT_ADDRESS,
  OVPN_SERVER_DEFAULT_PORT,
  OVPN_SERVER_DEFAULT_NETWORK,
  L2TP_SERVER_DEFAULT_PORT,
  L2TP_SERVER_DEFAULT_NETWORK,
  HUB_PROTOCOLS,
  cycleVpn,
  validateServer,
  validatePeer,
  validateServerBundle,
  allocatePeerAddress,
  renderWgServer,
  renderMikrotikScript,
  generateRadiusSecret,
  renderRadiusClientLines,
  CHR_RADIUS_ADDRESS,
  validateChrNas,
  renderChrMikrotikScript,
  applyServerToDisk,
  validateOvpnServer,
  validateOvpnPeer,
  allocateOvpnAddress,
  renderOvpnServer,
  renderOvpnAuthScript,
  renderOvpnMikrotikScript,
  applyOvpnServerToDisk,
  validateL2tpServer,
  validateL2tpPeer,
  allocateL2tpAddress,
  renderL2tpServerConf,
  renderL2tpServerOptions,
  renderL2tpChapSecrets,
  renderL2tpServerScript,
  applyL2tpServerToDisk,
  stopL2tpServer,
  startL2tpServer,
  generatePresharedKey,
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
  validateL2tp,
  validateProfile,
  sanitizeOvpn,
  renderWireguard,
  renderOvpn,
  renderOvpnAuth,
  renderSstpPeer,
  renderSstpUnit,
  renderSstpRoutes,
  renderSstpHook,
  renderL2tpXl2tpd,
  renderL2tpOptions,
  renderL2tpIpsec,
  renderL2tpRoutes,
  renderL2tpHook,
  renderL2tpRunner,
  renderL2tpUnit,
  renderWgUnitOverride,
  renderOvpnUnitOverride,
  applyToDisk,
};
