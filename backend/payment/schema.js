const pool = require('../../database');

async function ensurePaymentSchema(db = pool) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS payment_mutations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      external_id VARCHAR(128) NULL,
      amount DECIMAL(15,2) NOT NULL,
      matched_langganan_id INT NULL,
      match_status ENUM('matched','no_match','ambiguous','duplicate') NOT NULL DEFAULT 'no_match',
      raw_payload JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_payment_external_id (external_id)
    )`,
  );

  // Satu baris = satu tagihan yang dikirim ke Payment Gateway ("Invoice/Order").
  await db.query(
    `CREATE TABLE IF NOT EXISTS payment_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id VARCHAR(50) NOT NULL,
      langganan_id INT NOT NULL,
      amount DECIMAL(15,2) NOT NULL,
      status ENUM('Pending','Lunas','Gagal','Kadaluarsa') NOT NULL DEFAULT 'Pending',
      snap_token VARCHAR(100) NULL,
      redirect_url VARCHAR(255) NULL,
      paid_at DATETIME NULL,
      reactivated_at DATETIME NULL,
      gateway_payload JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_payment_order_id (order_id),
      KEY idx_payment_order_langganan (langganan_id, status)
    )`,
  );

  await db.query(
    `CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(64) PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
  );
}

const QRIS_STATIC_KEY = 'qris_static_payload';

async function readQrisStaticPayload(db = pool) {
  try {
    const { readPaymentSettings } = require('./payment_settings');
    const cfg = await readPaymentSettings(db);
    if (cfg.qris.qris_string) {
      return cfg.qris.qris_string;
    }
  } catch {
    // fallback ke kunci legacy di bawah
  }
  const [rows] = await db.execute(
    'SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1',
    [QRIS_STATIC_KEY],
  );
  return String(rows[0]?.setting_value || process.env.QRIS_STATIC_PAYLOAD || '').trim();
}

module.exports = {
  ensurePaymentSchema,
  QRIS_STATIC_KEY,
  readQrisStaticPayload,
};
