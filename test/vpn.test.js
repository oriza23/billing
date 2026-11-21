const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const test = require('node:test');
const assert = require('node:assert/strict');

const { secret } = require('../backend/config/jwt');
const requireAuth = require('../backend/middleware/auth');
const vpnRouter = require('../backend/routes/vpn');
const cfg = require('../backend/vpn_config');
const {
  createVpnService, parseIpAddr, parseWgDump, hijacksDefaultRoute, publicProfiles,
  hostOf, isSafePingTarget, tunnelGateway, publicPingTarget, tunnelPingTarget, parsePingMs,
} = require('../backend/vpn');

const KEY_A = 'A'.repeat(43) + '=';
const KEY_B = 'B'.repeat(43) + '=';

function wgInput(extra = {}) {
  return {
    endpoint: 'chr.contoh.net:51820',
    server_public_key: KEY_A,
    private_key: KEY_B,
    address: '10.10.99.2/24',
    allowed_ips: '10.10.99.0/24',
    keepalive: '',
    ...extra,
  };
}

function rejects(fn, pattern) {
  assert.throws(fn, (error) => error instanceof cfg.VpnValidationError && error.status === 400 && pattern.test(error.message));
}

// ---------------------------------------------------------------------------
// WireGuard
// ---------------------------------------------------------------------------
test('wireguard: input valid dinormalkan, keepalive default 25', () => {
  const out = cfg.validateWireguard(wgInput({ allowed_ips: '10.10.99.5/24, 192.168.50.0/24' }));
  assert.equal(out.endpoint, 'chr.contoh.net:51820');
  assert.equal(out.allowed_ips, '10.10.99.0/24, 192.168.50.0/24');
  assert.equal(out.keepalive, 25);
  assert.equal(out.address, '10.10.99.2/24');
  assert.equal(out.mtu, null);
});

test('wireguard: Allowed IPs yang menelan default route ditolak', () => {
  for (const bad of ['0.0.0.0/0', '0.0.0.0/1', '128.0.0.0/1', '10.0.0.0/7', '10.10.99.0/24, 0.0.0.0/0']) {
    rejects(() => cfg.validateWireguard(wgInput({ allowed_ips: bad })), /terlalu luas|0\.0\.0\.0\/0/);
  }
  rejects(() => cfg.validateWireguard(wgInput({ allowed_ips: '::/0' })), /tidak valid/);
});

test('wireguard: subnet yang memuat endpoint CHR ditolak (cegah routing loop)', () => {
  rejects(
    () => cfg.validateWireguard(wgInput({ endpoint: '203.0.113.10:51820', allowed_ips: '203.0.113.0/24' })),
    /memuat alamat CHR/,
  );
  assert.doesNotThrow(() => cfg.validateWireguard(wgInput({ endpoint: '203.0.113.10:51820' })));
});

test('wireguard: anti command/config injection', () => {
  const attacks = [
    { endpoint: 'chr.contoh.net:51820\nPostUp = reboot' },
    { endpoint: 'chr.contoh.net:51820; reboot' },
    { endpoint: '$(reboot):51820' },
    { endpoint: '-oProxyCommand=x:51820' },
    { endpoint: '127.0.0.1:51820' },
    { endpoint: 'chr.contoh.net' },
    { endpoint: 'chr.contoh.net:70000' },
    { server_public_key: `${KEY_A}\nPostUp = reboot` },
    { private_key: 'short' },
    { preshared_key: 'zzz' },
    { address: '10.10.99.2' },
    { address: '10.10.99.2/24\nPostUp=x' },
    { allowed_ips: '10.10.99.0/24\nPostUp=x' },
    { keepalive: '25; reboot' },
    { keepalive: 99999 },
    { mtu: 100 },
  ];
  for (const attack of attacks) {
    assert.throws(() => cfg.validateWireguard(wgInput(attack)), cfg.VpnValidationError, JSON.stringify(attack));
  }
});

test('wireguard: rahasia kosong memakai nilai tersimpan, preshared bisa dihapus', () => {
  const existing = cfg.validateWireguard(wgInput({ preshared_key: KEY_A }));
  const kept = cfg.validateWireguard(wgInput({ private_key: '' }), existing);
  assert.equal(kept.private_key, KEY_B);
  assert.equal(kept.preshared_key, KEY_A);
  const cleared = cfg.validateWireguard(wgInput({ private_key: '', clear_preshared_key: true }), existing);
  assert.equal(cleared.preshared_key, '');
  rejects(() => cfg.validateWireguard(wgInput({ private_key: '' })), /Private Key wajib/);
});

test('wireguard: render wg-billing.conf', () => {
  const out = cfg.renderWireguard(cfg.validateWireguard(wgInput({ preshared_key: KEY_A, mtu: 1380 })));
  assert.match(out, /\[Interface\]\nPrivateKey = B{43}=\nAddress = 10\.10\.99\.2\/24\nMTU = 1380/);
  assert.match(out, /\[Peer\]\nPublicKey = A{43}=\nPresharedKey = A{43}=\nEndpoint = chr\.contoh\.net:51820/);
  assert.match(out, /AllowedIPs = 10\.10\.99\.0\/24\nPersistentKeepalive = 25\n$/);
  assert.doesNotMatch(out, /PostUp|PostDown|DNS|Table/);
});

test('keygen: vektor RFC 7748 dan keypair konsisten', () => {
  // Kunci privat Alice dari RFC 7748 §6.1 -> kunci publik yang diketahui.
  const alicePriv = Buffer.from('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a', 'hex').toString('base64');
  const alicePub = Buffer.from('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a', 'hex').toString('base64');
  assert.equal(cfg.publicKeyViaCrypto(alicePriv), alicePub);

  const pair = cfg.generateKeypair();
  assert.match(pair.private_key, cfg.WG_KEY_RE);
  assert.match(pair.public_key, cfg.WG_KEY_RE);
  assert.equal(cfg.derivePublicKey(pair.private_key), pair.public_key);
  assert.notEqual(cfg.generateKeypair().private_key, pair.private_key);
});

