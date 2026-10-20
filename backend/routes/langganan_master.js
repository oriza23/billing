const express = require('express');
const pool = require('../../database');

// Master data sederhana (id + nama) untuk dropdown di form langganan.
// `table` dan `legacyColumn` berasal dari konstanta di bawah, bukan dari input pengguna.
function createMasterRouter({ table, legacyColumn, label }) {
  const router = express.Router();

  router.ensureTable = async function ensureTable() {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nama VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
    );
    // Salin nilai yang sudah pernah dipakai di data langganan (aman diulang, nama bersifat unik).
    await pool.query(
      `INSERT IGNORE INTO ${table} (nama)
       SELECT DISTINCT TRIM(${legacyColumn}) FROM langganan_pelanggan
       WHERE ${legacyColumn} IS NOT NULL AND TRIM(${legacyColumn}) <> '' AND CHAR_LENGTH(TRIM(${legacyColumn})) <= 100`,
    );
  };

  router.get('/', async (req, res) => {
    try {
      const [rows] = await pool.query(`SELECT id, nama FROM ${table} ORDER BY nama ASC`);
      res.json(rows);
    } catch (error) {
      res.status(500).json({
        success: false,
        message: `Gagal mengambil data ${label}`,
        error: error.message,
      });
    }
  });

  // Jika nama sudah ada, data yang ada dikembalikan (tanpa error) agar form langsung bisa memakainya.
  router.post('/', async (req, res) => {
    const nama = typeof req.body?.nama === 'string' ? req.body.nama.trim() : '';
    if (!nama || nama.length > 100) {
      return res.status(400).json({
        success: false,
        message: `Nama ${label} wajib diisi (maksimal 100 karakter)`,
      });
    }

    try {
      await pool.execute(`INSERT IGNORE INTO ${table} (nama) VALUES (?)`, [nama]);
      const [rows] = await pool.execute(`SELECT id, nama FROM ${table} WHERE nama = ? LIMIT 1`, [nama]);
      return res.json({ success: true, ...rows[0] });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: `Gagal menyimpan ${label}`,
        error: error.message,
      });
    }
  });

  return router;
}

// Wilayah memakai tabel & route sendiri (data_wilayah, /api/wilayah), lihat routes/wilayah.js.
const serverRouter = createMasterRouter({ table: 'master_server', legacyColumn: 'server', label: 'server' });

module.exports = {
  serverRouter,
  async ensureTables() {
    await serverRouter.ensureTable();
  },
};
