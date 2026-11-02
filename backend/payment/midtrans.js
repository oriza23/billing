/**
 * Adapter Midtrans Snap (referensi PG). Ganti file ini bila pindah ke Xendit/Tripay/Duitku;
 * sisa alur (orders, webhook, buka isolir) tidak perlu diubah.
 *
 * Env:
 *   MIDTRANS_SERVER_KEY      wajib (Server Key, JANGAN dikirim ke frontend)
 *   MIDTRANS_IS_PRODUCTION   '1' = produksi, selain itu sandbox
 */

const crypto = require('crypto');

function serverKey() {
  return String(process.env.MIDTRANS_SERVER_KEY || '').trim();
}

function snapUrl() {
  return String(process.env.MIDTRANS_IS_PRODUCTION || '') === '1'
    ? 'https://app.midtrans.com/snap/v1/transactions'
    : 'https://app.sandbox.midtrans.com/snap/v1/transactions';
}

/** Buat transaksi Snap. Mengembalikan { token, redirect_url }. */
async function createSnapTransaction({ orderId, amount, customer, itemName }, { fetchFn = fetch } = {}) {
  const key = serverKey();
  if (!key) {
    throw new Error('MIDTRANS_SERVER_KEY belum diisi');
  }

  const body = {
    transaction_details: { order_id: orderId, gross_amount: amount },
    item_details: [{ id: orderId, price: amount, quantity: 1, name: String(itemName).slice(0, 50) }],
    customer_details: {
      first_name: String(customer.name || '').slice(0, 50),
      phone: customer.phone || undefined,
    },
    // Link tagihan berlaku 24 jam.
    expiry: { unit: 'hours', duration: 24 },
  };

  const response = await fetchFn(snapUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) {
    const detail = data.error_messages?.join('; ') || `HTTP ${response.status}`;
    throw new Error(`Midtrans menolak transaksi: ${detail}`);
  }
  return { token: data.token, redirect_url: data.redirect_url };
}

/**
 * Verifikasi notifikasi: signature_key = SHA512(order_id + status_code + gross_amount + ServerKey).
 * Tanpa ini siapa pun bisa memalsukan "pembayaran sukses" ke webhook Anda.
 */
function verifySignature(body) {
  const key = serverKey();
  const given = String(body?.signature_key || '');
  if (!key || !given) {
    return false;
  }
  const expected = crypto
    .createHash('sha512')
    .update(`${body.order_id}${body.status_code}${body.gross_amount}${key}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Petakan status Midtrans → status internal: 'paid' | 'pending' | 'failed' | 'expired'. */
function mapStatus(body) {
  const status = String(body?.transaction_status || '');
  if (status === 'settlement') {
    return 'paid';
  }
  // Kartu kredit: capture hanya sah bila fraud_status = accept.
  if (status === 'capture') {
    return body?.fraud_status === 'accept' ? 'paid' : 'pending';
  }
  if (status === 'pending') {
    return 'pending';
  }
  if (status === 'expire') {
    return 'expired';
  }
  return 'failed'; // deny, cancel, failure, refund, dst.
}

module.exports = { createSnapTransaction, verifySignature, mapStatus };
