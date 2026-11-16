const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidEmail, publicAdminRow, saveProfilePhoto } = require('../backend/web_admins');

test('isValidEmail menolak kosong dan format salah', () => {
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail('bukan-email'), false);
  assert.equal(isValidEmail('a@b'), false);
});

test('isValidEmail menerima email standar', () => {
  assert.equal(isValidEmail('Admin@Contoh.COM'), true);
});

test('publicAdminRow tidak mengekspos password', () => {
  assert.deepEqual(publicAdminRow({
    id: 1, username: 'a', role: 'admin', password: 'secret', email: null, foto_profil: null,
  }), {
    id: 1,
    username: 'a',
    nama_lengkap: '',
    role: 'admin',
    role_label: 'Administrator',
    is_super: true,
    email: '',
    foto_profil: '',
  });
});

test('saveProfilePhoto menolak data URL invalid', async () => {
  await assert.rejects(() => saveProfilePhoto('x', 'not-image'), /Format foto/);
});
