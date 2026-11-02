const test = require('node:test');
const assert = require('node:assert/strict');
const {
  crc16CcittFalse,
  buildDynamicQris,
  computePaymentAmount,
  splitPaymentAmount,
} = require('../utils/qris_emvco');

test('computePaymentAmount menambah kode unik ke total', () => {
  assert.equal(computePaymentAmount(150000, 123), 150123);
});

test('splitPaymentAmount memecah nominal mutasi', () => {
  assert.deepEqual(splitPaymentAmount(150123), { amount: 150123, base: 150000, suffix: '123' });
  assert.equal(splitPaymentAmount(150005), null);
});

test('buildDynamicQris menyisipkan Tag 54 dan CRC baru', () => {
  const body = '0002010102115204000053033605802ID5909RANIAHNET6007JAKARTA';
  const staticPayload = `${body}6304${crc16CcittFalse(`${body}6304`)}`;

  const dynamic = buildDynamicQris(staticPayload, 150123);
  assert.match(dynamic, /54\d{2}150123\.00/);
  assert.match(dynamic, /5802ID/);
  assert.match(dynamic, /6304[0-9A-F]{4}$/);

  const crcTag = dynamic.slice(-8);
  const dynamicBody = dynamic.slice(0, -8);
  assert.equal(crcTag, `6304${crc16CcittFalse(`${dynamicBody}6304`)}`);
});
