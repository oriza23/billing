/**
 * GET/POST /api/settings/payment — konfigurasi Tripay, QRIS, gateway aktif.
 * POST: multipart/form-data (multer) + field teks; hanya admin.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const requireRole = require('../middleware/requireRole');
const {
  readPaymentSettings,
  applyPaymentSettingsUpdate,
  toAdminResponseDetailed,
} = require('../payment/payment_settings');

const router = express.Router();
const requireAdmin = requireRole('admin');

const QRIS_UPLOAD_DIR = path.join(__dirname, '../../uploads/qris');
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    fs.mkdirSync(QRIS_UPLOAD_DIR, { recursive: true });
    cb(null, QRIS_UPLOAD_DIR);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.png';
    cb(null, `qris-static${safeExt === '.jpeg' ? '.jpg' : safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error('Gambar QRIS harus JPEG, PNG, atau WebP'));
      return;
    }
    cb(null, true);
  },
});

function multerSingle(field) {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (!err) {
        return next();
      }
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'Ukuran gambar QRIS maksimal 2 MB' });
      }
      return res.status(400).json({ success: false, message: err.message || 'Upload gagal' });
    });
  };
}

function publicUploadUrl(relativePath) {
  if (!relativePath) {
    return '';
  }
  if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
    return relativePath;
  }
  const normalized = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return normalized;
}

router.get('/payment', requireAdmin, async (req, res) => {
  try {
    const settings = await readPaymentSettings();
    const includeSecrets = String(req.query.include_secrets || '') === '1';
    return res.json({
      success: true,
      ...toAdminResponseDetailed(settings, includeSecrets),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil pengaturan pembayaran',
      error: error.message,
    });
  }
});

router.post('/payment', requireAdmin, multerSingle('qris_image'), async (req, res) => {
  try {
    let qrisImageUrl;
    if (req.file) {
      qrisImageUrl = publicUploadUrl(`/uploads/qris/${req.file.filename}`);
    }

    const saved = await applyPaymentSettingsUpdate(req.body || {}, { qrisImageUrl });
    const includeSecrets = String(req.body?.include_secrets_response || '') === '1';

    return res.json({
      success: true,
      message: 'Pengaturan pembayaran disimpan',
      ...toAdminResponseDetailed(saved, includeSecrets),
    });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({
      success: false,
      message: 'Gagal menyimpan pengaturan pembayaran',
      error: error.message,
    });
  }
});

module.exports = router;
