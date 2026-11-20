const test = require('node:test');
const assert = require('node:assert/strict');
const { commandFor } = require('../backend/privileged');

test('commandFor memakai sudo -n saat bukan root dan perintah langsung saat root', () => {
  const asUser = commandFor('systemctl', ['restart', 'freeradius']);
  const asRoot = commandFor('systemctl', ['restart', 'freeradius']);
  assert.deepEqual(asRoot.args.slice(-2), ['restart', 'freeradius']);

  // Bandingkan langsung dengan perilaku berdasarkan uid proses uji.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  assert.equal(asUser.file, isRoot ? 'systemctl' : 'sudo');
  if (!isRoot) {
    assert.deepEqual(asUser.args, ['-n', 'systemctl', 'restart', 'freeradius']);
  }
});
