const express = require('express');
const pool = require('../../database');

const router = express.Router();

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function readRouterBody(body) {
  return {
    namaRouter: readText(body?.nama_router).slice(0, 100),
    ipAddress: readText(body?.ip_address).slice(0, 50),
    secret: readText(body?.secret).slice(0, 100),
    deskripsi: readText(body?.deskripsi),
  };
}

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, nama_router, ip_address, secret, deskripsi, status, created_at FROM routers ORDER BY id DESC',
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data router',
      error: error.message,
    });
  }
});

router.post('/', async (req, res) => {
  const { namaRouter, ipAddress, secret, deskripsi } = readRouterBody(req.body);

  if (!namaRouter || !ipAddress || !secret) {
    return res.status(400).json({
      success: false,
      message: 'Nama router, IP address, dan secret wajib diisi',
    });
  }

  try {
    const [result] = await pool.execute(
      'INSERT INTO routers (nama_router, ip_address, secret, deskripsi) VALUES (?, ?, ?, ?)',
      [namaRouter, ipAddress, secret, deskripsi],
    );

    return res.json({
      success: true,
      message: 'Router berhasil disimpan',
      id: result.insertId,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menyimpan router',
      error: error.message,
    });
  }
});

router.put('/:id', async (req, res) => {
  const id = readId(req.params.id);
  const { namaRouter, ipAddress, secret, deskripsi } = readRouterBody(req.body);

  if (!id || !namaRouter || !ipAddress || !secret) {
    return res.status(400).json({
      success: false,
      message: 'Data router belum lengkap atau tidak valid',
    });
  }

  try {
    const [result] = await pool.execute(
      'UPDATE routers SET nama_router = ?, ip_address = ?, secret = ?, deskripsi = ? WHERE id = ?',
      [namaRouter, ipAddress, secret, deskripsi, id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Router tidak ditemukan',
      });
    }

    return res.json({
      success: true,
      message: 'Router berhasil diperbarui',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui router',
      error: error.message,
    });
  }
});

router.delete('/:id', async (req, res) => {
  const id = readId(req.params.id);

  if (!id) {
    return res.status(400).json({
      success: false,
      message: 'Router tidak valid',
    });
  }

  try {
    const [result] = await pool.execute(
      'DELETE FROM routers WHERE id = ?',
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Router tidak ditemukan',
      });
    }

    return res.json({
      success: true,
      message: 'Router berhasil dihapus',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus router',
      error: error.message,
    });
  }
});

module.exports = router;
