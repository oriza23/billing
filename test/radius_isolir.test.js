const test = require('node:test');
const assert = require('node:assert/strict');
const {
  setRadusergroup,
  applyRadiusIsolir,
  applyRadiusNormal,
} = require('../backend/pppoe_isolir/radius_isolir');

function mockDb() {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql, params });
      if (/^UPDATE radusergroup/i.test(sql)) {
        return [{ affectedRows: params[1] === 'new-user' ? 0 : 1 }];
      }
      return [{ affectedRows: 1 }];
    },
  };
}

test('setRadusergroup UPDATE lalu INSERT bila belum ada baris', async () => {
  const db = mockDb();
  const r1 = await setRadusergroup(db, 'existing', 'profil_isolir');
  assert.equal(r1.ok, true);
  assert.match(db.calls[0].sql, /^UPDATE radusergroup/);

  db.calls.length = 0;
  const r2 = await setRadusergroup(db, 'new-user', 'profil_isolir');
  assert.equal(r2.ok, true);
  assert.match(db.calls[0].sql, /^UPDATE radusergroup/);
  assert.match(db.calls[1].sql, /^INSERT INTO radusergroup/);
});

test('applyRadiusIsolir menulis radusergroup dan radreply Mikrotik-Group', async () => {
  const db = mockDb();
  const result = await applyRadiusIsolir(db, 'budi', 'profil_isolir');
  assert.equal(result.ok, true);
  assert.equal(db.calls.filter((c) => /radusergroup/i.test(c.sql)).length, 1);
  assert.equal(db.calls.filter((c) => /radreply/i.test(c.sql)).length, 2);
});

test('applyRadiusNormal mengembalikan grup paket', async () => {
  const db = mockDb();
  const result = await applyRadiusNormal(db, 'budi', 'paket_20mbps');
  assert.equal(result.ok, true);
  assert.deepEqual(db.calls[0].params, ['paket_20mbps', 'budi']);
});
