#!/usr/bin/env bash
# =============================================================================
# install.sh — Auto-deploy Sistem Billing di server fresh
# Debian 11 / Ubuntu 22.04 (dan turunan Ubuntu 24.04).
#
# Stack: PostgreSQL (billing + RADIUS) · FreeRADIUS rlm_sql_postgresql · Node.js 22 · PM2
#
# TIDAK memasang: MariaDB/MySQL, Nginx. Billing hanya PostgreSQL (driver pg + pg_compat).
# Tanpa Nginx: Express (server.js) menyajikan API + frontend/dist satu port (default 5000).
# Akses: http://IP-SERVER:5000  (APP_PORT=... sudo ./install.sh untuk ubah port).
#
# Server yang sama dengan GenieACS / acs-standalone:
#   - UFW membuka port GenieACS (lihat variabel GENIEACS_*).
#   - MariaDB untuk acs-standalone TIDAK diinstal/dihapus oleh script ini; biarkan install.sh acs-standalone.
#
# Jalankan dari folder billing (setelah git clone):
#   chmod +x install.sh scripts/setup-admin.js
#   sudo ./install.sh
#
# Proyek ACS terpisah (/var/www/acs-standalone): pakai install.sh di repo tersebut (MariaDB).
# =============================================================================
set -euo pipefail

# --- Konstanta deploy -------------------------------------------------------
APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_PORT="${APP_PORT:-5000}"
# Port GenieACS (diinstal terpisah di server yang sama)
GENIEACS_UI_PORT="${GENIEACS_UI_PORT:-3000}"      # UI web
GENIEACS_CWMP_PORT="${GENIEACS_CWMP_PORT:-7547}"  # TR-069: ONU/CPE terhubung ke sini
GENIEACS_NBI_PORT="${GENIEACS_NBI_PORT:-7557}"    # NBI REST (dipakai billing; tanpa autentikasi)
GENIEACS_FS_PORT="${GENIEACS_FS_PORT:-7567}"      # File server (firmware)
# NBI tanpa login: default hanya localhost. Set GENIEACS_OPEN_NBI=1 bila billing/ACS ada di mesin lain.
GENIEACS_OPEN_NBI="${GENIEACS_OPEN_NBI:-0}"
RADDB="${RADDB:-/etc/freeradius/3.0}"
RADIUS_SCHEMA="${RADIUS_SCHEMA:-${RADDB}/mods-config/sql/main/postgresql/schema.sql}"
CLIENTS_MARKER="BEGIN-ORIZABIL-BILLING-INSTALL"

GREEN='\033[1;32m'
YELLOW='\033[1;33m'
CYAN='\033[1;36m'
RED='\033[1;31m'
NC='\033[0m'

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
  APP_USER="${SUDO_USER:-root}"
else
  SUDO="sudo"
  APP_USER="$USER"
fi
APP_HOME=$(getent passwd "$APP_USER" | cut -d: -f6)

die() { echo -e "${RED}$*${NC}" >&2; exit 1; }
info() { echo -e "${YELLOW}$*${NC}"; }
ok() { echo -e "${GREEN}$*${NC}"; }
warn() { echo -e "${RED}$*${NC}"; }

# Escape tunggal kutip untuk literal di SQL PostgreSQL (DO/CREATE ROLE).
sql_escape_pg() {
  local value=$1
  value=${value//\'/\'\'}
  printf '%s' "$value"
}

# Escape untuk menulis secret ke clients.conf (hindari karakter pengganggu).
freeradius_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '%s' "$value"
}

if [[ ! -f "$APP_DIR/server.js" || ! -f "$APP_DIR/frontend/package.json" ]]; then
  die "Jalankan script ini di dalam folder proyek billing (ada server.js dan frontend/package.json)."
fi

echo -e "${CYAN}=== Installer Billing + PostgreSQL + FreeRADIUS (tanpa Nginx) ===${NC}"
echo

# =============================================================================
# 1. INPUT INTERAKTIF (read) — sebelum apt/npm
# =============================================================================
read -r -p "Nama Database (DB_NAME) [orizabil]: " DB_NAME
DB_NAME=${DB_NAME:-orizabil}

read -r -p "Username DB (DB_USER) [oriza]: " DB_USER
DB_USER=${DB_USER:-oriza}

