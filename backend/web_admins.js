const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'admin-profiles');
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

async function ensureWebAdminColumns(db) {
  await db.query('ALTER TABLE web_admins ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL');
  await db.query('ALTER TABLE web_admins ADD COLUMN IF NOT EXISTS foto_profil VARCHAR(500) NULL');
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
    role: row.role,
    email: row.email || '',
    foto_profil: row.foto_profil || '',
  };
}

module.exports = {
  ensureWebAdminColumns,
  readEmail,
  isValidEmail,
  saveProfilePhoto,
  safeUnlink,
  publicAdminRow,
  MAX_PHOTO_BYTES,
};
