const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScopeRows, buildAccountRows, RadiusSyncError } = require('../backend/langganan_radius');
const { isolirPelangganFullRadius, bukaIsolirPelangganFullRadius } = require('../backend/pppoe_isolir/isolir_full_radius');

// DB palsu: routers berisi nama->ip; SQL dikenali dari potongan teksnya.
function fakeDb({ routers = {}, profiles = {}, customer = null } = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM routers')) {
        const ip = routers[params[0]];
        return [ip ? [{ ip_address: ip }] : []];
      }
      if (sql.includes('FROM langganan_profiles')) {
        return [[{ group_name: profiles[params[0]] || '' }]];
      }
      if (sql.includes('FROM langganan_pelanggan c') || sql.includes('FROM langganan_pelanggan c\n')) {
        return [[customer]];
      }
      return [[], []];
    },
  };
}

test('buildScopeRows: ALL ROUTER + ALL SERVER -> tanpa batasan', async () => {
  const rows = await buildScopeRows(fakeDb(), { router: 'ALL ROUTER', server: 'ALL SERVER' });
  assert.deepEqual(rows, []);
});

test('buildScopeRows: router tertentu -> NAS-IP-Address dari IP router', async () => {
  const db = fakeDb({ routers: { 'RB-A': '10.0.0.1' } });
  const rows = await buildScopeRows(db, { router: 'RB-A', server: 'ALL SERVER' });
  assert.deepEqual(rows, [['NAS-IP-Address', '==', '10.0.0.1']]);
});

test('buildScopeRows: server tertentu -> Called-Station-Id', async () => {
  const db = fakeDb({ routers: { 'RB-A': '10.0.0.1' } });
  const rows = await buildScopeRows(db, { router: 'RB-A', server: 'pppoe-utama' });
  assert.deepEqual(rows, [
    ['NAS-IP-Address', '==', '10.0.0.1'],
    ['Called-Station-Id', '==', 'pppoe-utama'],
  ]);
});

test('buildScopeRows: router tidak ada / tanpa IP -> error, tidak jatuh ke router lain', async () => {
  await assert.rejects(
    () => buildScopeRows(fakeDb({ routers: {} }), { router: 'RB-X', server: 'ALL SERVER' }),
    RadiusSyncError,
  );
  await assert.rejects(() => buildScopeRows(fakeDb(), { router: '', server: 'ALL SERVER' }), /Router wajib/);
});

test('buildAccountRows: status Isolir menambah Auth-Type Reject, scope tetap ikut', async () => {
  const db = fakeDb({ routers: { 'RB-A': '10.0.0.1' } });
  const { radcheck } = await buildAccountRows(db, {
    password: 'p', router: 'RB-A', server: 'ALL SERVER', status: 'Isolir', profil_id: null,
  });
  assert.deepEqual(radcheck.map((r) => r[0]), ['Cleartext-Password', 'NAS-IP-Address', 'Auth-Type']);
});

// Pelanggan dengan NAS yang sama sekali berbeda dengan router-acak lama: isolir tidak boleh memakai
// resolver router, dan harus memutus sesi lewat disconnectSessions (per NAS sesi).
function isolirDeps(events) {
  return {
    readIsolirGroupName: async () => 'isolir',
    applyRadiusIsolir: async (db, username, group) => {
      events.push(['radius', username, group]);
      return { ok: true };
    },
    applyRadiusNormal: async () => ({ ok: true }),
    disconnectSessions: async (db, username) => {
      events.push(['disconnect', username]);
      return { diputus: 1, gagal: 0, detail: [{ nas: '10.0.0.2', ok: true }] };
    },
  };
}

const customerRow = {
  id: 7, username: 'budi', status: 'Aktif', ktg: 'PPP', router: 'RB-B',
  profil_id: 3, profil_id_sebelum_isolir: null, profil_group: 'paket-10M',
};

test('isolir: sesi diputus per NAS lewat disconnectSessions, tanpa resolver router', async () => {
  const events = [];
  const db = {
    async execute(sql) {
      if (sql.includes('FROM langganan_pelanggan c')) return [[customerRow]];
      return [[{ affectedRows: 1 }]];
    },
  };
  const result = await isolirPelangganFullRadius(7, { deps: isolirDeps(events) }, db);
  assert.equal(result.success, true);
  assert.equal(result.router, 'RB-B');
  assert.deepEqual(events.map((e) => e[0]), ['radius', 'disconnect']);
  assert.equal(result.kick.ok, true);
});

test('isolir: kegagalan PoD tidak membatalkan isolir, tapi dilaporkan di kick', async () => {
  const events = [];
  const deps = {
    ...isolirDeps(events),
    disconnectSessions: async () => ({ diputus: 0, gagal: 1, detail: [{ nas: '10.0.0.2', ok: false }] }),
  };
  const db = {
    async execute(sql) {
      if (sql.includes('FROM langganan_pelanggan c')) return [[customerRow]];
      return [[{ affectedRows: 1 }]];
    },
  };
  const result = await isolirPelangganFullRadius(7, { deps }, db);
  assert.equal(result.status, 'Isolir');
  assert.equal(result.kick.ok, false);
  assert.equal(result.kick.gagal, 1);
});

test('isolir dengan kick=false: tidak memutus sesi', async () => {
  const events = [];
  const db = {
    async execute(sql) {
      if (sql.includes('FROM langganan_pelanggan c')) return [[customerRow]];
      return [[{ affectedRows: 1 }]];
    },
  };
  const result = await isolirPelangganFullRadius(7, { kick: false, deps: isolirDeps(events) }, db);
  assert.equal(result.kick.skipped, true);
  assert.deepEqual(events.map((e) => e[0]), ['radius']);
});

test('buka isolir: sesi diputus per NAS dan status kembali Aktif', async () => {
  const events = [];
  const isolirRow = { ...customerRow, status: 'Isolir', profil_id_sebelum_isolir: 3 };
  const db = {
    async execute(sql) {
      if (sql.includes('FROM langganan_pelanggan c')) return [[isolirRow]];
      if (sql.includes('FROM langganan_profiles')) return [[{ group_name: 'paket-10M' }]];
      return [[{ affectedRows: 1 }]];
    },
  };
  const deps = {
    ...isolirDeps(events),
    applyRadiusNormal: async (d, username, group) => {
      events.push(['normal', username, group]);
      return { ok: true };
    },
  };
  const result = await bukaIsolirPelangganFullRadius(7, { deps }, db);
  assert.equal(result.status, 'Aktif');
  assert.deepEqual(events.map((e) => e[0]), ['normal', 'disconnect']);
});
