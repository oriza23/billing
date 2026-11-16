const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_ISOLIR_GROUP } = require('../backend/pppoe_isolir/schema');
const { IsolirError } = require('../backend/pppoe_isolir/isolir_full_radius');

test('konstanta grup isolir default terdefinisi', () => {
  assert.equal(DEFAULT_ISOLIR_GROUP, 'profil_isolir');
});

test('IsolirError membawa status HTTP', () => {
  const error = new IsolirError('tes', 409);
  assert.equal(error.statusCode, 409);
});

// Smoke: modul cron dapat dimuat (node-cron opsional di lingkungan tanpa install).
test('modul cron dapat dimuat', () => {
  assert.doesNotThrow(() => require('../backend/pppoe_isolir/cron'));
});
