const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.MIDTRANS_SERVER_KEY = 'SB-Mid-server-test';

const midtrans = require('../backend/payment/midtrans');
const { createTransaction, handleWebhook } = require('../backend/payment/gateway_service');

function signed(body) {
  const signature_key = crypto
    .createHash('sha512')
    .update(`${body.order_id}${body.status_code}${body.gross_amount}${process.env.MIDTRANS_SERVER_KEY}`)
    .digest('hex');
  return { ...body, signature_key };
}

/** DB palsu in-memory: cukup untuk satu pelanggan + payment_orders. */
function fakeDb({ total = 150000, orderStatus = 'Pending', reactivatedAt = null } = {}) {
  const state = {
    orders: new Map(),
    jatuhTempoExtensions: 0,
  };
  if (orderStatus) {
    state.orders.set('INV-1-A', {
      order_id: 'INV-1-A', langganan_id: 1, amount: total, status: orderStatus, reactivated_at: reactivatedAt,
    });
  }
  const run = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT id, pelanggan')) {
      return [[{ id: 1, pelanggan: 'Budi', phone: '08123', status: 'Isolir', total }]];
    }
    if (q.includes("status = 'Pending' AND snap_token IS NOT NULL")) {
      return [[]];
    }
    if (q.startsWith('INSERT INTO payment_orders')) {
      state.orders.set(params[0], { order_id: params[0], langganan_id: params[1], amount: params[2], status: 'Pending' });
      return [{ affectedRows: 1 }];
    }
    if (q.startsWith('SELECT order_id, langganan_id')) {
      return [[state.orders.get(params[0]) ? { ...state.orders.get(params[0]) } : undefined].filter(Boolean)];
    }
    if (q.startsWith("UPDATE payment_orders SET status = 'Lunas'")) {
      const o = state.orders.get(params[1]);
      if (o && o.status === 'Pending') {
        o.status = 'Lunas';
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }
    if (q.startsWith('UPDATE langganan_pelanggan SET jatuh_tempo')) {
      state.jatuhTempoExtensions += 1;
      return [{ affectedRows: 1 }];
    }
    if (q.includes('SET reactivated_at')) {
      state.orders.get(params[0]).reactivated_at = new Date();
      return [{ affectedRows: 1 }];
    }
    if (q.startsWith('UPDATE payment_orders SET status = ?')) {
      const o = state.orders.get(params[1]);
      if (o && o.status === 'Pending') o.status = params[0];
      return [{ affectedRows: 1 }];
    }
    if (q.startsWith('UPDATE payment_orders SET snap_token')) {
      return [{ affectedRows: 1 }];
    }
    if (q.startsWith("UPDATE payment_orders SET status = 'Gagal'")) {
      state.orders.get(params[0]).status = 'Gagal';
      return [{ affectedRows: 1 }];
    }
    throw new Error(`SQL tidak dikenal di fakeDb: ${q}`);
  };
  return {
    state,
    execute: run,
    getConnection: async () => ({
      execute: run,
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
    }),
  };
}

const paidBody = (over = {}) => signed({
  order_id: 'INV-1-A', status_code: '200', gross_amount: '150000.00', transaction_status: 'settlement', ...over,
});

function deps(overrides = {}) {
  const calls = { reactivate: 0 };
  return {
    calls,
    deps: {
      verifySignature: midtrans.verifySignature,
      createSnapTransaction: async () => ({ token: 'tok123', redirect_url: 'https://pay.example/tok123' }),
      reactivate: async () => { calls.reactivate += 1; },
      ...overrides,
    },
  };
}

test('verifySignature menerima signature benar dan menolak yang salah/kosong', () => {
  assert.equal(midtrans.verifySignature(paidBody()), true);
  assert.equal(midtrans.verifySignature({ ...paidBody(), gross_amount: '1.00' }), false);
  assert.equal(midtrans.verifySignature({ ...paidBody(), signature_key: 'x' }), false);
  assert.equal(midtrans.verifySignature({ order_id: 'a' }), false);
});

test('mapStatus: capture hanya paid bila fraud_status accept', () => {
  assert.equal(midtrans.mapStatus({ transaction_status: 'settlement' }), 'paid');
  assert.equal(midtrans.mapStatus({ transaction_status: 'capture', fraud_status: 'accept' }), 'paid');
  assert.equal(midtrans.mapStatus({ transaction_status: 'capture', fraud_status: 'challenge' }), 'pending');
  assert.equal(midtrans.mapStatus({ transaction_status: 'expire' }), 'expired');
  assert.equal(midtrans.mapStatus({ transaction_status: 'deny' }), 'failed');
});

