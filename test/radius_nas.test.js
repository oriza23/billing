const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MANAGED_PREFIX, routerProblem, planNasSync, isValidIpv4, syncNasFromRouters,
} = require('../backend/radius_nas');

const router = (over = {}) => ({
  id: 1, nama_router: 'RB-A', ip_address: '10.0.0.1', secret: 'rahasia', status: 'Aktif', ...over,
});

test('isValidIpv4 menolak hostname, CIDR, dan IPv6', () => {
  assert.equal(isValidIpv4('192.168.1.1'), true);
  assert.equal(isValidIpv4('192.168.1.0/24'), false);
  assert.equal(isValidIpv4('router.local'), false);
  assert.equal(isValidIpv4('::1'), false);
  assert.equal(isValidIpv4(''), false);
});

test('routerProblem: status, IP, secret kosong, secret terlalu panjang', () => {
  assert.equal(routerProblem(router()), '');
  assert.match(routerProblem(router({ status: 'Nonaktif' })), /tidak aktif/i);
  assert.match(routerProblem(router({ ip_address: 'abc' })), /IPv4/);
  assert.match(routerProblem(router({ secret: '' })), /kosong/i);
  assert.match(routerProblem(router({ secret: 'x'.repeat(61) })), /60/);
  assert.equal(routerProblem(router({ secret: 'x'.repeat(60) })), '');
});

test('planNasSync: router baru -> insert dengan penanda billing-router:<id>', () => {
  const plan = planNasSync([router()], []);
  assert.equal(plan.inserts.length, 1);
  assert.deepEqual(plan.inserts[0], {
    router_id: 1, nasname: '10.0.0.1', shortname: 'RB-A', secret: 'rahasia', description: `${MANAGED_PREFIX}1`,
  });
  assert.equal(plan.updates.length + plan.deletes.length, 0);
});

test('planNasSync: tanpa perubahan -> unchanged, idempoten', () => {
  const nas = [{ id: 7, nasname: '10.0.0.1', shortname: 'RB-A', secret: 'rahasia', description: `${MANAGED_PREFIX}1` }];
  const plan = planNasSync([router()], nas);
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.inserts.length + plan.updates.length + plan.deletes.length, 0);
});

test('planNasSync: ganti IP atau secret -> update baris yang sama', () => {
  const nas = [{ id: 7, nasname: '10.0.0.1', shortname: 'RB-A', secret: 'lama', description: `${MANAGED_PREFIX}1` }];
  const plan = planNasSync([router({ ip_address: '10.0.0.9' })], nas);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, 7);
  assert.equal(plan.updates[0].nasname, '10.0.0.9');
  assert.equal(plan.updates[0].secret, 'rahasia');
});

test('planNasSync: router dihapus atau nonaktif -> baris terkelola dihapus', () => {
  const nas = [{ id: 7, nasname: '10.0.0.1', shortname: 'RB-A', secret: 'rahasia', description: `${MANAGED_PREFIX}1` }];
  assert.equal(planNasSync([], nas).deletes.length, 1);
  const plan = planNasSync([router({ status: 'Nonaktif' })], nas);
  assert.equal(plan.deletes.length, 1);
  assert.equal(plan.skipped.length, 1);
});

test('planNasSync: baris nas manual tidak pernah diubah atau dihapus', () => {
  const nas = [{ id: 3, nasname: '172.16.0.1', shortname: 'manual', secret: 's', description: 'RADIUS Client' }];
  const plan = planNasSync([], nas);
  assert.equal(plan.deletes.length, 0);
});

test('planNasSync: IP bentrok dengan baris manual atau antar-router dilewati', () => {
  const nas = [{ id: 3, nasname: '10.0.0.1', shortname: 'manual', secret: 's', description: 'RADIUS Client' }];
  const a = planNasSync([router()], nas);
  assert.equal(a.inserts.length, 0);
  assert.match(a.skipped[0].reason, /manual/);

  const b = planNasSync([router({ id: 1 }), router({ id: 2, nama_router: 'RB-B' })], []);
  assert.equal(b.inserts.length, 1);
  assert.equal(b.inserts[0].router_id, 1);
  assert.match(b.skipped[0].reason, /router id 1/);
});

test('planNasSync: shortname dipotong 32 karakter', () => {
  const plan = planNasSync([router({ nama_router: 'N'.repeat(80) })], []);
  assert.equal(plan.inserts[0].shortname.length, 32);
});

test('syncNasFromRouters: menerapkan plan lewat transaksi dan rollback bila gagal', async () => {
  const calls = [];
  let failInsert = false;
  const conn = {
    execute: async (sql) => {
      calls.push(sql.split(' ')[0]);
      if (failInsert && sql.startsWith('INSERT')) throw new Error('boom');
      return [[]];
    },
    beginTransaction: async () => calls.push('BEGIN'),
    commit: async () => calls.push('COMMIT'),
    rollback: async () => calls.push('ROLLBACK'),
    release: () => calls.push('RELEASE'),
  };
  const db = {
    execute: async (sql) => (sql.includes('FROM routers') ? [[router()]] : [[]]),
    getConnection: async () => conn,
  };

  const result = await syncNasFromRouters(db);
  assert.equal(result.inserted, 1);
  assert.deepEqual(calls, ['BEGIN', 'INSERT', 'COMMIT', 'RELEASE']);

  calls.length = 0;
  failInsert = true;
  await assert.rejects(() => syncNasFromRouters(db), /boom/);
  assert.deepEqual(calls, ['BEGIN', 'INSERT', 'ROLLBACK', 'RELEASE']);
});
