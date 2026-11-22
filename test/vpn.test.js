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
  vpnFailedProtocols, parseOvpnStatus, presentOvpnServer,
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
test('wireguard: input valid dinormalkan, keepalive default 15', () => {
  const out = cfg.validateWireguard(wgInput({ allowed_ips: '10.10.99.5/24, 192.168.50.0/24' }));
  assert.equal(out.endpoint, 'chr.contoh.net:51820');
  assert.equal(out.allowed_ips, '10.10.99.0/24, 192.168.50.0/24');
  assert.equal(out.keepalive, 15);
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
  assert.match(out, /AllowedIPs = 10\.10\.99\.0\/24\nPersistentKeepalive = 15\n$/);
  assert.doesNotMatch(out, /PostUp|PostDown|DNS|Table/);
});

test('wireguard: MTU default 1380 dan keepalive 15, nilai manual menang', () => {
  const auto = cfg.renderWireguard(cfg.validateWireguard(wgInput()));
  assert.match(auto, /^MTU = 1380$/m);
  assert.match(auto, /^PersistentKeepalive = 15$/m);
  const manual = cfg.renderWireguard(cfg.validateWireguard(wgInput({ mtu: 1420, keepalive: 25 })));
  assert.match(manual, /^MTU = 1420$/m);
  assert.match(manual, /^PersistentKeepalive = 25$/m);
  assert.equal((manual.match(/^MTU = /gm) || []).length, 1);
  // Profil lama tersimpan tanpa mtu (null) atau keepalive 0 tetap memakai default baru saat dirender.
  const legacy = cfg.renderWireguard({ ...cfg.validateWireguard(wgInput()), mtu: null, keepalive: 0 });
  assert.match(legacy, /^MTU = 1380$/m);
  assert.match(legacy, /^PersistentKeepalive = 15$/m);
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
  for (const flag of ['keepalive 10 30', 'resolv-retry infinite', 'persist-key', 'persist-tun']) {
    assert.ok(lines.includes(flag), flag);
  }
  assert.equal(lines.filter((line) => /^dev /.test(line)).length, 1);
  assert.equal(cfg.renderOvpnAuth(out), 'budi\nrahasia\n');

  // Password kosong memakai nilai tersimpan; username kosong menghapus kredensial.
  const kept = cfg.validateOpenvpn({ username: 'budi', password: '' }, out);
  assert.equal(kept.password, 'rahasia');
  assert.equal(kept.ovpn_config, out.ovpn_config);
  rejects(() => cfg.validateOpenvpn({ ovpn_config: OVPN, username: 'budi', password: 'a\nb' }), /Password OpenVPN/);
});

function ovpnRendered(lines) {
  const src = `client\n${lines.join('\n')}\n<ca>\n-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n</ca>\n`;
  return cfg.renderOvpn(cfg.validateOpenvpn({ ovpn_config: src }));
}
const countLines = (out, re) => out.split('\n').filter((line) => re.test(line)).length;

test('openvpn: tuning performa dan keamanan ditambahkan untuk UDP (termasuk fast-io)', () => {
  for (const variant of [['remote chr.contoh.net 1194', 'proto udp'], ['remote chr.contoh.net 1194'], ['remote chr.contoh.net 1194 udp4']]) {
    const lines = ovpnRendered(variant).split('\n');
    for (const flag of ['tun-mtu 1400', 'mssfix 1360', 'sndbuf 393216', 'rcvbuf 393216', 'fast-io',
      'data-ciphers AES-256-GCM:AES-128-GCM', 'tls-version-min 1.2']) {
      assert.ok(lines.includes(flag), `${flag} <- ${variant.join(' | ')}`);
    }
  }
});

test('openvpn: fast-io tidak dipasang untuk TCP atau campuran UDP/TCP', () => {
  for (const variant of [
    ['remote chr.contoh.net 443', 'proto tcp-client'],
    ['remote chr.contoh.net 443', 'proto tcp'],
    ['proto udp', 'remote chr.contoh.net 1194 udp', 'remote cadangan.contoh.net 443 tcp'],
    ['remote chr.contoh.net 443 tcp'],
  ]) {
    const out = ovpnRendered(variant);
    assert.ok(!out.split('\n').includes('fast-io'), variant.join(' | '));
    assert.ok(out.includes('\ntun-mtu 1400\n') && out.includes('\nmssfix 1360\n'), variant.join(' | '));
  }
});

test('openvpn: nilai yang sudah ada di .ovpn tidak ditimpa atau digandakan', () => {
  const out = ovpnRendered([
    'remote chr.contoh.net 1194', 'proto udp', 'tun-mtu 1500', 'mssfix 1200', 'sndbuf 65536', 'rcvbuf 65536',
    'fast-io', 'cipher AES-256-CBC', 'tls-version-min 1.3',
  ]);
  for (const re of [/^tun-mtu /, /^mssfix /, /^sndbuf /, /^rcvbuf /, /^fast-io$/, /^tls-version-min /, /^cipher /]) {
    assert.equal(countLines(out, re), 1, String(re));
  }
  assert.ok(out.includes('\ntun-mtu 1500\n') && out.includes('\nmssfix 1200\n') && out.includes('\nsndbuf 65536\n'));
  assert.ok(out.includes('\ntls-version-min 1.3\n'));
  // Cipher pilihan profil dihormati (CHR lama): data-ciphers tidak ditambahkan di atasnya.
  assert.equal(countLines(out, /^data-ciphers/), 0);
  // link-mtu eksplisit juga menahan tun-mtu agar keduanya tidak bentrok.
  assert.equal(countLines(ovpnRendered(['remote a.b 1194', 'link-mtu 1500']), /^tun-mtu /), 0);
  // Opsi di dalam blok inline tidak dianggap direktif.
  const inBlock = cfg.renderOvpn(cfg.validateOpenvpn({
    ovpn_config: 'client\nremote a.b 1194\n<ca>\nmssfix 1\n</ca>\n',
  }));
  assert.ok(inBlock.includes('\nmssfix 1360\n'));
});

test('openvpn: tls-version-min di bawah 1.2 dinaikkan, data-ciphers tidak dilemahkan', () => {
  for (const weak of ['1.0', '1.1']) {
    const out = ovpnRendered(['remote chr.contoh.net 1194', `tls-version-min ${weak}`]);
    assert.equal(countLines(out, /^tls-version-min /), 1);
    assert.ok(out.includes('\ntls-version-min 1.2\n'), weak);
  }
  const explicit = ovpnRendered(['remote chr.contoh.net 1194', 'data-ciphers AES-128-GCM']);
  assert.equal(countLines(explicit, /^data-ciphers /), 1);
  assert.ok(explicit.includes('\ndata-ciphers AES-128-GCM\n'));
});

test('openvpn: tanpa auth-user-pass, kredensial opsional', () => {
  const plain = 'client\nremote chr.contoh.net 1194\n';
  const out = cfg.validateOpenvpn({ ovpn_config: plain });
  assert.equal(out.username, '');
  assert.doesNotMatch(cfg.renderOvpn(out), /auth-user-pass/);
});

