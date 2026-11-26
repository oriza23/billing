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

# Debian sering tidak menyertakan /usr/sbin di PATH user non-root (visudo, runuser, ufw, sysctl tidak
# ditemukan), dan skrip ini bisa dipanggil lewat `sudo` yang memakai secure_path berbeda.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

# Distro: hanya Debian/Ubuntu (ID atau ID_LIKE). Tidak ada hardcode Ubuntu.
if [[ -r /etc/os-release ]]; then
  OS_ID="$(. /etc/os-release && printf '%s' "${ID:-}")"
  OS_ID_LIKE="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
  case " ${OS_ID} ${OS_ID_LIKE} " in
    *" ubuntu "*|*" debian "*) ;;
    *) echo "OS tidak didukung (ID=${OS_ID}); helper VPN hanya untuk Debian/Ubuntu." >&2; exit 1 ;;
  esac
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB_DIR=/usr/local/lib/raniah-vpn
BIN=/usr/local/sbin/raniah-vpn-helper

if [[ $EUID -ne 0 ]]; then
  echo "Jalankan sebagai root: sudo $0  (atau dari install.sh yang memakai run_root)" >&2
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

# Pembungkus dengan path node absolut dan PATH sistem lengkap: sudo memakai secure_path, bukan PATH user,
# dan helper memanggil wg, ip, systemctl, ufw, pkill (semuanya di /usr/sbin atau /sbin pada Debian).
# Mode 755 (bukan 700) wajib: proses Node non-root memeriksa berkas ini dengan fs.accessSync(..., X_OK).
TMP="$(mktemp)"
cat > "$TMP" <<EOF
#!/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
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
expect_mode "$LIB_DIR/helper.js" "root:root 644"
expect_mode "$LIB_DIR/vpn_config.js" "root:root 644"
[[ -x "$BIN" ]] || { echo "$BIN tidak bisa dieksekusi." >&2; exit 1; }

# Smoke test tanpa efek samping: aksi palsu harus ditolak dengan kode 5 SETELAH vpn_config.js berhasil
# dimuat. Memastikan node, pembungkus, dan modul benar-benar bisa jalan (bukan sekadar berkas ada).
set +e
"$BIN" cycle wireguard __selftest__ >/dev/null 2>&1
SELFTEST_RC=$?
set -e
if [[ "$SELFTEST_RC" -ne 5 ]]; then
  echo "Self-test helper gagal (kode $SELFTEST_RC, seharusnya 5). Jalankan manual: $BIN cycle wireguard __selftest__" >&2
  exit 1
fi

echo "Helper VPN terpasang: $BIN (root:root 755)"
