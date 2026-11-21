const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RadiusSyncError,
  usesRadius,
  assertUsernameFree,
  writeAccount,
  syncProfileGroup,
  replaceFramedProtocol,
  renameServerBindings,
  nasLockForRouter,
  syncRouterLocks,
} = require('../backend/langganan_radius');

// Database tiruan: mencatat semua statement dan menjawab lookup router/profil.
function fakeDb({ routers = {}, groups = {}, radcheckUsers = [], otherCustomers = [] } = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes('FROM routers')) {
        const ip = routers[params[0]];
        return [ip ? [{ ip_address: ip }] : []];
      }
      if (text.includes('FROM langganan_profiles')) {
        const group = groups[params[0]];
        return [group === undefined ? [] : [{ group_name: group }]];
      }
      if (text.includes('FROM langganan_pelanggan WHERE username')) {
        return [otherCustomers.includes(params[0]) ? [{ id: 99 }] : []];
      }
      if (text.includes('SELECT username FROM radcheck')) {
        return [radcheckUsers.includes(params[0]) ? [{ username: params[0] }] : []];
      }
      return [{ affectedRows: 1 }];
    },
  };
}

function inserted(db, table) {
  return db.calls
    .filter((call) => call.sql.startsWith(`INSERT INTO ${table}`))
    .map((call) => call.params);
}

const baseCustomer = {
  ktg: 'PPP',
  username: 'budi@net',
  password: 'rahasia1',
  profil_id: 5,
  router: 'RB TES',
  server: 'pppoe-service',
  status: 'Aktif',
};

const env = { routers: { 'RB TES': '192.168.223.250' }, groups: { 5: '10-Mbps' } };

test('router dan server tertentu dikunci lewat NAS-IP-Address dan Called-Station-Id', async () => {
  const db = fakeDb(env);
  await writeAccount(db, baseCustomer);

  assert.deepEqual(inserted(db, 'radcheck'), [
    ['budi@net', 'Cleartext-Password', ':=', 'rahasia1'],
    ['budi@net', 'NAS-IP-Address', '==', '192.168.223.250'],
    ['budi@net', 'Called-Station-Id', '==', 'pppoe-service'],
    ['budi@net', 'Framed-Protocol', '==', 'PPP'],
  ]);
  assert.deepEqual(inserted(db, 'radusergroup'), [['budi@net', '10-Mbps']]);
});

test('ALL ROUTER dan ALL SERVER tidak menulis batas apa pun', async () => {
  const db = fakeDb(env);
  await writeAccount(db, { ...baseCustomer, router: 'ALL ROUTER', server: 'ALL SERVER' });

  assert.deepEqual(inserted(db, 'radcheck'), [
    ['budi@net', 'Cleartext-Password', ':=', 'rahasia1'],
    ['budi@net', 'Framed-Protocol', '==', 'PPP'],
  ]);
  assert.equal(db.calls.some((call) => call.sql.includes('FROM routers')), false);
});

test('ALL ROUTER dengan server tertentu hanya membatasi server', async () => {
  const db = fakeDb(env);
  await writeAccount(db, { ...baseCustomer, router: 'ALL ROUTER' });

  assert.deepEqual(inserted(db, 'radcheck').map((row) => row[1]), [
    'Cleartext-Password',
    'Called-Station-Id',
    'Framed-Protocol',
  ]);
});

test('router tertentu dengan ALL SERVER hanya membatasi router', async () => {
  const db = fakeDb(env);
  await writeAccount(db, { ...baseCustomer, server: 'ALL SERVER' });

  assert.deepEqual(inserted(db, 'radcheck').map((row) => row[1]), [
    'Cleartext-Password',
    'NAS-IP-Address',
    'Framed-Protocol',
  ]);
});

test('status Non Aktif dan Isolir menolak login lewat Auth-Type Reject', async () => {
  for (const status of ['Non Aktif', 'Isolir']) {
    const db = fakeDb(env);
    await writeAccount(db, { ...baseCustomer, status });
    assert.ok(
      inserted(db, 'radcheck').some((row) => row[1] === 'Auth-Type' && row[3] === 'Reject'),
      status,
    );
  }
  const aktif = fakeDb(env);
  await writeAccount(aktif, baseCustomer);
  assert.equal(inserted(aktif, 'radcheck').some((row) => row[1] === 'Auth-Type'), false);
});

