/**
 * Restart layanan dari menu Pengaturan.
 * Nama layanan hanya boleh salah satu dari whitelist. Perintah systemctl disusun
 * dari peta tetap, bukan dari teks permintaan.
 */

const { exec } = require('child_process');

const PM2_APP = 'billing';
const RESTART_DELAY_MS = 1000;
const SUDOERS_HINT = 'Gagal restart: user server belum memiliki izin sudoers NOPASSWD untuk systemctl.';

const UNITS = {
  postgresql: { unit: 'postgresql', label: 'Database PostgreSQL' },
  freeradius: { unit: 'freeradius', label: 'Radius Server' },
};

const WEB_LABEL = 'Sistem Web';

let busy = false;

function processIsRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function sudoPrefix(root = processIsRoot()) {
  return root ? '' : 'sudo -n ';
}

function systemctlCommand(unit, root = processIsRoot()) {
  return `${sudoPrefix(root)}systemctl restart ${unit}`;
}

function isAllowed(service) {
  return service === 'web' || Object.prototype.hasOwnProperty.call(UNITS, service);
}

function serviceLabel(service) {
  if (service === 'web') {
    return WEB_LABEL;
  }
  return UNITS[service]?.label || '';
}

function pm2AppName() {
  const raw = process.env.name || process.env.PM2_APP_NAME || PM2_APP;
  return /^[A-Za-z0-9_.-]{1,40}$/.test(String(raw)) ? String(raw) : PM2_APP;
}

function sudoersDenied(text) {
  return /password is required|a terminal is required/i.test(String(text || ''));
}

function runCommand(command, execFn = exec) {
  return new Promise((resolve, reject) => {
    execFn(command, { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = `${stderr || ''} ${error.message || ''}`.trim();
        const wrapped = new Error(sudoersDenied(detail) ? SUDOERS_HINT : detail.slice(0, 240));
        wrapped.status = sudoersDenied(detail) ? 403 : 500;
        reject(wrapped);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function scheduleWebRestart({ exec: execFn = exec } = {}) {
  const name = pm2AppName();
  const timer = setTimeout(() => {
    // PM2 milik user yang sama dengan proses Node, jadi tanpa sudo.
    execFn(`pm2 restart ${name}`, { timeout: 20_000 }, (error, _stdout, stderr) => {
      busy = false;
      if (error) {
        console.error(`[restart] pm2 ${name} gagal: ${(stderr || error.message).trim()}`);
        return;
      }
      console.log(`[restart] pm2 ${name} dijalankan`);
    });
  }, RESTART_DELAY_MS);
  timer.unref?.();
}

async function restartService(service, deps = {}) {
  if (!isAllowed(service)) {
    const error = new Error('Layanan tidak diizinkan');
    error.status = 400;
    throw error;
  }
  if (busy) {
    const error = new Error('Restart lain masih berjalan, coba lagi sebentar');
    error.status = 409;
    throw error;
  }

  if (service === 'web') {
    busy = true;
    return {
      deferred: true,
      service,
      message: `${WEB_LABEL} sedang di-restart. Halaman akan tersambung lagi dalam beberapa detik.`,
      start: () => scheduleWebRestart(deps),
    };
  }

  const { unit, label } = UNITS[service];
  const root = deps.root === undefined ? processIsRoot() : Boolean(deps.root);
  const command = systemctlCommand(unit, root);
  busy = true;
  try {
    await runCommand(command, deps.exec || exec);
    return {
      deferred: false,
      service,
      message: `${label} berhasil di-restart`,
    };
  } finally {
    busy = false;
  }
}

function resetRestartLock() {
  busy = false;
}

module.exports = {
  PM2_APP,
  SUDOERS_HINT,
  UNITS,
  processIsRoot,
  sudoPrefix,
  systemctlCommand,
  isAllowed,
  serviceLabel,
  pm2AppName,
  restartService,
  scheduleWebRestart,
  resetRestartLock,
};
