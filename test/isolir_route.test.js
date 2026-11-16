const test = require('node:test');
const assert = require('node:assert/strict');
const isolirRoute = require('../backend/routes/isolir');

test('modul route isolir mengekspor handler dan router', () => {
  assert.equal(typeof isolirRoute.handleIsolir, 'function');
  assert.equal(typeof isolirRoute.handleBukaIsolir, 'function');
  assert.equal(typeof isolirRoute.bukaIsolirRouter, 'function');
});