test('openvpn: keepalive default tidak ditambah bila .ovpn sudah punya keepalive/ping/ping-exit/ping-restart', () => {
  const cases = [
    'client\nremote a.b 1194\nkeepalive 15 45\n',
    'client\nremote a.b 1194\nping 10\nping-restart 60\n',
    'client\nremote a.b 1194\nping 15\nping-exit 45\n',
    'client\nremote a.b 1194\nping 20\n',
  ];
  for (const ovpn of cases) {
    const conf = cfg.renderOvpn(cfg.validateOpenvpn({ ovpn_config: ovpn }));
    assert.doesNotMatch(conf, /\nkeepalive 10 30\n/, ovpn);
    for (const flag of ['resolv-retry infinite', 'persist-key', 'persist-tun']) {
      assert.ok(conf.includes(flag), `${flag} in ${ovpn}`);
    }
  }
  const withCustomKeep = cfg.renderOvpn(cfg.validateOpenvpn({ ovpn_config: cases[0] }));
  assert.match(withCustomKeep, /\nkeepalive 15 45\n/);
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
    'lcp-echo-interval 5', 'lcp-echo-failure 3', 'mtu 1400', 'mru 1400']) {
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
  assert.match(unit, /^KillMode=control-group$/m);
  assert.match(unit, /^TimeoutStopSec=5$/m);
  assert.match(unit, /^ExecStopPost=-\/sbin\/ip link delete raniah-sstp$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=3$/m);
  assert.match(unit, /^StartLimitIntervalSec=0$/m);
  assert.doesNotMatch(unit, /sstpc|chr\.contoh|vpn-user|p"a/, 'unit hanya menjalankan pppd; sstpc dan kredensial ada di peer');
  const wgDrop = cfg.renderWgUnitOverride();
  assert.match(wgDrop, /^After=network-online\.target$/m);
  assert.match(wgDrop, /^Wants=network-online\.target$/m);
  const ovpnDrop = cfg.renderOvpnUnitOverride();
  assert.match(ovpnDrop, /^StartLimitIntervalSec=0$/m);
  assert.match(ovpnDrop, /^Restart=always$/m);
  assert.match(ovpnDrop, /^RestartSec=5$/m);
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
    const reloadCalls = [];
    const wgFiles = cfg.applyToDisk('wireguard', cfg.validateWireguard(wgInput()), {
      root,
      exec: (...args) => { reloadCalls.push(args); },
    });
    assert.deepEqual(wgFiles, [cfg.PATHS.wireguard, cfg.PATHS.wgOverride]);
    const wgPath = path.join(root, cfg.PATHS.wireguard);
    assert.equal(fs.statSync(wgPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(wgPath)).mode & 0o777, 0o700);

    const ovpn = cfg.validateOpenvpn({ ovpn_config: OVPN, username: 'budi', password: 'x' });
    cfg.applyToDisk('openvpn', ovpn, { root, exec: () => {} });
    assert.equal(fs.existsSync(path.join(root, cfg.PATHS.ovpnOverride)), true);
    assert.equal(fs.statSync(path.join(root, cfg.PATHS.ovpn)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, cfg.PATHS.ovpnAuth)).mode & 0o777, 0o600);
    // Kredensial dihapus -> berkas auth ikut dihapus.
    cfg.applyToDisk('openvpn', cfg.validateOpenvpn({ ovpn_config: 'client\nremote a.b 1\n' }), { root });
    assert.equal(fs.existsSync(path.join(root, cfg.PATHS.ovpnAuth)), false);

    reloadCalls.length = 0;
    cfg.applyToDisk('sstp', cfg.validateSstp({
      server: 'chr.contoh.net', username: 'u', password: 'p', routes: '10.10.99.0/24',
    }), { root, existsSync: () => false, exec: (...args) => { reloadCalls.push(args); } });
    assert.deepEqual(reloadCalls, []);
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

test('applyToDisk: systemctl daemon-reload saat menulis ke OS nyata (root kosong)', () => {
  const calls = [];
  const profiles = {
    wireguard: cfg.validateWireguard(wgInput()),
    openvpn: cfg.validateOpenvpn({ ovpn_config: 'client\nremote a.b 1194\n' }),
    sstp: cfg.validateSstp({ server: 'a.b', username: 'u', password: 'p' }),
    l2tp: cfg.validateL2tp({ server: 'a.b', username: 'u', password: 'p' }),
  };
  for (const protocol of cfg.PROTOCOLS) {
    calls.length = 0;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-test-'));
    try {
      cfg.applyToDisk(protocol, profiles[protocol], {
        root, existsSync: () => false, exec: (...args) => calls.push(args),
      });
      assert.deepEqual(calls, [], protocol);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  calls.length = 0;
  try {
    cfg.applyToDisk('wireguard', profiles.wireguard, {
      root: '', existsSync: () => false, exec: (...args) => calls.push(args),
    });
    assert.deepEqual(calls, [['systemctl', ['daemon-reload']]]);
  } catch {
    // Lingkungan tanpa izin tulis /etc: cukup uji pemanggilan lewat root tmp di atas.
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
      const protocol = args[3];
      const action = args[4];
      if (args[2] === 'cycle' && protocol) {
        if (action === 'start' || action === 'restart') state.active[protocol] = 'active';
        if (action === 'stop' || action === 'disable') state.active[protocol] = 'inactive';
      }
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
      if (verb === 'disable' && proto) { state.active[proto] = 'inactive'; state.enabled[proto] = false; }
      if ((verb === 'restart' || verb === 'start') && proto) state.active[proto] = 'active';
      if (verb === 'stop' && proto) state.active[proto] = 'inactive';
      if (verb === 'reset-failed' && proto) state.active[proto] = 'inactive';
      return ok();
    }
    if (bin === 'pkill') return { ok: false, code: 1, stdout: '', stderr: 'no process' };
    if (bin === 'ip' && full[0] === 'link') {
      if (full[1] === 'delete') return ok();
      return { ok: false, code: 1, stdout: '', stderr: 'Device does not exist' };
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
    writeText: () => {},
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

test('vpnFailedProtocols: saat terhubung, abaikan failed pada protokol yang tidak aktif', () => {
  const states = { wireguard: 'inactive', openvpn: 'active', sstp: 'failed' };
  assert.deepEqual(vpnFailedProtocols(states, { connected: true, activeProtocol: 'openvpn' }), []);
  assert.deepEqual(vpnFailedProtocols(states), ['sstp']);
});

test('status: failed protokol lain tidak dilaporkan bila VPN sudah terhubung', async () => {
  const system = fakeSystem({
    active: { openvpn: 'active', sstp: 'failed', wireguard: 'inactive' },
    ip: { 'raniah-ovpn': '10.8.0.6/24' },
  });
  const status = await serviceWith(system).service.getStatus();
  assert.equal(status.protocol, 'openvpn');
  assert.equal(status.connected, true);
  assert.deepEqual(status.failed, []);
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

test('connect: disable --now protokol lain (selalu), lalu enable --now unit terpilih', async () => {
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
  const disableSstp = sudoCalls.indexOf('sudo -n /usr/local/sbin/raniah-vpn-helper cycle sstp disable');
  const stopWg = sudoCalls.indexOf('sudo -n /usr/local/sbin/raniah-vpn-helper cycle wireguard stop');
  const enableWg = sudoCalls.indexOf('sudo -n systemctl enable --now wg-quick@wg-billing');
  assert.ok(disableSstp >= 0 && stopWg > disableSstp && enableWg > stopWg, sudoCalls.join('\n'));
  assert.ok(sudoCalls.includes('sudo -n /usr/local/sbin/raniah-vpn-helper apply'), sudoCalls.join('\n'));
  assert.equal(sudoCalls.some((call) => call.includes('systemctl restart')), false);
  assert.ok(sudoCalls.includes('sudo -n /usr/local/sbin/raniah-vpn-helper cycle openvpn disable'));
  assert.ok(sudoCalls.includes('sudo -n /usr/local/sbin/raniah-vpn-helper cycle l2tp disable'));
});

test('restart: helper cycle tanpa systemctl restart dan tanpa disable protokol lain', async () => {
  const dump = 'PRIV\tPUB\t51820\toff\nPEER\tPSK\t203.0.113.10:51820\ta\t1700000095\t1\t2\t25\n';
  const system = fakeSystem({
    active: { wireguard: 'failed' },
    ip: { 'wg-billing': '10.10.99.2/24' },
    wg: dump,
    journal: 'restart-fail\n',
  });
  const { service } = serviceWith(system, { isRoot: false });
  const ok = await service.restart(
    'wireguard',
    cfg.validateWireguard(wgInput()),
    { selectedProtocol: 'wireguard' },
  );
  assert.equal(ok.connected, true);
  const sudoCalls = system.calls.filter((call) => call.startsWith('sudo -n '));
  assert.ok(sudoCalls.includes('sudo -n /usr/local/sbin/raniah-vpn-helper cycle wireguard restart'), sudoCalls.join('\n'));
  assert.equal(sudoCalls.some((call) => call.includes('systemctl restart')), false);
  assert.equal(sudoCalls.some((call) => call.includes('disable')), false);

  await assert.rejects(
    () => service.restart('sstp', cfg.validateSstp({ server: 'a.b:9921', username: 'u', password: 'p' })),
    (error) => error.status === 400 && /tidak sedang aktif/.test(error.message),
  );
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
  assert.ok(system.calls.includes('systemctl stop wg-quick@wg-billing'));
  assert.ok(system.calls.includes('ip link delete wg-billing'));
  assert.ok(system.calls.includes('systemctl enable --now wg-quick@wg-billing'));
  assert.equal(system.calls.some((call) => call.includes('systemctl restart')), false);
  const stopAt = system.calls.indexOf('systemctl stop wg-quick@wg-billing');
  const enableAt = system.calls.indexOf('systemctl enable --now wg-quick@wg-billing');
  assert.ok(stopAt >= 0 && enableAt > stopAt);
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
  await assert.rejects(() => service.connect('pptp', {}), (error) => error.status === 400);
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
  assert.ok(system.calls.includes('systemctl reset-failed openvpn-client@raniah-vpn'));
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
    for (const [method, route] of [['GET', '/status'], ['GET', '/config'], ['POST', '/wg/keygen'], ['POST', '/save'], ['POST', '/action'], ['POST', '/restart']]) {
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

    assert.equal((await call('POST', '/action', 'admin', { protocol: 'pptp', action: 'connect' })).status, 400);
    assert.equal((await call('POST', '/action', 'admin', { protocol: 'wireguard', action: 'restart' })).status, 400);
    assert.equal((await call('POST', '/restart', 'admin', { protocol: 'pptp' })).status, 400);
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

// ---------------------------------------------------------------------------
// L2TP (xl2tpd + pppd, IPsec PSK opsional)
// ---------------------------------------------------------------------------
function l2tpInput(extra = {}) {
  return {
    server: '103.195.65.78', username: 'hasdin22', password: 'rahasia-l2tp', ...extra,
  };
}

test('l2tp: validasi, UDP 1701 default, route dinormalkan, alias camelCase diterima', () => {
  const out = cfg.validateL2tp(l2tpInput({ routes: '10.210.0.5/24, 192.168.50.0/24' }));
  assert.equal(out.server, '103.195.65.78:1701');
  assert.equal(out.routes, '10.210.0.0/24, 192.168.50.0/24');
  assert.equal(out.ipsec_secret, '');
  assert.equal(cfg.validateL2tp(l2tpInput({ server: 'chr.contoh.net:1701' })).server, 'chr.contoh.net:1701');

  const alias = cfg.validateL2tp(l2tpInput({ nasSubnet: '10.210.0.0/24', ipsecSecret: 'psk-123' }));
  assert.equal(alias.routes, '10.210.0.0/24');
  assert.equal(alias.ipsec_secret, 'psk-123');
  assert.equal(cfg.validateProfile('l2tp', l2tpInput()).server, '103.195.65.78:1701');

  rejects(() => cfg.validateL2tp(l2tpInput({ server: 'chr.contoh.net:4500' })), /UDP 1701/);
  rejects(() => cfg.validateL2tp(l2tpInput({ server: '' })), /Server CHR wajib/);
  rejects(() => cfg.validateL2tp(l2tpInput({ username: '' })), /Username L2TP/);
  rejects(() => cfg.validateL2tp(l2tpInput({ password: '' })), /Password L2TP wajib/);
  rejects(() => cfg.validateL2tp(l2tpInput({ routes: '0.0.0.0/0' })), /terlalu luas/);
  rejects(() => cfg.validateL2tp(l2tpInput({ routes: '103.195.65.0/24' })), /memuat alamat CHR/);
});

test('l2tp: anti command/config injection', () => {
  for (const server of ['a.b;reboot', 'a.b\nlns = evil', '-oProxy', 'a.b port=1', '$(id).x', 'a b']) {
    rejects(() => cfg.validateL2tp(l2tpInput({ server })), /Server CHR/);
  }
  for (const username of ['u"\nnoauth', 'u p', 'u;id', 'u\nname x']) {
    rejects(() => cfg.validateL2tp(l2tpInput({ username })), /Username L2TP/);
  }
  rejects(() => cfg.validateL2tp(l2tpInput({ password: 'a\nnoauth' })), /Password L2TP/);
  // PSK ditulis di dalam "..." pada swanctl.conf: kutip, backslash, spasi, baris baru ditolak.
  for (const ipsec_secret of ['a"b', 'a\\b', 'a b', 'a\nb', 'x"; } children { evil', 'p'.repeat(129)]) {
    rejects(() => cfg.validateL2tp(l2tpInput({ ipsec_secret })), /IPsec Pre-Shared Key/);
  }
});

test('l2tp: PSK kosong memakai yang tersimpan, clear_ipsec_secret menghapus (L2TP murni)', () => {
  const existing = { password: 'lama', ipsec_secret: 'psk-lama' };
  const kept = cfg.validateL2tp(l2tpInput({ password: '', ipsec_secret: '' }), existing);
  assert.equal(kept.password, 'lama');
  assert.equal(kept.ipsec_secret, 'psk-lama');
  assert.equal(cfg.validateL2tp(l2tpInput({ ipsec_secret: 'psk-baru' }), existing).ipsec_secret, 'psk-baru');
  assert.equal(cfg.validateL2tp(l2tpInput({ clear_ipsec_secret: true }), existing).ipsec_secret, '');
  assert.equal(cfg.validateL2tp(l2tpInput()).ipsec_secret, '', 'tanpa profil tersimpan = L2TP murni');
});

test('l2tp: xl2tpd.conf, options pppd, hook rute, unit systemd, runner', () => {
  const out = cfg.validateL2tp(l2tpInput({ password: 'p"a\\ss', routes: '10.210.0.0/24' }));

  const conf = cfg.renderL2tpXl2tpd(out);
  assert.match(conf, /^\[lac raniah-l2tp\]$/m);
  assert.match(conf, /^lns = 103\.195\.65\.78$/m);
  assert.match(conf, /^pppoptfile = \/etc\/ppp\/options\.l2tpd\.client$/m);
  assert.match(conf, /^autodial = no$/m);
  assert.doesNotMatch(conf, /hasdin22|p"a|rahasia/, 'kredensial hanya di options pppd');

  const opts = cfg.renderL2tpOptions(out);
  assert.match(opts, /^name "hasdin22"$/m);
  assert.match(opts, /^password "p\\"a\\\\ss"$/m);
  assert.match(opts, /^ifname raniah-l2tp$/m);
  for (const flag of ['noauth', 'nodefaultroute', 'nopersist', 'mtu 1400', 'mru 1400', 'lcp-echo-interval 5', 'lcp-echo-failure 3']) {
    assert.match(opts, new RegExp(`^${flag}$`, 'm'), flag);
  }
  assert.doesNotMatch(opts, /usepeerdns/, 'DNS lokal tidak boleh ditimpa');
  assert.doesNotMatch(opts, /^defaultroute$/m);
  assert.doesNotMatch(opts, /^persist$/m);

  assert.equal(cfg.renderL2tpRoutes(out), '10.210.0.0/24\n');
  assert.match(cfg.renderL2tpHook(), /\[ "\$PPP_IFACE" = "raniah-l2tp" \] \|\| exit 0/);
  assert.match(cfg.renderL2tpHook(), /ROUTES=\/etc\/ppp\/raniah-l2tp\.routes/);
  assert.match(cfg.renderSstpHook(), /\[ "\$PPP_IFACE" = "raniah-sstp" \] \|\| exit 0/, 'hook SSTP tidak berubah');

  const unit = cfg.renderL2tpUnit();
  assert.match(unit, /^After=network-online\.target xl2tpd\.service$/m);
  assert.match(unit, /^Wants=network-online\.target xl2tpd\.service$/m);
  assert.match(unit, /^StartLimitIntervalSec=0$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=3$/m);
  assert.match(unit, /^ExecStartPre=.*test -c \/dev\/ppp.*\/dev\/ppp tidak ada/m);
  assert.match(unit, /^ExecStartPre=\/bin\/systemctl restart xl2tpd\.service$/m);
  assert.match(unit, /^ExecStart=\/etc\/xl2tpd\/raniah-l2tp-run\.sh start$/m);
  assert.match(unit, /^ExecStopPost=\/etc\/xl2tpd\/raniah-l2tp-run\.sh stop$/m);
  assert.match(unit, /^ExecStopPost=-\/sbin\/ip link delete raniah-l2tp$/m);
  assert.match(unit, /^KillMode=control-group$/m);
  assert.match(unit, /^TimeoutStopSec=5$/m);
  assert.doesNotMatch(unit, /hasdin22|103\.195|rahasia|p"a/);

  const runner = cfg.renderL2tpRunner();
  assert.match(runner, /^#!\/bin\/sh$/m);
  assert.match(runner, /^CTL=\/var\/run\/xl2tpd\/l2tp-control$/m);
  assert.match(runner, /ctl "c \$LAC"/);
  assert.match(runner, /ip link delete "\$IFACE"/);
  assert.match(runner, /printf "%s\\n"/, 'newline harus literal untuk shell, bukan newline JS');
  assert.doesNotMatch(runner, /hasdin22|103\.195|rahasia/, 'runner tidak memuat nilai konfigurasi');
});

test('cycleVpn: stop, bunuh sisa, tunggu interface hilang, baru start', async () => {
  const patterns = {
    wireguard: null,
    openvpn: 'pkill -f /etc/openvpn/client/raniah-vpn.conf',
    sstp: 'pkill -f raniah-sstp',
    l2tp: 'pkill -f options.l2tpd.client',
  };
  for (const protocol of cfg.PROTOCOLS) {
    const calls = [];
    // eslint-disable-next-line no-await-in-loop
    await cfg.cycleVpn(protocol, 'restart', {
      sleep: async () => {},
      exec: async (file, args) => {
        calls.push([file, ...args].join(' '));
        if (file === 'ip' && args[1] === 'show') return { ok: false, code: 1, stdout: '', stderr: 'gone' };
        return { ok: true, code: 0, stdout: '', stderr: '' };
      },
    });
    const stopAt = calls.indexOf(`systemctl stop ${cfg.UNITS[protocol]}`);
    const resetAt = calls.indexOf(`systemctl reset-failed ${cfg.UNITS[protocol]}`);
    const deleteAt = calls.indexOf(`ip link delete ${cfg.INTERFACES[protocol]}`);
    const showAt = calls.indexOf(`ip link show ${cfg.INTERFACES[protocol]}`);
    const startAt = calls.indexOf(`systemctl start ${cfg.UNITS[protocol]}`);
    assert.ok(stopAt >= 0 && resetAt > stopAt && deleteAt > resetAt && showAt > deleteAt && startAt > showAt, calls.join('\n'));
    assert.equal(calls.some((call) => call.startsWith('systemctl restart')), false, protocol);
    if (patterns[protocol]) assert.ok(calls.includes(patterns[protocol]), calls.join('\n'));
    else assert.equal(calls.some((call) => call.startsWith('pkill')), false);
  }
});

test('cycleVpn: L2TP menghentikan xl2tpd; start dibatalkan bila interface masih ada', async () => {
  const calls = [];
  await cfg.cycleVpn('l2tp', 'disable', {
    sleep: async () => {},
    exec: async (file, args) => {
      calls.push([file, ...args].join(' '));
      if (file === 'ip' && args[1] === 'show') return { ok: false, code: 1, stdout: '', stderr: 'gone' };
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  });
  assert.ok(calls.includes('systemctl disable --now raniah-l2tp'));
  assert.ok(calls.includes('systemctl disable --now xl2tpd'));
  assert.ok(calls.includes('pkill -f options.l2tpd.client'));
  assert.equal(calls.some((call) => call.startsWith('systemctl start')), false);

  const blocked = [];
  await assert.rejects(
    () => cfg.cycleVpn('l2tp', 'restart', {
      sleep: async () => {},
      exec: async (file, args) => {
        blocked.push([file, ...args].join(' '));
        if (file === 'ip' && args[1] === 'show') return { ok: true, code: 0, stdout: 'still-there', stderr: '' };
        return { ok: true, code: 0, stdout: '', stderr: '' };
      },
    }),
    /masih ada/,
  );
  assert.equal(blocked.some((call) => call.startsWith('systemctl start')), false);
});

test('l2tp: runner lolos sintaks sh dan unit lolos systemd-analyze (bila tersedia)', () => {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2tp-sh-'));
  try {
    const script = path.join(dir, 'run.sh');
    fs.writeFileSync(script, cfg.renderL2tpRunner(), { mode: 0o755 });
    const syntax = spawnSync('sh', ['-n', script], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const usage = spawnSync('sh', [script, 'bogus'], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Pemakaian/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('l2tp: swanctl.conf hanya dirender bila PSK ada; transport mode UDP 1701', () => {
  const conf = cfg.renderL2tpIpsec(cfg.validateL2tp(l2tpInput({ ipsec_secret: 'Psk-Rahasia_1' })));
  assert.match(conf, /^ {2}raniah-l2tp \{$/m);
  assert.match(conf, /^ {4}version = 1$/m);
  assert.match(conf, /^ {4}remote_addrs = 103\.195\.65\.78$/m);
  assert.match(conf, /mode = transport/);
  assert.match(conf, /local_ts = dynamic\[udp\/1701\]/);
  assert.match(conf, /remote_ts = dynamic\[udp\/1701\]/);
  assert.match(conf, /start_action = none/);
  assert.match(conf, /^ {4}secret = "Psk-Rahasia_1"$/m);
});

test('applyToDisk l2tp: mode berkas, PSK menambah/menghapus swanctl.conf, xl2tpd.conf bawaan dicadangkan sekali', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-test-'));
  try {
    const stock = path.join(root, cfg.PATHS.l2tpdConf);
    fs.mkdirSync(path.dirname(stock), { recursive: true });
    fs.writeFileSync(stock, '; konfigurasi bawaan paket\n');

    const withPsk = cfg.validateL2tp(l2tpInput({ routes: '10.210.0.0/24', ipsec_secret: 'psk-123' }));
    const written = cfg.applyToDisk('l2tp', withPsk, { root, exec: () => {} });
    assert.deepEqual(written, [
      cfg.PATHS.l2tpdConf, cfg.PATHS.l2tpOptions, cfg.PATHS.l2tpRoutes, cfg.PATHS.l2tpHook,
      cfg.PATHS.l2tpRunner, cfg.PATHS.l2tpIpsec, cfg.PATHS.l2tpUnit,
    ]);
    const modeOf = (target) => fs.statSync(path.join(root, target)).mode & 0o777;
    assert.equal(modeOf(cfg.PATHS.l2tpOptions), 0o600, 'berisi password');
    assert.equal(modeOf(cfg.PATHS.l2tpIpsec), 0o600, 'berisi PSK');
    assert.equal(modeOf(cfg.PATHS.l2tpHook), 0o755);
    assert.equal(modeOf(cfg.PATHS.l2tpRunner), 0o755);
    assert.equal(modeOf(cfg.PATHS.l2tpUnit), 0o644);
    assert.equal(fs.readFileSync(`${stock}.pre-raniah`, 'utf8'), '; konfigurasi bawaan paket\n');
    assert.match(fs.readFileSync(stock, 'utf8'), /\[lac raniah-l2tp\]/);

    // Tulis ulang: cadangan asli tidak tertimpa berkas buatan kita.
    cfg.applyToDisk('l2tp', withPsk, { root, exec: () => {} });
    assert.equal(fs.readFileSync(`${stock}.pre-raniah`, 'utf8'), '; konfigurasi bawaan paket\n');

    // PSK dikosongkan = L2TP murni: swanctl.conf dihapus.
    const pure = cfg.validateL2tp(l2tpInput({ clear_ipsec_secret: true }), withPsk);
    const writtenPure = cfg.applyToDisk('l2tp', pure, { root, exec: () => {} });
    assert.equal(writtenPure.includes(cfg.PATHS.l2tpIpsec), false);
    assert.equal(fs.existsSync(path.join(root, cfg.PATHS.l2tpIpsec)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publicProfiles l2tp: password dan IPsec PSK tidak ikut ke browser', () => {
  const pub = publicProfiles({
    l2tp: cfg.validateL2tp(l2tpInput({ routes: '10.210.0.0/24', ipsec_secret: 'psk-sangat-rahasia' })),
  });
  const json = JSON.stringify(pub);
  for (const secretValue of ['rahasia-l2tp', 'psk-sangat-rahasia']) {
    assert.equal(json.includes(secretValue), false, secretValue);
  }
  assert.equal(pub.l2tp.password_set, true);
  assert.equal(pub.l2tp.ipsec_secret_set, true);
  assert.equal(pub.l2tp.routes, '10.210.0.0/24');
  assert.equal(pub.l2tp.server, '103.195.65.78:1701');
  assert.equal(publicProfiles({}).l2tp, null);
  assert.equal(publicProfiles({ l2tp: cfg.validateL2tp(l2tpInput()) }).l2tp.ipsec_secret_set, false);
});

test('connect l2tp: protokol lain di-disable --now + reset-failed, lalu enable --now raniah-l2tp', async () => {
  const system = fakeSystem({
    active: { sstp: 'active', openvpn: 'failed' },
    enabled: { sstp: true },
    ip: { 'raniah-l2tp': '10.210.0.7 peer 10.210.0.1/32' },
  });
  const { service } = serviceWith(system, { isRoot: false });
  const result = await service.connect('l2tp', cfg.validateL2tp(l2tpInput()));
  assert.equal(result.status.connected, true);
  assert.equal(result.status.protocol, 'l2tp');
  assert.equal(result.status.interface, 'raniah-l2tp');
  assert.deepEqual(result.log, []);

  const sudoCalls = system.calls.filter((call) => call.startsWith('sudo -n '));
  const enable = sudoCalls.indexOf('sudo -n systemctl enable --now raniah-l2tp');
  const stopSelf = sudoCalls.indexOf('sudo -n /usr/local/sbin/raniah-vpn-helper cycle l2tp stop');
  for (const protocol of ['wireguard', 'openvpn', 'sstp']) {
    const disable = sudoCalls.indexOf(`sudo -n /usr/local/sbin/raniah-vpn-helper cycle ${protocol} disable`);
    assert.ok(disable >= 0 && disable < enable, `${protocol}\n${sudoCalls.join('\n')}`);
  }
  assert.ok(stopSelf > 0 && stopSelf < enable, sudoCalls.join('\n'));
  assert.equal(sudoCalls.some((call) => call.includes('systemctl restart')), false);
  assert.ok(sudoCalls.includes('sudo -n /usr/local/sbin/raniah-vpn-helper apply'));
});

test('connect protokol lain: l2tp + xl2tpd ikut di-disable --now dan reset-failed', async () => {
  const system = fakeSystem({
    active: { l2tp: 'active' },
    enabled: { l2tp: true },
    ip: { 'raniah-sstp': '172.16.0.5 peer 172.16.0.1/32' },
  });
  const { service } = serviceWith(system);
  await service.connect('sstp', cfg.validateSstp({ server: 'a.b:9921', username: 'u', password: 'p' }));
  for (const unit of ['raniah-l2tp', 'xl2tpd']) {
    assert.ok(system.calls.includes(`systemctl disable --now ${unit}`), unit);
    assert.ok(system.calls.includes(`systemctl reset-failed ${unit}`), unit);
  }
  assert.ok(system.calls.indexOf('systemctl disable --now raniah-l2tp') < system.calls.indexOf('systemctl disable --now xl2tpd'));
});

test('disconnect l2tp: disable --now raniah-l2tp dan xl2tpd', async () => {
  const system = fakeSystem({ active: { l2tp: 'active' }, enabled: { l2tp: true } });
  const { service } = serviceWith(system);
  const { status } = await service.disconnect('l2tp');
  assert.ok(system.calls.includes('systemctl disable --now raniah-l2tp'));
  assert.ok(system.calls.includes('systemctl reset-failed raniah-l2tp'));
  assert.ok(system.calls.includes('systemctl disable --now xl2tpd'));
  assert.equal(status.state, 'disconnected');
});

test('connect l2tp: unit belum pernah dibuat (disable gagal) tidak membuat protokol lain gagal', async () => {
  const system = fakeSystem({ ip: { 'wg-billing': '10.10.99.2/24' } });
  const failingRun = async (file, args) => {
    if (args.includes('disable') && args.some((a) => a === 'raniah-l2tp' || a === 'xl2tpd')) {
      return { ok: false, code: 1, stdout: '', stderr: 'Failed to disable unit: Unit file raniah-l2tp.service does not exist.' };
    }
    return system.run(file, args);
  };
  const { service } = serviceWith(system, { run: failingRun });
  const result = await service.connect('wireguard', cfg.validateWireguard(wgInput()));
  assert.equal(result.protocol, 'wireguard');
});

test('connect l2tp: /dev/ppp tidak ada -> 503 petunjuk LXC, unit dimatikan, konfigurasi tidak ditulis', async () => {
  const system = fakeSystem({ active: { l2tp: 'active' }, enabled: { l2tp: true } });
  const { service, applied } = serviceWith(system, { existsSync: (file) => file !== '/dev/ppp' });

  const status = await service.getStatus();
  assert.equal(status.tools.l2tp.device_missing, '/dev/ppp');
  assert.match(status.tools.l2tp.device_hint, /^L2TP butuh \/dev\/ppp/);
  assert.match(status.tools.l2tp.device_hint, /ppp_async/);

  await assert.rejects(
    () => service.connect('l2tp', cfg.validateL2tp(l2tpInput())),
    (error) => error.status === 503 && /\/dev\/ppp/.test(error.message) && /lxc\.cgroup2\.devices\.allow/.test(error.message) && /Privileged/.test(error.message),
  );
  assert.ok(system.calls.includes('systemctl disable --now raniah-l2tp'));
  assert.equal(system.calls.some((call) => call.includes('enable --now raniah-l2tp')), false);
  assert.deepEqual(applied, []);
});

test('connect l2tp: paket belum terpasang -> 503; PSK diisi tanpa swanctl -> 503 dengan petunjuk strongSwan', async () => {
  const noXl2tpd = serviceWith(fakeSystem(), { existsSync: (file) => !file.endsWith('/xl2tpd') && !file.endsWith('/xl2tpd-control') }).service;
  await assert.rejects(
    () => noXl2tpd.connect('l2tp', cfg.validateL2tp(l2tpInput())),
    (error) => error.status === 503 && /apt install -y xl2tpd ppp/.test(error.message),
  );

  const noSwanctl = serviceWith(fakeSystem(), { existsSync: (file) => !file.endsWith('/swanctl') }).service;
  const status = await noSwanctl.getStatus();
  assert.equal(status.tools.l2tp.installed, true, 'IPsec opsional: tidak mempengaruhi installed');
  assert.equal(status.tools.l2tp.ipsec_installed, false);
  assert.equal(status.tools.l2tp.ipsec_hint, 'apt install -y strongswan-swanctl charon-systemd');
  await assert.rejects(
    () => noSwanctl.connect('l2tp', cfg.validateL2tp(l2tpInput({ ipsec_secret: 'psk' }))),
    (error) => error.status === 503 && /strongSwan/.test(error.message) && /strongswan-swanctl/.test(error.message),
  );
  // L2TP murni tidak butuh swanctl.
  const pure = await noSwanctl.connect('l2tp', cfg.validateL2tp(l2tpInput()));
  assert.equal(pure.protocol, 'l2tp');
});

test('connect l2tp: belum dapat IP -> 20 baris journalctl -u raniah-l2tp -u xl2tpd (sudo bila bukan root)', async () => {
  const journal = [
    '-- Journal begins --',
    ...Array.from({ length: 24 }, (_, i) => `Nov 21 17:00:${String(i).padStart(2, '0')} Bil xl2tpd[1]: baris ${i}`),
    'Nov 21 17:00:59 Bil pppd[2]: peer password=rahasia123 ditolak',
    '',
  ].join('\n');
  const system = fakeSystem({ journal });
  const { service } = serviceWith(system, { isRoot: false });
  const result = await service.connect('l2tp', cfg.validateL2tp(l2tpInput()));
  assert.equal(result.status.connected, false);
  assert.equal(result.log.length, 20);
  assert.match(result.log[19], /password=\*\*\*/);
  assert.doesNotMatch(result.log.join('\n'), /rahasia123/);
  assert.ok(system.calls.includes('sudo -n journalctl -u raniah-l2tp -u xl2tpd -n 20 --no-pager'), system.calls.join('\n'));
});

test('connect l2tp: tunggu 12 detik tanpa IPsec, 15 detik dengan IPsec', async () => {
  for (const [extra, expected] of [[{}, 12], [{ ipsec_secret: 'psk' }, 15]]) {
    const sleeps = [];
    const { service } = serviceWith(fakeSystem(), { sleep: async (ms) => sleeps.push(ms) });
    await service.connect('l2tp', cfg.validateL2tp(l2tpInput(extra)));
    assert.equal(sleeps.length, expected, JSON.stringify(extra));
  }
});

test('monitoring l2tp: RX/TX dari /sys/class/net/raniah-l2tp, dual ping server CHR + gateway .1 dinamis', async () => {
  const reads = [];
  const system = fakeSystem({ active: { l2tp: 'active' }, ip: { 'raniah-l2tp': '10.210.0.7 peer 10.210.0.1/32' } });
  const { service } = serviceWith(system, {
    readText: (file) => {
      reads.push(file);
      if (file === '/proc/uptime') return '9000.5 100\n';
      return file.endsWith('/rx_bytes') ? '2048\n' : '4096\n';
    },
  });
  const status = await service.getStatus();
  assert.equal(status.state, 'connected');
  assert.equal(status.interface, 'raniah-l2tp');
  assert.ok(reads.includes('/sys/class/net/raniah-l2tp/statistics/rx_bytes'), reads.join('\n'));
  assert.equal(status.traffic.rx_bytes, 2048);
  assert.equal(status.traffic.tx_bytes, 4096);

  assert.equal(publicPingTarget('l2tp', { server: '103.195.65.78:1701' }), '103.195.65.78');
  assert.equal(publicPingTarget('l2tp', { server: 'chr.contoh.net:1701' }), 'chr.contoh.net');
  assert.equal(publicPingTarget('l2tp', null), null);
  assert.equal(tunnelPingTarget('l2tp', { server: 'x', routes: '192.168.88.0/24' }, '10.210.0.7'), '10.210.0.1');
  assert.equal(tunnelPingTarget('l2tp', { routes: '192.168.88.0/24' }, null), null, 'route NAS bukan gateway tunnel');

  const pinged = [];
  const pingService = createVpnService({
    isRoot: true,
    existsSync: () => true,
    run: async (file, args) => {
      if (file === 'ping') {
        pinged.push(args[args.length - 1]);
        return { ok: true, code: 0, stdout: 'time=9.5 ms\n', stderr: '' };
      }
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  });
  const ping = await pingService.measurePing('l2tp', { server: '103.195.65.78:1701' }, '10.210.0.7');
  assert.deepEqual([ping.public.target, ping.tunnel.target], ['103.195.65.78', '10.210.0.1']);
  assert.equal(ping.tunnel.status, 'ok');
  assert.deepEqual(pinged.sort(), ['10.210.0.1', '103.195.65.78']);
});

test('diagnoseLog l2tp: IPsec, jaringan, dan kredensial dibedakan dengan teks khusus L2TP', () => {
  const { diagnoseLog } = require('../backend/vpn');
  assert.equal(diagnoseLog(['charon-systemd: received NO_PROPOSAL_CHOSEN error notify'], 'l2tp').code, 'ipsec');
  assert.equal(diagnoseLog(['IPsec gagal: negosiasi IKE/ESP ke CHR tidak berhasil.'], 'l2tp').code, 'ipsec');
  assert.equal(diagnoseLog(['charon: giving up after 5 retransmits', 'initiate failed: timed out'], 'l2tp').code, 'ipsec');
  const network = diagnoseLog(['xl2tpd[1]: Maximum retries exceeded for tunnel 1234. Closing.'], 'l2tp');
  assert.equal(network.code, 'network');
  assert.match(network.text, /UDP 1701/);
  const auth = diagnoseLog(['pppd[2]: CHAP authentication failed'], 'l2tp');
  assert.equal(auth.code, 'auth');
  assert.match(auth.text, /service=l2tp/);
  assert.equal(diagnoseLog(['pppd: Couldn\'t open the /dev/ppp device'], 'l2tp').code, 'device');
  assert.equal(diagnoseLog(['SSL_connect: handshake failure'], 'l2tp'), null, 'TLS hanya untuk SSTP');
  // Tanpa protokol, perilaku SSTP lama tetap.
  assert.equal(diagnoseLog(['SSL_connect: handshake failure']).code, 'tls');
  assert.match(diagnoseLog(['pppd[2]: CHAP authentication failed']).text, /service=sstp/);
});

test('sudoers: semua perintah sudo yang dikeluarkan service tercakup di deploy/sudoers.d-billing', async () => {
  const sudoers = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'sudoers.d-billing'), 'utf8');
  const allowed = new Set(
    sudoers.split('\n').map((line) => line.trim().replace(/[,\s\\]+$/, '')).filter((line) => line.startsWith('/')),
  );
  const toSudoers = (call) => {
    const [, , bin, ...args] = call.split(' ');
    const full = bin.startsWith('/') ? bin : `/usr/bin/${bin}`;
    return [full, ...args].join(' ');
  };
  const cases = {
    wireguard: cfg.validateWireguard(wgInput()),
    openvpn: cfg.validateOpenvpn({ ovpn_config: 'client\nremote a.b 1194\n' }),
    sstp: cfg.validateSstp({ server: 'a.b:9921', username: 'u', password: 'p' }),
    l2tp: cfg.validateL2tp(l2tpInput({ ipsec_secret: 'psk' })),
  };
  const missing = new Set();
  for (const protocol of cfg.PROTOCOLS) {
    // Tanpa interface ber-IP: connect berakhir "belum tersambung" dan membaca journal.
    const system = fakeSystem({ journal: 'baris\n', wg: 'x' });
    const { service } = serviceWith(system, { isRoot: false });
    await service.getStatus();
    await service.connect(protocol, cases[protocol]);
    await service.restart(protocol, cases[protocol], { selectedProtocol: protocol });
    await service.disconnect(protocol);
    for (const call of system.calls.filter((item) => item.startsWith('sudo -n '))) {
      if (!allowed.has(toSudoers(call))) missing.add(toSudoers(call));
    }
  }
  assert.deepEqual([...missing], [], `perintah sudo belum ada di sudoers.d-billing:\n${[...missing].join('\n')}`);
});

test('helper menolak payload l2tp berbahaya tanpa menulis apa pun', () => {
  const { spawnSync } = require('child_process');
  const helper = path.join(__dirname, '..', 'deploy', 'raniah-vpn-helper.js');
  const attempt = (config) => spawnSync(process.execPath, [helper, 'apply'], {
    input: JSON.stringify({ protocol: 'l2tp', config }),
    encoding: 'utf8',
  });
  const server = attempt(l2tpInput({ server: 'a.b;reboot' }));
  assert.notEqual(server.status, 0);
  assert.match(server.stderr, /Server CHR tidak valid/);
  const psk = attempt(l2tpInput({ ipsec_secret: 'x"; } evil { "' }));
  assert.notEqual(psk.status, 0);
  assert.match(psk.stderr, /IPsec Pre-Shared Key/);
});

test('route: simpan l2tp divalidasi (400) dan config mengembalikan slot l2tp kosong', async () => {
  await withServer(async (call) => {
    const bad = await call('POST', '/save', 'admin', { protocol: 'l2tp', config: l2tpInput({ server: 'a.b;reboot' }) });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'server');
    const noPort = await call('POST', '/save', 'admin', { protocol: 'l2tp', config: l2tpInput({ server: 'a.b:9999' }) });
    assert.equal(noPort.status, 400);
    assert.match(noPort.body.message, /UDP 1701/);
    const config = await call('GET', '/config', 'admin');
    assert.equal(config.status, 200);
    assert.ok('l2tp' in config.body.profiles);
  });
});

test('install.sh: sysctl tuning VPN ditulis ke /etc/sysctl.d/99-raniah-vpn.conf dengan fallback aman', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
  assert.match(installer, /\/etc\/sysctl\.d\/99-raniah-vpn\.conf/);
  for (const line of [
    'net.core.rmem_max=26214400', 'net.core.wmem_max=26214400', 'net.ipv4.udp_rmem_min=16384',
    'net.ipv4.udp_wmem_min=16384', 'net.ipv4.tcp_mtu_probing=1', 'net.ipv4.conf.all.rp_filter=2',
  ]) {
    assert.ok(installer.includes(`\n${line}\n`), line);
  }
  assert.match(installer, /sysctl --system/);
  // Kegagalan satu parameter (LXC read-only) hanya memicu fallback, tidak menghentikan installer (set -e).
  assert.match(installer, /if ! \$SUDO sysctl --system/);
  assert.match(installer, /sysctl -w "\$\{SYSCTL_KEY\}=\$\{SYSCTL_VAL\}"[^\n]*\|\| SYSCTL_DENIED/);
});

test('install.sh: UFW hanya port yang dibutuhkan, tanpa port inbound VPN, SSH tidak pernah diputus', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
  const block = installer
    .slice(installer.indexOf('info "=== UFW ==="'), installer.indexOf('$SUDO ufw reload'))
    .split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert.ok(block.length > 200, 'blok UFW ditemukan');
  const allowed = [...block.matchAll(/ufw allow\s+("?[^\s"]+"?)/g)].map((m) => m[1].replace(/"/g, ''));
  assert.deepEqual(allowed.sort(), [
    '${APP_PORT}/tcp', '${GENIEACS_CWMP_PORT}/tcp', '${GENIEACS_FS_PORT}/tcp', '${GENIEACS_NBI_PORT}/tcp',
    '${GENIEACS_UI_PORT}/tcp', '1812/udp', '1813/udp', '443/tcp', '80/tcp', 'OpenSSH', 'from',
  ].sort());
  assert.doesNotMatch(block, /\b(1194|1701|4500|51820|9921|9929)\b|\b500\/udp/);
  assert.match(block, /ufw default deny incoming/);
  assert.match(block, /ufw default allow outgoing/);
  // SSH harus diizinkan sebelum ufw enable, dan reload dijalankan setelahnya.
  assert.ok(block.indexOf('ufw allow OpenSSH') > -1 && block.indexOf('ufw allow OpenSSH') < block.indexOf('ufw --force enable'));
  assert.ok(block.indexOf('ufw --force enable') < installer.indexOf('$SUDO ufw reload'));
  // Subnet VPN wajib divalidasi prefix >= /16 sebelum dipakai.
  assert.match(installer, /VPN_SUBNET="\$\{VPN_SUBNET-10\.210\.0\.0\/24\}"/);
  assert.match(block, />= 16 && 10#\$\{BASH_REMATCH\[6\]\} <= 32/);
  assert.doesNotMatch(block, /ufw (delete|reset)/);
});

test('wg server: subnet, alokasi IP peer, conf tanpa PostUp, script RouterOS', () => {
  const pair = cfg.generateKeypair();
  const server = cfg.validateServer({
    public_endpoint: 'vpn.contoh.net',
    listen_port: 51820,
    address: '10.220.0.1/24',
    private_key: pair.private_key,
  });
  assert.equal(server.public_key, pair.public_key);
  assert.equal(server.network, '10.220.0.0/24');
  assert.equal(server.mtu, 1380);
  rejects(() => cfg.validateServer({ ...server, public_endpoint: 'vpn.contoh.net;id' }), /Endpoint publik/);
  rejects(() => cfg.validateServer({ ...server, address: '10.220.0.0/24' }), /network atau broadcast/);
  rejects(() => cfg.validateServer({ ...server, address: '0.0.0.0/0' }), /Subnet server/);

  assert.equal(cfg.allocatePeerAddress(server.address, []), '10.220.0.2/32');
  assert.equal(cfg.allocatePeerAddress(server.address, ['10.220.0.2/32']), '10.220.0.3/32');

  const peer = cfg.validatePeer({ name: 'NAS Pusat', generate_psk: true }, null);
  const conf = cfg.renderWgServer(server, [{ ...peer, address: '10.220.0.2/32', enabled: true }]);
  assert.match(conf, /^Address = 10\.220\.0\.1\/24$/m);
  assert.match(conf, /^ListenPort = 51820$/m);
  assert.match(conf, /^MTU = 1380$/m);
  assert.match(conf, new RegExp(`^AllowedIPs = 10\\.220\\.0\\.2/32$`, 'm'));
  assert.doesNotMatch(conf, /PostUp|PostDown|vpn\.contoh\.net/);
  assert.equal(conf.includes(peer.private_key), false);

  const script = cfg.renderMikrotikScript(server, { ...peer, address: '10.220.0.2/32', radius_secret: 'Abcd1234SecretValue1234' });
  assert.match(script, /persistent-keepalive=15s/);
  assert.match(script, /endpoint-address=vpn\.contoh\.net endpoint-port=51820/);
  assert.match(script, /address=10\.220\.0\.2\/24/);
  assert.match(script, /comment="Auto by Billing"/);
  assert.match(script, /\/radius add service=ppp,hotspot address=10\.220\.0\.1 secret="Abcd1234SecretValue1234" timeout=3000ms src-address=10\.220\.0\.2 comment="Auto by Billing"/);
  assert.match(script, /\/radius incoming set accept=yes port=3799/);
  assert.match(script, /\/ppp aaa set use-radius=yes accounting=yes interim-update=5m/);
  assert.equal(script.includes('# /radius'), false);
  assert.equal(script.includes(peer.private_key), true);
  assert.equal(script.includes(server.private_key), false);
  rejects(() => cfg.validatePeer({ name: 'nas;id' }), /Nama router/);
});

test('cycle server: matikan client dulu, enable wg-server, buka UFW; start dibatalkan bila interface masih ada', async () => {
  const calls = [];
  const conf = '[Interface]\nAddress = 10.220.0.1/24\nListenPort = 51820\n';
  await cfg.cycleVpn('server', 'start', {
    sleep: async () => {},
    readText: (file) => (String(file).endsWith('wg-server.conf') ? conf : ''),
    writeText: (file, content) => calls.push(`write ${file} ${content.trim()}`),
    exec: async (file, args) => {
      calls.push([file, ...args].join(' '));
      if (file === 'ip' && args[1] === 'show') return { ok: false, code: 1, stdout: '', stderr: 'gone' };
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  });
  const enableAt = calls.indexOf('systemctl enable --now wg-quick@wg-server');
  assert.ok(enableAt > calls.indexOf('systemctl disable --now wg-quick@wg-billing'), calls.join('\n'));
  assert.ok(enableAt > calls.indexOf('systemctl disable --now openvpn-client@raniah-vpn'));
  assert.ok(enableAt > calls.indexOf('systemctl disable --now raniah-sstp'));
  assert.ok(enableAt > calls.indexOf('systemctl disable --now raniah-l2tp'));
  assert.ok(calls.indexOf('ufw allow 51820/udp comment WireGuard VPN server') > enableAt);
  assert.ok(calls.includes('ufw allow from 10.220.0.0/24 comment Subnet VPN server'));
  assert.equal(calls.some((call) => call === 'systemctl start wg-quick@wg-server'), false);

  const blocked = [];
  await assert.rejects(
    () => cfg.cycleVpn('server', 'restart', {
      sleep: async () => {},
      readText: () => conf,
      writeText: () => {},
      exec: async (file, args) => {
        blocked.push([file, ...args].join(' '));
        if (file === 'ip' && args[0] === 'link' && args[1] === 'show' && args[2] === 'wg-server') {
          return { ok: true, code: 0, stdout: 'still', stderr: '' };
        }
        if (file === 'ip' && args[1] === 'show') return { ok: false, code: 1, stdout: '', stderr: 'gone' };
        return { ok: true, code: 0, stdout: '', stderr: '' };
      },
    }),
    /masih ada/,
  );
  assert.equal(blocked.includes('systemctl start wg-quick@wg-server'), false);
  assert.equal(blocked.some((call) => call.startsWith('ufw allow')), false);
});

test('openvpn server: conf ROS v6, IP statis, script, dan rahasia tidak masuk daftar peer', () => {
  const server = cfg.validateOvpnServer({
    public_endpoint: 'vpn.contoh.net',
    listen_port: 1194,
    network: '10.221.0.0/24',
  }, { avoidCidr: '10.220.0.1/24' });
  const conf = cfg.renderOvpnServer(server);
  assert.match(conf, /^proto tcp-server$/m);
  assert.match(conf, /^port 1194$/m);
  assert.match(conf, /^dev tun-ovpn-srv$/m);
  assert.match(conf, /^topology subnet$/m);
  assert.match(conf, /^server 10\.221\.0\.0 255\.255\.255\.0$/m);
  assert.match(conf, /^cipher AES-256-CBC$/m);
  assert.match(conf, /^data-ciphers AES-256-CBC$/m);
  assert.match(conf, /^auth SHA1$/m);
  assert.match(conf, /^tls-version-min 1\.0$/m);
  assert.match(conf, /^tls-cipher DEFAULT:@SECLEVEL=0$/m);
  assert.match(conf, /^verify-client-cert none$/m);
  assert.match(conf, /^username-as-common-name$/m);
  assert.match(conf, /^status-version 2$/m);
  assert.match(conf, /status \/run\/openvpn-server\/status-raniah\.log 5/);

  const first = cfg.allocateOvpnAddress(server.network, []);
  const second = cfg.allocateOvpnAddress(server.network, [first]);
  assert.equal(first, '10.221.0.2');
  assert.equal(second, '10.221.0.3');
  const peer = cfg.validateOvpnPeer({ name: 'NAS Kantor', username: 'nas-kantor', password: 'Rahasia123' });
  const script = cfg.renderOvpnMikrotikScript(server, { ...peer, address: first, radius_secret: 'Abcd1234SecretValue1234' });
  assert.match(script, /\/interface ovpn-client add name=ovpn-raniah connect-to=vpn\.contoh\.net port=1194 mode=ip user=nas-kantor password=Rahasia123 cipher=aes256 auth=sha1 add-default-route=no/);
  assert.match(script, /comment="Auto by Billing"/);
  assert.match(script, /\/radius add service=ppp,hotspot address=10\.221\.0\.1 secret="Abcd1234SecretValue1234" timeout=3000ms src-address=10\.221\.0\.2 comment="Auto by Billing"/);
  assert.match(script, /\/radius incoming set accept=yes port=3799/);
  assert.match(script, /\/ppp aaa set use-radius=yes accounting=yes interim-update=5m/);
  assert.equal(script.includes('# /radius'), false);
  const generated = cfg.generateRadiusSecret();
  assert.match(generated, /^[A-Za-z0-9]{24}$/);

  const withIp = cfg.renderChrMikrotikScript({
    name: 'RB KONTE',
    radiusAddress: '10.210.0.2',
    secret: 'Abcd1234SecretValue1234',
    nasIp: '10.210.0.3',
  });
  assert.match(withIp, /\/radius add service=ppp,hotspot address=10\.210\.0\.2 secret="Abcd1234SecretValue1234" timeout=3000ms src-address=10\.210\.0\.3 comment="Auto by Billing"/);
  assert.match(withIp, /\/radius incoming set accept=yes port=3799/);
  assert.match(withIp, /\/ppp aaa set use-radius=yes accounting=yes interim-update=5m/);
  assert.match(withIp, /:do \{ \/ip hotspot profile set \[find\] use-radius=yes \} on-error=\{\}/);
  const noIp = cfg.renderChrMikrotikScript({
    name: 'RB NAPA', radiusAddress: '10.210.0.249', secret: 'Abcd1234SecretValue1234', nasIp: '',
  });
  assert.match(noIp, /address=10\.210\.0\.249 secret="Abcd1234SecretValue1234" timeout=3000ms comment="Auto by Billing"/);
  assert.equal(noIp.includes('src-address='), false);
  rejects(() => cfg.validateChrNas({ nama_router: 'nas;id', ip_vpn_nas: '10.210.0.3' }), /Nama router/);
  rejects(() => cfg.validateChrNas({ nama_router: 'RB KONTE', ip_vpn_nas: '10.210.0.3/32' }), /IP VPN NAS/);
  rejects(() => cfg.validateOvpnServer({ network: '10.220.0.0/24' }, { avoidCidr: '10.220.0.1/24' }), /bentrok/);
  rejects(() => cfg.validateOvpnPeer({ name: 'nas', username: '../etc', password: 'Rahasia123' }), /Username/);

  const view = presentOvpnServer({
    server,
    peers: [{ id: 1, name: peer.name, username: peer.username, password: 'Rahasia123', address: first, enabled: true }],
  }, { peers: [] });
  assert.equal(JSON.stringify(view).includes('Rahasia123'), false);
  assert.equal(view.peers[0].password_set, true);
  assert.equal(view.server.server_ip, '10.221.0.1');

  const live = parseOvpnStatus('CLIENT_LIST,nas-kantor,1.2.3.4:9,10.221.0.2,,100,200,now,1,nas-kantor,1,0,AES-256-CBC\n');
  assert.equal(live[0].username, 'nas-kantor');
  assert.equal(live[0].rx_bytes, 100);
  assert.equal(live[0].tx_bytes, 200);
});

test('openvpn server: berkas kredensial 600, ccd ifconfig-push, peer nonaktif tidak bisa login', () => {
  const { spawnSync } = require('child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ovpn-srv-'));
  try {
    const server = cfg.validateOvpnServer({ public_endpoint: '203.0.113.10', network: '10.221.0.0/24' });
    const peers = [
      { ...cfg.validateOvpnPeer({ name: 'A', username: 'nas-a', password: 'Password11' }), address: '10.221.0.2', enabled: true },
      { ...cfg.validateOvpnPeer({ name: 'B', username: 'nas-b', password: 'Password22' }), address: '10.221.0.3', enabled: false },
    ];
    cfg.applyOvpnServerToDisk(server, peers, { root, exec: () => {}, existsSync: () => true });
    const modeOf = (target) => fs.statSync(path.join(root, target)).mode & 0o777;
    assert.match(fs.readFileSync(path.join(root, cfg.PATHS.ovpnServerOverride), 'utf8'), /LimitNPROC=infinity\nTasksMax=infinity/);
    assert.equal(modeOf(cfg.PATHS.ovpnServerAuth), 0o755);
    assert.equal(modeOf(`${cfg.PATHS.ovpnServerUsers}/nas-a`), 0o600);
    assert.equal(fs.existsSync(path.join(root, cfg.PATHS.ovpnServerUsers, 'nas-b')), false);
    assert.match(fs.readFileSync(path.join(root, cfg.PATHS.ovpnServerCcd, 'nas-a'), 'utf8'), /^ifconfig-push 10\.221\.0\.2 255\.255\.255\.0/);
    assert.equal(fs.existsSync(path.join(root, cfg.PATHS.ovpnServerCcd, 'nas-b')), false);
    const script = path.join(root, cfg.PATHS.ovpnServerAuth);
    assert.equal(spawnSync('sh', ['-n', script], { encoding: 'utf8' }).status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cycle ovpn-server: matikan client, biarkan wg-server, buka UFW TCP', async () => {
  const calls = [];
  const conf = 'port 1194\nserver 10.221.0.0 255.255.255.0\n';
  await cfg.cycleVpn('ovpn-server', 'start', {
    sleep: async () => {},
    readText: (file) => (String(file).endsWith('raniah-server.conf') ? conf : ''),
    writeText: () => {},
    exec: async (file, args) => {
      calls.push([file, ...args].join(' '));
      if (file === 'ip' && args[1] === 'show') return { ok: false, code: 1, stdout: '', stderr: 'gone' };
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  });
  const enableAt = calls.indexOf('systemctl enable --now openvpn-server@raniah-server');
  const reloadAt = calls.indexOf('systemctl daemon-reload');
  assert.ok(reloadAt >= 0 && reloadAt < enableAt, calls.join('\n'));
  assert.ok(enableAt > calls.indexOf('systemctl disable --now wg-quick@wg-billing'));
  assert.ok(enableAt > calls.indexOf('systemctl disable --now openvpn-client@raniah-vpn'));
  assert.ok(enableAt > calls.indexOf('systemctl disable --now raniah-sstp'));
  assert.ok(enableAt > calls.indexOf('systemctl disable --now raniah-l2tp'));
  assert.equal(calls.some((call) => call.includes('wg-quick@wg-server')), false);
  assert.ok(calls.includes('ufw allow 1194/tcp comment OpenVPN VPN server'));
  assert.ok(calls.includes('ufw allow from 10.221.0.0/24 comment Subnet OpenVPN server'));
});

