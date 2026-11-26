#!/usr/bin/env bash
# Pasang helper root untuk menu Sistem > Koneksi VPN.
#
#   sudo deploy/install-vpn-helper.sh
#
# Hasil (semua root:root, tidak bisa diubah user aplikasi):
#  - /usr/local/lib/raniah-vpn/vpn_config.js   validasi + template konfigurasi
#  - /usr/local/lib/raniah-vpn/helper.js       dibungkus oleh /usr/local/sbin/raniah-vpn-helper
#
# Dipanggil juga oleh install.sh dan deploy/install-service.sh. Aman dijalankan ulang
# (mis. setelah update aplikasi, supaya salinan root ikut diperbarui).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB_DIR=/usr/local/lib/raniah-vpn
BIN=/usr/local/sbin/raniah-vpn-helper

if [[ $EUID -ne 0 ]]; then
  echo "Jalankan sebagai root: sudo $0" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js tidak ditemukan; helper VPN tidak dipasang." >&2
  exit 1
fi

# Helper berjalan sebagai root: interpreter-nya tidak boleh bisa diganti user biasa (mis. nvm di /home).
NODE_REAL="$(readlink -f "$NODE_BIN")"
if [[ "$NODE_REAL" == /home/* || "$(stat -c %U "$NODE_REAL")" != "root" ]]; then
  echo "Node di $NODE_REAL bukan milik root / ada di home user; pasang Node dari sistem (NodeSource) lalu ulangi." >&2
  exit 1
fi

install -d -m 0755 -o root -g root "$LIB_DIR"
install -m 0644 -o root -g root "$APP_DIR/backend/vpn_config.js" "$LIB_DIR/vpn_config.js"
install -m 0644 -o root -g root "$APP_DIR/deploy/raniah-vpn-helper.js" "$LIB_DIR/helper.js"

# Pembungkus dengan path node absolut: sudo memakai secure_path, bukan PATH user.
# Mode 755 (bukan 700) wajib: proses Node non-root memeriksa berkas ini dengan fs.accessSync(..., X_OK).
TMP="$(mktemp)"
cat > "$TMP" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$LIB_DIR/helper.js" "\$@"
EOF
install -m 0755 -o root -g root "$TMP" "$BIN"
rm -f "$TMP"

# Verifikasi hasil: pemilik, mode, dan dapat dieksekusi. Gagal di sini = instalasi dianggap gagal.
expect_mode() {
  local file="$1" want="$2" got
  got="$(stat -c '%U:%G %a' "$file")"
  if [[ "$got" != "$want" ]]; then
    echo "Izin $file = '$got', seharusnya '$want'." >&2
    exit 1
  fi
}
expect_mode "$BIN" "root:root 755"
expect_mode "$LIB_DIR" "root:root 755"
[[ -x "$BIN" ]] || { echo "$BIN tidak bisa dieksekusi." >&2; exit 1; }

echo "Helper VPN terpasang: $BIN (root:root 755)"