test('baris lama dihapus dulu sehingga tidak ada batas yang tertinggal', async () => {
  const db = fakeDb(env);
  await writeAccount(db, baseCustomer);

  assert.match(db.calls[0].sql, /^DELETE FROM radcheck/);
  assert.match(db.calls[1].sql, /^DELETE FROM radusergroup/);
});

test('kategori selain PPP/Hotspot atau tanpa password tidak punya akun RADIUS', async () => {
  for (const customer of [
    { ...baseCustomer, ktg: 'Static' },
    { ...baseCustomer, password: '' },
  ]) {
    assert.equal(usesRadius(customer), false);
    const db = fakeDb(env);
    await writeAccount(db, customer);
    assert.deepEqual(inserted(db, 'radcheck'), []);
    assert.deepEqual(inserted(db, 'radusergroup'), []);
    assert.match(db.calls[0].sql, /^DELETE FROM radcheck/);
  }
  assert.equal(usesRadius({ ...baseCustomer, ktg: 'Hotspot' }), true);
});

test('router tidak dikenal atau kosong membatalkan simpan, bukan menulis akun terbuka', async () => {
  await assert.rejects(
    writeAccount(fakeDb(env), { ...baseCustomer, router: 'RB HILANG' }),
    (error) => error instanceof RadiusSyncError && /RB HILANG/.test(error.message),
  );
  await assert.rejects(
    writeAccount(fakeDb(env), { ...baseCustomer, router: '' }),
    (error) => error instanceof RadiusSyncError,
  );
});

test('profil tanpa grup RADIUS tidak menulis radusergroup', async () => {
  const db = fakeDb({ ...env, groups: { 5: '' } });
  await writeAccount(db, baseCustomer);
  assert.deepEqual(inserted(db, 'radusergroup'), []);
});

test('username bentrok dengan langganan lain, voucher/akun RADIUS, atau terlalu panjang ditolak', async () => {
  await assert.rejects(
    assertUsernameFree(fakeDb({ otherCustomers: ['dobel'] }), 'dobel'),
    (error) => error.statusCode === 409,
  );
  await assert.rejects(
    assertUsernameFree(fakeDb({ radcheckUsers: ['5R2JBX4V'] }), '5R2JBX4V'),
    (error) => error.statusCode === 409,
  );
  await assert.rejects(
    assertUsernameFree(fakeDb(), 'x'.repeat(65)),
    (error) => error.statusCode === 400,
  );
  await assert.doesNotReject(assertUsernameFree(fakeDb(), 'baru@net'));
});

test('akun Hotspot memakai Framed-Protocol != PPP, akun PPP memakai ==', async () => {
  const hotspot = fakeDb(env);
  await writeAccount(hotspot, { ...baseCustomer, ktg: 'Hotspot', server: 'hs-1' });
  const rows = inserted(hotspot, 'radcheck');
  assert.ok(rows.some((row) => row[1] === 'Framed-Protocol' && row[2] === '!=' && row[3] === 'PPP'));
  assert.equal(rows.some((row) => row[1] === 'Framed-Protocol' && row[2] === '=='), false);
  assert.ok(rows.some((row) => row[1] === 'Called-Station-Id' && row[3] === 'hs-1'));
  assert.ok(rows.some((row) => row[1] === 'NAS-IP-Address' && row[3] === '192.168.223.250'));

  const db = fakeDb();
  await replaceFramedProtocol(db, 'andi', 'PPP');
  assert.match(db.calls[0].sql, /DELETE FROM radcheck/);
  assert.deepEqual(db.calls[1].params, ['andi', 'Framed-Protocol', '==', 'PPP']);
});

test('akun Hotspot ALL SERVER tidak menulis Called-Station-Id', async () => {
  const db = fakeDb(env);
  await writeAccount(db, { ...baseCustomer, ktg: 'Hotspot', server: 'ALL SERVER' });
  const rows = inserted(db, 'radcheck');
  assert.equal(rows.some((row) => row[1] === 'Called-Station-Id'), false);
  assert.ok(rows.some((row) => row[1] === 'NAS-IP-Address'));
  assert.ok(rows.some((row) => row[1] === 'Framed-Protocol' && row[2] === '!='));
});

