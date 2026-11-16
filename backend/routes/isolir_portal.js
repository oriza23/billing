/**
 * Portal pelanggan isolir (publik, tanpa JWT).
 * GET /api/isolir/me — identifikasi via IP sesi PPPoE + tagihan + QRIS dinamis.
 */

const express = require('express');
const pool = require('../../database');
const { resolveClientIp } = require('../payment/client_ip');
const { findCustomerBySessionIp } = require('../payment/resolve_customer_by_ip');
const { buildIsolirTagihan } = require('../payment/isolir_tagihan');
const {
  isolirDebugEnabled,
  listActiveSessionIps,
  buildDebugMeta,
} = require('../payment/isolir_debug');

const router = express.Router();

async function attachDebug(payload, clientIp) {
  if (!isolirDebugEnabled()) {
    return payload;
  }
  const activeSessions = await listActiveSessionIps(pool);
  return {
    ...payload,
    debug: {
      ...buildDebugMeta(clientIp),
      active_radacct_sessions: activeSessions,
    },
  };
}

router.get('/me', async (req, res) => {
  try {
    const clientIp = resolveClientIp(req);
    const lookup = await findCustomerBySessionIp(pool, clientIp);
    if (!lookup.ok) {
      const body = await attachDebug({
        success: false,
        message: lookup.message,
        ip: lookup.ip || clientIp,
      }, clientIp);
      return res.status(lookup.status).json(body);
    }

    const tagihan = await buildIsolirTagihan(req, pool);
    if (!tagihan.ok) {
      const body = await attachDebug({
        success: false,
        message: tagihan.message,
        ip: tagihan.ip,
      }, clientIp);
      return res.status(tagihan.status).json(body);
    }

    const { customer } = lookup;
    const payment = customer.status === 'Isolir' ? {
      total_tagihan: tagihan.nominal_tagihan_dasar,
      kode_unik: String(tagihan.kode_unik),
      amount_rupiah: tagihan.nominal_unik,
      qris_dynamic: tagihan.qris_dinamis_string,
      qris_configured: tagihan.qris_configured,
      error: tagihan.qris_error || undefined,
    } : null;

    const body = await attachDebug({
      success: true,
      ip: clientIp,
      session: {
        ip: customer.session_ip,
        mac: customer.mac_address || '',
        started_at: customer.session_start,
      },
      customer: {
        ...tagihan.customer,
        kode_unik: String(tagihan.kode_unik),
      },
      payment,
    }, clientIp);
    return res.json(body);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat data isolir',
      error: error.message,
    });
  }
});

/** Tagihan + QRIS dinamis (generateDynamicQRIS). */
router.get('/tagihan', async (req, res) => {
  try {
    const tagihan = await buildIsolirTagihan(req, pool);
    if (!tagihan.ok) {
      const body = await attachDebug({
        success: false,
        message: tagihan.message,
        ip: tagihan.ip,
      }, resolveClientIp(req));
      return res.status(tagihan.status).json(body);
    }

    const body = await attachDebug({
      success: true,
      ip: tagihan.ip,
      nominal_tagihan_dasar: tagihan.nominal_tagihan_dasar,
      kode_unik: tagihan.kode_unik,
      nominal_unik: tagihan.nominal_unik,
      qris_dinamis_string: tagihan.qris_dinamis_string,
      qris_configured: tagihan.qris_configured,
      qris_error: tagihan.qris_error,
      customer: tagihan.customer,
    }, tagihan.ip);
    return res.json(body);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat tagihan',
      error: error.message,
    });
  }
});

module.exports = router;
