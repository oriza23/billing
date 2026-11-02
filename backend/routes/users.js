const crypto = require('crypto');
const express = require('express');
const pool = require('../../database');
const { hashPassword, isScryptHash, verifyPassword } = require('../password');
const {
  readEmail, isValidEmail, saveProfilePhoto, safeUnlink, publicAdminRow,
} = require('../web_admins');

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

function sessionUsername(req) {
  return typeof req.user?.username === 'string' ? req.user.username.trim() : '';
}

router.get('/profile', async (req, res) => {
  const username = sessionUsername(req);
  if (!username) {
    return res.status(401).json({
      success: false,
      message: 'Sesi tidak valid, silakan login kembali',
    });
  }

  try {
    const [rows] = await pool.execute(
      'SELECT id, username, role, email, foto_profil FROM web_admins WHERE username = ? LIMIT 1',
      [username],
    );
    if (!rows[0]) {
      return res.status(404).json({
        success: false,
        message: 'Admin tidak ditemukan',
      });
    }
    return res.json(publicAdminRow(rows[0]));
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil profil',
      error: error.message,
    });
  }
});

router.put('/profile', async (req, res) => {
  const username = sessionUsername(req);
  if (!username) {
    return res.status(401).json({
      success: false,
      message: 'Sesi tidak valid, silakan login kembali',
    });
  }

  const email = readEmail(req.body?.email);
  const fotoData = req.body?.foto_profil_base64;

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: 'Alamat email wajib diisi dan harus valid',
    });
  }

  try {
    const [rows] = await pool.execute(
      'SELECT id, foto_profil FROM web_admins WHERE username = ? LIMIT 1',
      [username],
    );
    if (!rows[0]) {
      return res.status(404).json({
        success: false,
        message: 'Admin tidak ditemukan',
      });
    }

    let fotoPath = rows[0].foto_profil || '';
    if (typeof fotoData === 'string' && fotoData.trim()) {
      const saved = await saveProfilePhoto(username, fotoData);
      if (fotoPath && fotoPath !== saved) {
        safeUnlink(fotoPath);
      }
      fotoPath = saved;
    }

    await pool.execute(
      'UPDATE web_admins SET email = ?, foto_profil = ? WHERE username = ?',
      [email, fotoPath || null, username],
    );

    const [updated] = await pool.execute(
      'SELECT id, username, role, email, foto_profil FROM web_admins WHERE username = ? LIMIT 1',
      [username],
    );

    return res.json({
      success: true,
      message: 'Profil berhasil disimpan',
      profile: publicAdminRow(updated[0]),
    });
  } catch (error) {
    return res.status(error.message?.includes('foto') ? 400 : 500).json({
      success: false,
      message: error.message?.includes('foto') ? error.message : 'Gagal menyimpan profil',
      error: error.message,
    });
  }
});

// Hanya mengubah password pemilik token. Username di body diabaikan.
router.post('/change-password', async (req, res) => {
  const username = sessionUsername(req);
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
