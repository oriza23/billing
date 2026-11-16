#!/usr/bin/env node
/**
 * Buat atau perbarui akun Superadmin web setelah instalasi.
 * Password di-hash dengan scrypt (standar backend/password.js), bukan bcrypt.
 *
 * Env wajib (biasanya dari .env yang ditulis install.sh):
 *   BOOTSTRAP_ADMIN_USERNAME
 *   BOOTSTRAP_ADMIN_PASSWORD
 * Opsional: SETUP_ADMIN_NAMA_LENGKAP, SETUP_ADMIN_EMAIL
 */
const path = require('path');

require('../backend/load_env')(path.join(__dirname, '..', '.env'));

const pool = require('../database');
const { hashPassword } = require('../backend/password');
const { ensureWebAdminColumns, readEmail, isValidEmail } = require('../backend/web_admins');

function die(message) {
  console.error(message);
  process.exit(1);
}

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function main() {
  const username = readText(process.env.BOOTSTRAP_ADMIN_USERNAME);
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const namaLengkap = readText(process.env.SETUP_ADMIN_NAMA_LENGKAP) || username;
  const email = readEmail(process.env.SETUP_ADMIN_EMAIL);

  if (!username || !password) {
    die('BOOTSTRAP_ADMIN_USERNAME dan BOOTSTRAP_ADMIN_PASSWORD harus di-set di .env');
  }
  if (username.length > 50) {
    die('Username superadmin maksimal 50 karakter');
  }
  if (email && !isValidEmail(email)) {
    die('SETUP_ADMIN_EMAIL tidak valid');
  }

  await ensureWebAdminColumns(pool);
  const hash = await hashPassword(password);

  const [existing] = await pool.execute(
    'SELECT id FROM web_admins WHERE username = ? LIMIT 1',
    [username],
  );

  if (existing[0]) {
    await pool.execute(
      'UPDATE web_admins SET password = ?, role = ?, nama_lengkap = ?, email = ? WHERE username = ?',
      [hash, 'admin', namaLengkap, email || null, username],
    );
    console.log(`Superadmin "${username}" diperbarui (password & profil).`);
  } else {
    await pool.execute(
      'INSERT INTO web_admins (username, password, role, nama_lengkap, email) VALUES (?, ?, ?, ?, ?)',
      [username, hash, 'admin', namaLengkap, email || null],
    );
    console.log(`Superadmin "${username}" dibuat.`);
  }

  await pool.end();
}

main().catch((error) => {
  die(error.message);
});