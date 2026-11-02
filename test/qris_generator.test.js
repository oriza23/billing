const test = require('node:test');
const assert = require('node:assert/strict');
const { generateDynamicQRIS, crc16Ccitt, formatAmount } = require('../utils/qris-generator');

const tlv = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;

function makeStatic() {
  // 00 format, 01 POI statis (11), 26 merchant account, 52 MCC, 53 mata uang, 58 negara, 59 nama, 60 kota, 62 tambahan
  const body = [
    tlv('00', '01'),
    tlv('01', '11'),
    tlv('26', `${tlv('00', 'ID.CO.TEST')}${tlv('01', '1234')}`),
    tlv('52', '5812'),
    tlv('53', '360'),
    tlv('58', 'ID'),
    tlv('59', 'RANIAHNET'),
    tlv('60', 'JAKARTA'),
    tlv('62', tlv('07', 'A01')),
  ].join('');
  return `${body}6304${crc16Ccitt(`${body}6304`)}`;
}

test('crc16Ccitt: vektor baku "123456789" = 29B1', () => {
  assert.equal(crc16Ccitt('123456789'), '29B1');
});

test('formatAmount: 150000 -> "150000" (Tag 54 = 5406150000)', () => {
  assert.equal(formatAmount(150000), '150000');
  assert.equal(`54${String(formatAmount(150000).length).padStart(2, '0')}${formatAmount(150000)}`, '5406150000');
  assert.equal(formatAmount('150123'), '150123');
  assert.equal(formatAmount(1500.5), '1500.50');
});

test('formatAmount menolak nominal tidak valid', () => {
  for (const bad of [0, -1, NaN, 'abc', null, undefined, 1e15]) {
    assert.throws(() => formatAmount(bad), /Nominal/);
  }
});

test('generateDynamicQRIS: Tag 54 benar, urutan tag naik, POI 12, CRC valid', () => {
  const dynamic = generateDynamicQRIS(makeStatic(), 150000);

  assert.ok(dynamic.includes('5406150000'));
  assert.ok(dynamic.includes('010212'));
  assert.ok(!dynamic.includes('010211'));
  // Tag 54 tepat sebelum Tag 58.
  assert.ok(dynamic.includes('54061500005802ID'));
  // Header CRC hanya sekali di akhir.
  assert.equal(dynamic.match(/6304/g).length, 1);
  assert.match(dynamic, /6304[0-9A-F]{4}$/);

  const body = dynamic.slice(0, -4);
  assert.equal(dynamic.slice(-4), crc16Ccitt(body));
});

test('generateDynamicQRIS: Tag 54 lama diganti, bukan dobel', () => {
  const once = generateDynamicQRIS(makeStatic(), 100000);
  const twice = generateDynamicQRIS(once, 200000);
  assert.equal(twice.match(/54\d\d\d/g)?.filter((m) => m.startsWith('5406')).length, 1);
  assert.ok(twice.includes('5406200000'));
  assert.ok(!twice.includes('5406100000'));
});

test('generateDynamicQRIS menolak input rusak', () => {
  assert.throws(() => generateDynamicQRIS('', 1000), /kosong/);
  assert.throws(() => generateDynamicQRIS('0002010102115802ID', 1000), /Tag CRC/);
  assert.throws(() => generateDynamicQRIS('00020199996304ABCD', 1000), /rusak/);
  assert.throws(() => generateDynamicQRIS(makeStatic(), 0), /Nominal/);
});
