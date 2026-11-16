const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ISOLIR_PROFILE,
  ROUTEROS_API_PORT,
  setIsolir,
  kickSession,
} = require('../utils/mikrotik');

test('konstanta profil isolir dan port API', () => {
  assert.equal(ISOLIR_PROFILE, 'profil_isolir');
  assert.equal(ROUTEROS_API_PORT, 8728);
});

test('setIsolir menolak argumen kosong tanpa koneksi', async () => {
  const result = await setIsolir('', 'admin', 'pass', 'user1');
  assert.equal(result.ok, false);
  assert.match(result.error, /Host router wajib/i);
});

test('kickSession menolak username kosong', async () => {
  const result = await kickSession('10.0.0.1', 'admin', 'pass', '');
  assert.equal(result.ok, false);
  assert.match(result.error, /Username PPPoE wajib/i);
});
