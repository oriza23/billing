/**
 * Alur Payment Gateway:
 *   createTransaction  -> payment_orders (Pending) + token/URL checkout dari PG
 *   handleWebhook      -> verifikasi signature -> Lunas -> buka isolir + PoD
 */

const crypto = require('crypto');
const pool = require('../../database');
const midtrans = require('./midtrans');
const { bukaIsolirPelangganFullRadius } = require('../pppoe_isolir/isolir_full_radius');

class PaymentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'PaymentError';
    this.statusCode = statusCode;
  }
}

const defaultDeps = {
  createSnapTransaction: midtrans.createSnapTransaction,
  verifySignature: midtrans.verifySignature,
  reactivate: (customerId, db) => bukaIsolirPelangganFullRadius(customerId, { kick: true }, db),
};

function newOrderId(customerId) {
  // Maks 50 karakter di Midtrans. Bagian acak mencegah order_id bentrok/tertebak.
  return `INV-${customerId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Nominal SELALU dihitung server dari database. Nilai dari frontend hanya dicocokkan,
 * tidak pernah dipercaya (kalau tidak, pelanggan bisa membayar Rp 1 lalu lolos isolir).
 */
async function createTransaction({ customerId, nominalTagihan }, db = pool, deps = defaultDeps) {
  const [rows] = await db.execute(
    'SELECT id, pelanggan, phone, status, total FROM langganan_pelanggan WHERE id = ? LIMIT 1',
    [customerId],
  );
  const customer = rows[0];
  if (!customer) {
    throw new PaymentError('Pelanggan tidak ditemukan', 404);
  }

  const amount = Math.round(Number(customer.total) || 0);
  if (amount <= 0) {
    throw new PaymentError('Total tagihan pelanggan belum diisi', 422);
  }
  if (nominalTagihan != null && Math.round(Number(nominalTagihan)) !== amount) {
    throw new PaymentError('Nominal tidak sesuai dengan tagihan', 400);
  }

  // Idempoten: klik "Bayar" berulang memakai tagihan Pending yang sama (maks 23 jam).
  const [pending] = await db.execute(
    `SELECT order_id, snap_token, redirect_url, amount FROM payment_orders
     WHERE langganan_id = ? AND status = 'Pending' AND snap_token IS NOT NULL
       AND amount = ? AND created_at > (NOW() - INTERVAL 23 HOUR)
     ORDER BY id DESC LIMIT 1`,
    [customerId, amount],
  );
  if (pending[0]) {
    return {
      order_id: pending[0].order_id,
      amount,
      token: pending[0].snap_token,
      redirect_url: pending[0].redirect_url,
      reused: true,
    };
  }

  const orderId = newOrderId(customerId);
  await db.execute(
    'INSERT INTO payment_orders (order_id, langganan_id, amount) VALUES (?, ?, ?)',
    [orderId, customerId, amount],
  );

  try {
    const snap = await deps.createSnapTransaction({
      orderId,
      amount,
      customer: { name: customer.pelanggan, phone: customer.phone },
      itemName: `Tagihan internet ${customer.pelanggan}`,
    });
    await db.execute(
      'UPDATE payment_orders SET snap_token = ?, redirect_url = ? WHERE order_id = ?',
      [snap.token, snap.redirect_url || null, orderId],
    );
    return { order_id: orderId, amount, token: snap.token, redirect_url: snap.redirect_url, reused: false };
  } catch (error) {
    await db.execute("UPDATE payment_orders SET status = 'Gagal' WHERE order_id = ?", [orderId]);
    throw new PaymentError(error.message, 502);
  }
}

/**
 * Tandai Lunas secara atomik. UPDATE ... WHERE status='Pending' hanya berhasil SEKALI,
 * jadi notifikasi ganda dari PG tidak memperpanjang jatuh tempo dua kali.
 * Jatuh tempo ikut diperpanjang satu siklus; tanpa ini cron 00:01 akan mengisolir lagi
 * pelanggan yang baru membayar (jatuh_tempo masih lewat).
 */
async function markPaid(db, order, payload) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [claimed] = await conn.execute(
      `UPDATE payment_orders SET status = 'Lunas', paid_at = NOW(), gateway_payload = ?
       WHERE order_id = ? AND status = 'Pending'`,
      [JSON.stringify(payload), order.order_id],
    );
    if (claimed.affectedRows === 1) {
      await conn.execute(
        `UPDATE langganan_pelanggan
         SET jatuh_tempo = DATE_ADD(GREATEST(COALESCE(jatuh_tempo, CURDATE()), CURDATE()), INTERVAL 1 MONTH)
         WHERE id = ? AND siklus = 'BULAN'`,
        [order.langganan_id],
      );
    }
    await conn.commit();
    return claimed.affectedRows === 1;
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * Hasil: { httpStatus, message }. httpStatus 200 = PG berhenti mengirim ulang;
 * 5xx = PG akan mengirim ulang (dipakai bila buka isolir gagal sementara).
 */
async function handleWebhook(body, db = pool, deps = defaultDeps) {
  if (!deps.verifySignature(body)) {
    return { httpStatus: 401, message: 'Signature tidak valid' };
  }

  const [rows] = await db.execute(
    'SELECT order_id, langganan_id, amount, status, reactivated_at FROM payment_orders WHERE order_id = ? LIMIT 1',
    [String(body.order_id || '')],
  );
  const order = rows[0];
  if (!order) {
    // Order tak dikenal (mis. transaksi lain di akun Midtrans yang sama): jangan dikirim ulang.
    return { httpStatus: 200, message: 'Order tidak dikenal, diabaikan' };
  }

  // Nominal dari PG harus sama dengan nominal yang kita tagihkan.
  if (Math.round(Number(body.gross_amount)) !== Math.round(Number(order.amount))) {
    return { httpStatus: 400, message: 'Nominal tidak sesuai order' };
  }

  const state = midtrans.mapStatus(body);

  if (state === 'failed' || state === 'expired') {
    await db.execute(
      "UPDATE payment_orders SET status = ? WHERE order_id = ? AND status = 'Pending'",
      [state === 'expired' ? 'Kadaluarsa' : 'Gagal', order.order_id],
    );
    return { httpStatus: 200, message: `Order ${state}` };
  }
  if (state === 'pending') {
    return { httpStatus: 200, message: 'Menunggu pembayaran' };
  }

  // state === 'paid'
  if (order.status === 'Lunas' && order.reactivated_at) {
    return { httpStatus: 200, message: 'Sudah diproses sebelumnya' };
  }
  if (order.status !== 'Lunas') {
    await markPaid(db, order, body);
  }

  // Buka isolir: profil RADIUS dikembalikan + PoD (di dalam bukaIsolirPelangganFullRadius).
  try {
    await deps.reactivate(order.langganan_id, db);
  } catch (error) {
    // 409 = pelanggan tidak sedang isolir (bayar sebelum jatuh tempo): bukan kegagalan.
    if (!(error instanceof Error && error.statusCode === 409)) {
      console.error('[payment] buka isolir gagal:', error.message, { orderId: order.order_id });
      // Order sudah Lunas; 500 membuat PG mengirim ulang dan kita coba buka isolir lagi.
      return { httpStatus: 500, message: 'Pembayaran tercatat, buka isolir gagal (akan dicoba ulang)' };
    }
  }

  await db.execute('UPDATE payment_orders SET reactivated_at = NOW() WHERE order_id = ?', [order.order_id]);
  return { httpStatus: 200, message: 'Lunas, layanan diaktifkan' };
}

module.exports = { PaymentError, createTransaction, handleWebhook, markPaid, defaultDeps };
