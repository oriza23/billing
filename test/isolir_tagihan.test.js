const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveKodeUnik, buildNominalUnik } = require('../backend/payment/isolir_tagihan');
const { generateDynamicQRIS, crc16Ccitt } = require('../utils/qris-generator');

test('resolveKodeUnik: pakai DB bila valid, else 3 digit dari ID', () => {
  assert.equal(resolveKodeUnik(42, '123'), 123);
  assert.equal(resolveKodeUnik(150123, ''), 123);
  assert.equal(resolveKodeUnik(5, ''), 15);
});

test('buildNominalUnik menjumlahkan tagihan + kode unik', () => {
  const r = buildNominalUnik({ id: 7, total: 150000, kode_unik: '123' });
  assert.equal(r.nominal_tagihan_dasar, 150000);
  assert.equal(r.kode_unik, 123);
  assert.equal(r.nominal_unik, 150123);
});

test('generateDynamicQRIS terintegrasi dengan nominal unik', () => {
  const tlv = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;
  const body = [
    tlv('00', '01'),
    tlv('01', '11'),
    tlv('58', 'ID'),
    tlv('59', 'TEST'),
  ].join('');
  const staticQris = `${body}6304${crc16Ccitt(`${body}6304`)}`;
  const dynamic = generateDynamicQRIS(staticQris, 150123);
  assert.ok(dynamic.includes('5406150123'));
});
