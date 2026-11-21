const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeJenis, serverAllowed, serverNameTaken } = require('../backend/router_servers');

test('normalizeJenis: gabungan hotspot + pppoe menjadi both', () => {
  assert.equal(normalizeJenis('hotspot'), 'hotspot');
  assert.equal(normalizeJenis('PPPoE'), 'pppoe');
  assert.equal(normalizeJenis('both'), 'both');
  assert.equal(normalizeJenis('hotspot,pppoe'), 'both');
  assert.equal(normalizeJenis(['pppoe', 'hotspot']), 'both');
  assert.equal(normalizeJenis(['hotspot', 'hotspot']), 'hotspot');
  for (const bad of ['', 'static', [], ['hotspot', 'x'], null, undefined, 5]) {
    assert.equal(normalizeJenis(bad), null, JSON.stringify(bad));
  }
});

test('serverAllowed: server both berlaku untuk hotspot dan pppoe', async () => {
  const seen = [];
  const db = {
    execute: async (sql, params) => {
      seen.push({ sql, params });
      return [[{ id: 1 }]];
    },
  };
  for (const jenis of ['hotspot', 'pppoe']) {
    assert.equal(await serverAllowed(db, { jenis, routerName: 'RB', server: 'SRV' }), true);
  }
  assert.ok(seen.every((item) => /s\.jenis IN \(\?, 'both'\)/.test(item.sql)));
  assert.equal(await serverAllowed(db, { jenis: 'both', server: 'SRV' }), false);
  assert.equal(await serverAllowed(db, { jenis: 'hotspot', server: 'ALL SERVER' }), true);
});

test('serverNameTaken: both bentrok dengan semua jenis, hotspot dengan hotspot/both', async () => {
  const seen = [];
  const db = { execute: async (sql, params) => { seen.push(params); return [[]]; } };
  await serverNameTaken(db, { routerId: 1, nama: 'A', jenis: 'both' });
  await serverNameTaken(db, { routerId: 1, nama: 'A', jenis: 'hotspot', exceptId: 4 });
  assert.deepEqual(seen[0], [1, 'A', 0, 'hotspot', 'pppoe', 'both']);
  assert.deepEqual(seen[1], [1, 'A', 4, 'hotspot', 'both']);
});
