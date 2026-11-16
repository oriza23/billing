const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeRole, isSuperRole, labelOf: roleLabel } = require('./roles');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'admin-profiles');
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

async function ensureWebAdminColumns(db) {
  await db.query('ALTER TABLE web_admins ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL');
  await db.query('ALTER TABLE web_admins ADD COLUMN IF NOT EXISTS foto_profil VARCHAR(500) NULL');
  // Nama lengkap dipakai di tampilan Log Aplikasi ("Berasal" siapa) & sapaan header.
  await db.query('ALTER TABLE web_admins ADD COLUMN IF NOT EXISTS nama_lengkap VARCHAR(100) NULL');
}

// Nama lengkap opsional; bila kosong, UI memakai username.
function readNama(value) {
  return typeof value === 'string' ? value.trim().slice(0, 100) : '';
}

function readEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isValidEmail(email) {
  const text = readEmail(email);
  return Boolean(text) && text.length <= 255 && EMAIL_RE.test(text);
}

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function extForMime(mime) {
  if (mime === 'image/png') {
    return '.png';
  }
  if (mime === 'image/webp') {
    return '.webp';
  }
  return '.jpg';
}

function parsePhotoDataUrl(dataUrl) {
  const text = typeof dataUrl === 'string' ? dataUrl.trim() : '';
  if (!text) {
    return null;
  }
  const match = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(text);
  if (!match) {
    return null;
  }
  const mime = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_PHOTO_BYTES) {
    return null;
  }
  return { mime, buffer };
}

function safeUnlink(relativePath) {
  if (!relativePath || !String(relativePath).startsWith('/uploads/admin-profiles/')) {
    return;
  }
  const filename = path.basename(relativePath);
  const full = path.join(UPLOAD_DIR, filename);
  try {
    fs.unlinkSync(full);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function saveProfilePhoto(username, dataUrl) {
  const parsed = parsePhotoDataUrl(dataUrl);
  if (!parsed) {
    throw new Error('Format foto tidak valid atau ukuran melebihi 2 MB');
  }
  ensureUploadDir();
  const slug = String(username || 'admin').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
  const filename = `${slug}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extForMime(parsed.mime)}`;
  const full = path.join(UPLOAD_DIR, filename);
  await fs.promises.writeFile(full, parsed.buffer);
  return `/uploads/admin-profiles/${filename}`;
}

function publicAdminRow(row) {
  return {
    id: row.id,
    username: row.username,
    nama_lengkap: row.nama_lengkap || '',
    role: row.role,
    role_label: roleLabel(row.role),
    is_super: isSuperRole(row.role),
    email: row.email || '',
    foto_profil: row.foto_profil || '',
  };
}

// Identitas admin untuk dibuatkan token: JWT memuat nama lengkap & label role
// supaya Log Aplikasi dan sapaan header tidak perlu query ulang setiap request.
async function adminIdentity(db, username) {
  const [rows] = await db.execute(
    'SELECT username, nama_lengkap, role FROM web_admins WHERE username = ? LIMIT 1',
    [username],
  );
  const admin = rows[0] || {};
  return {
    username,
    nama_lengkap: admin.nama_lengkap || username,
    role: normalizeRole(admin.role) || 'admin',
    role_label: roleLabel(admin.role),
    is_super: isSuperRole(admin.role),
  };
}

// Isi nama_lengkap lama (kosong/NULL) dengan username supaya tampilan tidak "-".
async function backfillNamaLengkap(db) {
  await db.query(
    "UPDATE web_admins SET nama_lengkap = username WHERE nama_lengkap IS NULL OR nama_lengkap = ''",
  );
}

module.exports = {
  ensureWebAdminColumns,
  readEmail,
  readNama,
  isValidEmail,
  saveProfilePhoto,
  safeUnlink,
  publicAdminRow,
  adminIdentity,
  backfillNamaLengkap,
  MAX_PHOTO_BYTES,
};
