#!/usr/bin/env bash
# Alihkan modul SQL FreeRADIUS dari MariaDB ke PostgreSQL (orizabil).
#
#   chmod +x scripts/freeradius-switch-to-postgresql.sh
#   sudo ./scripts/freeradius-switch-to-postgresql.sh
#
set -euo pipefail

APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="${MIGRATE_ENV:-$APP_DIR/scripts/.env.migrate}"
BILLING_ENV="$APP_DIR/.env"

RADDB="${RADDB:-/etc/freeradius/3.0}"
SQL_MOD="$RADDB/mods-available/sql"

RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
die() { echo -e "${RED}$*${NC}" >&2; exit 1; }
info() { echo -e "${YELLOW}$*${NC}"; }
ok() { echo -e "${GREEN}$*${NC}"; }

[[ "$(id -u)" -ne 0 ]] && die "Jalankan dengan sudo."

[[ -f "$SQL_MOD" ]] || die "Tidak menemukan $SQL_MOD — pastikan freeradius terpasang."

PG_HOST=localhost
PG_PORT=5432
PG_USER=
PG_PASSWORD=
PG_DATABASE=orizabil

if [[ -f "$BILLING_ENV" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$BILLING_ENV"
  set +a
  PG_HOST=${DB_HOST:-localhost}
  PG_PORT=${DB_PORT:-5432}
  PG_USER=${DB_USER:-}
  PG_PASSWORD=${DB_PASSWORD:-}
  PG_DATABASE=${DB_NAME:-orizabil}
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  PG_HOST=${PG_HOST:-${DB_HOST:-localhost}}
  PG_PORT=${PG_PORT:-5432}
  PG_USER=${PG_USER:-${DB_USER:-}}
  PG_PASSWORD=${PG_PASSWORD:-${DB_PASSWORD:-}}
  PG_DATABASE=${PG_DATABASE:-${DB_NAME:-orizabil}}
fi

[[ -n "$PG_USER" && -n "$PG_PASSWORD" && -n "$PG_DATABASE" ]] \
  || die "Isi kredensial PG di $BILLING_ENV atau scripts/.env.migrate"

info "Memasang driver PostgreSQL FreeRADIUS..."
DEBIAN_FRONTEND=noninteractive apt-get install -y freeradius-postgresql || {
  die "Paket freeradius-postgresql gagal — cek apt."
}

STAMP=$(date +%Y%m%d-%H%M%S)
cp -a "$SQL_MOD" "${SQL_MOD}.bak.${STAMP}"
ok "Backup: ${SQL_MOD}.bak.${STAMP}"

# Ganti dialect/driver (baris aktif, bukan yang di-comment).
sed -i \
  -e 's/^[[:space:]]*dialect = "mysql"/\tdialect = "postgresql"/' \
  -e 's/^[[:space:]]*driver = "rlm_sql_mysql"/\tdriver = "rlm_sql_${dialect}"/' \
  "$SQL_MOD"

# Port & kredensial (hanya baris connection info standar).
sed -i \
  -e "s/^[[:space:]]*port = 3306/\tport = ${PG_PORT}/" \
  -e "s/^[[:space:]]*server = \"localhost\"/\tserver = \"${PG_HOST}\"/" \
  -e "s/^[[:space:]]*login = \".*\"/\tlogin = \"${PG_USER}\"/" \
  -e "s/^[[:space:]]*password = \".*\"/\tpassword = \"${PG_PASSWORD}\"/" \
  -e "s/^[[:space:]]*radius_db = \".*\"/\tradius_db = \"${PG_DATABASE}\"/" \
  "$SQL_MOD"

# Pastikan modul sql aktif.
ln -sf ../mods-available/sql "$RADDB/mods-enabled/sql"

# hotspot_time (opsional, jika sudah dipakai)
if [[ -f "$APP_DIR/deploy/freeradius/mods-available/hotspot_time" ]]; then
  install -o freerad -g freerad -m 640 \
    "$APP_DIR/deploy/freeradius/mods-available/hotspot_time" \
    "$RADDB/mods-available/hotspot_time"
  ln -sf ../mods-available/hotspot_time "$RADDB/mods-enabled/hotspot_time" 2>/dev/null || true
fi

info "Tes konfigurasi FreeRADIUS..."
if ! freeradius -XC >"/tmp/freeradius-xC-${STAMP}.log" 2>&1; then
  die "freeradius -XC gagal. Log: /tmp/freeradius-xC-${STAMP}.log — kembalikan dari ${SQL_MOD}.bak.${STAMP} bila perlu."
fi
ok "freeradius -XC OK (log: /tmp/freeradius-xC-${STAMP}.log)"

systemctl enable freeradius
systemctl restart freeradius
ok "FreeRADIUS memakai PostgreSQL (${PG_DATABASE} @ ${PG_HOST}:${PG_PORT})."

echo
echo "Cek:"
echo "  systemctl status freeradius"
echo "  tail -f /var/log/freeradius/radius.log"
echo "  Tes login PPP/hotspot dari pelanggan"