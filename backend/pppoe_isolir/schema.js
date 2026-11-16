/**
 * Skema & migrasi kolom isolir PPPoE (Walled Garden).
 *
 * Relasi dengan kolom yang SUDAH ADA di langganan_pelanggan:
 *   - status          ENUM('Aktif','Non Aktif','Isolir')  -> status isolir manual/otomatis
 *   - tgl_isolir      DATETIME  -> batas layanan penuh (dipakai backend/langganan_isolir.js saat ini)
 *   - jatuh_tempo     DATE      -> tanggal jatuh tempo tagihan (untuk cron isolir otomatis)
 *   - profil_id       INT       -> profil langganan / grup RADIUS MikroTik saat Aktif
 *
 * Kolom BARU (opsional, untuk Walled Garden + audit):
 */
const pool = require('../../database');
const { writeProfileReply } = require('../radius_group');

const SETTINGS_KEY = 'pppoe_isolir_group';
const DEFAULT_ISOLIR_GROUP = 'profil_isolir';

async function ensurePppoeIsolirSchema(db = pool) {
  await db.query(
    `ALTER TABLE langganan_pelanggan
      ADD COLUMN IF NOT EXISTS profil_id_sebelum_isolir INT NULL,
      ADD COLUMN IF NOT EXISTS tgl_isolir_dijalankan DATETIME NULL,
      ADD COLUMN IF NOT EXISTS isolir_sumber ENUM('manual','cron','jatuh_tempo','tgl_isolir') NULL`,
  );

  // Nama grup RADIUS / PPP Profile di MikroTik untuk walled garden (bisa diubah lewat settings).
  await db.query(
    `CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(64) PRIMARY KEY,
      setting_value VARCHAR(255) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
  );
  await db.execute(
    `INSERT INTO app_settings (setting_key, setting_value)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_key = setting_key`,
    [SETTINGS_KEY, process.env.PPPoE_ISOLIR_GROUP || DEFAULT_ISOLIR_GROUP],
  );

  await db.query(
    `ALTER TABLE routers
      ADD COLUMN IF NOT EXISTS api_user VARCHAR(64) NULL,
      ADD COLUMN IF NOT EXISTS api_password VARCHAR(128) NULL,
      ADD COLUMN IF NOT EXISTS api_port INT NULL`,
  );

  const isolirGroup = process.env.PPPoE_ISOLIR_GROUP || DEFAULT_ISOLIR_GROUP;
  await writeProfileReply(db, isolirGroup, '');
}

async function readIsolirGroupName(db = pool) {
  const [rows] = await db.execute(
    'SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1',
    [SETTINGS_KEY],
  );
  const value = String(rows[0]?.setting_value || '').trim();
  return value || DEFAULT_ISOLIR_GROUP;
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_ISOLIR_GROUP,
  ensurePppoeIsolirSchema,
  readIsolirGroupName,
};