test('ganti nama server memperbarui Called-Station-Id milik router itu', async () => {
  const calls = [];
  const db = {
    async execute(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes('COUNT(*)')) {
        return [[{ n: 0 }]];
      }
      return [{ affectedRows: 2 }];
    },
  };
  const result = await renameServerBindings(db, {
    oldName: 'LAMA',
    newName: 'BARU',
    routerName: 'RB TES',
    routerIp: '10.0.0.1',
  });
  assert.ok(result.radcheck > 0);
  assert.equal(result.radgroupcheck, 2);
  const nas = calls.find((item) => item.sql.includes('NAS-IP-Address'));
  assert.deepEqual(nas.params, ['BARU', 'LAMA', '10.0.0.1']);
  const group = calls.find((item) => item.sql.includes('UPDATE radgroupcheck'));
  assert.deepEqual(group.params, ['BARU', 'LAMA']);
  const billing = calls.filter((item) => item.sql.startsWith('UPDATE langganan_pelanggan'));
  assert.deepEqual(billing.map((item) => item.params[2]), ['RB TES', 'ALL ROUTER']);
});

test('nama server yang masih dipakai router lain tidak mengubah akun ALL ROUTER', async () => {
  const calls = [];
  const db = {
    async execute(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes('COUNT(*)')) {
        return [[{ n: 1 }]];
      }
      return [{ affectedRows: 1 }];
    },
  };
  await renameServerBindings(db, {
    oldName: 'SAMA',
    newName: 'BARU',
    routerName: 'RB TES',
    routerIp: '10.0.0.1',
  });
  const billing = calls.filter((item) => item.sql.startsWith('UPDATE langganan_pelanggan'));
  assert.deepEqual(billing.map((item) => item.params[2]), ['RB TES']);
  assert.equal(calls.some((item) => item.sql.includes('UPDATE radgroupcheck')), false);
  assert.equal(calls.some((item) => item.sql.includes('username NOT IN')), false);
});

test('pilihan router: ALL ROUTER tidak mengunci, router tertentu mengunci ke IP-nya', () => {
  const routers = new Map([['RB TES', '10.0.0.1']]);
  assert.deepEqual(nasLockForRouter('ALL ROUTER', routers), { lock: false, ip: '' });
  assert.deepEqual(nasLockForRouter('  ', routers), { lock: false, ip: '' });
  assert.deepEqual(nasLockForRouter('RB TES', routers), { lock: true, ip: '10.0.0.1' });
  assert.equal(nasLockForRouter('RB HILANG', routers).unknown, true);
});

test('syncRouterLocks menulis NAS-IP hanya untuk router spesifik dan melepas ALL ROUTER', async () => {
  const calls = [];
  const db = {
    async execute(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (sql.includes('FROM routers')) return [[{ nama_router: 'RB TES', ip_address: '10.0.0.1' }]];
      if (sql.includes('FROM hotspot_vouchers')) return [[{ username: 'vc1', router: 'RB TES' }]];
      if (sql.includes('FROM langganan_pelanggan')) return [[{ username: 'budi', router: 'ALL ROUTER' }]];
      if (sql.includes("attribute = 'NAS-IP-Address'") && sql.includes('SELECT')) return [[]];
      return [{ affectedRows: 1 }];
    },
  };
  const summary = await syncRouterLocks(db);
  assert.equal(summary.locked, 1);
  assert.equal(summary.opened, 1);
  const insert = calls.find((item) => item.sql.includes('INSERT INTO radcheck'));
  assert.deepEqual(insert.params, ['vc1', '10.0.0.1']);
  const deleted = calls
    .filter((item) => item.sql.includes('DELETE FROM radcheck'))
    .map((item) => item.params[0]);
  assert.ok(deleted.includes('vc1'));
  assert.ok(deleted.includes('budi'));
});

test('ganti grup profil memperbarui pelanggan, grup kosong hanya mencabut', async () => {
  const db = fakeDb();
  await syncProfileGroup(db, 5, '20-Mbps');
  assert.match(db.calls[0].sql, /DELETE ug FROM radusergroup/);
  assert.match(db.calls[1].sql, /INSERT INTO radusergroup/);
  assert.deepEqual(db.calls[1].params, ['20-Mbps', 5]);

  const removed = fakeDb();
  await syncProfileGroup(removed, 5, '');
  assert.equal(removed.calls.length, 1);
});
