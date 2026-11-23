#!/usr/bin/env node
'use strict';
/**
 * Helper root untuk menu Sistem > Koneksi VPN. Dipasang ROOT-OWNED di
 * /usr/local/sbin/raniah-vpn-helper (lihat deploy/install-vpn-helper.sh) dan hanya boleh
 * dipanggil lewat sudoers:
 *   sudo -n /usr/local/sbin/raniah-vpn-helper apply
 *   sudo -n /usr/local/sbin/raniah-vpn-helper apply-server
 *   sudo -n /usr/local/sbin/raniah-vpn-helper cycle <wireguard|openvpn|sstp|l2tp|server> <stop|start|restart|disable>
 *
 * apply  — stdin JSON: { "protocol", "config" }. Isi divalidasi ulang lalu dirender dari template.
 * cycle  — stop bersih (unit, proses yatim, hapus interface, tunggu hilang) lalu start bila diminta.
 *          Pola proses dan nama interface dikunci di vpn_config.js, bukan dari argumen bebas.
 */

const fs = require('fs');
const path = require('path');

function loadConfigModule() {
  for (const candidate of [path.join(__dirname, 'vpn_config.js'), path.join(__dirname, '..', 'backend', 'vpn_config.js')]) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }
  throw new Error('vpn_config.js tidak ditemukan di sebelah helper.');
}

function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function readStdin(onJson) {
  const chunks = [];
  let size = 0;
  process.stdin.on('data', (chunk) => {
    size += chunk.length;
    if (size > 256 * 1024) {
      die('Input terlalu besar.', 4);
    }
    chunks.push(chunk);
  });
  process.stdin.on('end', () => {
    try {
      onJson(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (error) {
      die(error.message || String(error), error.status === 400 ? 6 : 1);
    }
  });
}

function main() {
  const cmd = process.argv[2];
  if (cmd === 'cycle') {
    const protocol = process.argv[3];
    const action = process.argv[4];
    if (process.argv.length !== 5) {
      die('Pemakaian: raniah-vpn-helper cycle <wireguard|openvpn|sstp|l2tp|server> <stop|start|restart|disable>', 2);
    }
    let vpn;
    try {
      vpn = loadConfigModule();
    } catch (error) {
      die(error.message || String(error), 1);
    }
    if (!vpn.CYCLE_PROTOCOLS.includes(protocol) || !vpn.CYCLE_ACTIONS.includes(action)) {
      die('Protokol atau aksi tidak dikenal.', 5);
    }
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      die('Helper harus dijalankan sebagai root (lewat sudo).', 3);
    }
    vpn.cycleVpn(protocol, action)
      .then((result) => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      })
      .catch((error) => {
        die(error.message || String(error), error.status === 400 ? 6 : 1);
      });
    return;
  }
  if (cmd === 'start-l2tp-server') {
    if (process.argv.length !== 3) {
      die('Pemakaian: raniah-vpn-helper start-l2tp-server', 2);
    }
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      die('Helper harus dijalankan sebagai root (lewat sudo).', 3);
    }
    let vpn;
    try {
      vpn = loadConfigModule();
    } catch (error) {
      die(error.message || String(error), 1);
    }
    // Sama dengan `cycle l2tp-server start`: matikan VPN Client, lalu start xl2tpd
    // dengan verifikasi proses + port UDP. Gagal => exit non-nol dengan log asli.
    vpn.cycleVpn('l2tp-server', 'start')
      .then((result) => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      })
      .catch((error) => {
        die(error.message || String(error), error.status === 400 ? 6 : 1);
      });
    return;
  }
  if (cmd === 'stop-l2tp-server') {
    if (process.argv.length !== 3) {
      die('Pemakaian: raniah-vpn-helper stop-l2tp-server', 2);
    }
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      die('Helper harus dijalankan sebagai root (lewat sudo).', 3);
    }
    let vpn;
    try {
      vpn = loadConfigModule();
    } catch (error) {
      die(error.message || String(error), 1);
    }
    vpn.stopL2tpServer()
      .then((result) => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      })
      .catch((error) => {
        die(error.message || String(error), error.status === 400 ? 6 : 1);
      });
    return;
  }
  if (cmd === 'apply-l2tp-server') {
    if (process.argv.length !== 3) {
      die('Pemakaian: raniah-vpn-helper apply-l2tp-server  (JSON dari stdin)', 2);
    }
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      die('Helper harus dijalankan sebagai root (lewat sudo).', 3);
    }
    return readStdin((payload) => {
      const vpn = loadConfigModule();
      const written = vpn.applyL2tpServerToDisk(payload.server, payload.peers);
      process.stdout.write(`${JSON.stringify({ ok: true, files: written })}\n`);
    });
  }
  if (cmd === 'apply-ovpn-server') {
    if (process.argv.length !== 3) {
      die('Pemakaian: raniah-vpn-helper apply-ovpn-server  (JSON dari stdin)', 2);
    }
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      die('Helper harus dijalankan sebagai root (lewat sudo).', 3);
    }
    return readStdin((payload) => {
      const vpn = loadConfigModule();
      const written = vpn.applyOvpnServerToDisk(payload.server, payload.peers);
      process.stdout.write(`${JSON.stringify({ ok: true, files: written })}\n`);
    });
  }
  if (cmd === 'apply-server') {
    if (process.argv.length !== 3) {
      die('Pemakaian: raniah-vpn-helper apply-server  (JSON dari stdin)', 2);
    }
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      die('Helper harus dijalankan sebagai root (lewat sudo).', 3);
    }
    return readStdin((payload) => {
      const vpn = loadConfigModule();
      const written = vpn.applyServerToDisk(payload.server, payload.peers);
      process.stdout.write(`${JSON.stringify({ ok: true, files: written })}\n`);
    });
  }
  if (cmd !== 'apply' || process.argv.length !== 3) {
    die('Pemakaian: raniah-vpn-helper apply  (JSON dari stdin)', 2);
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    die('Helper harus dijalankan sebagai root (lewat sudo).', 3);
  }

  const chunks = [];
  let size = 0;
  process.stdin.on('data', (chunk) => {
    size += chunk.length;
    if (size > 256 * 1024) {
      die('Input terlalu besar.', 4);
    }
    chunks.push(chunk);
  });
  process.stdin.on('end', () => {
    try {
      const vpn = loadConfigModule();
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const protocol = typeof payload?.protocol === 'string' ? payload.protocol : '';
      if (!vpn.PROTOCOLS.includes(protocol)) {
        die('Protokol tidak dikenal.', 5);
      }
      const cfg = vpn.validateProfile(protocol, payload.config, null);
      const written = vpn.applyToDisk(protocol, cfg);
      process.stdout.write(`${JSON.stringify({ ok: true, files: written })}\n`);
    } catch (error) {
      die(error.message || String(error), error.status === 400 ? 6 : 1);
    }
  });
}

main();
