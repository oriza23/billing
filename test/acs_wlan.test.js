const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWlanUpdate, planWlanUpdate, passwordPathFor } = require('../backend/acs_wlan');

const ok = { deviceId: 'ONU-1', wlanId: 1, ssid: 'Rumah', password: 'sandi1234', status: true };
const v = (value) => ({ _value: value });
const BASE = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1';

test('parseWlanUpdate: input valid dinormalisasi', () => {
  assert.deepEqual(parseWlanUpdate(ok).value, { deviceId: 'ONU-1', wlanId: '1', ssid: 'Rumah', password: 'sandi1234', status: true });
  assert.deepEqual(parseWlanUpdate({ ...ok, wlanId: '05', password: '' }).value.wlanId, '5');
  assert.equal(parseWlanUpdate({ ...ok, password: undefined }).value.password, '');
  assert.equal(parseWlanUpdate({ ...ok, status: false }).value.status, false);
  assert.equal(parseWlanUpdate({ ...ok, ssid: 'x'.repeat(32) }).error, undefined);
});

test('parseWlanUpdate: menolak input berbahaya / tidak valid', () => {
  const bad = (override) => parseWlanUpdate({ ...ok, ...override }).error;
  assert.ok(bad({ deviceId: '' }));
  assert.ok(bad({ deviceId: 5 }));
  assert.ok(bad({ wlanId: '1.SSID' }), 'wlanId tidak boleh menyisipkan path');
  assert.ok(bad({ wlanId: '../2' }));
  assert.ok(bad({ wlanId: 0 }));
  assert.ok(bad({ wlanId: 17 }));
  assert.ok(bad({ wlanId: '' }));
  assert.ok(bad({ ssid: '' }));
  assert.ok(bad({ ssid: 'x'.repeat(33) }));
  assert.ok(bad({ ssid: 'a\nb' }), 'karakter kontrol');
  assert.ok(bad({ ssid: 'é'.repeat(17) }), 'batas 32 byte, bukan 32 karakter');
  assert.ok(bad({ password: '1234567' }), 'terlalu pendek');
  assert.ok(bad({ password: 'x'.repeat(64) }), 'terlalu panjang');
  assert.ok(bad({ password: 'sandi\u00e9123' }), 'non-ASCII');
  assert.ok(bad({ password: 12345678 }));
  assert.ok(bad({ status: 'true' }), 'status harus boolean sungguhan');
  assert.ok(bad({ status: undefined }));
  assert.ok(parseWlanUpdate(null).error);
});

test('planWlanUpdate: hanya parameter yang berubah, dengan tipe XSD yang benar', () => {
  const node = { SSID: v('Lama'), Enable: v('0'), PreSharedKey: { 1: { PreSharedKey: v('lama12345') } } };
  const { parameterValues, changed } = planWlanUpdate({ wlanId: '1', wlanNode: node, ssid: 'Baru', password: 'baru12345', status: true });
  assert.deepEqual(parameterValues, [
    [`${BASE}.SSID`, 'Baru', 'xsd:string'],
    [`${BASE}.Enable`, true, 'xsd:boolean'],
    [`${BASE}.PreSharedKey.1.PreSharedKey`, 'baru12345', 'xsd:string'],
  ]);
  assert.deepEqual(changed, ['ssid', 'status', 'password']);
});

test('planWlanUpdate: tidak ada perubahan -> tidak ada parameter', () => {
  const node = { SSID: v('Rumah'), Enable: v(true), PreSharedKey: { 1: { PreSharedKey: v('sandi1234') } } };
  assert.deepEqual(planWlanUpdate({ wlanId: '1', wlanNode: node, ssid: 'Rumah', password: 'sandi1234', status: true }), { parameterValues: [], changed: [] });
  assert.deepEqual(planWlanUpdate({ wlanId: '1', wlanNode: node, ssid: 'Rumah', password: '', status: true }).changed, []);
});

test('planWlanUpdate: password kosong tidak mengirim apa pun; status false dikirim sebagai boolean', () => {
  const node = { SSID: v('Rumah'), Enable: v('1') };
  const plan = planWlanUpdate({ wlanId: '2', wlanNode: node, ssid: 'Rumah', password: '', status: false });
  assert.deepEqual(plan.parameterValues, [['InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.Enable', false, 'xsd:boolean']]);
});

test('planWlanUpdate: sandi yang hanya dibaca ACS tersembunyi tetap dikirim bila diisi', () => {
  const node = { SSID: v('Rumah'), Enable: v(true), PreSharedKey: { 1: { PreSharedKey: v('') } } };
  const plan = planWlanUpdate({ wlanId: '1', wlanNode: node, ssid: 'Rumah', password: 'sandi1234', status: true });
  assert.deepEqual(plan.changed, ['password']);
});

test('passwordPathFor: memilih path sandi yang ada di ONU', () => {
  assert.equal(passwordPathFor('1', { PreSharedKey: { 1: { PreSharedKey: v('x') } } }), `${BASE}.PreSharedKey.1.PreSharedKey`);
  assert.equal(passwordPathFor('1', { PreSharedKey: { 1: { PreSharedKey: v('x'), KeyPassphrase: v('y') } } }), `${BASE}.PreSharedKey.1.PreSharedKey`);
  assert.equal(passwordPathFor('1', { PreSharedKey: { 1: { KeyPassphrase: v('y') } } }), `${BASE}.PreSharedKey.1.KeyPassphrase`);
  assert.equal(passwordPathFor('1', { KeyPassphrase: v('y') }), `${BASE}.KeyPassphrase`);
  assert.equal(passwordPathFor('1', {}), `${BASE}.PreSharedKey.1.PreSharedKey`);
});
