/**
 * Generator QRIS Dinamis (EMVCo MPM) dari string QRIS Statis. Mandiri, tanpa library eksternal.
 *
 * Alur generateDynamicQRIS(staticQris, amount):
 *  1. Validasi string statis berakhiran Tag 63 (`6304` + 4 hex CRC), lalu buang 8 karakter itu
 *     (header 6304 + CRC lama). Header ditambahkan lagi satu kali di langkah 4.
 *  2. Ubah Tag 01 (Point of Initiation) 11 (statis) -> 12 (dinamis).
 *  3. Sisipkan Tag 54 (Transaction Amount) = "54" + panjang 2 digit + nominal,
 *     contoh 150000 -> "5406150000". Disisipkan sesuai urutan tag EMVCo (sebelum Tag 58),
 *     Tag 54 lama (bila ada) diganti.
 *  4. Tambahkan "6304", hitung CRC16-CCITT (poly 0x1021, init 0xFFFF) atas seluruh string
 *     termasuk "6304", ubah ke 4 hex uppercase, tempelkan di akhir.
 */

const TAG_POI = '01';
const TAG_AMOUNT = '54';
const CRC_HEADER = '6304';
const MAX_AMOUNT_LENGTH = 13; // batas EMVCo untuk Tag 54

/**
 * CRC16-CCITT (False): polinomial 0x1021, nilai awal 0xFFFF, tanpa reflect/xor akhir.
 * @param {string} input
 * @returns {string} 4 digit heksadesimal uppercase
 */
function crc16Ccitt(input) {
  let crc = 0xffff;
  const bytes = Buffer.from(String(input), 'utf8');
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Pecah payload EMV (tanpa Tag 63) menjadi [{ id, value }]; melempar error bila TLV rusak. */
function parseTlv(payload) {
  const tags = [];
  let index = 0;
  while (index < payload.length) {
    if (index + 4 > payload.length) {
      throw new Error(`QRIS statis rusak: TLV terpotong di posisi ${index}`);
    }
    const id = payload.slice(index, index + 2);
    const lengthText = payload.slice(index + 2, index + 4);
    const length = Number(lengthText);
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(lengthText)) {
      throw new Error(`QRIS statis rusak: header TLV tidak valid di posisi ${index}`);
    }
    if (index + 4 + length > payload.length) {
      throw new Error(`QRIS statis rusak: panjang tag ${id} melebihi payload`);
    }
    tags.push({ id, value: payload.slice(index + 4, index + 4 + length) });
    index += 4 + length;
  }
  return tags;
}

/** Nominal -> teks Tag 54: bulat tanpa desimal ("150000"), pecahan 2 desimal ("150000.50"). */
function formatAmount(amount) {
  const n = typeof amount === 'string' ? Number(amount.trim()) : amount;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw new Error('Nominal harus angka positif');
  }
  const text = Number.isInteger(n) ? String(n) : n.toFixed(2);
  if (text.length > MAX_AMOUNT_LENGTH) {
    throw new Error(`Nominal terlalu panjang (maks ${MAX_AMOUNT_LENGTH} karakter)`);
  }
  return text;
}

/**
 * @param {string} staticQris string QRIS statis (berakhiran 6304XXXX)
 * @param {number|string} amount nominal Rupiah
 * @returns {string} string QRIS dinamis utuh
 */
function generateDynamicQRIS(staticQris, amount) {
  const raw = String(staticQris || '').trim();
  if (!raw) {
    throw new Error('String QRIS statis kosong');
  }
  if (!new RegExp(`${CRC_HEADER}[0-9A-Fa-f]{4}$`).test(raw)) {
    throw new Error('String QRIS statis tidak berakhiran Tag CRC (6304 + 4 hex)');
  }

  // Langkah 1: buang "6304" + CRC lama.
  const body = raw.slice(0, -(CRC_HEADER.length + 4));
  let tags = parseTlv(body);

  // Langkah 2: statis (11) -> dinamis (12).
  const poi = tags.find((tag) => tag.id === TAG_POI);
  if (poi) {
    poi.value = '12';
  } else {
    tags.unshift({ id: TAG_POI, value: '12' });
  }

  // Langkah 3: Tag 54 menggantikan yang lama dan masuk sesuai urutan naik.
  tags = tags.filter((tag) => tag.id !== TAG_AMOUNT);
  const amountText = formatAmount(amount);
  let insertAt = tags.findIndex((tag) => tag.id > TAG_AMOUNT);
  if (insertAt === -1) {
    insertAt = tags.length;
  }
  tags.splice(insertAt, 0, { id: TAG_AMOUNT, value: amountText });

  const withoutCrc = tags
    .map((tag) => `${tag.id}${String(tag.value.length).padStart(2, '0')}${tag.value}`)
    .join('');

  // Langkah 4-6: header CRC, hitung checksum, gabungkan.
  const crcInput = `${withoutCrc}${CRC_HEADER}`;
  return `${crcInput}${crc16Ccitt(crcInput)}`;
}

module.exports = { generateDynamicQRIS, crc16Ccitt, formatAmount };
