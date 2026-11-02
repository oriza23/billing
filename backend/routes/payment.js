/**
 * Pembayaran (semua publik di level router; dilindungi per-endpoint):
 *  POST /api/payment/create   — buat transaksi Payment Gateway (Midtrans Snap)
 *  POST /api/payment/webhook  — notifikasi PG, dilindungi signature_key
 *  POST /api/payment/callback — webhook mutasi bank / e-wallet, dilindungi shared secret
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../../database');
const jwtConfig = require('../config/jwt');
const { processPaymentCallback } = require('../payment/payment_service');
const { PaymentError, createTransaction, handleWebhook } = require('../payment/gateway_service');
const { resolveClientIp } = require('../payment/client_ip');
const { findCustomerBySessionIp } = require('../payment/resolve_customer_by_ip');

const router = express.Router();

function verifyWebhookSecret(req) {
  const expected = String(process.env.PAYMENT_WEBHOOK_SECRET || '').trim();
  if (!expected) {
    return process.env.NODE_ENV !== 'production';
  }
  const header = String(req.headers['x-webhook-secret'] || req.headers['x-moota-signature'] || '').trim();
  const bodyToken = String(req.body?.secret || req.body?.token || '').trim();
  return header === expected || bodyToken === expected;
}

/**
 * Siapa yang boleh membuat tagihan untuk pelanggan X?
 *  - admin dengan JWT valid (bebas), atau
 *  - pelanggan di walled garden: IP sesi PPPoE-nya harus milik pelanggan X.
 */
async function authorizeCreate(req, customerId) {
  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      jwt.verify(token, jwtConfig.secret, { algorithms: ['HS256'] });
      return true;
    } catch {
      // Token kedaluwarsa/sisa login admin di browser: lanjut cek lewat IP pelanggan.
    }
  }
  const lookup = await findCustomerBySessionIp(pool, resolveClientIp(req));
  return lookup.ok && Number(lookup.customer.id) === customerId;
}

// Client Key bersifat publik (memang dipasang di snap.js); Server Key tidak pernah keluar.
function midtransPublicConfig() {
  const production = String(process.env.MIDTRANS_IS_PRODUCTION || '') === '1';
  return {
    client_key: String(process.env.MIDTRANS_CLIENT_KEY || '').trim(),
    snap_js_url: production
      ? 'https://app.midtrans.com/snap/snap.js'
      : 'https://app.sandbox.midtrans.com/snap/snap.js',
  };
}

// Body: { id_pelanggan, nominal_tagihan? } -> { token, redirect_url, order_id, amount }
router.post('/create', async (req, res) => {
  const customerId = Number(req.body?.id_pelanggan);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return res.status(400).json({ success: false, message: 'id_pelanggan tidak valid' });
  }

  try {
    if (!(await authorizeCreate(req, customerId))) {
      return res.status(403).json({ success: false, message: 'Tidak berhak membuat tagihan ini' });
    }
    const data = await createTransaction({
      customerId,
      nominalTagihan: req.body?.nominal_tagihan,
    });
    return res.json({ success: true, ...data, ...midtransPublicConfig() });
  } catch (error) {
    if (error instanceof PaymentError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error('[payment] create gagal:', error.message);
    return res.status(500).json({ success: false, message: 'Gagal membuat transaksi' });
  }
});

// Notification URL Midtrans. Keamanan = signature_key, bukan JWT/IP.
router.post('/webhook', async (req, res) => {
  try {
    const result = await handleWebhook(req.body || {});
    return res.status(result.httpStatus).json({ success: result.httpStatus === 200, message: result.message });
  } catch (error) {
    console.error('[payment] webhook error:', error.message);
    return res.status(500).json({ success: false, message: 'Gagal memproses webhook' });
  }
});

router.post('/callback', async (req, res) => {
  if (!verifyWebhookSecret(req)) {
    return res.status(401).json({ success: false, message: 'Webhook secret tidak valid' });
  }

  try {
    const result = await processPaymentCallback(req.body);
    return res.status(result.status || (result.ok ? 200 : 400)).json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memproses callback pembayaran',
      error: error.message,
    });
  }
});

module.exports = router;
