const test = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizeRequest, summarizeResult, parseUserAgent, classifyAction, entityOf, composeInfo,
} = require('../backend/activity_log');

test('summarizeRequest: sembunyikan field rahasia dan batasi jumlah kunci', () => {
  const summary = summarizeRequest({
    username: 'budi', password: 'rahasia', deviceId: 'ONT-1', ports: ['LAN1', 'LAN2'],
  });
  assert.match(summary, /password=\*\*\*/);
  assert.equal(summary.includes('rahasia'), false);
  assert.match(summary, /username=budi/);
  assert.match(summary, /ports=\[2\]/);
});

test('summarizeRequest: body kosong / bukan objek -> string kosong', () => {
  assert.equal(summarizeRequest(null), '');
  assert.equal(summarizeRequest('teks'), '');
  assert.equal(summarizeRequest([]), '');
});

test('summarizeResult: ringkas pesan, hitungan, dan penanda sebagian', () => {
  const summary = summarizeResult({ message: 'Berhasil', total: 3, berhasil: 2, gagal: 1, partial: true });
  assert.match(summary, /Berhasil/);
  assert.match(summary, /total=3/);
  assert.match(summary, /sebagian/);
});

test('summarizeResult: payload tanpa pesan tetap aman', () => {
  assert.equal(summarizeResult(null), '');
  assert.equal(summarizeResult({}), '');
});

test('parseUserAgent: kenali browser, OS, dan perangkat', () => {
  const desktop = parseUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  );
  assert.equal(desktop.browser, 'Chrome 128');
  assert.equal(desktop.os, 'Windows');
  assert.equal(desktop.device, 'Desktop');

  const mobile = parseUserAgent('Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 Chrome/116.0.0.0 Mobile Safari/537.36');
  assert.equal(mobile.os, 'Android');
  assert.equal(mobile.device, 'Mobile');

  // Edge memuat kata "Chrome" di UA-nya, jadi harus tetap dikenali sebagai Edge.
  const edge = parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0');
  assert.equal(edge.browser, 'Edge 126');

  assert.deepEqual(parseUserAgent(''), { browser: '', os: '', device: '' });
});

test('classifyAction: hapus lewat POST /delete tetap terbaca "hapus"', () => {
  assert.equal(classifyAction('POST', '/api/hotspot/voucher/delete-massal'), 'hapus');
  assert.equal(classifyAction('POST', '/api/acs/delete'), 'hapus');
  assert.equal(classifyAction('POST', '/api/langganan/data'), 'tambah');
  assert.equal(classifyAction('PUT', '/api/admins/budi'), 'edit');
  assert.equal(classifyAction('DELETE', '/api/routers/3'), 'hapus');
  assert.equal(classifyAction('POST', '/api/auth/login'), 'login');
  assert.equal(classifyAction('POST', '/api/sistem/restart-service'), 'restart');
});

test('entityOf: petakan prefix path ke label entitas', () => {
  assert.equal(entityOf('/api/langganan/data'), 'data langganan');
  assert.equal(entityOf('/api/hotspot/voucher/delete-massal'), 'voucher hotspot');
  assert.equal(entityOf('/api/entah/apa'), 'data');
  assert.equal(entityOf('/api/sistem/restart-service'), 'layanan');
});

test('composeInfo: kalimat login memuat platform & kata "Berhasil/Gagal"', () => {
  const ok = composeInfo({
    action: 'login', status: 200, entity: 'aplikasi', subject: '', browser: 'Chrome 128', os: 'Windows', message: '',
  });
  assert.match(ok, /Berhasil login ke aplikasi/);
  assert.match(ok, /Chrome 128 · Windows/);

  const failed = composeInfo({
    action: 'login', status: 401, entity: 'aplikasi', subject: '', browser: '', os: '', message: 'Username atau password salah',
  });
  assert.match(failed, /Gagal login/);
  assert.match(failed, /Username atau password salah/);
});

test('composeInfo: kalimat hapus memuat entitas & subjek', () => {
  const info = composeInfo({
    action: 'hapus', status: 200, entity: 'data langganan', subject: '26000013501', browser: '', os: '', message: 'Langganan dihapus',
  });
  assert.match(info, /Menghapus data langganan: 26000013501/);
  assert.match(info, /Langganan dihapus/);
});

test('audit VPN: save/action tercatat sebagai edit "koneksi VPN" dan rahasia disamarkan', () => {
  assert.equal(classifyAction('POST', '/api/sistem/vpn/save'), 'edit');
  assert.equal(classifyAction('POST', '/api/sistem/vpn/action'), 'edit');
  assert.equal(classifyAction('POST', '/api/sistem/vpn/restart'), 'edit');
  assert.equal(classifyAction('POST', '/api/sistem/vpn/server/action'), 'edit');
  assert.equal(classifyAction('POST', '/api/sistem/vpn/server/save'), 'edit');
  assert.equal(entityOf('/api/sistem/vpn/save'), 'koneksi VPN');
  assert.equal(entityOf('/api/sistem/vpn/action'), 'koneksi VPN');
  assert.equal(entityOf('/api/sistem/vpn/restart'), 'koneksi VPN');

  const summary = summarizeRequest({
    protocol: 'wireguard',
    private_key: 'PRIVKEY-RAHASIA',
    preshared_key: 'PSK-RAHASIA',
    password: 'PASS-RAHASIA',
    ovpn_config: '<secret>RAHASIA</secret>',
    config: { password: 'PASS-RAHASIA' },
  });
  assert.match(summary, /protocol=wireguard/);
  assert.equal(summary.includes('RAHASIA'), false);
});
