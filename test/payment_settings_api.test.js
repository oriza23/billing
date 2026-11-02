const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  readPaymentSettings,
  writePaymentSettings,
  applyPaymentSettingsUpdate,
  toAdminResponse,
  normalizeSettings,
} = require('../backend/payment/payment_settings');

function memoryDb(initial = new Map()) {
  const store = new Map(initial);
  return {
    store,
    async execute(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (q.startsWith('SELECT setting_value FROM app_settings WHERE setting_key = ?')) {
        const val = store.get(params[0]);
        return [[val != null ? { setting_value: val } : undefined].filter(Boolean)];
      }
      if (q.startsWith('INSERT INTO app_settings')) {
        store.set(params[0], params[1]);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`SQL tidak dikenal: ${q.slice(0, 80)}`);
    },
  };
}

test('normalizeSettings: default qris aktif, fee null jika kosong', () => {
  const s = normalizeSettings({});
  assert.equal(s.active_gateway, 'qris');
  assert.equal(s.tripay.environment, 'sandbox');
  assert.equal(s.qris.qris_fee_nontunai, null);
});

test('writePaymentSettings menyimpan JSON dan sinkron qris_static_payload', async () => {
  const db = memoryDb();
  await writePaymentSettings({
    active_gateway: 'qris',
    qris: { qris_string: '0002010102115204000053033605802ID' },
  }, db);
  assert.ok(db.store.get('payment_gateway_config').includes('000201'));
  assert.equal(db.store.get('qris_static_payload'), '0002010102115204000053033605802ID');
});

test('readPaymentSettings migrasi dari qris_static_payload legacy', async () => {
  const db = memoryDb(new Map([['qris_static_payload', 'LEGACY-QRIS-STRING']]));
  const s = await readPaymentSettings(db);
  assert.equal(s.qris.qris_string, 'LEGACY-QRIS-STRING');
});

test('applyPaymentSettingsUpdate: secret kosong mempertahankan api_key lama', async () => {
  const db = memoryDb();
  await writePaymentSettings({
    tripay: { api_key: 'secret-old', private_key: 'priv-old', merchant_code: 'T1' },
  }, db);
  const saved = await applyPaymentSettingsUpdate({
    tripay_merchant_code: 'T2',
    tripay_api_key: '',
    tripay_private_key: '   ',
  }, {}, db);
  assert.equal(saved.tripay.merchant_code, 'T2');
  assert.equal(saved.tripay.api_key, 'secret-old');
  assert.equal(saved.tripay.private_key, 'priv-old');
});

test('applyPaymentSettingsUpdate menolak active_gateway tidak valid', async () => {
  const db = memoryDb();
  await assert.rejects(
    applyPaymentSettingsUpdate({ active_gateway: 'midtrans' }, {}, db),
    (e) => e.statusCode === 400,
  );
});

test('toAdminResponse menyembunyikan secret penuh', () => {
  const view = toAdminResponse(normalizeSettings({
    tripay: { api_key: 'abc12345', private_key: 'xyz98765' },
  }));
  assert.equal(view.tripay.api_key_configured, true);
  assert.equal(view.tripay.api_key_preview, '••••2345');
  assert.equal(view.tripay.private_key_configured, true);
  assert.equal(view.tripay.api_key, undefined);
});

test('upload route: multer menyimpan file ke uploads/qris', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-qris-'));
  const uploadDir = path.join(tmpRoot, 'uploads', 'qris');
  fs.mkdirSync(uploadDir, { recursive: true });
  const fakeFile = path.join(uploadDir, 'qris-static.png');
  fs.writeFileSync(fakeFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.ok(fs.existsSync(fakeFile));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
