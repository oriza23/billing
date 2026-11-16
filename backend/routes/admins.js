const express = require('express');
const pool = require('../../database');
const requireRole = require('../middleware/requireRole');
const { hashPassword } = require('../password');
const { readEmail, readNama, isValidEmail, publicAdminRow } = require('../web_admins');
const { isValidRole, normalizeRole } = require('../roles');

const router = express.Router();
const requireAdmin = requireRole('admin');

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, username, nama_lengkap, role, email, foto_profil FROM web_admins ORDER BY id ASC',
    );
    res.json(rows.map(publicAdminRow));
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data admin',
      error: error.message,
    });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  const username = readText(req.body?.username);
  const password = readText(req.body?.password);
  const role = normalizeRole(req.body?.role) || 'admin';
  const namaLengkap = readNama(req.body?.nama_lengkap);
  const email = readEmail(req.body?.email);

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: 'Username dan password wajib diisi',
    });
  }
  if (!isValidRole(role)) {
    return res.status(400).json({
      success: false,
      message: `Role harus salah satu dari: admin, operator, teknisi, cs, customer`,
    });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: 'Alamat email wajib diisi dan harus valid',
    });
  }

  try {
    await pool.execute(
      'INSERT INTO web_admins (username, password, role, nama_lengkap, email) VALUES (?, ?, ?, ?, ?)',
      [username, await hashPassword(password), role, namaLengkap || username, email],
    );

    return res.json({
      success: true,
      message: 'Admin berhasil disimpan',
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: 'Username admin sudah digunakan',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Gagal menyimpan admin',
      error: error.message,
    });
  }
});

router.put('/:username', requireAdmin, async (req, res) => {
  const username = readText(req.params.username);
  const password = readText(req.body?.password);
  const role = normalizeRole(req.body?.role) || 'admin';
  const namaLengkap = readNama(req.body?.nama_lengkap);
  const email = readEmail(req.body?.email);

  if (!username) {
    return res.status(400).json({
      success: false,
      message: 'Username wajib diisi',
    });
  }
  if (!isValidRole(role)) {
    return res.status(400).json({
      success: false,
      message: 'Role harus salah satu dari: admin, operator, teknisi, cs, customer',
    });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: 'Alamat email wajib diisi dan harus valid',
    });
  }

  try {
    const [result] = password
      ? await pool.execute(
        'UPDATE web_admins SET password = ?, role = ?, nama_lengkap = ?, email = ? WHERE username = ?',
        [await hashPassword(password), role, namaLengkap || username, email, username],
      )
      : await pool.execute(
        'UPDATE web_admins SET role = ?, nama_lengkap = ?, email = ? WHERE username = ?',
        [role, namaLengkap || username, email, username],
      );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Admin tidak ditemukan',
      });
    }

    return res.json({
      success: true,
      message: 'Admin berhasil diperbarui',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui admin',
      error: error.message,
    });
  }
});

router.delete('/:username', requireAdmin, async (req, res) => {
  const username = readText(req.params.username);

  if (username === 'admin') {
    return res.status(403).json({
      message: 'Administrator utama tidak boleh dihapus!',
    });
  }

  try {
    const [result] = await pool.execute(
      'DELETE FROM web_admins WHERE username = ?',
      [username],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Admin tidak ditemukan',
      });
    }

    return res.json({
      success: true,
      message: 'Admin berhasil dihapus',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus admin',
      error: error.message,
    });
  }
});

module.exports = router;