read -r -s -p "Password DB (DB_PASS) [Enter = otomatis]: " DB_PASS
echo
if [[ -z "$DB_PASS" ]]; then
  DB_PASS=$(openssl rand -hex 16)
  info "Password DB dibuat otomatis."
fi

echo
read -r -p "Username Superadmin Web (WEB_ADMIN) [admin]: " WEB_ADMIN
WEB_ADMIN=${WEB_ADMIN:-admin}

read -r -s -p "Password Superadmin Web (WEB_PASS): " WEB_PASS
echo
if [[ -z "$WEB_PASS" ]]; then
  die "WEB_PASS wajib diisi (minimal 8 karakter)."
fi

read -r -s -p "RADIUS NAS Secret (RADIUS_SECRET): " RADIUS_SECRET
echo
if [[ -z "$RADIUS_SECRET" ]]; then
  RADIUS_SECRET=$(openssl rand -hex 12)
  info "RADIUS_SECRET dibuat otomatis."
fi

read -r -p "Nama lengkap Superadmin [${WEB_ADMIN}]: " WEB_ADMIN_NAMA
WEB_ADMIN_NAMA=${WEB_ADMIN_NAMA:-$WEB_ADMIN}

# --- Validasi input ---------------------------------------------------------
if [[ ! "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; then
  die "DB_NAME: huruf/underscore di awal, lalu huruf/angka/underscore."
fi
if [[ ! "$DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; then
  die "DB_USER tidak valid untuk PostgreSQL."
fi
[[ "$DB_PASS" != *$'\n'* ]] || die "DB_PASS tidak boleh mengandung baris baru."
[[ "$WEB_ADMIN" =~ ^[A-Za-z0-9._-]{1,50}$ ]] || die "WEB_ADMIN tidak valid."
[[ ${#WEB_PASS} -ge 8 ]] || die "WEB_PASS minimal 8 karakter."
[[ ${#RADIUS_SECRET} -ge 6 ]] || die "RADIUS_SECRET minimal 6 karakter."

echo
info "Ringkasan:"
echo "  Billing DB : PostgreSQL ${DB_NAME} @ localhost:5432 (${DB_USER}) — bukan MariaDB"
echo "  Web admin  : ${WEB_ADMIN}"
echo "  RADIUS     : secret ****, clients 0.0.0.0/0 (SQL → PostgreSQL)"
echo "  Web        : http://IP-SERVER:${APP_PORT} (Node.js, tanpa Nginx)"
echo "  MariaDB    : tidak dipasang (acs-standalone pakai installer sendiri bila perlu)"
read -r -p "Lanjut instalasi? [y/N]: " CONFIRM
CONFIRM=${CONFIRM:-N}
[[ "$CONFIRM" =~ ^[yY] ]] || die "Instalasi dibatalkan."

# Alias kompatibel .env / setup-admin.js
DB_PASSWORD="$DB_PASS"
SUPERADMIN_USER="$WEB_ADMIN"
SUPERADMIN_PASS="$WEB_PASS"
SUPERADMIN_NAMA="$WEB_ADMIN_NAMA"

# =============================================================================
# 2. PERSIAPAN OS & PostgreSQL
# =============================================================================
info "=== apt update & upgrade ==="
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update
$SUDO apt-get upgrade -y

info "=== Paket dasar (tanpa nginx, tanpa mariadb-server) ==="
$SUDO apt-get install -y \
  ca-certificates curl wget git openssl ufw \
  postgresql postgresql-contrib \
  build-essential

if systemctl is-active mariadb >/dev/null 2>&1 || systemctl is-active mysql >/dev/null 2>&1; then
  info "MariaDB/MySQL sudah berjalan di server (mis. acs-standalone): dibiarkan, billing tetap PostgreSQL."
fi

info "=== PostgreSQL: role, database, hak akses ==="
$SUDO systemctl enable --now postgresql

DB_USER_SQL=$(sql_escape_pg "$DB_USER")
DB_PASSWORD_SQL=$(sql_escape_pg "$DB_PASS")
DB_NAME_SQL=$(sql_escape_pg "$DB_NAME")

$SUDO -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER_SQL}') THEN
    CREATE ROLE "${DB_USER_SQL}" LOGIN PASSWORD '${DB_PASSWORD_SQL}';
  ELSE
    ALTER ROLE "${DB_USER_SQL}" WITH LOGIN PASSWORD '${DB_PASSWORD_SQL}';
  END IF;
END\$\$;
SELECT format(
  'CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0',
  '${DB_NAME_SQL}', '${DB_USER_SQL}'
)
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME_SQL}')\gexec
GRANT ALL PRIVILEGES ON DATABASE "${DB_NAME_SQL}" TO "${DB_USER_SQL}";
SQL

PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c 'SELECT 1;' \
  || die "Koneksi PostgreSQL gagal untuk user ${DB_USER} — periksa pg_hba.conf / password."

# =============================================================================
# 3. FreeRADIUS + skema PostgreSQL
# =============================================================================
info "=== FreeRADIUS + freeradius-postgresql (bukan freeradius-mysql) ==="
$SUDO apt-get install -y freeradius freeradius-postgresql
if dpkg -s freeradius-mysql >/dev/null 2>&1; then
  info "=== Mencopot freeradius-mysql (billing memakai rlm_sql_postgresql) ==="
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get purge -y freeradius-mysql || true
fi

if [[ ! -f "$RADIUS_SCHEMA" ]]; then
  die "Skema RADIUS tidak ditemukan: $RADIUS_SCHEMA"
fi

info "=== Impor skema RADIUS ke database ${DB_NAME} ==="
$SUDO -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$RADIUS_SCHEMA"

$SUDO -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
GRANT ALL ON SCHEMA public TO "${DB_USER_SQL}";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${DB_USER_SQL}";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${DB_USER_SQL}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${DB_USER_SQL}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${DB_USER_SQL}";
SQL

SQL_MOD="${RADDB}/mods-available/sql"
if [[ ! -f "$SQL_MOD" ]]; then
  die "Modul SQL FreeRADIUS tidak ada: $SQL_MOD"
fi

STAMP=$(date +%Y%m%d-%H%M%S)
$SUDO cp -a "$SQL_MOD" "${SQL_MOD}.bak.${STAMP}"
info "Backup modul sql: ${SQL_MOD}.bak.${STAMP}"

info "=== Konfigurasi modul SQL (PostgreSQL) ==="
# Dialect & driver — memenuhi permintaan rlm_sql_postgresql + kompatibel Debian.
$SUDO sed -i \
  -e 's/^[[:space:]]*dialect[[:space:]]*=.*/\tdialect = "postgresql"/' \
  -e 's/^[[:space:]]*driver[[:space:]]*=.*/\tdriver = "rlm_sql_postgresql"/' \
  -e 's/^[[:space:]]*#.*driver[[:space:]]*=.*/\tdriver = "rlm_sql_postgresql"/' \
  "$SQL_MOD"

# Koneksi database dari input user
RAD_ESC_PASS=$(freeradius_escape "$DB_PASS")
$SUDO sed -i \
  -e 's/^[[:space:]]*server[[:space:]]*=.*/\tserver = "localhost"/' \
  -e 's/^[[:space:]]*port[[:space:]]*=.*/\tport = 5432/' \
  -e "s/^[[:space:]]*login[[:space:]]*=.*/\tlogin = \"${DB_USER}\"/" \
  -e "s/^[[:space:]]*password[[:space:]]*=.*/\tpassword = \"${RAD_ESC_PASS}\"/" \
  -e "s/^[[:space:]]*radius_db[[:space:]]*=.*/\tradius_db = \"${DB_NAME}\"/" \
  "$SQL_MOD"

$SUDO ln -sf ../mods-available/sql "${RADDB}/mods-enabled/sql"

# Modul hotspot_time (opsional, jika ada di repo)
HOTSPOT_MOD="$APP_DIR/deploy/freeradius/mods-available/hotspot_time"
if [[ -f "$HOTSPOT_MOD" ]]; then
  $SUDO install -o freerad -g freerad -m 640 "$HOTSPOT_MOD" "${RADDB}/mods-available/hotspot_time"
  $SUDO ln -sf ../mods-available/hotspot_time "${RADDB}/mods-enabled/hotspot_time" 2>/dev/null || true
fi

info "=== clients.conf: NAS 0.0.0.0/0 ==="
CLIENTS_CONF="${RADDB}/clients.conf"
RAD_ESC_SECRET=$(freeradius_escape "$RADIUS_SECRET")
if $SUDO grep -q "$CLIENTS_MARKER" "$CLIENTS_CONF" 2>/dev/null; then
  $SUDO sed -i "/${CLIENTS_MARKER}/,/${CLIENTS_MARKER}-END/{
    s/^[[:space:]]*secret[[:space:]]*=.*/\tsecret = ${RAD_ESC_SECRET}/
  }" "$CLIENTS_CONF"
else
  $SUDO tee -a "$CLIENTS_CONF" >/dev/null <<EOF

# --- ${CLIENTS_MARKER} ---
client billing_nas_all {
	ipaddr = 0.0.0.0/0
	secret = ${RAD_ESC_SECRET}
	require_message_authenticator = no
	limit_proxy_state = true
}
# --- ${CLIENTS_MARKER}-END ---
EOF
fi

info "=== Tes konfigurasi FreeRADIUS ==="
if ! $SUDO freeradius -XC >"/tmp/freeradius-install-${STAMP}.log" 2>&1; then
  die "freeradius -XC gagal. Lihat /tmp/freeradius-install-${STAMP}.log"
fi

# =============================================================================
# 4. Node.js 22, billing backend/frontend, migrasi & superadmin
# =============================================================================
if command -v node >/dev/null 2>&1 && node -v | grep -qE '^v22\.'; then
  info "Node.js sudah v22: $(node -v)"
else
  info "=== Memasang Node.js 22 LTS (NodeSource) ==="
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

if ! command -v pm2 >/dev/null 2>&1; then
  info "=== Memasang PM2 global ==="
  $SUDO npm install -g pm2
fi

JWT_SECRET=$(openssl rand -hex 48)

info "=== Menulis .env billing ==="
umask 077
{
  echo "PORT=${APP_PORT}"
  echo "DB_HOST=localhost"
  echo "DB_PORT=5432"
  echo "DB_USER=${DB_USER}"
  echo "DB_PASSWORD=${DB_PASS}"
  echo "DB_NAME=${DB_NAME}"
  echo "DB_SERVICE=postgresql"
  echo "JWT_SECRET=${JWT_SECRET}"
  echo "JWT_EXPIRES_IN=12h"
  echo "BOOTSTRAP_ADMIN_USERNAME=${WEB_ADMIN}"
  echo "BOOTSTRAP_ADMIN_PASSWORD=${WEB_PASS}"
  echo "SETUP_ADMIN_NAMA_LENGKAP=${WEB_ADMIN_NAMA}"
  # TRUST_PROXY sengaja tidak diset: tanpa reverse proxy, IP klien (isolir/log) diambil dari
  # koneksi TCP langsung. Mengaktifkannya tanpa proxy membuat header X-Forwarded-For bisa dipalsukan.
} > "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
echo "VITE_API_URL=" > "$APP_DIR/frontend/.env.production"

info "=== npm install (akar proyek + frontend) ==="
cd "$APP_DIR"
npm install
cd "$APP_DIR/frontend"
npm install
npm run build

info "=== Migrasi skema aplikasi (CREATE TABLE di server.js) ==="
cd "$APP_DIR"
BILLING_SCHEMA_ONLY=1 node server.js

info "=== Seeder superadmin (scripts/setup-admin.js) ==="
node "$APP_DIR/scripts/setup-admin.js"

# =============================================================================
# 5. PM2 & firewall
# =============================================================================
info "=== PM2: billing ==="
if pm2 describe billing >/dev/null 2>&1; then
  pm2 delete billing
fi
pm2 start "$APP_DIR/server.js" --name billing --cwd "$APP_DIR"
pm2 save
$SUDO env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" || true
pm2 save

# --- Billing tidak memakai Nginx: hapus hanya config billing, jangan pasang nginx ---
$SUDO rm -f /etc/nginx/sites-enabled/billing /etc/nginx/sites-available/billing 2>/dev/null || true
if dpkg -s nginx >/dev/null 2>&1 || dpkg -s nginx-common >/dev/null 2>&1; then
  OTHER_SITES=$(ls -A /etc/nginx/sites-enabled 2>/dev/null | grep -vE '^default$' || true)
  if [[ -z "$OTHER_SITES" ]]; then
    info "=== Nginx terpasang tanpa situs lain: stop & copot (billing pakai Node :${APP_PORT}) ==="
    $SUDO systemctl disable --now nginx 2>/dev/null || true
    DEBIAN_FRONTEND=noninteractive $SUDO apt-get purge -y 'nginx*' || true
    $SUDO apt-get autoremove -y || true
  else
    warn "Nginx dipakai situs lain (${OTHER_SITES}); hanya config 'billing' dihapus."
  fi
fi

# Port < 1024 (mis. APP_PORT=80) butuh izin bind tanpa root
if [[ "${APP_PORT}" -lt 1024 ]]; then
  NODE_BIN=$(readlink -f "$(command -v node)")
  info "=== Izinkan Node bind port ${APP_PORT} (setcap) ==="
  $SUDO setcap 'cap_net_bind_service=+ep' "$NODE_BIN"
  pm2 restart billing --update-env || true
fi

# --- UFW & layanan ----------------------------------------------------------
info "=== UFW (SSH, Billing, RADIUS, GenieACS) ==="
$SUDO ufw allow OpenSSH
$SUDO ufw allow "${APP_PORT}/tcp" comment 'Billing web'
$SUDO ufw allow 1812/udp comment 'FreeRADIUS auth' 2>/dev/null || true
$SUDO ufw allow 1813/udp comment 'FreeRADIUS acct' 2>/dev/null || true
$SUDO ufw allow "${GENIEACS_CWMP_PORT}/tcp" comment 'GenieACS CWMP (TR-069)'
$SUDO ufw allow "${GENIEACS_FS_PORT}/tcp" comment 'GenieACS File Server'
$SUDO ufw allow "${GENIEACS_UI_PORT}/tcp" comment 'GenieACS UI'
if [[ "${GENIEACS_OPEN_NBI}" == "1" ]]; then
  warn "NBI GenieACS (${GENIEACS_NBI_PORT}) dibuka ke publik dan TIDAK punya autentikasi bawaan!"
  $SUDO ufw allow "${GENIEACS_NBI_PORT}/tcp" comment 'GenieACS NBI'
else
  info "NBI GenieACS (${GENIEACS_NBI_PORT}) tidak dibuka: billing mengaksesnya via localhost."
fi
$SUDO ufw --force enable || true

info "=== Restart FreeRADIUS ==="
$SUDO systemctl enable freeradius
$SUDO systemctl restart freeradius

SERVER_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')
[[ -n "${SERVER_IP}" ]] || SERVER_IP="127.0.0.1"

echo
ok "=== Instalasi selesai ==="
echo -e "${GREEN}Billing  : http://${SERVER_IP}:${APP_PORT}${NC}"
echo -e "${GREEN}Login    : ${WEB_ADMIN} / (password yang Anda masukkan)${NC}"
echo -e "${GREEN}Database : PostgreSQL ${DB_NAME} user=${DB_USER}${NC}"
echo -e "${GREEN}PM2      : pm2 ls   |   pm2 logs billing${NC}"
echo -e "${GREEN}RADIUS   : DB=${DB_NAME} secret=(input Anda) client 0.0.0.0/0${NC}"
echo
echo "Catatan:"
echo "  - Billing + FreeRADIUS: PostgreSQL saja (DB_SERVICE=postgresql di .env)"
echo "  - Kredensial DB di ${APP_DIR}/.env"
echo "  - Dokumentasi: ${APP_DIR}/docs/DATABASE-POSTGRESQL.md"
echo "  - Tidak ada Nginx; akses web langsung port ${APP_PORT} (HTTPS opsional: reverse proxy terpisah + TRUST_PROXY=1)"
echo "  - acs-standalone: MariaDB terpisah — jangan campur DB billing ke MariaDB"
echo "  - Setelah verifikasi PPP/Hotspot, secret MikroTik = RADIUS_SECRET"
echo "  - GenieACS (UI :${GENIEACS_UI_PORT}, CWMP :${GENIEACS_CWMP_PORT}) diinstal terpisah; UFW sudah dibuka"
echo "  - Di Billing > ACS, isi GenieACS: 127.0.0.1 port ${GENIEACS_NBI_PORT} (NBI via localhost)"