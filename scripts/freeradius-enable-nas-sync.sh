#!/usr/bin/env bash
# Pastikan FreeRADIUS membaca daftar NAS dari tabel `nas` (diisi otomatis oleh web billing
# dari tabel `routers`), dan deteksi client ganda di clients.conf.
#
# Aman dijalankan berulang. TIDAK me-restart FreeRADIUS kecuali diberi --restart.
#   sudo ./scripts/freeradius-enable-nas-sync.sh            # cek + perbaiki konfigurasi
#   sudo ./scripts/freeradius-enable-nas-sync.sh --restart  # lalu restart FreeRADIUS
set -euo pipefail

RADDB="${RADDB:-/etc/freeradius/3.0}"
SQL_MOD="$RADDB/mods-available/sql"
CLIENTS_CONF="$RADDB/clients.conf"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESTART=0
[[ "${1:-}" == "--restart" ]] && RESTART=1

[[ -f "$SQL_MOD" ]] || { echo "Tidak ada $SQL_MOD (RADDB=$RADDB benar?)" >&2; exit 1; }

# 1) read_clients = yes dan client_table = "nas" pada modul sql.
changed=0
if ! grep -Eq '^[[:space:]]*read_clients[[:space:]]*=[[:space:]]*yes' "$SQL_MOD"; then
  cp -a "$SQL_MOD" "$SQL_MOD.bak.$(date +%Y%m%d%H%M%S)"
  sed -i -E 's/^[[:space:]#]*read_clients[[:space:]]*=.*/\tread_clients = yes/' "$SQL_MOD"
  changed=1
fi
if ! grep -Eq '^[[:space:]]*client_table[[:space:]]*=[[:space:]]*"nas"' "$SQL_MOD"; then
  [[ $changed -eq 0 ]] && cp -a "$SQL_MOD" "$SQL_MOD.bak.$(date +%Y%m%d%H%M%S)"
  sed -i -E 's/^[[:space:]#]*client_table[[:space:]]*=.*/\tclient_table = "nas"/' "$SQL_MOD"
  changed=1
fi
if [[ $changed -eq 1 ]]; then echo "[ok] mods-available/sql diperbarui (backup .bak.* dibuat)"; else echo "[ok] read_clients/client_table sudah benar"; fi

# 2) Client yang ada di clients.conf DAN di tabel nas (hasil sinkronisasi) -> berisiko ganda.
if [[ -f "$APP_DIR/.env" ]] && command -v psql >/dev/null; then
  set -a; . "$APP_DIR/.env"; set +a
  export PGPASSWORD="${DB_PASSWORD:-}"
  mapfile -t nas_ips < <(psql -h "${DB_HOST:-localhost}" -p "${DB_PORT:-5432}" -U "${DB_USER:-}" -d "${DB_NAME:-}" -Atc \
    "SELECT nasname FROM nas WHERE description LIKE 'billing-router:%'" 2>/dev/null || true)
  dups=0
  for ip in "${nas_ips[@]}"; do
    if grep -Eq "^[[:space:]]*ipaddr[[:space:]]*=[[:space:]]*${ip//./\\.}[[:space:]]*$" "$CLIENTS_CONF"; then
      echo "[!] $ip ada di clients.conf dan di tabel nas. Hapus blok client-nya dari clients.conf agar tidak ganda."
      dups=1
    fi
  done
  [[ $dups -eq 0 ]] && echo "[ok] tidak ada client ganda (${#nas_ips[@]} router tersinkron di nas)"
else
  echo "[-] lewati cek client ganda (tidak ada .env atau psql)"
fi

# 3) Peringatan catch-all (install.sh membuat client 0.0.0.0/0 dengan satu secret global).
if grep -Eq '^[[:space:]]*ipaddr[[:space:]]*=[[:space:]]*0\.0\.0\.0/0' "$CLIENTS_CONF"; then
  echo "[!] clients.conf punya client 0.0.0.0/0 (terima NAS dari IP mana pun dengan 1 secret)."
  echo "    Setelah semua router ada di web, hapus blok itu agar hanya router terdaftar yang diterima."
fi

# 4) Validasi konfigurasi sebelum restart.
if command -v freeradius >/dev/null; then
  freeradius -Cx -lstdout -d "$RADDB" >/dev/null 2>&1 && echo "[ok] freeradius -C: konfigurasi valid" \
    || { echo "[X] konfigurasi FreeRADIUS tidak valid (jalankan: freeradius -CX)" >&2; exit 1; }
fi

if [[ $RESTART -eq 1 ]]; then
  systemctl restart freeradius && echo "[ok] FreeRADIUS di-restart"
else
  echo "Selesai. Restart manual agar daftar NAS terbaru dipakai: systemctl restart freeradius"
fi
