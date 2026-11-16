#!/usr/bin/env bash
# Migrasi database orizabil MariaDB -> PostgreSQL (app billing + tabel RADIUS).
#
# Prasyarat: backup Anda sendiri sudah aman, maintenance window disepakati.
#
#   cp scripts/.env.migrate.example scripts/.env.migrate
#   chmod 600 scripts/.env.migrate   # isi password
#   chmod +x scripts/migrate-mariadb-to-postgresql.sh
#   sudo ./scripts/migrate-mariadb-to-postgresql.sh
#
set -euo pipefail

APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="${MIGRATE_ENV:-$APP_DIR/scripts/.env.migrate}"
TEMPLATE="$APP_DIR/scripts/pgloader-orizabil.load.template"
DUMP_DIR="${DUMP_DIR:-$APP_DIR/backups/migrate-$(date +%Y%m%d-%H%M%S)}"

RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

die() { echo -e "${RED}$*${NC}" >&2; exit 1; }
info() { echo -e "${YELLOW}$*${NC}"; }
ok() { echo -e "${GREEN}$*${NC}"; }

if [[ "$(id -u)" -ne 0 ]]; then
  die "Jalankan sebagai root (sudo) agar bisa memasang PostgreSQL/pgloader dan menghentikan layanan."
fi

[[ -f "$ENV_FILE" ]] || die "Buat $ENV_FILE dari scripts/.env.migrate.example"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

for var in MYSQL_HOST MYSQL_USER MYSQL_PASSWORD MYSQL_DATABASE PG_HOST PG_USER PG_PASSWORD PG_DATABASE; do
  [[ -n "${!var:-}" ]] || die "Variabel $var kosong di $ENV_FILE"
done

MYSQL_PORT=${MYSQL_PORT:-3306}
PG_PORT=${PG_PORT:-5432}

pg_urlencode() {
  python3 - "$1" <<'PY'
import sys, urllib.parse
print(urllib.parse.quote(sys.argv[1], safe=""))
PY
}

mkdir -p "$DUMP_DIR"
umask 077

info "=== Pra-migrasi: backup MariaDB ke $DUMP_DIR ==="
if command -v mariadb-dump >/dev/null 2>&1; then
  DUMP_BIN=mariadb-dump
elif command -v mysqldump >/dev/null 2>&1; then
  DUMP_BIN=mysqldump
else
  die "mariadb-dump / mysqldump tidak ditemukan"
fi

export MYSQL_PWD="$MYSQL_PASSWORD"
$DUMP_BIN \
  --single-transaction --routines --triggers --events \
  -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" \
  "$MYSQL_DATABASE" | gzip -9 > "$DUMP_DIR/${MYSQL_DATABASE}.sql.gz"
unset MYSQL_PWD
ok "Backup: $DUMP_DIR/${MYSQL_DATABASE}.sql.gz"

info "=== Memasang PostgreSQL & pgloader (jika belum) ==="
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-client pgloader

systemctl enable --now postgresql

PG_USER_SQL=$(printf '%s' "$PG_USER" | sed "s/'/''/g")
PG_PASSWORD_SQL=$(printf '%s' "$PG_PASSWORD" | sed "s/'/''/g")
PG_DATABASE_SQL=$(printf '%s' "$PG_DATABASE" | sed "s/'/''/g")

info "=== Membuat role & database PostgreSQL ==="
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PG_USER_SQL}') THEN
    CREATE ROLE "${PG_USER}" LOGIN PASSWORD '${PG_PASSWORD_SQL}';
  ELSE
    ALTER ROLE "${PG_USER}" WITH LOGIN PASSWORD '${PG_PASSWORD_SQL}';
  END IF;
END\$\$;
SELECT format(
  'CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0',
  '${PG_DATABASE_SQL}', '${PG_USER_SQL}'
)
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${PG_DATABASE_SQL}')\gexec
GRANT ALL PRIVILEGES ON DATABASE "${PG_DATABASE}" TO "${PG_USER}";
SQL

info "=== Menghentikan billing & FreeRADIUS (downtime) ==="
pm2 stop billing 2>/dev/null || true
systemctl stop freeradius 2>/dev/null || true

MYSQL_ESC_PASS=$(pg_urlencode "$MYSQL_PASSWORD")
PG_ESC_PASS=$(pg_urlencode "$PG_PASSWORD")
LOAD_FILE=$(mktemp /tmp/pgloader-orizabil.XXXXXX.load)
trap 'rm -f "$LOAD_FILE"' EXIT

