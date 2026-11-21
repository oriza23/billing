'use strict';
/**
 * Koneksi VPN client server billing -> MikroTik CHR (WireGuard / OpenVPN / SSTP).
 *
 * - Status  : systemctl is-active, ip -4 addr, wg show (dump), sysfs counter.
 * - Aksi    : connect/disconnect lewat systemctl, protokol lain dimatikan lebih dulu.
 * - Berkas  : root menulis langsung; non-root lewat helper `sudo -n` yang memvalidasi ulang.
 * - Simpan  : tabel vpn_profiles (PostgreSQL), rahasia tidak pernah dikirim balik ke browser.
 *
 * Semua perintah memakai execFile (tanpa shell). Deteksi root sama seperti restart layanan:
 * root langsung, selain itu `sudo -n` (gagal cepat bila sudoers belum dipasang).
 */

const fs = require('fs');
const { execFile } = require('child_process');
const { IS_ROOT } = require('./privileged');
const vpnConfig = require('./vpn_config');

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
};
const PACKAGES = {
  wireguard: 'wireguard-tools',
  openvpn: 'openvpn',
  sstp: 'sstp-client ppp',
};
const LABELS = { wireguard: 'WireGuard', openvpn: 'OpenVPN', sstp: 'SSTP' };
// Detik menunggu interface mendapat IP sebelum log unit diambil dan dikirim ke UI.
const CONNECT_WAIT_SECONDS = { wireguard: 8, sstp: 8, openvpn: 15 };
// SSTP butuh lebih banyak baris: pesan TLS/sertifikat/auth sstpc ada di atas
// baris "Exit" pppd, jadi 10 baris sering memotong penyebab aslinya.
const LOG_LINES = { wireguard: 10, openvpn: 10, sstp: 20 };
const LOG_LINE_MAX = 300;
// Device yang harus ada di OS. Di kontainer LXC/Proxmox keduanya harus diteruskan dari host.
const REQUIRED_DEVICES = {
  sstp: {
    path: '/dev/ppp',
    hint: 'SSTP butuh /dev/ppp. Di host Proxmox jalankan "modprobe ppp_generic", "modprobe ppp_async", dan "chmod 666 /dev/ppp", lalu tambahkan ke /etc/pve/lxc/<CTID>.conf: "lxc.cgroup2.devices.allow: c 108:0 rwm" dan "lxc.mount.entry: /dev/ppp dev/ppp none bind,create=file". Kontainer harus Privileged (unprivileged: 0). Jika masih Unprivileged, Backup & Restore tanpa centang Unprivileged container, lalu "pct reboot <CTID>".',
  },
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
  if (protocol === 'sstp') {
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
function diagnoseLog(lines) {
  const text = (Array.isArray(lines) ? lines : []).join('\n');
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
  if (/connection refused|timed out|timeout|could not connect|unable to connect|no route to host|network is unreachable|could not resolve|name or service not known|getaddrinfo|temporary failure in name resolution/i.test(text)) {
    return { code: 'network', text: 'Server CHR tidak terjangkau. Periksa IP/domain, port (SSTP bawaan 443), service SSTP server aktif di CHR, dan firewall.' };
  }
  if (/authentication failed|authentication failure|peer refused to authenticate|chap authentication failed|mschap.*(fail|error)|auth.*(rejected|denied)|access-reject/i.test(text)) {
    return { code: 'auth', text: 'Username/password ditolak CHR. Periksa /ppp secret (service=sstp atau any) dan profilnya.' };
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
        // Device OS yang wajib ada (mis. /dev/ppp untuk SSTP); kosong = aman.
        device_missing: device && !existsSync(device.path) ? device.path : null,
        device_hint: device && !existsSync(device.path) ? device.hint : null,
      };
    }
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
      failed: PROTOCOLS.filter((protocol) => states[protocol] === 'failed'),
      tools: toolsInfo(),
      is_root: isRoot,
      helper_installed: isRoot || existsSync(helperPath),
      checked_at: new Date(now()).toISOString(),
    };
    if (!activeProtocol) {
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

  function ensureTools(protocol) {
    const info = toolsInfo()[protocol];
    if (!info.installed) {
      throw httpError(503, `Paket ${LABELS[protocol]} belum terpasang di server (${info.missing.join(', ')}). Jalankan: ${info.hint}`);
    }
  }

  // Tanpa device ini pppd/openvpn gagal seketika dan systemd memulai ulang tanpa henti.
  // Hentikan unit yang terlanjur menyala supaya tidak membanjiri journal.
  async function ensureDevices(protocol) {
    const need = REQUIRED_DEVICES[protocol];
    if (!need || existsSync(need.path)) {
      return;
    }
    await systemctlPriv(['disable', '--now', UNITS[protocol]]).catch(() => {});
    throw httpError(503, need.hint);
  }

  // Baris terakhir journal unit, untuk ditampilkan di UI saat koneksi belum tersambung.
  async function readUnitLog(protocol, lines = logLineCount(protocol)) {
    try {
      const result = await runPriv('journalctl', ['-u', UNITS[protocol], '-n', String(lines), '--no-pager'], { timeout: 8000 });
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

  async function stopOthers(protocol) {
    for (const other of PROTOCOLS.filter((item) => item !== protocol)) {
      // eslint-disable-next-line no-await-in-loop
      const [state, enabled] = await Promise.all([
        unitState(other),
        run('systemctl', ['is-enabled', UNITS[other]], { timeout: 8000 }).then((result) => result.stdout.trim()),
      ]);
      if (state !== 'inactive' || enabled === 'enabled') {
        try {
          // eslint-disable-next-line no-await-in-loop
          await systemctlPriv(['disable', '--now', UNITS[other]]);
        } catch (error) {
          if (error.status === 503) {
            throw error;
          }
          // Unit belum pernah dibuat: tidak ada yang perlu dimatikan.
        }
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
    ensureTools(protocol);
    return exclusive(async () => {
      await ensureDevices(protocol);
      await applyConfig(protocol, cfg);
      await stopOthers(protocol);
      const unit = UNITS[protocol];
      const wasActive = (await unitState(protocol)) === 'active';
      await systemctlPriv(['enable', '--now', unit]);
      if (wasActive) {
        await systemctlPriv(['restart', unit]);
      }

      const attempts = CONNECT_WAIT_SECONDS[protocol] || 8;
      let status = null;
      for (let i = 0; i < attempts; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(1000);
        // eslint-disable-next-line no-await-in-loop
        if (await routeHijack(protocol)) {
          // eslint-disable-next-line no-await-in-loop
          await systemctlPriv(['disable', '--now', unit]).catch(() => {});
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
      await systemctlPriv(['disable', '--now', UNITS[protocol]]);
      return { status: await getStatus(), protocol };
    });
  }

  return {
    getStatus, connect, disconnect, applyConfig, toolsInfo, measurePing, isRoot,
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
  const out = { wireguard: null, openvpn: null, sstp: null };
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
  return out;
}

module.exports = {
  HELPER_PATH,
  LABELS,
  createVpnService,
  parseIpAddr,
  parseWgDump,
  hijacksDefaultRoute,
  hostOf,
  isSafePingTarget,
  tunnelGateway,
  publicPingTarget,
  tunnelPingTarget,
  parsePingMs,
  presentTraffic,
  emptyPing,
  logLineCount,
  sanitizeLog,
  diagnoseLog,
  ensureTable,
  loadProfiles,
  saveProfile,
  markSelected,
  publicProfiles,
  service: createVpnService(),
};
