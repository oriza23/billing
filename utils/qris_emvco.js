/**
 * Konversi QRIS Statis → Dinamis (EMVCo QR Code / QRIS Indonesia).
 * Menyisipkan Tag 54 (Transaction Amount), mempertahankan Tag 58 (Country), menghitung ulang Tag 63 (CRC16-CCITT).
 *
 * Referensi: EMVCo QR Code Specification for Payment Systems (Merchant Presented Mode).
 */

const TAG_CRC = '63';
const TAG_AMOUNT = '54';
const TAG_COUNTRY = '58';
const TAG_POI = '01';

/** CRC16-CCITT-FALSE (poly 0x1021, init 0xFFFF) — dipakai QRIS/EMV. */
function crc16CcittFalse(input) {
  let crc = 0xffff;
  const buf = Buffer.from(String(input), 'utf8');
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i] << 8;
    for (let j = 0; j < 8; j += 1) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function encodeTlv(id, value) {
  const v = String(value);
  const len = v.length.toString().padStart(2, '0');
  if (id.length !== 2 || len.length !== 2) {
    throw new Error('Format TLV tidak valid');
  }
  return `${id}${len}${v}`;
}

/** Parse payload EMV menjadi array berurutan [{ id, value }]. */
function parseTlvSequence(payload) {
  const tags = [];
  let index = 0;
  const text = String(payload || '').trim();
  while (index + 4 <= text.length) {
    const id = text.slice(index, index + 2);
    const length = Number.parseInt(text.slice(index + 2, index + 4), 10);
    if (!Number.isFinite(length) || length < 0 || index + 4 + length > text.length) {
      throw new Error(`TLV rusak di posisi ${index} (tag ${id})`);
    }
    const value = text.slice(index + 4, index + 4 + length);
    tags.push({ id, value });
    index += 4 + length;
  }
  if (index !== text.length) {
    throw new Error('Sisa byte payload EMV tidak terpakai');
  }
  return tags;
}

/** Buang Tag 63 dari urutan TLV. */
function stripCrcTag(tags) {
  return tags.filter((tag) => tag.id !== TAG_CRC);
}

function upsertTag(tags, id, value) {
  const next = tags.filter((tag) => tag.id !== id);
  const countryIndex = next.findIndex((tag) => tag.id === TAG_COUNTRY);
  const insertAt = id === TAG_AMOUNT && countryIndex >= 0 ? countryIndex : next.length;
  next.splice(insertAt, 0, { id, value });
  return next;
}

function serializeTags(tags) {
  return tags.map((tag) => encodeTlv(tag.id, tag.value)).join('');
}

/**
 * Nominal Rupiah bulat → string Tag 54 (2 desimal), mis. 150123 → "150123.00".
 */
function formatAmountTag54(amountRupiah) {
  const amount = Number(amountRupiah);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Nominal tagihan harus angka positif');
  }
  return amount.toFixed(2);
}

/**
 * @param {string} staticPayload  string QRIS statis (hasil scan / copy dari bank)
 * @param {number} amountRupiah   nominal final (tagihan + kode unik), integer Rupiah
 * @returns {string} payload dinamis siap di-render QR Code
 */
function buildDynamicQris(staticPayload, amountRupiah) {
  const raw = String(staticPayload || '').trim();
  if (!raw) {
    throw new Error('Payload QRIS statis kosong');
  }

  let tags = parseTlvSequence(raw);
  tags = stripCrcTag(tags);

  const poi = tags.find((tag) => tag.id === TAG_POI);
  if (poi && poi.value === '11') {
    poi.value = '12';
  } else if (!poi) {
    tags.unshift({ id: TAG_POI, value: '12' });
  }

  if (!tags.some((tag) => tag.id === TAG_COUNTRY)) {
    tags = upsertTag(tags, TAG_COUNTRY, 'ID');
  }

  tags = upsertTag(tags, TAG_AMOUNT, formatAmountTag54(amountRupiah));

  const body = serializeTags(tags);
  const crc = crc16CcittFalse(`${body}6304`);
  return `${body}${encodeTlv(TAG_CRC, crc)}`;
}

/**
 * Hitung nominal pembayaran: total tagihan (bulat) + kode unik 3 digit (10–999).
 */
function computePaymentAmount(totalTagihan, kodeUnik) {
  const base = Math.round(Number(totalTagihan) || 0);
  const suffix = Number.parseInt(String(kodeUnik || ''), 10);
  if (!Number.isFinite(base) || base <= 0) {
    throw new Error('Total tagihan tidak valid');
  }
  if (!Number.isFinite(suffix) || suffix < 10 || suffix > 999) {
    throw new Error('Kode unik harus 3 digit (10–999)');
  }
  return base + suffix;
}

/**
 * Pecah nominal mutasi masuk → { base, suffix } untuk pencocokan kode unik.
 */
function splitPaymentAmount(amountRupiah) {
  const amount = Math.round(Number(amountRupiah) || 0);
  if (amount <= 0) {
    return null;
  }
  const suffix = amount % 1000;
  const base = amount - suffix;
  if (suffix < 10) {
    return null;
  }
  return { amount, base, suffix: String(suffix) };
}

module.exports = {
  crc16CcittFalse,
  parseTlvSequence,
  buildDynamicQris,
  computePaymentAmount,
  splitPaymentAmount,
  formatAmountTag54,
};
