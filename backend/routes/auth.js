const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../../database');
const requireAuth = require('../middleware/auth');
const { hashPassword, isScryptHash, verifyPassword } = require('../password');
const { secret, expiresIn } = require('../config/jwt');
const { resolveClientIp } = require('../client_ip');

const { normalizeRole, isSuperRole, labelOf: roleLabel } = require('../roles');

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_KEYS = 10_000;
const failedAttempts = new Map();

// Buang kunci kedaluwarsa supaya Map tidak tumbuh tanpa batas pada serangan acak.
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failedAttempts) {
    if (now - entry.first > LOCK_WINDOW_MS) {
      failedAttempts.delete(key);
    }
  }
}, LOCK_WINDOW_MS);
sweepTimer.unref?.();

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sameText(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function attemptKey(req, username) {
  return `${resolveClientIp(req) || req.ip}|${username.toLowerCase()}`;
}

function isLocked(key) {
  const entry = failedAttempts.get(key);
  if (!entry) {
    return false;
  }
  if (Date.now() - entry.first > LOCK_WINDOW_MS) {
    failedAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILED_ATTEMPTS;
}

function recordFailure(key) {
  const entry = failedAttempts.get(key);
  if (!entry || Date.now() - entry.first > LOCK_WINDOW_MS) {
    if (!entry && failedAttempts.size >= MAX_TRACKED_KEYS) {
      // Map menjaga urutan penyisipan: hapus kunci tertua agar ukuran tetap terbatas.
      const oldest = failedAttempts.keys().next().value;
      if (oldest !== undefined) {
        failedAttempts.delete(oldest);
      }
    }
    failedAttempts.set(key, { count: 1, first: Date.now() });
    return;
  }
  entry.count += 1;
}

router.post('/login', async (req, res) => {
  const username = readText(req.body?.username);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!username || !password) {
    return res.status(401).json({
      success: false,
      message: 'Username atau password salah',
    });
  }

  const key = attemptKey(req, username);
  if (isLocked(key)) {
    return res.status(429).json({
      success: false,
      message: 'Terlalu banyak percobaan gagal, coba lagi dalam 15 menit',
    });
  }

  try {
    const [rows] = await pool.execute(
      'SELECT username, password, role, nama_lengkap FROM web_admins WHERE username = ? LIMIT 1',
      [username],
    );
    const admin = rows[0];
    const stored = admin?.password;
    const hashed = isScryptHash(stored);
    const passwordOk = hashed
      ? await verifyPassword(password, stored)
      : Boolean(admin) && sameText(stored, password);

    if (!passwordOk) {
      recordFailure(key);
      return res.status(401).json({
        success: false,
        message: 'Username atau password salah',
      });
    }

    // Akun lama yang masih polos: izinkan login ini, lalu simpan ulang sebagai hash.
    if (!hashed) {
      const upgraded = await hashPassword(password);
      await pool.execute(
        'UPDATE web_admins SET password = ? WHERE username = ?',
        [upgraded, admin.username],
      );
    }

    failedAttempts.delete(key);
    const role = normalizeRole(admin.role) || 'admin';
    const namaLengkap = admin.nama_lengkap || admin.username;
    // Dipakai activity_log agar baris log login memuat nama & role (req.user belum ada di route publik ini).
    res.locals.logIdentity = { username: admin.username, nama_lengkap: namaLengkap, role };
    const token = jwt.sign({
      username: admin.username,
      nama_lengkap: namaLengkap,
      role,
      is_super: isSuperRole(role),
    }, secret, {
      algorithm: 'HS256',
      expiresIn,
    });

    return res.json({
      success: true,
      message: 'Login berhasil',
      token,
      username: admin.username,
      nama_lengkap: namaLengkap,
      role,
      role_label: roleLabel(role),
      is_super: isSuperRole(role),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memeriksa data login',
      error: error.message,
    });
  }
});

// Cek token masih berlaku (dipakai frontend bila perlu).
router.get('/me', requireAuth, (req, res) => {
  res.json({ success: true, username: req.user.username, role: req.user.role });
});

module.exports = router;
