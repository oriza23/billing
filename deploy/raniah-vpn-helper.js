#!/usr/bin/env node
'use strict';
/**
 * Helper root untuk menu Sistem > Koneksi VPN. Dipasang ROOT-OWNED di
 * /usr/local/sbin/raniah-vpn-helper (lihat deploy/install-vpn-helper.sh) dan hanya boleh
 * dipanggil lewat sudoers: `sudo -n /usr/local/sbin/raniah-vpn-helper apply`.
 *
 * Input (stdin, JSON): { "protocol": "wireguard|openvpn|sstp", "config": { ... } }
 *
 * Helper TIDAK menulis isi mentah dari proses aplikasi. Konfigurasi divalidasi ulang dengan
 * vpn_config.js (salinan root-owned) lalu semua berkas dirender dari template di sini, sehingga
 * aplikasi yang dibobol pun tidak bisa menyuruh root menulis skrip/unit/perintah sembarang.
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

function main() {
  if (process.argv[2] !== 'apply' || process.argv.length !== 3) {
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
