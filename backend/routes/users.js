const crypto = require('crypto');
const express = require('express');
const pool = require('../../database');
const { hashPassword, isScryptHash, verifyPassword } = require('../password');

const router = express.Router();

const MIN_PASSWORD = 6;
const MAX_PASSWORD = 128;

function sameText(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function readPassword(value) {
  return typeof value === 'string' ? value : '';
}

async function passwordMatches(password, stored) {
  if (isScryptHash(stored)) {
    return verifyPassword(password, stored);
  }
  return Boolean(stored) && sameText(stored, password);
}

// Hanya mengubah password pemilik token. Username di body diabaikan.
router.post('/change-password', async (req, res) => {
  const username = typeof req.user?.username === 'string' ? req.user.username.trim() : '';
  if (!username) {
    return res.status(401).json({
      success: false,
      message: 'Sesi tidak valid, silakan login kembali',
    });
  }

  const currentPassword = readPassword(req.body?.currentPassword);
  const newPassword = readPassword(req.body?.newPassword);
  const confirmPassword = readPassword(req.body?.confirmPassword);

  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({
      success: false,
      message: 'Password lama, password baru, dan konfirmasi wajib diisi',
    });
  }
  if (newPassword.length < MIN_PASSWORD || newPassword.length > MAX_PASSWORD) {
    return res.status(400).json({
      success: false,
      message: `Password baru harus ${MIN_PASSWORD}-${MAX_PASSWORD} karakter`,
    });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({
      success: false,
      message: 'Konfirmasi password baru tidak sama',
    });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({
      success: false,
      message: 'Password baru harus berbeda dari password lama',
    });
  }

  try {
    const [rows] = await pool.execute(
      'SELECT password FROM web_admins WHERE username = ? LIMIT 1',
      [username],
    );
    const stored = rows[0]?.password;
    if (!stored || !(await passwordMatches(currentPassword, stored))) {
      return res.status(401).json({
        success: false,
        message: 'Password lama salah',
      });
    }

    await pool.execute(
      'UPDATE web_admins SET password = ? WHERE username = ?',
      [await hashPassword(newPassword), username],
    );

    return res.json({
      success: true,
      message: 'Password berhasil diubah',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal mengubah password',
      error: error.message,
    });
  }
});

module.exports = router;
