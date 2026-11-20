/**
 * Perintah sistem yang butuh root (restart PostgreSQL/FreeRADIUS, ubah zona waktu OS).
 *
 * Saat server berjalan sebagai root, perintah dipanggil langsung. Saat berjalan sebagai
 * pengguna biasa (unit systemd `billing.service`), perintah dijalankan lewat `sudo -n`
 * memakai aturan sempit di /etc/sudoers.d/billing (tanpa password, hanya perintah ini).
 *
 * Argumen dibatasi oleh pemanggil (nama layanan regex, zona waktu dari daftar tetap),
 * jadi wildcard sudoers tidak bisa disalahgunakan untuk perintah lain.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

function commandFor(binary, args) {
  if (IS_ROOT) {
    return { file: binary, args };
  }
  return { file: 'sudo', args: ['-n', binary, ...args] };
}

function execPrivileged(binary, args, options, callback) {
  const command = commandFor(binary, args);
  return execFile(command.file, command.args, options, callback);
}

function runPrivileged(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    execPrivileged(binary, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

// Tulis berkas milik root (mis. /etc/timezone) lewat berkas sementara + `install -m`.
async function writeSystemFile(target, content, mode = '0644') {
  const tmp = path.join(os.tmpdir(), `billing-${path.basename(target)}-${process.pid}`);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try {
    await runPrivileged('install', ['-m', mode, tmp, target]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = {
  IS_ROOT,
  commandFor,
  execPrivileged,
  runPrivileged,
  writeSystemFile,
};