test('createTransaction memakai nominal dari DB dan mengembalikan token', async () => {
  const db = fakeDb({ orderStatus: null });
  const { deps: d } = deps();
  const result = await createTransaction({ customerId: 1 }, db, d);
  assert.equal(result.amount, 150000);
  assert.equal(result.token, 'tok123');
  assert.match(result.order_id, /^INV-1-/);
});

test('createTransaction menolak nominal dari frontend yang tidak sama dengan tagihan', async () => {
  const db = fakeDb({ orderStatus: null });
  const { deps: d } = deps();
  await assert.rejects(
    createTransaction({ customerId: 1, nominalTagihan: 1 }, db, d),
    (e) => e.statusCode === 400,
  );
});

test('createTransaction menandai order Gagal bila PG menolak', async () => {
  const db = fakeDb({ orderStatus: null });
  const { deps: d } = deps({ createSnapTransaction: async () => { throw new Error('PG down'); } });
  await assert.rejects(createTransaction({ customerId: 1 }, db, d), (e) => e.statusCode === 502);
  assert.equal([...db.state.orders.values()][0].status, 'Gagal');
});

test('webhook: signature salah -> 401 dan tidak buka isolir', async () => {
  const db = fakeDb();
  const { deps: d, calls } = deps();
  const res = await handleWebhook({ ...paidBody(), signature_key: 'palsu' }, db, d);
  assert.equal(res.httpStatus, 401);
  assert.equal(calls.reactivate, 0);
});

test('webhook: nominal berbeda dari order -> 400', async () => {
  const db = fakeDb();
  const { deps: d, calls } = deps();
  const res = await handleWebhook(paidBody({ gross_amount: '1000.00' }), db, d);
  assert.equal(res.httpStatus, 400);
  assert.equal(calls.reactivate, 0);
});

test('webhook settlement: Lunas, perpanjang jatuh tempo, buka isolir sekali', async () => {
  const db = fakeDb();
  const { deps: d, calls } = deps();
  const res = await handleWebhook(paidBody(), db, d);
  assert.equal(res.httpStatus, 200);
  assert.equal(db.state.orders.get('INV-1-A').status, 'Lunas');
  assert.equal(db.state.jatuhTempoExtensions, 1);
  assert.equal(calls.reactivate, 1);

  // Notifikasi duplikat dari PG: tidak memproses ulang.
  const again = await handleWebhook(paidBody(), db, d);
  assert.equal(again.httpStatus, 200);
  assert.equal(db.state.jatuhTempoExtensions, 1);
  assert.equal(calls.reactivate, 1);
});

test('webhook: buka isolir gagal -> 500 (PG kirim ulang), retry tidak memperpanjang dua kali', async () => {
  const db = fakeDb();
  let fail = true;
  const { deps: d, calls } = deps({
    reactivate: async () => {
      calls.reactivate += 1;
      if (fail) throw new Error('RADIUS down');
    },
  });
  const first = await handleWebhook(paidBody(), db, d);
  assert.equal(first.httpStatus, 500);
  assert.equal(db.state.orders.get('INV-1-A').status, 'Lunas');

  fail = false;
  const retry = await handleWebhook(paidBody(), db, d);
  assert.equal(retry.httpStatus, 200);
  assert.equal(db.state.jatuhTempoExtensions, 1);
  assert.ok(db.state.orders.get('INV-1-A').reactivated_at);
});

test('webhook: pelanggan tidak sedang isolir (409) tetap dianggap sukses', async () => {
  const db = fakeDb();
  const { deps: d } = deps({
    reactivate: async () => { const e = new Error('tidak isolir'); e.statusCode = 409; throw e; },
  });
  const res = await handleWebhook(paidBody(), db, d);
  assert.equal(res.httpStatus, 200);
  assert.ok(db.state.orders.get('INV-1-A').reactivated_at);
});

test('webhook expire menandai Kadaluarsa; order tak dikenal diabaikan 200', async () => {
  const db = fakeDb();
  const { deps: d, calls } = deps();
  const exp = await handleWebhook(paidBody({ transaction_status: 'expire', status_code: '407' }), db, d);
  assert.equal(exp.httpStatus, 200);
  assert.equal(db.state.orders.get('INV-1-A').status, 'Kadaluarsa');
  assert.equal(calls.reactivate, 0);

  const unknown = await handleWebhook(signed({
    order_id: 'LAIN-1', status_code: '200', gross_amount: '1.00', transaction_status: 'settlement',
  }), db, d);
  assert.equal(unknown.httpStatus, 200);
});
