const pool = require('../../database');
const { splitPaymentAmount } = require('../../utils/qris_emvco');
const { resolveKodeUnik } = require('./isolir_tagihan');
const { bukaIsolirPelangganFullRadius } = require('../pppoe_isolir/isolir_full_radius');

const AMOUNT_TOLERANCE = 1;

async function findCustomerByPaymentAmount(db, amountRupiah) {
  const parts = splitPaymentAmount(amountRupiah);
  if (!parts) {
    return { ok: false, reason: 'Nominal tidak memuat kode unik 3 digit (suffix >= 10)' };
  }

  const [rows] = await db.execute(
    `SELECT id, pelanggan, username, status, total, kode_unik
     FROM langganan_pelanggan
     WHERE status = 'Isolir'
       AND ABS(total - ?) <= ?`,
    [parts.base, AMOUNT_TOLERANCE],
  );
  const matched = rows.filter(
    (row) => resolveKodeUnik(row.id, row.kode_unik) === parts.suffix,
  );

  if (matched.length === 0) {
    return { ok: false, reason: 'Tidak ada pelanggan Isolir dengan nominal & kode unik tersebut', parts };
  }
  if (matched.length > 1) {
    return { ok: false, reason: 'Lebih dari satu pelanggan cocok (ambiguous)', parts, candidates: matched };
  }

  return { ok: true, customer: matched[0], parts };
}

function extractWebhookAmount(body) {
  const candidates = [
    body?.amount,
    body?.nominal,
    body?.credit,
    body?.saldo,
    body?.data?.amount,
    body?.data?.nominal,
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return Math.round(num);
    }
  }
  return null;
}

function extractExternalId(body) {
  return String(
    body?.id
    ?? body?.mutation_id
    ?? body?.transaction_id
    ?? body?.data?.id
    ?? '',
  ).trim() || null;
}

async function logMutation(db, {
  externalId,
  amount,
  matchedLanggananId,
  matchStatus,
  rawPayload,
}) {
  try {
    await db.execute(
      `INSERT INTO payment_mutations (external_id, amount, matched_langganan_id, match_status, raw_payload)
       VALUES (?, ?, ?, ?, ?)`,
      [
        externalId,
        amount,
        matchedLanggananId,
        matchStatus,
        JSON.stringify(rawPayload || {}),
      ],
    );
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY' && externalId) {
      return { duplicate: true };
    }
    throw error;
  }
  return { duplicate: false };
}

/**
 * Proses mutasi masuk → cocokkan tagihan → buka isolir Full RADIUS.
 */
async function processPaymentCallback(body, db = pool) {
  const amount = extractWebhookAmount(body);
  if (amount == null) {
    return { ok: false, status: 400, message: 'Nominal mutasi tidak ditemukan di payload' };
  }

  const externalId = extractExternalId(body);
  if (externalId) {
    const [existing] = await db.execute(
      'SELECT id FROM payment_mutations WHERE external_id = ? LIMIT 1',
      [externalId],
    );
    if (existing.length > 0) {
      return { ok: true, status: 200, duplicate: true, message: 'Mutasi sudah pernah diproses' };
    }
  }

  const match = await findCustomerByPaymentAmount(db, amount);
  if (!match.ok) {
    await logMutation(db, {
      externalId,
      amount,
      matchedLanggananId: null,
      matchStatus: match.candidates ? 'ambiguous' : 'no_match',
      rawPayload: body,
    });
    return {
      ok: false,
      status: match.candidates ? 409 : 404,
      message: match.reason,
      amount,
      parts: match.parts,
    };
  }

  const { customer } = match;
  const reactivate = await bukaIsolirPelangganFullRadius(customer.id, { kick: true }, db)
    .catch(async (error) => {
      await logMutation(db, {
        externalId,
        amount,
        matchedLanggananId: customer.id,
        matchStatus: 'no_match',
        rawPayload: { ...body, reactivateError: error.message },
      });
      throw error;
    });

  await logMutation(db, {
    externalId,
    amount,
    matchedLanggananId: customer.id,
    matchStatus: 'matched',
    rawPayload: body,
  });

  return {
    ok: true,
    status: 200,
    message: 'Pembayaran cocok, isolir dibuka',
    amount,
    customer: {
      id: customer.id,
      username: customer.username,
      pelanggan: customer.pelanggan,
    },
    reactivate,
  };
}

module.exports = {
  findCustomerByPaymentAmount,
  extractWebhookAmount,
  processPaymentCallback,
};
