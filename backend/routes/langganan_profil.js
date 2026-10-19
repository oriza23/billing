const express = require('express');
const pool = require('../../database');

const router = express.Router();

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readMoney(value) {
  if (value === '' || value == null) {
    return 0;
  }
  const number = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }
  return Math.round(number * 100) / 100;
}

function readShared(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    return null;
  }
  return number;
}

function readColor(value) {
  const color = readText(value) || '#000000';
  return /^#[0-9A-Fa-f]{6}$/.test(color) ? color.toLowerCase() : null;
}

function readProfileBody(body) {
  return {
    nama_profile: readText(body?.nama_profile),
    warna_dot: readColor(body?.warna_dot),
    tipe: readText(body?.tipe) || 'Rumahan',
    media: readText(body?.media) || 'Fiber Optic',
    group_name: readText(body?.group_name),
    rate_limit: readText(body?.rate_limit),
    shared: readShared(body?.shared ?? 1),
    masa_aktif: readText(body?.masa_aktif) || '30 Hari',
    hpp: readMoney(body?.hpp),
    komisi: readMoney(body?.komisi),
    harga: readMoney(body?.harga),
  };
}

function profileIsValid(profile) {
  return Boolean(profile.nama_profile)
    && profile.warna_dot
    && profile.shared
    && profile.hpp != null
    && profile.komisi != null
    && profile.harga != null;
}

function mapProfile(row) {
  return {
    id: row.id,
    nama_profile: row.nama_profile,
    warna_dot: row.warna_dot,
    tipe: row.tipe,
    media: row.media,
    group_name: row.group_name,
    rate_limit: row.rate_limit,
    shared: Number(row.shared) || 0,
    masa_aktif: row.masa_aktif,
    hpp: Number(row.hpp) || 0,
    komisi: Number(row.komisi) || 0,
    harga: Number(row.harga) || 0,
    created_at: row.created_at,
    jumlah_pelanggan: 0,
  };
}

async function ensureTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS langganan_profiles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nama_profile VARCHAR(100) NOT NULL,
      warna_dot VARCHAR(7) DEFAULT '#000000',
      tipe VARCHAR(50) DEFAULT 'Rumahan',
      media VARCHAR(50) DEFAULT 'Fiber Optic',
      group_name VARCHAR(100),
      rate_limit VARCHAR(50),
      shared INT DEFAULT 1,
      masa_aktif VARCHAR(50) DEFAULT '30 Hari',
      hpp DECIMAL(12,2) DEFAULT 0,
      komisi DECIMAL(12,2) DEFAULT 0,
      harga DECIMAL(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
  );
}

router.ensureTable = ensureTable;

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, nama_profile, warna_dot, tipe, media, group_name, rate_limit, shared,
        masa_aktif, hpp, komisi, harga, created_at, 0 AS jumlah_pelanggan
       FROM langganan_profiles
       ORDER BY id DESC`,
    );
    res.json(rows.map(mapProfile));
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil profil langganan',
      error: error.message,
    });
  }
});

router.post('/', async (req, res) => {
  const profile = readProfileBody(req.body);
  if (!profileIsValid(profile)) {
    return res.status(400).json({
      success: false,
      message: 'Data profil belum lengkap atau tidak valid',
    });
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO langganan_profiles
        (nama_profile, warna_dot, tipe, media, group_name, rate_limit, shared, masa_aktif, hpp, komisi, harga)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        profile.nama_profile,
        profile.warna_dot,
        profile.tipe,
        profile.media,
        profile.group_name,
        profile.rate_limit,
        profile.shared,
        profile.masa_aktif,
        profile.hpp,
        profile.komisi,
        profile.harga,
      ],
    );
    return res.json({
      success: true,
      message: 'Profil langganan berhasil disimpan',
      id: result.insertId,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menyimpan profil langganan',
      error: error.message,
    });
  }
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const profile = readProfileBody(req.body);
  if (!Number.isInteger(id) || id < 1 || !profileIsValid(profile)) {
    return res.status(400).json({
      success: false,
      message: 'Data profil belum lengkap atau tidak valid',
    });
  }

  try {
    const [result] = await pool.execute(
      `UPDATE langganan_profiles
       SET nama_profile = ?, warna_dot = ?, tipe = ?, media = ?, group_name = ?, rate_limit = ?,
           shared = ?, masa_aktif = ?, hpp = ?, komisi = ?, harga = ?
       WHERE id = ?`,
      [
        profile.nama_profile,
        profile.warna_dot,
        profile.tipe,
        profile.media,
        profile.group_name,
        profile.rate_limit,
        profile.shared,
        profile.masa_aktif,
        profile.hpp,
        profile.komisi,
        profile.harga,
        id,
      ],
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Profil tidak ditemukan',
      });
    }
    return res.json({
      success: true,
      message: 'Profil langganan berhasil diperbarui',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui profil langganan',
      error: error.message,
    });
  }
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({
      success: false,
      message: 'Profil tidak valid',
    });
  }

  try {
    const [result] = await pool.execute('DELETE FROM langganan_profiles WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Profil tidak ditemukan',
      });
    }
    return res.json({
      success: true,
      message: 'Profil langganan berhasil dihapus',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus profil langganan',
      error: error.message,
    });
  }
});

module.exports = router;
