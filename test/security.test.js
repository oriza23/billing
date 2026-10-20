const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../database');
const { secret } = require('../backend/config/jwt');
const requireAuth = require('../backend/middleware/auth');
const { hashPassword, isScryptHash, verifyPassword } = require('../backend/password');
const ensureBootstrapAdmin = require('../backend/bootstrap_admin');
const {
  EXPIRED_VOUCHER_SQL,
  INSERT_REJECT_SQL,
  rejectExpiredVouchers,
} = require('../backend/hotspot_quota');
const authRouter = require('../backend/routes/auth');
const hotspotRouter = require('../backend/routes/hotspot');
const adminsRouter = require('../backend/routes/admins');
const routersRouter = require('../backend/routes/routers');
const settingsRouter = require('../backend/routes/settings');

const WRITE_ENDPOINTS = [
  ['POST', '/api/hotspot/profil'],
  ['PUT', '/api/hotspot/profil/grup'],
  ['DELETE', '/api/hotspot/profil/grup'],
  ['POST', '/api/hotspot/profil/delete-massal'],
  ['POST', '/api/hotspot/voucher/generate'],
  ['POST', '/api/hotspot/voucher/delete-massal'],
  ['DELETE', '/api/hotspot/voucher/kode'],
  ['POST', '/api/hotspot/kick-user'],
  ['POST', '/api/hotspot/hapus-cookie'],
  ['POST', '/api/admins'],
  ['PUT', '/api/admins/petugas'],
  ['DELETE', '/api/admins/petugas'],
  ['POST', '/api/routers'],
  ['PUT', '/api/routers/1'],
  ['DELETE', '/api/routers/1'],
  ['POST', '/api/settings/timezone'],
];

function sign(role, username = 'petugas') {
  return jwt.sign({ username, role }, secret, { algorithm: 'HS256', expiresIn: '5m' });
}

function installPool(overrides = {}) {
  const calls = [];
  const execute = async (sql, params) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (overrides.execute) {
      return overrides.execute(text, params);
    }
    if (text.includes('SELECT')) {
      return [[]];
    }
    if (text.includes('UPDATE radgroupcheck')) {
      return [{ affectedRows: 0 }];
    }
    return [{ affectedRows: 1, insertId: 1 }];
  };
  const query = async (sql, params) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (overrides.query) {
      return overrides.query(text, params);
    }
    if (text.includes('GET_LOCK')) {
      return [[{ locked: 1 }]];
    }
    return [[]];
  };
  pool.execute = execute;
  pool.query = query;
  pool.getConnection = async () => ({
    execute,
    query,
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release() {},
  });
  return calls;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api', requireAuth);
  app.use('/api/hotspot', hotspotRouter);
  app.use('/api/admins', adminsRouter);
  app.use('/api/routers', routersRouter);
  app.use('/api/settings', settingsRouter);
  return app;
}

let server;
let base;