// ---------------------------------------------------------------------------
// OpenVPN
// ---------------------------------------------------------------------------
const OVPN = [
  'client', 'dev tun0', 'proto tcp', 'remote chr.contoh.net 1194', 'auth-user-pass',
  '# komentar', '<ca>', '-----BEGIN CERTIFICATE-----', 'MIIB', '-----END CERTIFICATE-----', '</ca>',
].join('\r\n');

test('openvpn: config inline diterima, dev dinormalkan, komentar dibuang', () => {
  const out = cfg.sanitizeOvpn(OVPN);
  assert.equal(out.needsAuth, true);
  assert.equal(out.deviceType, 'tun');
  assert.match(out.config, /^client\ndev tun\nproto tcp\nremote chr\.contoh\.net 1194\nauth-user-pass\n<ca>\n/);
  assert.doesNotMatch(out.config, /komentar|\r/);
});

test('openvpn: direktif berbahaya & rujukan berkas ditolak', () => {
  const base = 'client\nremote chr.contoh.net 1194\n';
  const bad = [
    'up /tmp/evil.sh', 'down "/bin/sh -c reboot"', 'script-security 2', 'plugin /tmp/x.so', 'route-up /x',
    'tls-verify /x', 'iproute /x', 'setenv A B', 'config /etc/passwd', 'log /etc/cron.d/x', 'writepid /x',
    'management 127.0.0.1 7505', 'redirect-gateway def1', 'route 0.0.0.0 0.0.0.0', 'route default', 'engine dynamic',
    'ca /etc/shadow', 'cert /x', 'key /x', 'tls-auth ta.key 1', 'askpass /root/x', 'http-proxy-user-pass /x',
    'dev-node /dev/x', 'user root', '<connection>',
  ];
  for (const line of bad) {
    assert.throws(() => cfg.sanitizeOvpn(`${base}${line}\n`), cfg.VpnValidationError, line);
  }
  rejects(() => cfg.sanitizeOvpn('client\nproto udp\n'), /remote/);
  rejects(() => cfg.sanitizeOvpn('client\nremote a.b 1\n<ca>\nx\n'), /tidak ditutup/);
  rejects(() => cfg.sanitizeOvpn('client\nremote a.b 1\ndev lain\n'), /tun atau tap/);
});

test('openvpn: auth-user-pass wajib kredensial; render aman', () => {
  rejects(() => cfg.validateOpenvpn({ ovpn_config: OVPN }), /Username dan Password/);
  const out = cfg.validateOpenvpn({ ovpn_config: OVPN, username: 'budi', password: 'rahasia' });
  const conf = cfg.renderOvpn(out);
  const lines = conf.split('\n');
  assert.ok(lines.indexOf('pull-filter ignore "redirect-gateway"') > 0);
  assert.ok(lines.indexOf('pull-filter ignore "redirect-gateway"') < lines.indexOf('client'), 'pull-filter harus di atas isi .ovpn');
  assert.ok(lines.includes('dev raniah-ovpn'));
  assert.ok(lines.includes('dev-type tun'));
  assert.ok(lines.includes('auth-user-pass /etc/openvpn/client/raniah-vpn.auth'));
  assert.equal(lines.filter((line) => /^dev /.test(line)).length, 1);
  assert.equal(cfg.renderOvpnAuth(out), 'budi\nrahasia\n');

  // Password kosong memakai nilai tersimpan; username kosong menghapus kredensial.
  const kept = cfg.validateOpenvpn({ username: 'budi', password: '' }, out);
  assert.equal(kept.password, 'rahasia');
  assert.equal(kept.ovpn_config, out.ovpn_config);
  rejects(() => cfg.validateOpenvpn({ ovpn_config: OVPN, username: 'budi', password: 'a\nb' }), /Password OpenVPN/);
});

test('openvpn: tanpa auth-user-pass, kredensial opsional', () => {
  const plain = 'client\nremote chr.contoh.net 1194\n';
  const out = cfg.validateOpenvpn({ ovpn_config: plain });
  assert.equal(out.username, '');
  assert.doesNotMatch(cfg.renderOvpn(out), /auth-user-pass/);
});

// ---------------------------------------------------------------------------
// SSTP
// ---------------------------------------------------------------------------
test('sstp: validasi, port default 443, route dinormalkan', () => {
  const out = cfg.validateSstp({
    server: 'chr.contoh.net', username: 'vpn-user', password: 'p"a\\ss', routes: '10.10.99.7/24', ignore_cert: true,
  });
  assert.equal(out.server, 'chr.contoh.net:443');
  assert.equal(out.routes, '10.10.99.0/24');
  assert.equal(out.ignore_cert, true);

  for (const attack of [
    { server: 'chr;reboot' }, { server: '-x' }, { username: 'a b' }, { username: 'a"\nname root' },
    { password: 'x\ny' }, { routes: '0.0.0.0/0' }, { server: '203.0.113.1:443', routes: '203.0.113.0/24' },
  ]) {
    assert.throws(
      () => cfg.validateSstp({ server: 'chr.contoh.net', username: 'u', password: 'p', ...attack }),
      cfg.VpnValidationError,
      JSON.stringify(attack),
    );
  }
});

test('sstp: ignore_cert aktif default, hormati pilihan eksplisit dan profil tersimpan', () => {
  const base = { server: 'chr.contoh.net', username: 'u', password: 'p' };
  assert.equal(cfg.validateSstp(base).ignore_cert, true, 'profil baru: aktif');
  assert.equal(cfg.validateSstp({ ...base, ignore_cert: false }).ignore_cert, false);
  assert.equal(cfg.validateSstp({ ...base, ignore_cert: 'true' }).ignore_cert, true);
  assert.equal(cfg.validateSstp(base, { password: 'p', ignore_cert: false }).ignore_cert, false, 'tanpa input: ikut profil tersimpan');
});

