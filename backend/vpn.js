'use strict';
/**
 * Koneksi VPN client server billing -> MikroTik CHR (WireGuard / OpenVPN / SSTP / L2TP).
 *
 * - Status  : systemctl is-active, ip -4 addr, wg show (dump), sysfs counter.
 * - Aksi    : connect/disconnect/restart lewat helper root (stop bersih, tunggu interface hilang, baru start).
 * - Berkas  : root menulis langsung; non-root lewat helper `sudo -n` yang memvalidasi ulang.
 * - Simpan  : tabel vpn_profiles (PostgreSQL), rahasia tidak pernah dikirim balik ke browser.
 *
 * Semua perintah memakai execFile (tanpa shell). Deteksi root sama seperti restart layanan:
 * root langsung, selain itu `sudo -n` (gagal cepat bila sudoers belum dipasang).
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { IS_ROOT } = require('./privileged');
const vpnConfig = require('./vpn_config');
const radiusNas = require('./radius_nas');

const {
  PROTOCOLS, UNITS, INTERFACES,
} = vpnConfig;

const HELPER_PATH = '/usr/local/sbin/raniah-vpn-helper';
const SUDOERS_HINT = 'Izin sudoers VPN belum terpasang untuk user server. Jalankan ulang install.sh atau deploy/install-vpn-helper.sh sebagai root.';
const HANDSHAKE_FRESH_SECONDS = 180;
const BIN_DIRS = ['/usr/bin', '/usr/sbin', '/bin', '/sbin', '/usr/local/bin', '/usr/local/sbin'];
const REQUIRED_TOOLS = {
  wireguard: ['wg', 'wg-quick'],
  openvpn: ['openvpn'],
  sstp: ['sstpc', 'pppd'],
  l2tp: ['xl2tpd', 'xl2tpd-control', 'pppd'],
};
const PACKAGES = {
  wireguard: 'wireguard-tools',
  openvpn: 'openvpn',
  sstp: 'sstp-client ppp',
  l2tp: 'xl2tpd ppp',
};
// L2TP/IPsec (PSK diisi) butuh strongSwan versi swanctl. Tanpa PSK paket ini tidak diperlukan.
const IPSEC_TOOL = 'swanctl';
const IPSEC_PACKAGES = 'strongswan-swanctl charon-systemd';
const LABELS = {
  wireguard: 'WireGuard', openvpn: 'OpenVPN', sstp: 'SSTP', l2tp: 'L2TP',
};
// Detik menunggu interface mendapat IP sebelum log unit diambil dan dikirim ke UI.
// SSTP/L2TP/OpenVPN butuh lebih lama: negosiasi PPP/TLS tidak selesai dalam beberapa detik.
const CONNECT_WAIT_SECONDS = {
  wireguard: 8, sstp: 12, l2tp: 12, openvpn: 15,
};
// L2TP/IPsec menegosiasikan IKE + ESP dulu sebelum L2TP didial, jadi diberi waktu lebih panjang.
const CONNECT_WAIT_SECONDS_IPSEC = 15;
// Setelah start bersih: WireGuard cepat; PPP/TLS diberi 12 detik sampai IP dari CHR muncul.
const RESTART_WAIT_SECONDS = {
  wireguard: 8, sstp: 12, l2tp: 12, openvpn: 12,
};
// SSTP/L2TP butuh lebih banyak baris: pesan TLS/sertifikat/auth ada di atas baris "Exit" pppd,
// jadi 10 baris sering memotong penyebab aslinya.
const LOG_LINES = {
  wireguard: 10, openvpn: 10, sstp: 20, l2tp: 20,
};
// Unit journal yang digabung untuk log diagnosa. pppd milik L2TP berjalan di bawah xl2tpd.service.
const LOG_UNITS = {
  l2tp: [UNITS.l2tp, 'xl2tpd'],
};
const LOG_LINE_MAX = 300;
function pppDeviceHint(label) {
  return `${label} butuh /dev/ppp. Di host Proxmox jalankan "modprobe ppp_generic", "modprobe ppp_async", dan "chmod 666 /dev/ppp", lalu tambahkan ke /etc/pve/lxc/<CTID>.conf: "lxc.cgroup2.devices.allow: c 108:0 rwm" dan "lxc.mount.entry: /dev/ppp dev/ppp none bind,create=file". Kontainer harus Privileged (unprivileged: 0). Jika masih Unprivileged, Backup & Restore tanpa centang Unprivileged container, lalu "pct reboot <CTID>".`;
}
// Device yang harus ada di OS. Di kontainer LXC/Proxmox keduanya harus diteruskan dari host.
const REQUIRED_DEVICES = {
  sstp: { path: '/dev/ppp', hint: pppDeviceHint('SSTP') },
  l2tp: { path: '/dev/ppp', hint: pppDeviceHint('L2TP') },
  openvpn: {
    path: '/dev/net/tun',
    hint: 'OpenVPN butuh /dev/net/tun, tetapi device ini tidak ada di server (umum pada kontainer LXC/Proxmox). Di host Proxmox tambahkan ke /etc/pve/lxc/<CTID>.conf: "lxc.cgroup2.devices.allow: c 10:200 rwm" dan "lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file", lalu restart kontainer.',
  },
};

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function defaultRun(file, args = [], { input, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(file, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      });
    } catch (error) {
      resolve({ ok: false, code: 1, stdout: '', stderr: String(error.message || error) });
      return;
    }
    child.stdin.on('error', () => {});
    try {
      child.stdin.end(input === undefined ? undefined : String(input));
    } catch {
      // Proses tanpa stdin (perintah tidak ditemukan) tetap diselesaikan lewat callback.
    }
  });
}

function sudoDenied(output) {
  return /password is required|a terminal is required|not allowed to execute|is not in the sudoers/i.test(String(output || ''));
}

function parseIpAddr(output) {
  const match = /\binet\s+(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?/.exec(String(output || ''));
  return match ? { ip: match[1], prefix: match[2] ? Number(match[2]) : null } : null;
}

// `wg show <if> dump`: baris 1 = interface (berisi private key, JANGAN dikembalikan),
// baris berikut = peer: pub psk endpoint allowed-ips handshake rx tx keepalive.
function parseWgDump(output) {
  const lines = String(output || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) {
    return null;
  }
  const cols = lines[1].split('\t');
  const handshake = Number(cols[4]) || 0;
  return {
    endpoint: cols[2] && cols[2] !== '(none)' ? cols[2] : null,
    latest_handshake: handshake > 0 ? handshake : null,
    rx_bytes: Number(cols[5]) || 0,
    tx_bytes: Number(cols[6]) || 0,
  };
}

// Banyak peer. Baris pertama interface dibuang (berisi private key server).
function parseWgServerDump(output) {
  const lines = String(output || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const peers = [];
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    if (!cols[0]) {
      continue;
    }
    const handshake = Number(cols[4]) || 0;
    peers.push({
      public_key: cols[0],
      endpoint: cols[2] && cols[2] !== '(none)' ? cols[2] : null,
      allowed_ips: cols[3] || '',
      latest_handshake: handshake > 0 ? handshake : null,
      rx_bytes: Number(cols[5]) || 0,
      tx_bytes: Number(cols[6]) || 0,
    });
  }
  return { peers };
}

// status-version 2: CLIENT_LIST,CN,real,virt,virt6,rx,tx,since,since_t,username,...
function parseOvpnStatus(output) {
  const peers = [];
  for (const line of String(output || '').split('\n')) {
    if (!line.startsWith('CLIENT_LIST,')) {
      continue;
    }
    const cols = line.split(',');
    const username = (cols[9] || cols[1] || '').trim();
    if (!username || username === 'UNDEF') {
      continue;
    }
    peers.push({
      username,
      virtual_ip: cols[3] || '',
      rx_bytes: Number(cols[5]) || 0,
      tx_bytes: Number(cols[6]) || 0,
    });
  }
  return peers;
}

// Rute yang membelokkan seluruh trafik server lewat VPN (default / 0.0.0.0/1 / 128.0.0.0/1).
function hijacksDefaultRoute(routeOutput) {
  return String(routeOutput || '').split('\n').some((line) => /^(default|0\.0\.0\.0\/[01]|128\.0\.0\.0\/1)\b/.test(line.trim()));
}

const PING_HOST_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const PING_NAME_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function emptyPing() {
  return {
    public: { target: null, ms: null, status: 'timeout' },
    tunnel: { target: null, ms: null, status: 'timeout' },
  };
}

// Unit yang disabled tapi masih berstatus failed di systemd tidak perlu membanjiri UI.
function vpnFailedProtocols(states, { connected = false, activeProtocol = null } = {}) {
  const failed = PROTOCOLS.filter((protocol) => states[protocol] === 'failed');
  if (connected && activeProtocol) {
    return failed.filter((protocol) => protocol === activeProtocol);
  }
  return failed;
}

// Host saja: buang :port. Menerima IPv4 dan domain. Bukan string yang lolos = null.
function hostOf(value) {
  const raw = String(value || '').trim();
  if (!raw || /[\s/\\]/.test(raw)) {
    return null;
  }
  const bracket = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(raw);
  let host = raw;
  if (bracket) {
    host = bracket[1];
  } else {
    const colon = raw.lastIndexOf(':');
    if (colon > 0 && /^\d{1,5}$/.test(raw.slice(colon + 1))) {
      const port = Number(raw.slice(colon + 1));
      if (port < 1 || port > 65535) {
        return null;
      }
      host = raw.slice(0, colon);
    }
  }
  return isSafePingTarget(host) ? host : null;
}

function isSafePingTarget(value) {
  const host = String(value || '');
  return PING_HOST_RE.test(host) || PING_NAME_RE.test(host);
}

// 10.210.0.2/24 -> 10.210.0.1. Oktet terakhir selalu .1 (gateway CHR).
function tunnelGateway(value) {
  const raw = String(value || '').trim().split('/')[0].trim();
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
  if (!match) {
    return null;
  }
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return null;
  }
  return `${octets[0]}.${octets[1]}.${octets[2]}.1`;
}

function publicPingTarget(protocol, profile) {
  if (!profile) {
    return null;
  }
  if (protocol === 'wireguard') {
    return hostOf(profile.endpoint);
  }
  if (protocol === 'sstp' || protocol === 'l2tp') {
    return hostOf(profile.server);
  }
  if (protocol === 'openvpn') {
    const remote = /^[ \t]*remote[ \t]+(\S+)/im.exec(profile.ovpn_config || '');
    return remote ? hostOf(remote[1]) : null;
  }
  return null;
}

function tunnelPingTarget(protocol, profile, activeIp) {
  if (protocol === 'wireguard') {
    return tunnelGateway(profile?.address) || tunnelGateway(activeIp);
  }
  if (protocol === 'openvpn' || protocol === 'sstp') {
    return tunnelGateway(activeIp) || tunnelGateway(profile?.address);
  }
  if (protocol === 'l2tp') {
    // Dari IP interface ppp yang diberi CHR. Subnet route NAS sengaja tidak dipakai sebagai
    // cadangan: itu jaringan di belakang NAS, bukan gateway tunnel, dan hasil ping-nya menyesatkan.
    return tunnelGateway(activeIp);
  }
  return null;
}

function parsePingMs(output) {
  const match = /time[=<]([0-9]+(?:[.,][0-9]+)?)\s*ms/i.exec(String(output || ''));
  if (!match) {
    return null;
  }
  const ms = Number(match[1].replace(',', '.'));
  return Number.isFinite(ms) ? ms : null;
}

function formatByteCount(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) {
    return null;
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : 2)} ${units[index]}`;
}

function presentTraffic(traffic) {
  if (!traffic) {
    return null;
  }
  return {
    rx_bytes: Number(traffic.rx_bytes) || 0,
    tx_bytes: Number(traffic.tx_bytes) || 0,
    rx: formatByteCount(traffic.rx_bytes),
    tx: formatByteCount(traffic.tx_bytes),
  };
}

// Journal bisa memuat karakter kontrol dan, jarang, kredensial. Bersihkan sebelum dikirim ke browser.
function logLineCount(protocol) {
  return LOG_LINES[protocol] || 10;
}

function sanitizeLog(output, max = 20) {
  return String(output || '')
    .split('\n')
    // eslint-disable-next-line no-control-regex
    .map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trimEnd())
    .filter((line) => line.trim() !== '' && !/^-- (Logs begin|No entries|Journal)/i.test(line.trim()))
    .map((line) => line
      .replace(/\b(password|passwd|secret|private[_-]?key|preshared[_-]?key)(\s*[=:]\s*)\S+/gi, '$1$2***')
      .slice(0, LOG_LINE_MAX))
    .slice(-max);
}

// Tebak penyebab dari log unit: device, port/jaringan, handshake TLS, sertifikat, atau kredensial.
// Urutan penting: pesan "certificate ... ignoring" (mode --cert-warn) bukan kegagalan.
function diagnoseLog(lines, protocol = null) {
  const text = (Array.isArray(lines) ? lines : []).join('\n');
  const isL2tp = protocol === 'l2tp';
  if (!text) {
    return null;
  }
  if (/\/dev\/ppp|\/dev\/net\/tun/i.test(text)) {
    return { code: 'device', text: 'Device PPP/TUN tidak tersedia di server (kontainer LXC/Proxmox: teruskan device dari host).' };
  }
  if (/set tty to PPP discipline|TIOCSETD/i.test(text)) {
    return {
      code: 'discipline',
      text: 'Kernel menolak line discipline PPP (Couldn\'t set tty to PPP discipline: Operation not permitted). Di host muat modul ppp_generic dan ppp_async. Kontainer LXC harus Privileged (unprivileged: 0); yang masih Unprivileged diubah lewat Backup & Restore di Proxmox (hilangkan centang Unprivileged container), lalu pct reboot <CTID>.',
    };
  }
  // IPsec dicek sebelum "network": kegagalan IKE sering berbentuk timeout/retransmit.
  if (isL2tp && /no proposal chosen|NO_PROPOSAL_CHOSEN|INVALID_HASH_INFORMATION|AUTHENTICATION_FAILED|giving up after \d+ retransmits|establishing IKE_SA failed|initiate failed|IPsec gagal/i.test(text)) {
    return {
      code: 'ipsec',
      text: 'Negosiasi IPsec ke CHR gagal. Periksa IPsec Pre-Shared Key (harus sama dengan ipsec-secret di CHR), UDP 500/4500 tidak diblokir, use-ipsec=yes di L2TP server CHR, dan paket strongswan-swanctl terpasang. Untuk L2TP tanpa IPsec, kosongkan IPsec Pre-Shared Key.',
    };
  }
  if (/connection refused|timed out|timeout|could not connect|unable to connect|no route to host|network is unreachable|could not resolve|name or service not known|getaddrinfo|temporary failure in name resolution|maximum retries exceeded/i.test(text)) {
    return {
      code: 'network',
      text: isL2tp
        ? 'Server CHR tidak terjangkau. Periksa IP/domain, UDP 1701 (dan UDP 500/4500 bila memakai IPsec), L2TP server aktif di CHR, dan firewall.'
        : 'Server CHR tidak terjangkau. Periksa IP/domain, port (SSTP bawaan 443), service SSTP server aktif di CHR, dan firewall.',
    };
  }
  if (/authentication failed|authentication failure|peer refused to authenticate|chap authentication failed|mschap.*(fail|error)|auth.*(rejected|denied)|access-reject/i.test(text)) {
    return {
      code: 'auth',
      text: `Username/password ditolak CHR. Periksa /ppp secret (service=${isL2tp ? 'l2tp' : 'sstp'} atau any) dan profilnya.`,
    };
  }
  // TLS/sertifikat hanya relevan untuk SSTP.
  if (isL2tp) {
    return null;
  }
  if (/ssl_connect|handshake|ssl error|unsupported protocol|wrong version number|alert (handshake|protocol)/i.test(text)) {
    return { code: 'tls', text: 'Handshake TLS gagal. Pastikan port itu memang SSTP server CHR dan versi TLS di CHR didukung.' };
  }
  if (/certificate.*(fail|error|verif)|verify failed|self[- ]signed/i.test(text) && !/ignoring/i.test(text)) {
    return { code: 'certificate', text: 'Sertifikat TLS CHR ditolak. Centang "Abaikan validasi sertifikat" (--cert-warn) bila CHR memakai sertifikat self-signed.' };
  }
  return null;
}

function createVpnService(overrides = {}) {
  const isRoot = overrides.isRoot ?? IS_ROOT;
  const run = overrides.run || defaultRun;
  const existsSync = overrides.existsSync || fs.existsSync;
  const readText = overrides.readText || ((file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  });
  const sleep = overrides.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const writeText = overrides.writeText || ((file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode: 0o600 });
  });
  const now = overrides.now || (() => Date.now());
  const applyDisk = overrides.applyToDisk || vpnConfig.applyToDisk;
  const helperPath = overrides.helperPath || HELPER_PATH;

  let busy = false;

  // Root: langsung. Selain root: `sudo -n` (aturan: process.getuid() === 0 ? '' : 'sudo -n ').
  function runPriv(binary, args, options) {
    return isRoot ? run(binary, args, options) : run('sudo', ['-n', binary, ...args], options);
  }

  async function systemctlPriv(args) {
    const result = await runPriv('systemctl', args);
    if (!result.ok) {
      const detail = (result.stderr || result.stdout).trim();
      throw httpError(sudoDenied(detail) ? 503 : 500, sudoDenied(detail) ? SUDOERS_HINT : `systemctl ${args.join(' ')} gagal: ${detail.slice(0, 240)}`);
    }
    return result.stdout.trim();
  }

  // Root menjalankan urutan teardown di proses ini. Selain root, satu panggilan sudo ke helper
  // yang menjalankan urutan yang sama (pkill/ip tidak pernah masuk sudoers sebagai perintah bebas).
  async function cleanCycle(protocol, action) {
    if (isRoot) {
      await vpnConfig.cycleVpn(protocol, action, { exec: run, sleep, readText, writeText });
      return;
    }
    const result = await run('sudo', ['-n', helperPath, 'cycle', protocol, action], { timeout: 60000 });
    if (!result.ok) {
      const detail = (result.stderr || result.stdout || '').trim();
      throw httpError(
        sudoDenied(detail) ? 503 : 500,
        sudoDenied(detail) ? SUDOERS_HINT : (detail.slice(0, 300) || `Teardown ${LABELS[protocol] || protocol} gagal.`),
      );
    }
  }

  async function disableUnit(protocol) {
    await cleanCycle(protocol, 'disable');
  }

  function findBinary(name) {
    return BIN_DIRS.some((dir) => existsSync(`${dir}/${name}`));
  }

  function toolsInfo() {
    const tools = {};
    for (const protocol of PROTOCOLS) {
      const missing = REQUIRED_TOOLS[protocol].filter((name) => !findBinary(name));
      const device = REQUIRED_DEVICES[protocol];
      tools[protocol] = {
        installed: missing.length === 0,
        missing,
        package: PACKAGES[protocol],
        hint: missing.length ? `apt install -y ${PACKAGES[protocol]}` : null,
        // Device OS yang wajib ada (mis. /dev/ppp untuk SSTP/L2TP); kosong = aman.
        device_missing: device && !existsSync(device.path) ? device.path : null,
        device_hint: device && !existsSync(device.path) ? device.hint : null,
      };
    }
    // IPsec bersifat opsional (hanya bila IPsec Pre-Shared Key diisi): dilaporkan terpisah dari `installed`.
    const ipsecInstalled = findBinary(IPSEC_TOOL);
    tools.l2tp.ipsec_installed = ipsecInstalled;
    tools.l2tp.ipsec_hint = ipsecInstalled ? null : `apt install -y ${IPSEC_PACKAGES}`;
    return tools;
  }

  async function unitState(protocol) {
    try {
      const result = await run('systemctl', ['is-active', UNITS[protocol]], { timeout: 8000 });
      return (result.stdout || '').trim() || 'unknown';
    } catch {
      // systemctl tidak ada, atau unit belum dikenal: anggap tidak aktif.
      return 'unknown';
    }
  }

  async function interfaceInfo(protocol) {
    try {
      const result = await run('ip', ['-4', '-o', 'addr', 'show', 'dev', INTERFACES[protocol]], { timeout: 8000 });
      return result.ok ? parseIpAddr(result.stdout) : null;
    } catch {
      return null;
    }
  }

  async function uptimeSeconds(protocol) {
    try {
      const result = await run('systemctl', ['show', UNITS[protocol], '-p', 'ActiveEnterTimestampMonotonic', '--value'], { timeout: 8000 });
      const micros = Number(result.stdout.trim());
      const bootSeconds = Number(readText('/proc/uptime').split(' ')[0]);
      if (!micros || !bootSeconds) {
        return null;
      }
      return Math.max(0, Math.round(bootSeconds - micros / 1e6));
    } catch {
      return null;
    }
  }

  function trafficOf(protocol) {
    const base = `/sys/class/net/${INTERFACES[protocol]}/statistics`;
    const rx = readText(`${base}/rx_bytes`).trim();
    const tx = readText(`${base}/tx_bytes`).trim();
    return rx !== '' && tx !== '' ? { rx_bytes: Number(rx) || 0, tx_bytes: Number(tx) || 0 } : null;
  }

  function disconnectedStatus(extra = {}) {
    return {
      success: true,
      state: 'disconnected',
      connected: false,
      protocol: null,
      interface: null,
      ip: null,
      prefix: null,
      uptime_seconds: null,
      traffic: null,
      wireguard: null,
      units: {},
      failed: [],
      tools: {},
      is_root: isRoot,
      helper_installed: false,
      checked_at: new Date(now()).toISOString(),
      ping: emptyPing(),
      ...extra,
    };
  }

  async function getStatus() {
    try {
      return await collectStatus();
    } catch (error) {
      // Perintah OS gagal (paket belum terpasang, interface belum ada, sudo ditolak).
      // Halaman harus tetap bisa dibuka: HTTP 200, bukan popup error.
      console.error('[vpn] status:', error.message);
      return disconnectedStatus();
    }
  }

  async function collectStatus() {
    const states = {};
    await Promise.all(PROTOCOLS.map(async (protocol) => {
      states[protocol] = await unitState(protocol);
    }));
    const activeProtocol = PROTOCOLS.find((protocol) => ['active', 'activating', 'reloading'].includes(states[protocol])) || null;

    const status = {
      success: true,
      state: 'disconnected',
      connected: false,
      protocol: activeProtocol,
      interface: activeProtocol ? INTERFACES[activeProtocol] : null,
      ip: null,
      prefix: null,
      uptime_seconds: null,
      traffic: null,
      wireguard: null,
      units: states,
      failed: [],
      tools: toolsInfo(),
      is_root: isRoot,
      helper_installed: isRoot || existsSync(helperPath),
      checked_at: new Date(now()).toISOString(),
      server_active: false,
    };
    const hubLife = async (protocol) => ['active', 'activating', 'reloading'].includes(await unitState(protocol));
    status.server_active = (await hubLife('server')) || (await hubLife('ovpn-server'));
    if (!activeProtocol) {
      status.failed = vpnFailedProtocols(states);
      status.ping = emptyPing();
      return status;
    }

    const [addr, uptime] = await Promise.all([interfaceInfo(activeProtocol), uptimeSeconds(activeProtocol)]);
    status.ip = addr?.ip || null;
    status.prefix = addr?.prefix ?? null;
    status.uptime_seconds = uptime;
    status.traffic = trafficOf(activeProtocol);

    if (activeProtocol === 'wireguard') {
      const dump = await runPriv('wg', ['show', INTERFACES.wireguard, 'dump'], { timeout: 8000 });
      const peer = dump.ok ? parseWgDump(dump.stdout) : null;
      if (peer) {
        const age = peer.latest_handshake ? Math.max(0, Math.round(now() / 1000 - peer.latest_handshake)) : null;
        status.wireguard = {
          endpoint: peer.endpoint,
          latest_handshake: peer.latest_handshake ? new Date(peer.latest_handshake * 1000).toISOString() : null,
          handshake_age_seconds: age,
          rx_bytes: peer.rx_bytes,
          tx_bytes: peer.tx_bytes,
        };
        status.traffic = { rx_bytes: peer.rx_bytes, tx_bytes: peer.tx_bytes };
        status.state = status.ip && age !== null && age <= HANDSHAKE_FRESH_SECONDS ? 'connected' : 'connecting';
      } else {
        // `wg` tidak bisa dibaca (mis. sudoers belum ada): andalkan interface naik.
        status.state = status.ip ? 'connected' : 'connecting';
      }
    } else {
      status.state = status.ip && states[activeProtocol] === 'active' ? 'connected' : 'connecting';
    }
    status.connected = status.state === 'connected';
    status.failed = vpnFailedProtocols(states, {
      connected: status.connected,
      activeProtocol,
    });
    status.traffic = presentTraffic(status.traffic);
    status.ping = emptyPing();
    return status;
  }

  async function pingOnce(target) {
    if (!target || !isSafePingTarget(target)) {
      return { target: target || null, ms: null, status: 'timeout' };
    }
    try {
      const result = await run('ping', ['-c', '1', '-W', '1', target], { timeout: 4000 });
      const ms = result && result.ok ? parsePingMs(result.stdout) : null;
      return { target, ms, status: ms === null ? 'timeout' : 'ok' };
    } catch {
      return { target, ms: null, status: 'timeout' };
    }
  }

  // Dua ping sekaligus. Target hanya dari konfigurasi/interface, dan hanya argv yang lolos validasi.
  async function measurePing(protocol, profile, activeIp) {
    if (!protocol) {
      return emptyPing();
    }
    const publicTarget = publicPingTarget(protocol, profile);
    const tunnelTarget = tunnelPingTarget(protocol, profile, activeIp);
    const [pub, tunnel] = await Promise.all([
      pingOnce(publicTarget),
      pingOnce(tunnelTarget),
    ]);
    return { public: pub, tunnel };
  }

  // Tulis konfigurasi ke OS: langsung bila root, selain itu lewat helper root-owned.
  async function applyConfig(protocol, cfg) {
    if (isRoot) {
      try {
        applyDisk(protocol, cfg);
      } catch (error) {
        if (error.status) {
          throw error;
        }
        throw httpError(500, `Gagal menulis konfigurasi VPN: ${String(error.message).slice(0, 240)}`);
      }
      return;
    }
    if (!existsSync(helperPath)) {
      throw httpError(503, `Helper VPN belum terpasang (${helperPath}). Jalankan ulang install.sh atau deploy/install-vpn-helper.sh sebagai root.`);
    }
    const result = await run('sudo', ['-n', helperPath, 'apply'], {
      input: JSON.stringify({ protocol, config: cfg }),
      timeout: 30000,
    });
    if (!result.ok) {
      const detail = (result.stderr || result.stdout).trim();
      throw httpError(sudoDenied(detail) ? 503 : 500, sudoDenied(detail) ? SUDOERS_HINT : `Gagal menulis konfigurasi VPN: ${detail.slice(0, 240)}`);
    }
  }

  function ensureTools(protocol, cfg = null) {
    const info = toolsInfo()[protocol];
    if (!info.installed) {
      throw httpError(503, `Paket ${LABELS[protocol]} belum terpasang di server (${info.missing.join(', ')}). Jalankan: ${info.hint}`);
    }
    // L2TP + IPsec PSK: tanpa swanctl runner gagal di tahap IPsec, jadi tolak lebih awal dengan petunjuk.
    if (protocol === 'l2tp' && cfg?.ipsec_secret && !info.ipsec_installed) {
      throw httpError(503, `IPsec Pre-Shared Key diisi, tetapi paket strongSwan belum terpasang (${IPSEC_TOOL}). Jalankan: ${info.ipsec_hint}. Atau kosongkan IPsec Pre-Shared Key untuk L2TP murni.`);
    }
  }

  // Tanpa device ini pppd/openvpn gagal seketika dan systemd memulai ulang tanpa henti.
  // Hentikan unit yang terlanjur menyala supaya tidak membanjiri journal.
  async function ensureDevices(protocol) {
    const need = REQUIRED_DEVICES[protocol];
    if (!need || existsSync(need.path)) {
      return;
    }
    await disableUnit(protocol).catch(() => {});
    throw httpError(503, need.hint);
  }

  // Baris terakhir journal unit, untuk ditampilkan di UI saat koneksi belum tersambung.
  async function readUnitLog(protocol, lines = logLineCount(protocol)) {
    try {
      const units = (LOG_UNITS[protocol] || [UNITS[protocol]]).flatMap((unit) => ['-u', unit]);
      const result = await runPriv('journalctl', [...units, '-n', String(lines), '--no-pager'], { timeout: 8000 });
      if (!result || !result.ok) {
        return [];
      }
      return sanitizeLog(result.stdout, lines);
    } catch {
      return [];
    }
  }

  // Satu operasi VPN pada satu waktu, supaya connect/disconnect tidak saling menimpa.
  async function exclusive(task) {
    if (busy) {
      throw httpError(409, 'Operasi VPN lain sedang berjalan. Coba lagi sebentar lagi.');
    }
    busy = true;
    try {
      return await task();
    } finally {
      busy = false;
    }
  }

  // Matikan & copot dari boot semua protokol lain agar tidak bentrok saat LXC/OS restart.
  async function stopOthers(protocol) {
    for (const other of PROTOCOLS.filter((item) => item !== protocol)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await disableUnit(other);
      } catch (error) {
        if (error.status === 503) {
          throw error;
        }
        // Unit belum pernah dibuat: abaikan.
      }
    }
  }

  async function routeHijack(protocol) {
    const result = await run('ip', ['-4', 'route', 'show', 'dev', INTERFACES[protocol]], { timeout: 8000 });
    return result.ok && hijacksDefaultRoute(result.stdout);
  }

  async function connect(protocol, cfg) {
    if (!PROTOCOLS.includes(protocol)) {
      throw httpError(400, 'Protokol tidak dikenal.');
    }
    if (!cfg) {
      throw httpError(400, `Konfigurasi ${LABELS[protocol]} belum disimpan. Simpan konfigurasi dulu.`);
    }
    ensureTools(protocol, cfg);
    return exclusive(async () => {
      // Client tidak boleh bersamaan dengan hub. Matikan WireGuard Server dan OpenVPN Server.
      await cleanCycle('server', 'disable');
      await cleanCycle('ovpn-server', 'disable');
      await ensureDevices(protocol);
      await applyConfig(protocol, cfg);
      await stopOthers(protocol);
      // Lepas interface lama dulu. enable --now baru dijalankan setelah nama interface hilang.
      await cleanCycle(protocol, 'stop');
      await systemctlPriv(['enable', '--now', UNITS[protocol]]);

      const attempts = protocol === 'l2tp' && cfg.ipsec_secret
        ? CONNECT_WAIT_SECONDS_IPSEC
        : CONNECT_WAIT_SECONDS[protocol] || 8;
      let status = null;
      for (let i = 0; i < attempts; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(1000);
        // eslint-disable-next-line no-await-in-loop
        if (await routeHijack(protocol)) {
          // eslint-disable-next-line no-await-in-loop
          await disableUnit(protocol).catch(() => {});
          throw httpError(409, `${LABELS[protocol]} dibatalkan: CHR mencoba mengalihkan default route server sehingga akses VPS bisa terputus. Periksa konfigurasi di CHR.`);
        }
        // eslint-disable-next-line no-await-in-loop
        status = await getStatus();
        if (status.protocol === protocol && status.connected) {
          break;
        }
        if (status.units[protocol] === 'failed' || status.units[protocol] === 'inactive') {
          break;
        }
      }
      const connected = Boolean(status && status.protocol === protocol && status.connected);
      // Belum tersambung: sertakan log asli unit supaya penyebabnya (sertifikat, port, kredensial) terlihat.
      const log = connected ? [] : await readUnitLog(protocol);
      return { status, protocol, log };
    });
  }

  async function disconnect(protocol) {
    if (!PROTOCOLS.includes(protocol)) {
      throw httpError(400, 'Protokol tidak dikenal.');
    }
    return exclusive(async () => {
      await disableUnit(protocol);
      return { status: await getStatus(), protocol };
    });
  }

  // Restart unit VPN yang sedang dipakai (tanpa mematikan protokol lain atau menulis ulang konfigurasi).
  // Bukan systemctl restart mentah: stop, bunuh proses yatim, tunggu interface hilang, baru start.
  async function restart(protocol, cfg, { selectedProtocol = null } = {}) {
    if (!PROTOCOLS.includes(protocol)) {
      throw httpError(400, 'Protokol tidak dikenal.');
    }
    if (cfg) {
      ensureTools(protocol, cfg);
    }
    return exclusive(async () => {
      const snapshot = await getStatus();
      const unitLife = snapshot.units?.[protocol] || 'unknown';
      const ownsSlot = snapshot.protocol === protocol
        || (selectedProtocol === protocol && ['active', 'activating', 'reloading', 'failed'].includes(unitLife));
      if (!ownsSlot) {
        throw httpError(
          400,
          `${LABELS[protocol]} tidak sedang aktif${snapshot.protocol ? ` (${LABELS[snapshot.protocol]} sedang berjalan)` : ''}. Gunakan Hubungkan untuk mengaktifkannya.`,
        );
      }
      await ensureDevices(protocol);
      await cleanCycle(protocol, 'restart');

      const attempts = protocol === 'l2tp' && cfg && cfg.ipsec_secret
        ? CONNECT_WAIT_SECONDS_IPSEC
        : RESTART_WAIT_SECONDS[protocol] || 12;
      let status = null;
      for (let i = 0; i < attempts; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(1000);
        // eslint-disable-next-line no-await-in-loop
        if (await routeHijack(protocol)) {
          // eslint-disable-next-line no-await-in-loop
          await disableUnit(protocol).catch(() => {});
          throw httpError(409, `${LABELS[protocol]} dibatalkan: CHR mengalihkan default route server.`);
        }
        // eslint-disable-next-line no-await-in-loop
        status = await getStatus();
        if (status.protocol === protocol && status.connected) {
          break;
        }
        if (status.units[protocol] === 'failed') {
          break;
        }
      }
      const connected = Boolean(status && status.protocol === protocol && status.connected);
      const log = connected ? [] : await readUnitLog(protocol);
      return { status, protocol, log, connected };
    });
  }

  async function applyServer(server, peers) {
    if (isRoot) {
      try {
        vpnConfig.applyServerToDisk(server, peers);
      } catch (error) {
        if (error.status) {
          throw error;
        }
        throw httpError(500, `Gagal menulis konfigurasi VPN Server: ${String(error.message).slice(0, 240)}`);
      }
      return;
    }
    if (!existsSync(helperPath)) {
      throw httpError(503, `Helper VPN belum terpasang (${helperPath}). Jalankan ulang install.sh atau deploy/install-vpn-helper.sh sebagai root.`);
    }
    const result = await run('sudo', ['-n', helperPath, 'apply-server'], {
      input: JSON.stringify({ server, peers }),
      timeout: 30000,
    });
    if (!result.ok) {
      const detail = (result.stderr || result.stdout).trim();
      throw httpError(sudoDenied(detail) ? 503 : 500, sudoDenied(detail) ? SUDOERS_HINT : `Gagal menulis konfigurasi VPN Server: ${detail.slice(0, 240)}`);
    }
  }

  async function getServerStatus() {
    const life = await unitState('server');
    const active = ['active', 'activating', 'reloading'].includes(life);
    const status = {
      state: life === 'failed' ? 'failed' : (active ? 'starting' : 'inactive'),
      unit: life,
      interface: INTERFACES.server,
      ip: null,
      rx_bytes: 0,
      tx_bytes: 0,
      peers: [],
    };
    if (!active) {
      return status;
    }
    const addr = await interfaceInfo('server');
    status.ip = addr?.ip || null;
    if (status.ip) {
      status.state = 'active';
    }
    const dump = await runPriv('wg', ['show', INTERFACES.server, 'dump'], { timeout: 8000 });
    if (dump.ok) {
      const parsed = parseWgServerDump(dump.stdout);
      status.peers = parsed.peers;
      for (const peer of parsed.peers) {
        status.rx_bytes += peer.rx_bytes;
        status.tx_bytes += peer.tx_bytes;
      }
    }
    return status;
  }

  async function syncServer(server, peers) {
    return exclusive(async () => {
      await applyServer(server, peers);
      const life = await unitState('server');
      if (['active', 'activating', 'reloading'].includes(life)) {
        await cleanCycle('server', 'restart');
      }
      return getServerStatus();
    });
  }

  async function controlServer(action, server, peers) {
    if (!['enable', 'disable', 'restart'].includes(action)) {
      throw httpError(400, 'Aksi server harus enable, disable, atau restart.');
    }
    return exclusive(async () => {
      if (action !== 'disable') {
        if (!server?.public_endpoint) {
          throw httpError(400, 'Isi Endpoint Publik (IP atau domain server ini) sebelum mengaktifkan VPN Server.');
        }
        const tools = toolsInfo();
        if (!tools.wireguard.installed) {
          throw httpError(503, `Paket WireGuard belum terpasang. Jalankan: ${tools.wireguard.hint}`);
        }
        await applyServer(server, peers);
      }
      const cycleAction = action === 'enable' ? 'start' : action;
      await cleanCycle('server', cycleAction);
      return getServerStatus();
    });
  }

  async function readRootFile(file) {
    const allowed = new Set([vpnConfig.PATHS.ovpnServerStatus, vpnConfig.PATHS.ovpnServerCa]);
    if (!allowed.has(file)) {
      throw httpError(400, 'Berkas tidak diizinkan.');
    }
    if (isRoot) {
      try {
        return readText(file);
      } catch {
        return '';
      }
    }
    const result = await run('sudo', ['-n', '/usr/bin/cat', file], { timeout: 8000 });
    return result.ok ? result.stdout : '';
  }

  async function applyOvpnServer(server, peers) {
    if (isRoot) {
      try {
        vpnConfig.applyOvpnServerToDisk(server, peers);
      } catch (error) {
        if (error.status) {
          throw error;
        }
        throw httpError(500, `Gagal menulis konfigurasi OpenVPN Server: ${String(error.message).slice(0, 240)}`);
      }
      return;
    }
    if (!existsSync(helperPath)) {
      throw httpError(503, `Helper VPN belum terpasang (${helperPath}). Jalankan ulang install.sh atau deploy/install-vpn-helper.sh sebagai root.`);
    }
    const result = await run('sudo', ['-n', helperPath, 'apply-ovpn-server'], {
      input: JSON.stringify({ server, peers }),
      timeout: 120000,
    });
    if (!result.ok) {
      const detail = (result.stderr || result.stdout).trim();
      throw httpError(sudoDenied(detail) ? 503 : 500, sudoDenied(detail) ? SUDOERS_HINT : `Gagal menulis konfigurasi OpenVPN Server: ${detail.slice(0, 240)}`);
    }
  }

  async function getOvpnServerStatus() {
    const life = await unitState('ovpn-server');
    const active = ['active', 'activating', 'reloading'].includes(life);
    const status = {
      state: life === 'failed' ? 'failed' : (active ? 'starting' : 'inactive'),
      unit: life,
      interface: INTERFACES['ovpn-server'],
      ip: null,
      rx_bytes: 0,
      tx_bytes: 0,
      peers: [],
    };
    if (!active) {
      return status;
    }
    const addr = await interfaceInfo('ovpn-server');
    status.ip = addr?.ip || null;
    if (status.ip) {
      status.state = 'active';
    }
    const text = await readRootFile(vpnConfig.PATHS.ovpnServerStatus);
    status.peers = parseOvpnStatus(text);
    for (const peer of status.peers) {
      status.rx_bytes += peer.rx_bytes;
      status.tx_bytes += peer.tx_bytes;
    }
    return status;
  }

  async function syncOvpnServer(server, peers) {
    return exclusive(async () => {
      await applyOvpnServer(server, peers);
      const life = await unitState('ovpn-server');
      if (['active', 'activating', 'reloading'].includes(life)) {
        await cleanCycle('ovpn-server', 'restart');
      }
      return getOvpnServerStatus();
    });
  }

  async function controlOvpnServer(action, server, peers) {
    if (!['enable', 'disable', 'restart'].includes(action)) {
      throw httpError(400, 'Aksi server harus enable, disable, atau restart.');
    }
    return exclusive(async () => {
      if (action !== 'disable') {
        if (!server?.public_endpoint) {
          throw httpError(400, 'Isi Endpoint Publik sebelum mengaktifkan OpenVPN Server.');
        }
        const tools = toolsInfo();
        if (!tools.openvpn.installed) {
          throw httpError(503, `Paket OpenVPN belum terpasang. Jalankan: ${tools.openvpn.hint}`);
        }
        await applyOvpnServer(server, peers);
      }
      const cycleAction = action === 'enable' ? 'start' : action;
      await cleanCycle('ovpn-server', cycleAction);
      return getOvpnServerStatus();
    });
  }

  async function readOvpnCa() {
    const pem = await readRootFile(vpnConfig.PATHS.ovpnServerCa);
    if (!pem.includes('BEGIN CERTIFICATE')) {
      throw httpError(404, 'CA belum dibuat. Simpan pengaturan OpenVPN Server dulu.');
    }
    return pem;
  }

  return {
    getStatus, connect, disconnect, restart, applyConfig, applyServer, syncServer, controlServer, getServerStatus,
    applyOvpnServer, syncOvpnServer, controlOvpnServer, getOvpnServerStatus, readOvpnCa,
    toolsInfo, measurePing, isRoot,
  };
}

// ---------------------------------------------------------------------------
// Penyimpanan konfigurasi (PostgreSQL)
// ---------------------------------------------------------------------------
async function ensureTable(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS vpn_profiles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      protocol VARCHAR(12) NOT NULL UNIQUE,
      config TEXT NOT NULL,
      selected SMALLINT NOT NULL DEFAULT 0,
      updated_by VARCHAR(50) DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
}

async function loadProfiles(pool) {
  await ensureTable(pool);
  let rows = [];
  try {
    const result = await pool.query('SELECT protocol, config, selected FROM vpn_profiles');
    rows = result[0] || [];
  } catch (error) {
    // Tabel kosong atau belum siap: form tetap tampil dengan nilai default.
    console.error('[vpn] config:', error.message);
    return { profiles: {}, selected: null };
  }
  const profiles = {};
  let selected = null;
  for (const row of rows) {
    try {
      profiles[row.protocol] = JSON.parse(row.config);
    } catch {
      continue;
    }
    if (Number(row.selected) === 1) {
      selected = row.protocol;
    }
  }
  return { profiles, selected };
}

async function saveProfile(pool, protocol, cfg, username) {
  const json = JSON.stringify(cfg);
  const [updated] = await pool.execute(
    'UPDATE vpn_profiles SET config = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE protocol = ?',
    [json, username || null, protocol],
  );
  if (!updated.affectedRows) {
    await pool.execute(
      'INSERT INTO vpn_profiles (protocol, config, updated_by) VALUES (?, ?, ?)',
      [protocol, json, username || null],
    );
  }
  await markSelected(pool, protocol);
}

async function markSelected(pool, protocol) {
  await pool.execute('UPDATE vpn_profiles SET selected = CASE WHEN protocol = ? THEN 1 ELSE 0 END', [protocol]);
}

// Bentuk aman untuk browser: rahasia diganti penanda *_set, tidak pernah ikut dikirim.
function publicProfiles(profiles, deps = {}) {
  const derive = deps.derivePublicKey || vpnConfig.derivePublicKey;
  const out = {
    wireguard: null, openvpn: null, sstp: null, l2tp: null,
  };
  const wg = profiles.wireguard;
  if (wg) {
    let publicKey = '';
    try {
      publicKey = derive(wg.private_key);
    } catch {
      publicKey = '';
    }
    out.wireguard = {
      endpoint: wg.endpoint,
      server_public_key: wg.server_public_key,
      address: wg.address,
      allowed_ips: wg.allowed_ips,
      keepalive: wg.keepalive,
      mtu: wg.mtu || '',
      public_key: publicKey,
      private_key_set: Boolean(wg.private_key),
      preshared_key_set: Boolean(wg.preshared_key),
    };
  }
  const ovpn = profiles.openvpn;
  if (ovpn) {
    const remote = /^remote\s+(\S+)(?:\s+(\S+))?/im.exec(ovpn.ovpn_config || '');
    out.openvpn = {
      username: ovpn.username || '',
      password_set: Boolean(ovpn.password),
      ovpn_set: Boolean(ovpn.ovpn_config),
      ovpn_lines: String(ovpn.ovpn_config || '').split('\n').filter(Boolean).length,
      ovpn_remote: remote ? `${remote[1]}${remote[2] ? `:${remote[2]}` : ''}` : '',
    };
  }
  const sstp = profiles.sstp;
  if (sstp) {
    out.sstp = {
      server: sstp.server,
      username: sstp.username,
      password_set: Boolean(sstp.password),
      routes: sstp.routes || '',
      ignore_cert: Boolean(sstp.ignore_cert),
    };
  }
  const l2tp = profiles.l2tp;
  if (l2tp) {
    out.l2tp = {
      server: l2tp.server,
      username: l2tp.username,
      password_set: Boolean(l2tp.password),
      routes: l2tp.routes || '',
      // Nilai PSK tidak pernah dikirim ke browser, hanya penanda sudah diisi atau belum.
      ipsec_secret_set: Boolean(l2tp.ipsec_secret),
    };
  }
  return out;
}

const HANDSHAKE_ONLINE_SECONDS = 180;

async function ensureServerTables(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS vpn_server (
      id INT PRIMARY KEY,
      public_endpoint VARCHAR(255) NOT NULL DEFAULT '',
      listen_port INT NOT NULL DEFAULT 51820,
      address VARCHAR(32) NOT NULL DEFAULT '10.220.0.1/24',
      private_key TEXT NOT NULL,
      public_key VARCHAR(64) NOT NULL,
      mtu INT NOT NULL DEFAULT 1380,
      updated_by VARCHAR(50) DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS vpn_server_peers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      address VARCHAR(32) NOT NULL UNIQUE,
      public_key VARCHAR(64) NOT NULL UNIQUE,
      private_key TEXT DEFAULT NULL,
      preshared_key VARCHAR(64) DEFAULT NULL,
      enabled SMALLINT NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await pool.query('ALTER TABLE vpn_server_peers ADD COLUMN IF NOT EXISTS radius_secret VARCHAR(64) NULL');
}

function peerRow(row) {
  return {
    id: Number(row.id),
    name: row.name,
    address: row.address,
    public_key: row.public_key,
    private_key: row.private_key || '',
    preshared_key: row.preshared_key || '',
    radius_secret: row.radius_secret || '',
    enabled: Number(row.enabled) !== 0,
  };
}

async function fillRadiusSecrets(pool, table, peers) {
  let changed = false;
  for (const peer of peers) {
    if (/^[A-Za-z0-9]{20,32}$/.test(peer.radius_secret || '')) {
      continue;
    }
    peer.radius_secret = vpnConfig.generateRadiusSecret();
    await pool.execute(`UPDATE ${table} SET radius_secret = ? WHERE id = ?`, [peer.radius_secret, peer.id]);
    changed = true;
  }
  return changed;
}

async function loadServer(pool) {
  await ensureServerTables(pool);
  const [servers] = await pool.query('SELECT id, public_endpoint, listen_port, address, private_key, public_key, mtu FROM vpn_server WHERE id = 1');
  let server = servers[0];
  if (!server) {
    const pair = vpnConfig.generateKeypair();
    await pool.execute(
      'INSERT INTO vpn_server (id, public_endpoint, listen_port, address, private_key, public_key, mtu) VALUES (1, ?, ?, ?, ?, ?, ?)',
      ['', vpnConfig.SERVER_DEFAULT_PORT, vpnConfig.SERVER_DEFAULT_ADDRESS, pair.private_key, pair.public_key, 1380],
    );
    server = {
      id: 1,
      public_endpoint: '',
      listen_port: vpnConfig.SERVER_DEFAULT_PORT,
      address: vpnConfig.SERVER_DEFAULT_ADDRESS,
      private_key: pair.private_key,
      public_key: pair.public_key,
      mtu: 1380,
    };
  }
  const [peerRows] = await pool.query(
    'SELECT id, name, address, public_key, private_key, preshared_key, radius_secret, enabled FROM vpn_server_peers ORDER BY id',
  );
  const peers = (peerRows || []).map(peerRow);
  const filled = await fillRadiusSecrets(pool, 'vpn_server_peers', peers);
  if (filled) {
    for (const peer of peers) {
      await radiusNas.syncVpnPeer(pool, { kind: 'wg', peer });
    }
  }
  return {
    server: {
      public_endpoint: server.public_endpoint || '',
      listen_port: Number(server.listen_port),
      address: server.address,
      private_key: server.private_key,
      public_key: server.public_key,
      mtu: Number(server.mtu) || 1380,
    },
    peers,
  };
}

function presentServer(bundle, live, nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  const byKey = new Map((live?.peers || []).map((peer) => [peer.public_key, peer]));
  const peers = bundle.peers.map((peer) => {
    const row = byKey.get(peer.public_key);
    const handshake = row?.latest_handshake || null;
    const age = handshake ? Math.max(0, nowSec - handshake) : null;
    return {
      id: peer.id,
      name: peer.name,
      address: peer.address,
      public_key: peer.public_key,
      enabled: peer.enabled,
      preshared_key_set: Boolean(peer.preshared_key),
      has_private_key: Boolean(peer.private_key),
      radius_secret: peer.radius_secret || '',
      online: Boolean(peer.enabled && handshake && age !== null && age <= HANDSHAKE_ONLINE_SECONDS),
      handshake_age_seconds: age,
      rx_bytes: row?.rx_bytes || 0,
      tx_bytes: row?.tx_bytes || 0,
    };
  });
  return {
    server: {
      public_endpoint: bundle.server.public_endpoint,
      listen_port: bundle.server.listen_port,
      address: bundle.server.address,
      public_key: bundle.server.public_key,
      mtu: bundle.server.mtu,
      private_key_set: Boolean(bundle.server.private_key),
    },
    peers,
    online: peers.filter((peer) => peer.online).length,
    total: peers.length,
  };
}

async function saveServerSettings(pool, input, username) {
  const current = await loadServer(pool);
  const server = vpnConfig.validateServer({ ...input, private_key: current.server.private_key }, current.server);
  vpnConfig.validateServerBundle({ server, peers: current.peers });
  await pool.execute(
    'UPDATE vpn_server SET public_endpoint = ?, listen_port = ?, address = ?, public_key = ?, mtu = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [server.public_endpoint, server.listen_port, server.address, server.public_key, server.mtu, username || null],
  );
  return loadServer(pool);
}

async function addServerPeer(pool, input) {
  const current = await loadServer(pool);
  const peer = vpnConfig.validatePeer(input, null);
  if (current.peers.some((item) => item.public_key === peer.public_key)) {
    const error = new Error('Public key peer ini sudah terdaftar.');
    error.status = 400;
    error.field = 'public_key';
    throw error;
  }
  const address = vpnConfig.allocatePeerAddress(current.server.address, current.peers.map((item) => item.address));
  const radiusSecret = vpnConfig.generateRadiusSecret();
  const [header] = await pool.execute(
    'INSERT INTO vpn_server_peers (name, address, public_key, private_key, preshared_key, radius_secret, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [peer.name, address, peer.public_key, peer.private_key || null, peer.preshared_key || null, radiusSecret, peer.enabled ? 1 : 0],
  );
  const bundle = await loadServer(pool);
  const created = bundle.peers.find((item) => item.id === Number(header.insertId));
  if (created) {
    await radiusNas.syncVpnPeer(pool, { kind: 'wg', peer: created });
  }
  return { id: Number(header.insertId), bundle };
}

async function updateServerPeer(pool, id, input) {
  const current = await loadServer(pool);
  const existing = current.peers.find((item) => item.id === id);
  if (!existing) {
    const error = new Error('Peer tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  const peer = vpnConfig.validatePeer(input, existing);
  if (current.peers.some((item) => item.id !== id && item.public_key === peer.public_key)) {
    const error = new Error('Public key peer ini sudah terdaftar.');
    error.status = 400;
    error.field = 'public_key';
    throw error;
  }
  const radiusSecret = /^[A-Za-z0-9]{20,32}$/.test(existing.radius_secret || '')
    ? existing.radius_secret
    : vpnConfig.generateRadiusSecret();
  await pool.execute(
    'UPDATE vpn_server_peers SET name = ?, public_key = ?, private_key = ?, preshared_key = ?, radius_secret = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [peer.name, peer.public_key, peer.private_key || null, peer.preshared_key || null, radiusSecret, peer.enabled ? 1 : 0, id],
  );
  const bundle = await loadServer(pool);
  const saved = bundle.peers.find((item) => item.id === id);
  if (saved) {
    await radiusNas.syncVpnPeer(pool, { kind: 'wg', peer: saved });
  }
  return bundle;
}

async function deleteServerPeer(pool, id) {
  const current = await loadServer(pool);
  if (!current.peers.some((item) => item.id === id)) {
    const error = new Error('Peer tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  await pool.execute('DELETE FROM vpn_server_peers WHERE id = ?', [id]);
  await radiusNas.forgetVpnPeer(pool, { kind: 'wg', peerId: id });
  return loadServer(pool);
}

function serverScript(bundle, id) {
  const peer = bundle.peers.find((item) => item.id === id);
  if (!peer) {
    const error = new Error('Peer tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  if (!bundle.server.public_endpoint) {
    const error = new Error('Isi Endpoint Publik server sebelum menyalin script MikroTik.');
    error.status = 400;
    error.field = 'public_endpoint';
    throw error;
  }
  return vpnConfig.renderMikrotikScript(bundle.server, peer);
}

function ovpnPeerRow(row) {
  return {
    id: Number(row.id),
    name: row.name,
    username: row.username,
    password: row.password || '',
    address: row.address,
    radius_secret: row.radius_secret || '',
    enabled: Number(row.enabled) !== 0,
  };
}

async function ensureOvpnServerTables(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS vpn_ovpn_server (
      id INT PRIMARY KEY,
      public_endpoint VARCHAR(255) NOT NULL DEFAULT '',
      listen_port INT NOT NULL DEFAULT 1194,
      network VARCHAR(32) NOT NULL DEFAULT '10.221.0.0/24',
      updated_by VARCHAR(50) DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS vpn_ovpn_peers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      username VARCHAR(32) NOT NULL UNIQUE,
      password TEXT NOT NULL,
      address VARCHAR(32) NOT NULL UNIQUE,
      enabled SMALLINT NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await pool.query('ALTER TABLE vpn_ovpn_peers ADD COLUMN IF NOT EXISTS radius_secret VARCHAR(64) NULL');
}

async function loadOvpnServer(pool) {
  await ensureOvpnServerTables(pool);
  const [servers] = await pool.query('SELECT id, public_endpoint, listen_port, network FROM vpn_ovpn_server WHERE id = 1');
  let server = servers[0];
  if (!server) {
    await pool.execute(
      'INSERT INTO vpn_ovpn_server (id, public_endpoint, listen_port, network) VALUES (1, ?, ?, ?)',
      ['', vpnConfig.OVPN_SERVER_DEFAULT_PORT, vpnConfig.OVPN_SERVER_DEFAULT_NETWORK],
    );
    server = {
      public_endpoint: '',
      listen_port: vpnConfig.OVPN_SERVER_DEFAULT_PORT,
      network: vpnConfig.OVPN_SERVER_DEFAULT_NETWORK,
    };
  }
  const [peerRows] = await pool.query(
    'SELECT id, name, username, password, address, radius_secret, enabled FROM vpn_ovpn_peers ORDER BY id',
  );
  const peers = (peerRows || []).map(ovpnPeerRow);
  const filled = await fillRadiusSecrets(pool, 'vpn_ovpn_peers', peers);
  if (filled) {
    for (const peer of peers) {
      await radiusNas.syncVpnPeer(pool, { kind: 'ovpn', peer });
    }
  }
  return {
    server: {
      public_endpoint: server.public_endpoint || '',
      listen_port: Number(server.listen_port) || vpnConfig.OVPN_SERVER_DEFAULT_PORT,
      network: server.network || vpnConfig.OVPN_SERVER_DEFAULT_NETWORK,
    },
    peers,
  };
}

function presentOvpnServer(bundle, live) {
  const byUser = new Map((live?.peers || []).map((peer) => [peer.username, peer]));
  const peers = bundle.peers.map((peer) => {
    const livePeer = byUser.get(peer.username);
    const online = Boolean(peer.enabled && livePeer);
    return {
      id: peer.id,
      name: peer.name,
      username: peer.username,
      address: peer.address,
      enabled: peer.enabled,
      password_set: Boolean(peer.password),
      radius_secret: peer.radius_secret || '',
      online,
      virtual_ip: online ? livePeer.virtual_ip : null,
      rx_bytes: online ? livePeer.rx_bytes : 0,
      tx_bytes: online ? livePeer.tx_bytes : 0,
    };
  });
  return {
    server: {
      public_endpoint: bundle.server.public_endpoint,
      listen_port: bundle.server.listen_port,
      network: bundle.server.network,
      server_ip: vpnConfig.validateOvpnServer(bundle.server).server_ip,
    },
    peers,
    online: peers.filter((peer) => peer.online).length,
    total: peers.length,
  };
}

function assertOvpnPeersFit(server, peers) {
  const net = vpnConfig.parseCidr(server.network, { minPrefix: 16 });
  for (const peer of peers) {
    const ip = vpnConfig.parseIPv4(String(peer.address || '').split('/')[0]);
    if (!net || ip === null || ip <= net.network + 1 || ip >= net.network + net.size - 1) {
      const error = new Error('Subnet baru tidak menampung peer yang sudah ada.');
      error.status = 400;
      error.field = 'network';
      throw error;
    }
  }
}

async function saveOvpnServerSettings(pool, input, username) {
  const current = await loadOvpnServer(pool);
  const wg = await loadServer(pool);
  const server = vpnConfig.validateOvpnServer(
    { ...current.server, ...input },
    { avoidCidr: wg.server.address },
  );
  assertOvpnPeersFit(server, current.peers);
  await pool.execute(
    'UPDATE vpn_ovpn_server SET public_endpoint = ?, listen_port = ?, network = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [server.public_endpoint, server.listen_port, server.network, username || null],
  );
  return loadOvpnServer(pool);
}

async function addOvpnPeer(pool, input) {
  const current = await loadOvpnServer(pool);
  const peer = vpnConfig.validateOvpnPeer(input, null);
  if (current.peers.some((item) => item.username === peer.username)) {
    const error = new Error('Username ini sudah terdaftar.');
    error.status = 400;
    error.field = 'username';
    throw error;
  }
  const address = vpnConfig.allocateOvpnAddress(current.server.network, current.peers.map((item) => item.address));
  const radiusSecret = vpnConfig.generateRadiusSecret();
  const [header] = await pool.execute(
    'INSERT INTO vpn_ovpn_peers (name, username, password, address, radius_secret, enabled) VALUES (?, ?, ?, ?, ?, ?)',
    [peer.name, peer.username, peer.password, address, radiusSecret, peer.enabled ? 1 : 0],
  );
  const bundle = await loadOvpnServer(pool);
  const created = bundle.peers.find((item) => item.id === Number(header.insertId));
  if (created) {
    await radiusNas.syncVpnPeer(pool, { kind: 'ovpn', peer: created });
  }
  return { id: Number(header.insertId), bundle };
}

async function updateOvpnPeer(pool, id, input) {
  const current = await loadOvpnServer(pool);
  const existing = current.peers.find((item) => item.id === id);
  if (!existing) {
    const error = new Error('Peer tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  const peer = vpnConfig.validateOvpnPeer({ ...existing, ...input, password: input.password }, existing);
  if (current.peers.some((item) => item.id !== id && item.username === peer.username)) {
    const error = new Error('Username ini sudah terdaftar.');
    error.status = 400;
    error.field = 'username';
    throw error;
  }
  const radiusSecret = /^[A-Za-z0-9]{20,32}$/.test(existing.radius_secret || '')
    ? existing.radius_secret
    : vpnConfig.generateRadiusSecret();
  await pool.execute(
    'UPDATE vpn_ovpn_peers SET name = ?, username = ?, password = ?, radius_secret = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [peer.name, peer.username, peer.password, radiusSecret, peer.enabled ? 1 : 0, id],
  );
  const bundle = await loadOvpnServer(pool);
  const saved = bundle.peers.find((item) => item.id === id);
  if (saved) {
    await radiusNas.syncVpnPeer(pool, { kind: 'ovpn', peer: saved });
  }
  return bundle;
}

async function deleteOvpnPeer(pool, id) {
  const current = await loadOvpnServer(pool);
  if (!current.peers.some((item) => item.id === id)) {
    const error = new Error('Peer tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  await pool.execute('DELETE FROM vpn_ovpn_peers WHERE id = ?', [id]);
  await radiusNas.forgetVpnPeer(pool, { kind: 'ovpn', peerId: id });
  return loadOvpnServer(pool);
}

async function ensureChrNasTable(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS vpn_chr_nas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nama_router VARCHAR(64) NOT NULL,
      ip_vpn_nas VARCHAR(32) NULL,
      radius_secret VARCHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
}

function chrNasRow(row) {
  return {
    id: Number(row.id),
    nama_router: row.nama_router,
    ip_vpn_nas: row.ip_vpn_nas || '',
    radius_secret: row.radius_secret || '',
  };
}

async function chrRadiusAddress() {
  try {
    const status = await service.getStatus();
    const ip = String(status?.ip || '').split('/')[0].trim();
    if (status?.state === 'connected' && vpnConfig.parseIPv4(ip) !== null) {
      return ip;
    }
  } catch {
    // Tunnel belum terbaca: pakai alamat default di CHR.
  }
  return vpnConfig.CHR_RADIUS_ADDRESS;
}

async function listChrNas(pool) {
  await ensureChrNasTable(pool);
  const [rows] = await pool.query(
    'SELECT id, nama_router, ip_vpn_nas, radius_secret FROM vpn_chr_nas ORDER BY id',
  );
  return {
    radius_address: await chrRadiusAddress(),
    items: (rows || []).map(chrNasRow),
  };
}

async function assertChrNasFree(pool, row, exceptId = 0) {
  const [names] = await pool.execute(
    'SELECT id FROM vpn_chr_nas WHERE nama_router = ? AND id <> ? LIMIT 1',
    [row.nama_router, exceptId],
  );
  if (names.length) {
    const error = new Error('Nama router ini sudah ada di daftar NAS CHR.');
    error.status = 409;
    error.field = 'nama_router';
    throw error;
  }
  if (!row.ip_vpn_nas) {
    return;
  }
  const [ips] = await pool.execute(
    'SELECT id FROM vpn_chr_nas WHERE ip_vpn_nas = ? AND id <> ? LIMIT 1',
    [row.ip_vpn_nas, exceptId],
  );
  if (ips.length) {
    const error = new Error('IP VPN NAS ini sudah dipakai.');
    error.status = 409;
    error.field = 'ip_vpn_nas';
    throw error;
  }
}

async function addChrNas(pool, input) {
  const row = vpnConfig.validateChrNas(input);
  await ensureChrNasTable(pool);
  await assertChrNasFree(pool, row);
  const secret = vpnConfig.generateRadiusSecret();
  const [header] = await pool.execute(
    'INSERT INTO vpn_chr_nas (nama_router, ip_vpn_nas, radius_secret) VALUES (?, ?, ?)',
    [row.nama_router, row.ip_vpn_nas || null, secret],
  );
  const saved = { id: Number(header.insertId), ...row, radius_secret: secret };
  await radiusNas.syncChrClient(pool, { id: saved.id, name: saved.nama_router, ip: saved.ip_vpn_nas, radius_secret: secret });
  return saved;
}

async function updateChrNas(pool, id, input) {
  await ensureChrNasTable(pool);
  const [rows] = await pool.execute(
    'SELECT id, nama_router, ip_vpn_nas, radius_secret FROM vpn_chr_nas WHERE id = ? LIMIT 1',
    [id],
  );
  const existing = rows[0];
  if (!existing) {
    const error = new Error('NAS tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  const row = vpnConfig.validateChrNas({ ...chrNasRow(existing), ...input });
  await assertChrNasFree(pool, row, id);
  const secret = /^[A-Za-z0-9]{20,32}$/.test(existing.radius_secret || '')
    ? existing.radius_secret
    : vpnConfig.generateRadiusSecret();
  await pool.execute(
    'UPDATE vpn_chr_nas SET nama_router = ?, ip_vpn_nas = ?, radius_secret = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [row.nama_router, row.ip_vpn_nas || null, secret, id],
  );
  await radiusNas.syncChrClient(pool, { id, name: row.nama_router, ip: row.ip_vpn_nas, radius_secret: secret });
  return { id, ...row, radius_secret: secret };
}

async function deleteChrNas(pool, id) {
  await ensureChrNasTable(pool);
  const [rows] = await pool.execute('SELECT id FROM vpn_chr_nas WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) {
    const error = new Error('NAS tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  await pool.execute('DELETE FROM vpn_chr_nas WHERE id = ?', [id]);
  await radiusNas.forgetVpnPeer(pool, { kind: 'chr', peerId: id });
}

async function chrNasScript(pool, id) {
  await ensureChrNasTable(pool);
  const [rows] = await pool.execute(
    'SELECT id, nama_router, ip_vpn_nas, radius_secret FROM vpn_chr_nas WHERE id = ? LIMIT 1',
    [id],
  );
  const row = rows[0] ? chrNasRow(rows[0]) : null;
  if (!row) {
    const error = new Error('NAS tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  const radiusAddress = await chrRadiusAddress();
  return {
    radius_address: radiusAddress,
    script: vpnConfig.renderChrMikrotikScript({
      name: row.nama_router,
      radiusAddress,
      secret: row.radius_secret,
      nasIp: row.ip_vpn_nas,
    }),
  };
}

function ovpnServerScript(bundle, id) {
  const peer = bundle.peers.find((item) => item.id === id);
  if (!peer) {
    const error = new Error('Peer tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  return vpnConfig.renderOvpnMikrotikScript(bundle.server, peer);
}

const service = createVpnService();

module.exports = {
  HELPER_PATH,
  LABELS,
  createVpnService,
  parseIpAddr,
  parseWgDump,
  parseWgServerDump,
  parseOvpnStatus,
  hijacksDefaultRoute,
  hostOf,
  isSafePingTarget,
  tunnelGateway,
  publicPingTarget,
  tunnelPingTarget,
  parsePingMs,
  presentTraffic,
  emptyPing,
  vpnFailedProtocols,
  logLineCount,
  sanitizeLog,
  diagnoseLog,
  ensureTable,
  ensureServerTables,
  loadServer,
  presentServer,
  saveServerSettings,
  addServerPeer,
  updateServerPeer,
  deleteServerPeer,
  serverScript,
  ensureOvpnServerTables,
  loadOvpnServer,
  presentOvpnServer,
  saveOvpnServerSettings,
  addOvpnPeer,
  updateOvpnPeer,
  deleteOvpnPeer,
  ovpnServerScript,
  listChrNas,
  addChrNas,
  updateChrNas,
  deleteChrNas,
  chrNasScript,
  chrRadiusAddress,
  loadProfiles,
  saveProfile,
  markSelected,
  publicProfiles,
  service,
};
