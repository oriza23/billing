const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../database');

test('pool memiliki handler error agar restart database tidak mematikan proses', () => {
  assert.ok(pool.listenerCount('error') >= 1);
  assert.doesNotThrow(() => pool.emit('error', new Error('terminating connection due to administrator command')));
});