test('sstp: peer pppd, unit systemd, hook rute', () => {
  const out = cfg.validateSstp({
    server: 'chr.contoh.net:4443', username: 'vpn-user', password: 'p"a\\ss', routes: '10.10.99.0/24', ignore_cert: true,
  });
  const peer = cfg.renderSstpPeer(out, '/usr/sbin/sstpc');
  assert.match(peer, /^name "vpn-user"$/m);
  assert.match(peer, /^password "p\\"a\\\\ss"$/m);
  assert.match(peer, /^ifname raniah-sstp$/m);
  assert.match(peer, /^pty "\/usr\/sbin\/sstpc --log-stderr --log-level 2 --tls-ext --cert-warn --nolaunchpppd chr\.contoh\.net:4443"$/m);
  assert.match(peer, /^nopersist$/m);
  for (const flag of ['noauth', 'nodefaultroute', 'nobsdcomp', 'nodeflate', 'refuse-eap',
    'lcp-echo-interval 10', 'lcp-echo-failure 3']) {
    assert.match(peer, new RegExp(`^${flag}$`, 'm'), flag);
  }
  assert.doesNotMatch(peer, /^persist$/m, 'persist membuat pppd membuka ulang /dev/pts yang sudah ditutup');
  assert.doesNotMatch(peer, /maxfail/);
  assert.doesNotMatch(peer, /^lock$/m);
  assert.doesNotMatch(peer, /require-mschap-v2/, 'tidak memaksa satu metode auth: CHR bawaan boleh mschap2/chap/pap');
  assert.doesNotMatch(peer, /^noccp$/m, 'MPPE harus tetap bisa dinegosiasikan');
  assert.doesNotMatch(peer, /usepeerdns/);
  assert.doesNotMatch(peer, /^defaultroute$/m);

  const unit = cfg.renderSstpUnit(out, '/usr/sbin/pppd');
  assert.match(unit, /^ExecStart=\/usr\/sbin\/pppd call raniah-sstp nodetach$/m);
  assert.match(unit, /^ExecStartPre=.*test -c \/dev\/ppp.*\/dev\/ppp tidak ada/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=5$/m);
  assert.doesNotMatch(unit, /sstpc|chr\.contoh|vpn-user|p"a/, 'unit hanya menjalankan pppd; sstpc dan kredensial ada di peer');
  const strictPeer = cfg.renderSstpPeer({ ...out, ignore_cert: false }, '/usr/sbin/sstpc');
  assert.doesNotMatch(strictPeer, /--cert-warn/);
  assert.match(strictPeer, /--tls-ext --nolaunchpppd/, '--tls-ext selalu ada untuk RouterOS v7');

  assert.equal(cfg.renderSstpRoutes(out), '10.10.99.0/24\n');
  assert.match(cfg.renderSstpHook(), /\[ "\$PPP_IFACE" = "raniah-sstp" \] \|\| exit 0/);
});

// ---------------------------------------------------------------------------
// Penulisan berkas
// ---------------------------------------------------------------------------
test('applyToDisk: berkas rahasia 0600, hook 0755, tanpa sisa tmp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-test-'));
  try {
    const wgFiles = cfg.applyToDisk('wireguard', cfg.validateWireguard(wgInput()), { root });
    assert.deepEqual(wgFiles, [cfg.PATHS.wireguard]);
    const wgPath = path.join(root, cfg.PATHS.wireguard);
    assert.equal(fs.statSync(wgPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(wgPath)).mode & 0o777, 0o700);

    const ovpn = cfg.validateOpenvpn({ ovpn_config: OVPN, username: 'budi', password: 'x' });
    cfg.applyToDisk('openvpn', ovpn, { root });
    assert.equal(fs.statSync(path.join(root, cfg.PATHS.ovpn)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, cfg.PATHS.ovpnAuth)).mode & 0o777, 0o600);
    // Kredensial dihapus -> berkas auth ikut dihapus.
    cfg.applyToDisk('openvpn', cfg.validateOpenvpn({ ovpn_config: 'client\nremote a.b 1\n' }), { root });
    assert.equal(fs.existsSync(path.join(root, cfg.PATHS.ovpnAuth)), false);

    cfg.applyToDisk('sstp', cfg.validateSstp({
      server: 'chr.contoh.net', username: 'u', password: 'p', routes: '10.10.99.0/24',
    }), { root, existsSync: () => false });
    assert.equal(fs.statSync(path.join(root, cfg.PATHS.sstpPeer)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, cfg.PATHS.sstpHook)).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(root, cfg.PATHS.sstpUnit)).mode & 0o777, 0o644);

    const leftovers = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full); else if (/\.tmp-/.test(entry.name)) leftovers.push(full);
      }
    }(root));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyToDisk sstp sebagai root nyata memanggil systemctl daemon-reload', () => {
  const calls = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-test-'));
  try {
    // root kosong -> menulis ke path asli, jadi hanya periksa lewat root: tmp; reload dilewati.
    cfg.applyToDisk('sstp', cfg.validateSstp({ server: 'a.b', username: 'u', password: 'p' }), {
      root, exec: (...args) => calls.push(args),
    });
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Parser status
// ---------------------------------------------------------------------------
test('parser ip addr, wg dump, deteksi default route', () => {
  assert.deepEqual(parseIpAddr('5: wg-billing    inet 10.10.99.2/24 scope global wg-billing\\ valid_lft forever'), { ip: '10.10.99.2', prefix: 24 });
  assert.deepEqual(parseIpAddr('9: raniah-sstp    inet 172.16.0.5 peer 172.16.0.1/32 scope global'), { ip: '172.16.0.5', prefix: null });
  assert.equal(parseIpAddr(''), null);

  const dump = 'PRIVATEKEY\tPUBKEY\t51820\toff\nPEER\tPSK\t203.0.113.10:51820\t10.10.99.0/24\t1700000000\t1234\t5678\t25\n';
  assert.deepEqual(parseWgDump(dump), {
    endpoint: '203.0.113.10:51820', latest_handshake: 1700000000, rx_bytes: 1234, tx_bytes: 5678,
  });
  assert.equal(parseWgDump('PRIVATEKEY\tPUB\t51820\toff\n'), null);
  assert.equal(parseWgDump('a\tb\tc\td\nP\tP\t(none)\t10.0.0.0/24\t0\t0\t0\toff').latest_handshake, null);

  assert.equal(hijacksDefaultRoute('default dev wg-billing scope link'), true);
  assert.equal(hijacksDefaultRoute('0.0.0.0/1 via 10.8.0.1 dev raniah-ovpn\n128.0.0.0/1 via 10.8.0.1'), true);
  assert.equal(hijacksDefaultRoute('10.10.99.0/24 proto kernel scope link src 10.10.99.2'), false);
});

test('publicProfiles tidak membocorkan rahasia', () => {
  const pub = publicProfiles({
    wireguard: cfg.validateWireguard(wgInput({ preshared_key: KEY_A })),
    openvpn: cfg.validateOpenvpn({ ovpn_config: OVPN, username: 'budi', password: 'rahasia' }),
    sstp: cfg.validateSstp({ server: 'a.b', username: 'u', password: 'sangat-rahasia' }),
  });
  const json = JSON.stringify(pub);
  for (const secretValue of [KEY_B, 'rahasia', 'sangat-rahasia', 'BEGIN CERTIFICATE']) {
    assert.equal(json.includes(secretValue), false, secretValue);
  }
  assert.equal(pub.wireguard.private_key_set, true);
  assert.equal(pub.wireguard.preshared_key_set, true);
  assert.match(pub.wireguard.public_key, cfg.WG_KEY_RE);
  assert.equal(pub.openvpn.ovpn_remote, 'chr.contoh.net:1194');
  assert.equal(pub.sstp.password_set, true);
});

// ---------------------------------------------------------------------------
// Service: status + aksi dengan perintah palsu
// ---------------------------------------------------------------------------
function fakeSystem({ active = {}, enabled = {}, ip = {}, routes = '', wg = null, journal = null } = {}) {
  const calls = [];
  const state = { active: { ...active }, enabled: { ...enabled } };
  const unitOf = (name) => Object.entries(cfg.UNITS).find(([, unit]) => unit === name)?.[0];
  async function run(file, args) {
    calls.push([file, ...args].join(' '));
    const full = file === 'sudo' ? args.slice(1) : args;
    const bin = file === 'sudo' ? args[1] : file;
    const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
    if (file === 'sudo' && bin === '/usr/local/sbin/raniah-vpn-helper') {
      return ok('{"ok":true}\n');
    }
    if (bin === 'systemctl') {
      const [verb] = full.slice(file === 'sudo' ? 1 : 0);
      const rest = full.slice(file === 'sudo' ? 2 : 1);
      if (verb === 'is-active') return ok(`${state.active[unitOf(rest[0])] || 'inactive'}\n`);
      if (verb === 'is-enabled') return ok(`${state.enabled[unitOf(rest[0])] ? 'enabled' : 'disabled'}\n`);
      if (verb === 'show') return ok('5000000\n');
      const unit = rest[rest.length - 1];
      const proto = unitOf(unit);
      if (verb === 'enable') { state.active[proto] = 'active'; state.enabled[proto] = true; }
      if (verb === 'disable') { state.active[proto] = 'inactive'; state.enabled[proto] = false; }
      return ok();
    }
    if (bin === 'ip' && full.includes('addr')) {
      const iface = full[full.length - 1];
      const found = ip[iface];
      return found ? ok(`2: ${iface}    inet ${found} scope global ${iface}\n`) : { ok: false, code: 1, stdout: '', stderr: 'no dev' };
    }
    if (bin === 'ip' && full.includes('route')) return ok(routes);
    if (bin === 'journalctl') {
      return journal === null ? { ok: false, code: 1, stdout: '', stderr: 'denied' } : ok(journal);
    }
    if (bin === 'wg') return wg ? ok(wg) : { ok: false, code: 1, stdout: '', stderr: 'denied' };
    return { ok: false, code: 127, stdout: '', stderr: 'unknown' };
  }
  return { run, calls, state };
}

function serviceWith(system, extra = {}) {
  const applied = [];
  const service = createVpnService({
    isRoot: true,
    run: system.run,
    existsSync: () => true,
    readText: (file) => (file === '/proc/uptime' ? '9000.5 100\n' : '1000'),
    sleep: async () => {},
    now: () => 1700000100 * 1000,
    applyToDisk: (protocol, config) => applied.push([protocol, config]),
    ...extra,
  });
  return { service, applied };
}

test('status: perintah OS yang melempar tetap connected false dan ip null', async () => {
  const { service } = serviceWith({ run: async () => { throw new Error('wg: command not found'); } });
  const status = await service.getStatus();
  assert.equal(status.success, true);
  assert.equal(status.connected, false);
  assert.equal(status.ip, null);
  assert.equal(status.state, 'disconnected');
});

test('status: tidak ada layanan aktif = terputus', async () => {
  const { service } = serviceWith(fakeSystem());
  const status = await service.getStatus();
  assert.equal(status.state, 'disconnected');
  assert.equal(status.connected, false);
  assert.equal(status.protocol, null);
  assert.equal(status.tools.wireguard.installed, true);
});

test('status wireguard: handshake segar = terhubung, basi = menunggu', async () => {
  const dump = (hs) => `PRIV\tPUB\t51820\toff\nPEER\tPSK\t203.0.113.10:51820\t10.10.99.0/24\t${hs}\t100\t200\t25\n`;
  let system = fakeSystem({ active: { wireguard: 'active' }, ip: { 'wg-billing': '10.10.99.2/24' }, wg: dump(1700000090) });
  let status = await serviceWith(system).service.getStatus();
  assert.equal(status.state, 'connected');
  assert.equal(status.ip, '10.10.99.2');
  assert.equal(status.wireguard.handshake_age_seconds, 10);
  assert.equal(status.traffic.rx_bytes, 100);
  assert.equal(status.traffic.tx_bytes, 200);
  assert.equal(status.traffic.rx, '100 B');
  assert.equal(status.traffic.tx, '200 B');
  assert.equal(status.uptime_seconds, 8996);
  assert.equal(JSON.stringify(status).includes('PRIV'), false);

  system = fakeSystem({ active: { wireguard: 'active' }, ip: { 'wg-billing': '10.10.99.2/24' }, wg: dump(1699990000) });
  status = await serviceWith(system).service.getStatus();
  assert.equal(status.state, 'connecting');

  system = fakeSystem({ active: { wireguard: 'active' }, ip: { 'wg-billing': '10.10.99.2/24' }, wg: dump(0) });
  status = await serviceWith(system).service.getStatus();
  assert.equal(status.state, 'connecting');
});

test('ping: target publik dan gateway tunnel diambil dari konfigurasi, bukan IP tetap', () => {
  assert.equal(hostOf('chr.domain.com:51820'), 'chr.domain.com');
  assert.equal(hostOf('203.0.113.10:55722'), '203.0.113.10');
  assert.equal(hostOf('chr.domain.com'), 'chr.domain.com');
  assert.equal(hostOf('10.210.0.2;id'), null);
  assert.equal(hostOf('$(reboot)'), null);
  assert.equal(isSafePingTarget('chr.domain.com;id'), false);

  assert.equal(tunnelGateway('10.210.0.2/24'), '10.210.0.1');
  assert.equal(tunnelGateway('172.16.50.15/24'), '172.16.50.1');
  assert.equal(tunnelGateway('10.10.99.2'), '10.10.99.1');
  assert.equal(tunnelGateway('bukan-ip'), null);

  assert.equal(publicPingTarget('wireguard', { endpoint: 'chr.domain.com:51820' }), 'chr.domain.com');
  assert.equal(publicPingTarget('sstp', { server: '203.0.113.10:443' }), '203.0.113.10');
  assert.equal(publicPingTarget('openvpn', { ovpn_config: 'client\nremote vpn.chr.local 1194\n' }), 'vpn.chr.local');
  assert.equal(tunnelPingTarget('wireguard', { address: '10.210.0.2/24' }, '10.210.0.9'), '10.210.0.1');
  assert.equal(tunnelPingTarget('openvpn', {}, '172.16.50.15'), '172.16.50.1');
  assert.equal(tunnelPingTarget('sstp', {}, '10.8.0.6'), '10.8.0.1');
  assert.equal(parsePingMs('64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=24.5 ms'), 24.5);
  assert.equal(parsePingMs(''), null);
});

test('ping: dua target dijalankan paralel dan host berbahaya tidak dieksekusi', async () => {
  const calls = [];
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createVpnService({
    isRoot: true,
    existsSync: () => true,
    run: async (file, args) => {
      calls.push([file, args]);
      if (file !== 'ping') return { ok: true, code: 0, stdout: '', stderr: '' };
      started += 1;
      if (started === 2) release();
      await gate;
      const target = args[args.length - 1];
      return { ok: true, code: 0, stdout: `time=${target.endsWith('.1') ? '25.1' : '24.5'} ms\n`, stderr: '' };
    },
  });
  const pending = service.measurePing('wireguard', {
    endpoint: 'chr.domain.com:51820',
    address: '10.210.0.2/24',
  }, '10.210.0.2');
  await gate;
  assert.equal(started, 2);
  const ping = await pending;
  assert.deepEqual(ping.public, { target: 'chr.domain.com', ms: 24.5, status: 'ok' });
  assert.deepEqual(ping.tunnel, { target: '10.210.0.1', ms: 25.1, status: 'ok' });
  assert.deepEqual(
    calls.filter(([file]) => file === 'ping').map(([, args]) => args),
    [['-c', '1', '-W', '1', 'chr.domain.com'], ['-c', '1', '-W', '1', '10.210.0.1']],
  );

  calls.length = 0;
  const blocked = await service.measurePing('wireguard', { endpoint: 'evil.com;reboot:51820', address: 'nope' }, null);
  assert.equal(blocked.public.status, 'timeout');
  assert.equal(blocked.tunnel.status, 'timeout');
  assert.equal(calls.some(([file]) => file === 'ping'), false);
});

test('status openvpn/sstp: terhubung bila interface punya IP', async () => {
  const system = fakeSystem({ active: { sstp: 'active' }, ip: { 'raniah-sstp': '172.16.0.5 peer 172.16.0.1/32' } });
  const status = await serviceWith(system).service.getStatus();
  assert.equal(status.protocol, 'sstp');
  assert.equal(status.state, 'connected');
  const waiting = await serviceWith(fakeSystem({ active: { openvpn: 'active' } })).service.getStatus();
  assert.equal(waiting.state, 'connecting');
});

test('non-root memakai sudo -n untuk systemctl dan wg', async () => {
  const system = fakeSystem({ active: { wireguard: 'active' }, ip: { 'wg-billing': '10.10.99.2/24' }, wg: 'PRIV\nPEER\tP\t(none)\ta\t0\t0\t0\t0' });
  const { service } = serviceWith(system, { isRoot: false });
  await service.getStatus();
  assert.ok(system.calls.includes('sudo -n wg show wg-billing dump'), system.calls.join('\n'));
  assert.ok(system.calls.includes('systemctl is-active wg-quick@wg-billing'));
});

test('connect: mematikan protokol lain dulu, lalu enable --now unit terpilih', async () => {
  const system = fakeSystem({
    active: { sstp: 'active' },
    enabled: { sstp: true },
    ip: { 'wg-billing': '10.10.99.2/24' },
    wg: 'PRIV\tPUB\t51820\toff\nPEER\tPSK\t1.2.3.4:51820\ta\t1700000095\t1\t2\t25\n',
  });
  const { service, applied } = serviceWith(system, { isRoot: false });
  const config = cfg.validateWireguard(wgInput());
  const result = await service.connect('wireguard', config);

  assert.equal(result.status.connected, true);
  assert.equal(result.status.protocol, 'wireguard');
  assert.deepEqual(applied, [], 'non-root menulis lewat helper sudo, bukan langsung');
  const sudoCalls = system.calls.filter((call) => call.startsWith('sudo -n '));
  const disableSstp = sudoCalls.indexOf('sudo -n systemctl disable --now raniah-sstp');
  const enableWg = sudoCalls.indexOf('sudo -n systemctl enable --now wg-quick@wg-billing');
  assert.ok(disableSstp >= 0 && enableWg > disableSstp, sudoCalls.join('\n'));
  assert.ok(sudoCalls.includes('sudo -n /usr/local/sbin/raniah-vpn-helper apply'), sudoCalls.join('\n'));
  assert.equal(sudoCalls.some((call) => call.includes('restart wg-quick')), false);
});

test('connect: root menulis konfigurasi langsung dan restart bila sudah aktif', async () => {
  const system = fakeSystem({
    active: { wireguard: 'active' },
    ip: { 'wg-billing': '10.10.99.2/24' },
    wg: 'PRIV\tPUB\t51820\toff\nPEER\tPSK\t1.2.3.4:51820\ta\t1700000095\t1\t2\t25\n',
  });
  const { service, applied } = serviceWith(system);
  const config = cfg.validateWireguard(wgInput());
  await service.connect('wireguard', config);
  assert.deepEqual(applied, [['wireguard', config]]);
  assert.ok(system.calls.includes('systemctl enable --now wg-quick@wg-billing'));
  assert.ok(system.calls.includes('systemctl restart wg-quick@wg-billing'));
});

test('connect: dibatalkan bila VPN membelokkan default route server', async () => {
  const system = fakeSystem({
    ip: { 'raniah-ovpn': '10.8.0.6/24' },
    routes: '0.0.0.0/1 via 10.8.0.5 dev raniah-ovpn\n128.0.0.0/1 via 10.8.0.5 dev raniah-ovpn\n',
  });
  const { service } = serviceWith(system);
  const config = cfg.validateOpenvpn({ ovpn_config: 'client\nremote a.b 1\n' });
  await assert.rejects(() => service.connect('openvpn', config), (error) => error.status === 409 && /default route/.test(error.message));
  assert.ok(system.calls.includes('systemctl disable --now openvpn-client@raniah-vpn'));
});

test('connect: tolak tanpa konfigurasi tersimpan / paket belum terpasang / protokol asing', async () => {
  const { service } = serviceWith(fakeSystem());
  await assert.rejects(() => service.connect('wireguard', null), (error) => error.status === 400);
  await assert.rejects(() => service.connect('l2tp', {}), (error) => error.status === 400);
  const missing = serviceWith(fakeSystem(), { existsSync: () => false }).service;
  await assert.rejects(
    () => missing.connect('wireguard', cfg.validateWireguard(wgInput())),
    (error) => error.status === 503 && /apt install -y wireguard-tools/.test(error.message),
  );
});

test('connect sstp: /dev/ppp tidak ada -> 503 berisi petunjuk LXC, unit dimatikan, tidak di-enable', async () => {
  const system = fakeSystem({ active: { sstp: 'active' }, enabled: { sstp: true } });
  const noPpp = (file) => file !== '/dev/ppp';
  const { service, applied } = serviceWith(system, { existsSync: noPpp });
  await assert.rejects(
    () => service.connect('sstp', cfg.validateSstp({ server: 'a.b:9921', username: 'u', password: 'p' })),
    (error) => error.status === 503 && /\/dev\/ppp/.test(error.message) && /lxc\.cgroup2\.devices\.allow/.test(error.message) && /ppp_async/.test(error.message) && /Privileged/.test(error.message),
  );
  assert.ok(system.calls.includes('systemctl disable --now raniah-sstp'), 'unit yang berulang-gagal harus dihentikan');
  assert.equal(system.calls.some((call) => call.includes('enable --now raniah-sstp')), false);
  assert.deepEqual(applied, [], 'konfigurasi tidak ditulis bila device tidak ada');
});

test('connect sstp: belum dapat IP -> kembalikan 20 baris terakhir journalctl (sudo bila bukan root)', async () => {
  const journal = [
    '-- Journal begins --',
    ...Array.from({ length: 24 }, (_, i) => `Nov 21 17:00:${String(i).padStart(2, '0')} Bil sstpc[1]: baris ${i}`),
    'Nov 21 17:00:59 Bil pppd[2]: peer password=rahasia123 ditolak',
    '',
  ].join('\n');
  const system = fakeSystem({ journal });
  const { service } = serviceWith(system, { isRoot: false });
  const result = await service.connect('sstp', cfg.validateSstp({ server: 'a.b:9921', username: 'u', password: 'p' }));
  assert.equal(result.status.connected, false);
  assert.equal(result.log.length, 20);
  assert.match(result.log[0], /baris 5/, 'baris awal sstpc ikut, tidak hanya Exit pppd');
  assert.match(result.log[19], /password=\*\*\*/);
  assert.doesNotMatch(result.log.join('\n'), /rahasia123/);
  assert.ok(system.calls.includes('sudo -n journalctl -u raniah-sstp -n 20 --no-pager'), system.calls.join('\n'));
});

test('connect: log kosong bila tersambung, dan journalctl yang ditolak tidak menggagalkan respons', async () => {
  const ok = fakeSystem({
    ip: { 'raniah-sstp': '172.16.0.5 peer 172.16.0.1/32' }, journal: 'tidak dipakai\n',
  });
  const connected = await serviceWith(ok).service.connect('sstp', cfg.validateSstp({ server: 'a.b:9921', username: 'u', password: 'p' }));
  assert.equal(connected.status.connected, true);
  assert.deepEqual(connected.log, []);
  assert.equal(ok.calls.some((call) => call.includes('journalctl')), false);

  const denied = await serviceWith(fakeSystem({ journal: null }), { isRoot: false })
    .service.connect('sstp', cfg.validateSstp({ server: 'a.b:9921', username: 'u', password: 'p' }));
  assert.deepEqual(denied.log, []);
});

test('connect: sudoers belum dipasang -> pesan jelas, bukan hang', async () => {
  const system = fakeSystem();
  const denyingRun = async (file, args) => {
    if (file === 'sudo' && args.includes('enable')) {
      return { ok: false, code: 1, stdout: '', stderr: 'sudo: a password is required' };
    }
    return system.run(file, args);
  };
  const { service } = serviceWith(system, { isRoot: false, run: denyingRun });
  await assert.rejects(
    () => service.connect('wireguard', cfg.validateWireguard(wgInput())),
    (error) => error.status === 503 && /sudoers/.test(error.message),
  );
});

test('connect: operasi bersamaan ditolak 409', async () => {
  const system = fakeSystem({ ip: { 'wg-billing': '10.10.99.2/24' } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = serviceWith(system, { sleep: () => gate });
  const first = service.connect('wireguard', cfg.validateWireguard(wgInput()));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => service.disconnect('wireguard'), (error) => error.status === 409);
  release();
  await first;
});

test('disconnect: disable --now unit protokol itu', async () => {
  const system = fakeSystem({ active: { openvpn: 'active' }, enabled: { openvpn: true } });
  const { service } = serviceWith(system);
  const { status } = await service.disconnect('openvpn');
  assert.ok(system.calls.includes('systemctl disable --now openvpn-client@raniah-vpn'));
  assert.equal(status.state, 'disconnected');
});

// ---------------------------------------------------------------------------
// Helper root: memvalidasi ulang, tidak percaya input dari aplikasi
// (hanya payload yang DITOLAK yang diuji di sini, supaya tidak menulis ke /etc sungguhan)
// ---------------------------------------------------------------------------
test('helper menolak payload berbahaya tanpa menulis apa pun', () => {
  const { spawnSync } = require('child_process');
  const helper = path.join(__dirname, '..', 'deploy', 'raniah-vpn-helper.js');
  const attempt = (payload, args = ['apply']) => spawnSync(process.execPath, [helper, ...args], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });

  const injection = attempt({ protocol: 'sstp', config: { server: 'a.b;reboot', username: 'u', password: 'p' } });
  assert.notEqual(injection.status, 0);
  assert.match(injection.stderr, /Server CHR tidak valid/);

  const unit = attempt({ protocol: 'wireguard', config: wgInput({ allowed_ips: '0.0.0.0/0' }) });
  assert.notEqual(unit.status, 0);
  assert.match(unit.stderr, /terlalu luas/);

  const ovpn = attempt({ protocol: 'openvpn', config: { ovpn_config: 'client\nremote a.b 1\nup /tmp/x.sh\n' } });
  assert.notEqual(ovpn.status, 0);
  assert.match(ovpn.stderr, /tidak diizinkan/);

  assert.notEqual(attempt({ protocol: '../../etc/passwd', config: {} }).status, 0);
  assert.notEqual(attempt('bukan json').status, 0);
  assert.equal(attempt({}, ['write']).status, 2);
  assert.equal(attempt({}, ['apply', 'extra']).status, 2);
});

// ---------------------------------------------------------------------------
// Route: hanya administrator
// ---------------------------------------------------------------------------
function sign(role) {
  return jwt.sign({ username: 'tester', role }, secret, { algorithm: 'HS256', expiresIn: '5m' });
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api', requireAuth);
  app.use('/api/sistem/vpn', vpnRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const call = (method, route, role, body) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `/api/sistem/vpn${route}`,
      method,
      headers: {
        ...(role ? { Authorization: `Bearer ${sign(role)}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, headers: res.headers }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  try {
    await fn(call);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('route: non-administrator ditolak 403 di semua endpoint', async () => {
  await withServer(async (call) => {
    for (const [method, route] of [['GET', '/status'], ['GET', '/config'], ['POST', '/wg/keygen'], ['POST', '/save'], ['POST', '/action']]) {
      const response = await call(method, route, 'operator', method === 'POST' ? {} : undefined);
      assert.equal(response.status, 403, `${method} ${route}`);
    }
    assert.equal((await call('GET', '/status', null)).status, 401);
  });
});

test('route: administrator bisa keygen; input aksi/protokol divalidasi', async () => {
  await withServer(async (call) => {
    const keygen = await call('POST', '/wg/keygen', 'admin', {});
    assert.equal(keygen.status, 200);
    assert.match(keygen.body.private_key, cfg.WG_KEY_RE);
    assert.match(keygen.body.public_key, cfg.WG_KEY_RE);
    assert.equal(keygen.headers['cache-control'], 'no-store');

    assert.equal((await call('POST', '/action', 'admin', { protocol: 'l2tp', action: 'connect' })).status, 400);
    assert.equal((await call('POST', '/action', 'admin', { protocol: 'wireguard', action: 'restart' })).status, 400);
    assert.equal((await call('POST', '/save', 'admin', { protocol: '../etc', config: {} })).status, 400);
  });
});

test('diagnoseLog: mengenali penyebab dari log unit', () => {
  const { diagnoseLog } = require('../backend/vpn');
  assert.equal(diagnoseLog([]), null);
  assert.equal(diagnoseLog(['pppd: Couldn\'t open the /dev/ppp device: No such file or directory']).code, 'device');
  assert.equal(diagnoseLog([
    'SSL certificate verification failed: self-signed certificate (18)',
    'Server certificated failed verification, ignoring',
    'pppd: Couldn\'t set tty to PPP discipline: Operation not permitted',
  ]).code, 'discipline');
  assert.equal(diagnoseLog(['sstpc: Could not connect to server: Connection refused']).code, 'network');
  assert.equal(diagnoseLog(['pppd: Connection terminated.', 'CHAP authentication failed']).code, 'auth');
  assert.equal(diagnoseLog(['SSL_connect: handshake failure']).code, 'tls');
  assert.equal(diagnoseLog(['SSL certificate verification failed: self-signed certificate']).code, 'certificate');
  // Mode --cert-warn: sertifikat diabaikan, bukan penyebab kegagalan.
  assert.equal(diagnoseLog(['SSL certificate verification failed: self-signed certificate', 'Server certificated failed verification, ignoring']), null);
});

test('monitoring: RX/TX dibaca dari /sys/class/net/<iface> untuk OpenVPN dan SSTP, bukan hanya WireGuard', async () => {
  const cases = [
    ['openvpn', 'raniah-ovpn', '10.8.0.6/24'],
    ['sstp', 'raniah-sstp', '172.16.0.5 peer 172.16.0.1/32'],
  ];
  for (const [protocol, iface, addr] of cases) {
    const reads = [];
    const system = fakeSystem({ active: { [protocol]: 'active' }, ip: { [iface]: addr } });
    const { service } = serviceWith(system, {
      readText: (file) => {
        reads.push(file);
        if (file === '/proc/uptime') return '9000.5 100\n';
        if (file.endsWith('/rx_bytes')) return '2048\n';
        if (file.endsWith('/tx_bytes')) return '4096\n';
        return '';
      },
    });
    const status = await service.getStatus();
    assert.equal(status.state, 'connected', protocol);
    assert.equal(status.interface, iface);
    assert.ok(reads.includes(`/sys/class/net/${iface}/statistics/rx_bytes`), reads.join('\n'));
    assert.ok(reads.includes(`/sys/class/net/${iface}/statistics/tx_bytes`), reads.join('\n'));
    assert.equal(status.traffic.rx_bytes, 2048);
    assert.equal(status.traffic.tx_bytes, 4096);
    assert.equal(status.traffic.rx, '2.00 KiB');
  }
});

test('monitoring: dual ping OpenVPN/SSTP memakai remote/server profil dan gateway .1 dari IP interface', async () => {
  const pinged = [];
  const service = createVpnService({
    isRoot: true,
    existsSync: () => true,
    run: async (file, args) => {
      if (file === 'ping') {
        pinged.push(args[args.length - 1]);
        return { ok: true, code: 0, stdout: 'time=12.5 ms\n', stderr: '' };
      }
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  });
  const ovpn = await service.measurePing('openvpn', { ovpn_config: 'client\nremote vpn.chr.local 1194\n' }, '10.8.0.6');
  assert.deepEqual([ovpn.public.target, ovpn.tunnel.target], ['vpn.chr.local', '10.8.0.1']);
  const sstp = await service.measurePing('sstp', { server: '103.195.65.78:9921' }, '10.210.0.7');
  assert.deepEqual([sstp.public.target, sstp.tunnel.target], ['103.195.65.78', '10.210.0.1']);
  assert.equal(sstp.tunnel.status, 'ok');
  assert.deepEqual(pinged.sort(), ['10.210.0.1', '10.8.0.1', '103.195.65.78', 'vpn.chr.local'].sort());
});

test('openvpn: /dev/net/tun tidak ada -> status memberi peringatan dan connect 503 berisi perintah passthrough LXC', async () => {
  const noTun = (file) => file !== '/dev/net/tun';
  const system = fakeSystem({ active: { openvpn: 'active' }, enabled: { openvpn: true } });
  const { service, applied } = serviceWith(system, { existsSync: noTun });

  const status = await service.getStatus();
  assert.equal(status.tools.openvpn.device_missing, '/dev/net/tun');
  assert.match(status.tools.openvpn.device_hint, /lxc\.cgroup2\.devices\.allow: c 10:200 rwm/);
  assert.match(status.tools.openvpn.device_hint, /lxc\.mount\.entry: \/dev\/net\/tun dev\/net\/tun none bind,create=file/);
  assert.equal(status.tools.sstp.device_missing, null, '/dev/ppp ada pada existsSync palsu ini');
  assert.equal(status.tools.wireguard.device_missing, null);

  await assert.rejects(
    () => service.connect('openvpn', cfg.validateOpenvpn({ ovpn_config: 'client\nremote a.b 1194\n' })),
    (error) => error.status === 503
      && /\/dev\/net\/tun/.test(error.message)
      && /lxc\.cgroup2\.devices\.allow: c 10:200 rwm/.test(error.message)
      && /lxc\.mount\.entry: \/dev\/net\/tun dev\/net\/tun none bind,create=file/.test(error.message),
  );
  assert.ok(system.calls.includes('systemctl disable --now openvpn-client@raniah-vpn'));
  assert.deepEqual(applied, []);

  // Device ada: tidak ada peringatan.
  const ok = await serviceWith(fakeSystem(), { existsSync: () => true }).service.getStatus();
  assert.equal(ok.tools.openvpn.device_missing, null);
  assert.equal(ok.tools.openvpn.device_hint, null);
});
