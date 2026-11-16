/**
 * Tagihan isolir + QRIS dinamis (identifikasi pelanggan via IP sesi PPPoE).
 */

const { generateDynamicQRIS } = require('../../utils/qris-generator');
const { readQrisStaticPayload } = require('./schema');
const { readPaymentSettings } = require('./payment_settings');
const { resolveClientIp } = require('./client_ip');
const { findCustomerBySessionIp } = require('./resolve_customer_by_ip');

/** Kode unik 3 digit (10–999) agar mutasi bank bisa dicocokkan di payment_service. */
function resolveKodeUnik(customerId, kodeUnikFromDb) {
  const parsed = Number.parseInt(String(kodeUnikFromDb || ''), 10);
  if (Number.isFinite(parsed) && parsed >= 10 && parsed <= 999) {
    return parsed;
  }
  let suffix = Math.abs(Number(customerId) || 0) % 1000;
  if (suffix < 10) {
    suffix += 10;
  }
  return suffix;
}

function buildNominalUnik(customer) {
  const base = Math.round(Number(customer.total) || 0);
  if (base <= 0) {
    throw new Error('Total tagihan tidak valid');
  }
  const kodeUnik = resolveKodeUnik(customer.id, customer.kode_unik);
  return {
    nominal_tagihan_dasar: base,
    kode_unik: kodeUnik,
    nominal_unik: base + kodeUnik,
  };
}

async function readQrisString(db) {
  const settings = await readPaymentSettings(db);
  const fromSettings = String(settings.qris?.qris_string || '').trim();
  if (fromSettings) {
    return fromSettings;
  }
  return readQrisStaticPayload(db);
}

/**
 * @returns {Promise<object>} payload sukses atau { ok: false, status, message, ip? }
 */
async function buildIsolirTagihan(req, db) {
  const clientIp = resolveClientIp(req);
  const lookup = await findCustomerBySessionIp(db, clientIp);
  if (!lookup.ok) {
    return {
      ok: false,
      status: lookup.status,
      message: lookup.message,
      ip: lookup.ip || clientIp,
    };
  }

  const { customer } = lookup;
  const amounts = buildNominalUnik(customer);
  const qrisStatic = await readQrisString(db);

  let qris_dinamis_string = null;
  let qris_error = null;
  if (customer.status === 'Isolir' && qrisStatic) {
    try {
      qris_dinamis_string = generateDynamicQRIS(qrisStatic, amounts.nominal_unik);
    } catch (error) {
      qris_error = error.message;
    }
  } else if (customer.status === 'Isolir' && !qrisStatic) {
    qris_error = 'String QRIS statis belum dikonfigurasi (Pengaturan Payment)';
  }

  return {
    ok: true,
    ip: clientIp,
    nominal_tagihan_dasar: amounts.nominal_tagihan_dasar,
    kode_unik: amounts.kode_unik,
    nominal_unik: amounts.nominal_unik,
    qris_dinamis_string,
    qris_configured: Boolean(qrisStatic),
    qris_error,
    customer: {
      id: customer.id,
      pelanggan: customer.pelanggan,
      username: customer.username,
      nolayanan: customer.nolayanan,
      status: customer.status,
      total: amounts.nominal_tagihan_dasar,
      jatuh_tempo: customer.jatuh_tempo,
      phone: customer.phone || '',
    },
  };
}

module.exports = {
  resolveKodeUnik,
  buildNominalUnik,
  buildIsolirTagihan,
  readQrisString,
};