sed \
  -e "s|MYSQL_USER|$(pg_urlencode "$MYSQL_USER")|g" \
  -e "s|MYSQL_PASS|${MYSQL_ESC_PASS}|g" \
  -e "s|MYSQL_HOST|${MYSQL_HOST}|g" \
  -e "s|MYSQL_PORT|${MYSQL_PORT}|g" \
  -e "s|MYSQL_DB|$(pg_urlencode "$MYSQL_DATABASE")|g" \
  -e "s|PG_USER|$(pg_urlencode "$PG_USER")|g" \
  -e "s|PG_PASS|${PG_ESC_PASS}|g" \
  -e "s|PG_HOST|${PG_HOST}|g" \
  -e "s|PG_PORT|${PG_PORT}|g" \
  -e "s|PG_DB|$(pg_urlencode "$PG_DATABASE")|g" \
  "$TEMPLATE" > "$LOAD_FILE"

info "=== pgloader (bisa beberapa menit untuk radacct besar) ==="
pgloader "$LOAD_FILE" | tee "$DUMP_DIR/pgloader.log"

info "=== Tambahan skema billing (kolom/tabel baru) ==="
cd "$APP_DIR"
npm install
umask 077
if [[ ! -f "$APP_DIR/.env" ]]; then
  JWT_SECRET=$(openssl rand -hex 48)
  cat > "$APP_DIR/.env" <<EOF
PORT=5000
DB_HOST=${PG_HOST}
DB_PORT=${PG_PORT}
DB_USER=${PG_USER}
DB_PASSWORD=${PG_PASSWORD}
DB_NAME=${PG_DATABASE}
DB_SERVICE=postgresql
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=12h
TRUST_PROXY=1
EOF
  chmod 600 "$APP_DIR/.env"
  ok "File .env baru dibuat — lengkapi BOOTSTRAP_* / JWT jika perlu."
else
  cp -a "$APP_DIR/.env" "$DUMP_DIR/.env.before"
  python3 - "$APP_DIR/.env" "$PG_HOST" "$PG_PORT" "$PG_USER" "$PG_PASSWORD" "$PG_DATABASE" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8") if path.exists() else ""
updates = {
    "DB_HOST": sys.argv[2],
    "DB_PORT": sys.argv[3],
    "DB_USER": sys.argv[4],
    "DB_PASSWORD": sys.argv[5],
    "DB_NAME": sys.argv[6],
    "DB_SERVICE": "postgresql",
}
lines = text.splitlines()
seen = set()
out = []
for line in lines:
    if "=" in line and not line.strip().startswith("#"):
        key = line.split("=", 1)[0].strip()
        if key in updates:
            out.append(f"{key}={updates[key]}")
            seen.add(key)
            continue
    out.append(line)
for key, val in updates.items():
    if key not in seen:
        out.append(f"{key}={val}")
path.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
PY
  chmod 600 "$APP_DIR/.env"
  ok ".env diperbarui ke PostgreSQL (salinan lama: $DUMP_DIR/.env.before)"
fi

BILLING_SCHEMA_ONLY=1 node "$APP_DIR/server.js"

info "=== Verifikasi cepat ==="
export PGPASSWORD="$PG_PASSWORD"
psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -v ON_ERROR_STOP=1 <<'SQL' | tee "$DUMP_DIR/counts.txt"
SELECT 'web_admins' AS tbl, COUNT(*)::bigint AS n FROM web_admins
UNION ALL SELECT 'langganan_pelanggan', COUNT(*) FROM langganan_pelanggan
UNION ALL SELECT 'radcheck', COUNT(*) FROM radcheck
UNION ALL SELECT 'radacct', COUNT(*) FROM radacct;
SQL
unset PGPASSWORD

echo
ok "=== Migrasi data selesai ==="
echo "Langkah berikutnya (WAJIB sebelum buka layanan):"
echo "  1. ./scripts/freeradius-switch-to-postgresql.sh"
echo "  2. pm2 start $APP_DIR/server.js --name billing --cwd $APP_DIR"
echo "  3. Login web, cek Langganan Online / voucher"
echo "  4. Setelah stabil, pertimbangkan hapus MariaDB (install.sh bisa purge)"
echo
echo "Log & backup: $DUMP_DIR"