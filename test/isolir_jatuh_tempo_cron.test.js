const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CRON_EXPR,
  SELECT_MENUNGGAK,
  DELAY_MS,
  runIsolirJatuhTempo,
} = require('../utils/cron');

function silentLog() {
  return { log() {}, warn() {}, error() {} };
}

function fakeDb({ targets, affectedRows = 1 }) {
  const updates = [];
  return {
    updates,
    async execute(sql, params = []) {
      if (/FROM langganan_pelanggan/.test(sql) && /jatuh_tempo < CURDATE/.test(sql)) {
        return [targets];
      }
      if (/UPDATE langganan_pelanggan/.test(sql)) {
        updates.push(params);
        return [{ affectedRows }];
      }
      throw new Error(`query tak terduga: ${sql}`);
    },
  };
}

test('jadwal cron default tepat 00:01 setiap hari', () => {
  assert.equal(CRON_EXPR, '1 0 * * *');
});

test('jeda default antar pelanggan 2 detik', () => {
  assert.equal(DELAY_MS, 2000);
});

test('query hanya PPP berstatus Aktif dengan jatuh_tempo sebelum hari ini', () => {
  assert.match(SELECT_MENUNGGAK, /ktg = 'PPP'/);
  assert.match(SELECT_MENUNGGAK, /status = 'Aktif'/);
  assert.match(SELECT_MENUNGGAK, /jatuh_tempo < CURDATE\(\)/);
});

test('isolir berurutan dengan jeda antar pelanggan', async () => {
  const targets = [
    { id: 1, username: 'a', router: 'R1', profil_id: 5, profil_id_sebelum_isolir: null },
    { id: 2, username: 'b', router: 'R1', profil_id: 6, profil_id_sebelum_isolir: null },
    { id: 3, username: 'c', router: 'R1', profil_id: 7, profil_id_sebelum_isolir: null },
  ];
  const db = fakeDb({ targets });
  const calls = [];
  const sleeps = [];

  const summary = await runIsolirJatuhTempo({
    db,
    log: silentLog(),
    delayMs: 1500,
    sleepFn: async (ms) => { sleeps.push(ms); },
    isolirFn: async (id) => {
      calls.push(id);
      await db.execute('UPDATE langganan_pelanggan SET status = ? WHERE id = ?', ['Isolir', id]);
    },
  });

  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(sleeps, [1500, 1500]);
  assert.equal(summary.berhasil, 3);
  assert.equal(db.updates.length, 3);
});

test('isolir gagal: loop lanjut ke pelanggan berikutnya', async () => {
  const targets = [
    { id: 1, username: 'a', router: 'R1', profil_id: 5, profil_id_sebelum_isolir: null },
    { id: 2, username: 'b', router: 'R1', profil_id: 6, profil_id_sebelum_isolir: null },
  ];
  const db = fakeDb({ targets });

  const summary = await runIsolirJatuhTempo({
    db,
    log: silentLog(),
    delayMs: 0,
    sleepFn: async () => {},
    isolirFn: async (id) => {
      if (id === 1) {
        throw new Error('RADIUS gagal');
      }
      await db.execute('UPDATE langganan_pelanggan SET status = ? WHERE id = ?', ['Isolir', id]);
    },
  });

  assert.equal(summary.berhasil, 1);
  assert.equal(summary.gagal.length, 1);
  assert.equal(summary.gagal[0].username, 'a');
  assert.equal(db.updates.length, 1);
});