test.before(async () => {
  installPool();
  server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function attributeValues(calls, attribute) {
  return calls
    .filter((call) => call.sql.includes(`'${attribute}'`) && call.sql.includes('INSERT'))
    .map((call) => call.params[call.params.length - 1]);
}

test('pemanggil tanpa token menerima 401', async () => {
  for (const [method, path] of WRITE_ENDPOINTS) {
    const response = await call(method, path, { body: {} });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  const read = await call('GET', '/api/hotspot/profil');
  assert.equal(read.status, 401);
});

test('role selain admin ditolak saat menulis dan tetap boleh membaca', async () => {
  const token = sign('kasir', 'kasir');
  for (const [method, path] of WRITE_ENDPOINTS) {
    const response = await call(method, path, { token, body: {} });
    assert.equal(response.status, 403, `${method} ${path}`);
  }

  const profil = await call('GET', '/api/hotspot/profil', { token });
  assert.equal(profil.status, 200);

  const calls = installPool({
    execute: async (sql) => {
      if (sql.includes('FROM web_admins')) {
        return [[{ id: 1, username: 'ada', role: 'admin', password: 'bocor-rahasia' }]];
      }
      return [[]];
    },
  });
  const admins = await call('GET', '/api/admins', { token });
  assert.equal(admins.status, 200);
  assert.deepEqual(admins.body, [{ id: 1, username: 'ada', role: 'admin' }]);
  const packed = JSON.stringify(admins.body);
  assert.equal(packed.includes('password'), false);
  assert.equal(packed.includes('bocor-rahasia'), false);
  assert.equal(calls.some((item) => /password/i.test(item.sql)), false);
});

test('generate voucher mencatat username dari token, bukan dari body', async () => {
  const calls = installPool({
    execute: async (sql) => {
      if (sql.includes('FROM hotspot_profiles')) {
        return [[{
          id: 1,
          nama_profile: 'Harian',
          harga_jual: 10000,
          komisi_reseller: 1000,
          hpp: 9000,
        }]];
      }
      if (sql.includes('UPDATE radgroupcheck')) {
        return [{ affectedRows: 0 }];
      }
      return [{ affectedRows: 1, insertId: 1 }];
    },
  });

  const response = await call('POST', '/api/hotspot/voucher/generate', {
    token: sign('admin', 'pembuat-token'),
    body: {
      jumlah: 1,
      panjang: 6,
      mikrotik_group: 'grp-harian',
      prefix: '',
      jenis_voucher: 'username=password',
      kode_kombinasi: 'angka-huruf',
      router: '',
      server: '',
      outlet: '',
      mitra: '',
      admin: 'bukan-dari-token',
    },
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const insert = calls.find((item) => item.sql.includes('INSERT INTO hotspot_vouchers'));
  assert.ok(insert, 'voucher tidak disimpan');
  const row = insert.params[0][0];
  assert.equal(row[10], 'pembuat-token');
  assert.equal(JSON.stringify(insert.params).includes('bukan-dari-token'), false);
});

test('profil baru dan profil yang diubah menulis Max-All-Session tanpa Session-Timeout', async () => {
  const created = installPool();
  const createResponse = await call('POST', '/api/hotspot/profil', {
    token: sign('admin', 'admin'),
    body: {
      nama_profile: '1 Jam',
      mikrotik_group: 'grp-1j',
      address_list: '',
      rate_limit: '1M/1M',
      shared: 1,
      masa_aktif: 1,
      masa_aktif_satuan: 'JAM',
      harga_jual: 5000,
      komisi_reseller: 0,
    },
  });
  assert.equal(createResponse.status, 200, JSON.stringify(createResponse.body));
  assert.deepEqual(attributeValues(created, 'Session-Timeout'), []);
  assert.deepEqual(attributeValues(created, 'Max-All-Session'), ['3600']);
  assert.equal(created.some((item) => item.sql.includes('Session-Timeout')), false);

  const updated = installPool({
    execute: async (sql) => {
      if (sql.includes('SELECT id FROM hotspot_profiles')) {
        return [[{ id: 4 }]];
      }
      if (sql.includes('UPDATE radgroupcheck')) {
        return [{ affectedRows: 0 }];
      }
      return [{ affectedRows: 1 }];
    },
  });
  const updateResponse = await call('PUT', '/api/hotspot/profil/grp-2h', {
    token: sign('admin', 'admin'),
    body: {
      rate_limit: '2M/2M',
      masa_aktif: 2,
      masa_aktif_satuan: 'HARI',
    },
  });
  assert.equal(updateResponse.status, 200, JSON.stringify(updateResponse.body));
  assert.deepEqual(attributeValues(updated, 'Session-Timeout'), []);
  assert.deepEqual(attributeValues(updated, 'Max-All-Session'), ['172800']);
  assert.equal(updated.some((item) => item.sql.includes('Session-Timeout')), false);
  assert.equal(
    updated.some((item) => item.sql.includes('DELETE') && item.sql.includes('Max-All-Session')),
    false,
  );
});

test('voucher yang waktu kumulatifnya habis ditolak pada autentikasi berikutnya', async () => {
  assert.match(EXPIRED_VOUCHER_SQL, /SUM\(acctsessiontime\)/);
  assert.match(INSERT_REJECT_SQL, /Auth-Type/);
  assert.match(INSERT_REJECT_SQL, /Reject/);

  const inserted = [];
  const rejected = await rejectExpiredVouchers({
    query: async () => [[{ username: 'vc-habis' }, { username: 'vc-habis' }]],
    execute: async (sql, params) => {
      assert.equal(sql, INSERT_REJECT_SQL);
      inserted.push(params);
      return [{ affectedRows: 1 }];
    },
  });
  assert.deepEqual(rejected, ['vc-habis']);
  assert.deepEqual(inserted, [['vc-habis', 'vc-habis']]);

  const skipped = [];
  const none = await rejectExpiredVouchers({
    query: async () => [[]],
    execute: async () => {
      skipped.push('insert');
      return [{ affectedRows: 1 }];
    },
  });
  assert.deepEqual(none, []);
  assert.deepEqual(skipped, []);
});

test('login mengangkat kata sandi polos menjadi hash dan tidak mengembalikannya', async () => {
  let stored = 'rahasia-lama';
  const calls = installPool({
    execute: async (sql, params) => {
      if (sql.includes('SELECT username, password, role')) {
        return [[{ username: 'lama', password: stored, role: 'admin' }]];
      }
      if (sql.startsWith('UPDATE web_admins SET password')) {
        stored = params[0];
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    },
  });

  const first = await call('POST', '/api/auth/login', {
    body: { username: 'lama', password: 'rahasia-lama' },
  });
  assert.equal(first.status, 200);
  assert.equal(Object.hasOwn(first.body, 'password'), false);
  assert.equal(isScryptHash(stored), true);
  assert.equal(await verifyPassword('rahasia-lama', stored), true);
  assert.equal(JSON.stringify(first.body).includes(stored), false);

  const second = await call('POST', '/api/auth/login', {
    body: { username: 'lama', password: 'rahasia-lama' },
  });
  assert.equal(second.status, 200);
  assert.equal(calls.filter((item) => item.sql.startsWith('UPDATE web_admins SET password')).length, 1);

  const wrong = await call('POST', '/api/auth/login', {
    body: { username: 'lama', password: 'salah' },
  });
  assert.equal(wrong.status, 401);
});

test('hash scrypt bisa diverifikasi dan akun awal hanya dibuat dari env', async () => {
  const hash = await hashPassword('contoh-sandi');
  assert.equal(hash.length < 255, true);
  assert.equal(await verifyPassword('contoh-sandi', hash), true);
  assert.equal(await verifyPassword('lain', hash), false);

  const logs = [];
  let inserted = null;
  const emptyDb = {
    async query(sql) {
      if (sql.includes('COUNT')) {
        return [[{ total: 0 }]];
      }
      return [[]];
    },
    async execute(sql, params) {
      inserted = { sql, params };
      return [{ affectedRows: 1 }];
    },
  };
  const created = await ensureBootstrapAdmin(emptyDb, {
    BOOTSTRAP_ADMIN_USERNAME: 'rootadmin',
    BOOTSTRAP_ADMIN_PASSWORD: 'sangat-rahasia',
  }, { log: (message) => logs.push(message) });
  assert.equal(created.created, true);
  assert.equal(isScryptHash(inserted.params[1]), true);
  assert.notEqual(inserted.params[1], 'sangat-rahasia');
  assert.equal(logs.join('\n').includes('sangat-rahasia'), false);
  assert.equal(logs.join('\n').includes('rootadmin'), false);

  let writes = 0;
  const occupied = {
    async query(sql) {
      if (sql.includes('COUNT')) {
        return [[{ total: 2 }]];
      }
      return [[]];
    },
    async execute() {
      writes += 1;
      return [{ affectedRows: 1 }];
    },
  };
  const skipped = await ensureBootstrapAdmin(occupied, {
    BOOTSTRAP_ADMIN_USERNAME: 'rootadmin',
    BOOTSTRAP_ADMIN_PASSWORD: 'sangat-rahasia',
  }, { log() {} });
  assert.equal(skipped.created, false);
  assert.equal(writes, 0);

  const missingEnv = await ensureBootstrapAdmin(emptyDb, {}, { log() {} });
  assert.equal(missingEnv.created, false);
});
