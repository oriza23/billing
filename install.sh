#!/usr/bin/env bash
# =============================================================================
# install.sh — RANIAH.NET ISP Billing System (Utama)
# Auto-deploy server fresh: Debian 11 / Ubuntu 22.04+ (termasuk Ubuntu 24.04)
#
# Stack: PostgreSQL · FreeRADIUS (PostgreSQL) · Node.js 22 · PM2 · Nginx
# Repo: https://github.com/oriza23/billing.git
#
# Backend: server.js + folder backend/ (kode) di akar repositori (bukan paket npm terpisah).
# Frontend: frontend/ (React + Vite build → frontend/dist, dilayani Express).
#
# MariaDB: tidak dipasang. Proyek acs-standalone (jika ada) memakai installer sendiri.
# =============================================================================
set -euo pipefail

APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_PORT="${APP_PORT:-5000}"
USE_NGINX="${USE_NGINX:-1}"
NGINX_SITE_NAME="${NGINX_SITE_NAME:-raniah-billing}"

GENIEACS_UI_PORT="${GENIEACS_UI_PORT:-3000}"
GENIEACS_CWMP_PORT="${GENIEACS_CWMP_PORT:-7547}"
GENIEACS_NBI_PORT="${GENIEACS_NBI_PORT:-7557}"
GENIEACS_FS_PORT="${GENIEACS_FS_PORT:-7567}"
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

sql_escape_pg() {
  local value=$1
  value=${value//\'/\'\'}
  printf '%s' "$value"
}

freeradius_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '%s' "$value"
}

if [[ ! -f "$APP_DIR/server.js" || ! -f "$APP_DIR/frontend/package.json" ]]; then
  die "Jalankan script di folder clone billing (ada server.js dan frontend/package.json)."
fi

echo -e "${CYAN}=== RANIAH.NET — Installer Billing (PostgreSQL + FreeRADIUS + Nginx) ===${NC}"
echo

# =============================================================================
# 1. INPUT INTERAKTIF
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

if [[ "$USE_NGINX" == "1" ]]; then
  read -r -p "Domain / IP Nginx (server_name) [_]: " SERVER_NAME
  SERVER_NAME=${SERVER_NAME:-_}
else
  SERVER_NAME="_"
fi

if [[ ! "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; then
  die "DB_NAME tidak valid."
fi
if [[ ! "$DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; then
  die "DB_USER tidak valid."
fi
[[ "$DB_PASS" != *$'\n'* ]] || die "DB_PASS tidak boleh mengandung baris baru."
[[ "$WEB_ADMIN" =~ ^[A-Za-z0-9._-]{1,50}$ ]] || die "WEB_ADMIN tidak valid."
[[ ${#WEB_PASS} -ge 8 ]] || die "WEB_PASS minimal 8 karakter."
[[ ${#RADIUS_SECRET} -ge 6 ]] || die "RADIUS_SECRET minimal 6 karakter."

echo
info "Ringkasan:"
echo "  DB         : PostgreSQL ${DB_NAME} (${DB_USER}@localhost:5432)"
echo "  Web admin  : ${WEB_ADMIN}"
echo "  RADIUS     : secret **** · client 0.0.0.0/0"
if [[ "$USE_NGINX" == "1" ]]; then
  echo "  Publik web : Nginx :80 → Node :${APP_PORT}"
else
  echo "  Publik web : http://IP:${APP_PORT} (tanpa Nginx)"
fi
read -r -p "Lanjut instalasi? [y/N]: " CONFIRM
CONFIRM=${CONFIRM:-N}
[[ "$CONFIRM" =~ ^[yY] ]] || die "Instalasi dibatalkan."

DB_PASSWORD="$DB_PASS"
SUPERADMIN_USER="$WEB_ADMIN"
SUPERADMIN_PASS="$WEB_PASS"
SUPERADMIN_NAMA="$WEB_ADMIN_NAMA"

# =============================================================================
# 2. OS & dependensi (curl, wget, git, nginx)
# =============================================================================
info "=== apt update & upgrade ==="
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update
$SUDO apt-get upgrade -y

info "=== Paket dasar: curl, wget, git, nginx, PostgreSQL ==="
$SUDO apt-get install -y \
  ca-certificates curl wget git openssl ufw nginx \
  postgresql postgresql-contrib \
  build-essential

if systemctl is-active mariadb >/dev/null 2>&1 || systemctl is-active mysql >/dev/null 2>&1; then
  info "MariaDB/MySQL terdeteksi (mis. acs-standalone): tidak diubah oleh installer billing."
fi

# =============================================================================
# 3. PostgreSQL
# =============================================================================
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
  || die "Koneksi PostgreSQL gagal untuk ${DB_USER}."

# =============================================================================
# 4. FreeRADIUS + PostgreSQL
# =============================================================================
info "=== FreeRADIUS + freeradius-postgresql ==="
$SUDO apt-get install -y freeradius freeradius-postgresql
if dpkg -s freeradius-mysql >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get purge -y freeradius-mysql || true
fi

[[ -f "$RADIUS_SCHEMA" ]] || die "Skema RADIUS tidak ada: $RADIUS_SCHEMA"

info "=== Impor skema SQL RADIUS ke ${DB_NAME} ==="
$SUDO -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$RADIUS_SCHEMA"

$SUDO -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
GRANT ALL ON SCHEMA public TO "${DB_USER_SQL}";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${DB_USER_SQL}";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${DB_USER_SQL}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${DB_USER_SQL}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${DB_USER_SQL}";
SQL

SQL_MOD="${RADDB}/mods-available/sql"
STAMP=$(date +%Y%m%d-%H%M%S)
$SUDO cp -a "$SQL_MOD" "${SQL_MOD}.bak.${STAMP}"

info "=== mods-enabled/sql → PostgreSQL ==="
$SUDO sed -i \
  -e 's/^[[:space:]]*dialect[[:space:]]*=.*/\tdialect = "postgresql"/' \
  -e 's/^[[:space:]]*driver[[:space:]]*=.*/\tdriver = "rlm_sql_postgresql"/' \
  "$SQL_MOD"

RAD_ESC_PASS=$(freeradius_escape "$DB_PASS")
$SUDO sed -i \
  -e 's/^[[:space:]]*server[[:space:]]*=.*/\tserver = "localhost"/' \
  -e 's/^[[:space:]]*port[[:space:]]*=.*/\tport = 5432/' \
  -e "s/^[[:space:]]*login[[:space:]]*=.*/\tlogin = \"${DB_USER}\"/" \
  -e "s/^[[:space:]]*password[[:space:]]*=.*/\tpassword = \"${RAD_ESC_PASS}\"/" \
  -e "s/^[[:space:]]*radius_db[[:space:]]*=.*/\tradius_db = \"${DB_NAME}\"/" \
  "$SQL_MOD"

$SUDO ln -sf ../mods-available/sql "${RADDB}/mods-enabled/sql"

HOTSPOT_MOD="$APP_DIR/deploy/freeradius/mods-available/hotspot_time"
if [[ -f "$HOTSPOT_MOD" ]]; then
  $SUDO install -o freerad -g freerad -m 640 "$HOTSPOT_MOD" "${RADDB}/mods-available/hotspot_time"
  $SUDO ln -sf ../mods-available/hotspot_time "${RADDB}/mods-enabled/hotspot_time" 2>/dev/null || true
fi

info "=== clients.conf (MikroTik / NAS) ==="
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

if ! $SUDO freeradius -XC >"/tmp/freeradius-install-${STAMP}.log" 2>&1; then
  die "freeradius -XC gagal — lihat /tmp/freeradius-install-${STAMP}.log"
fi

# =============================================================================
# 5. Node.js 22, backend (akar), frontend build, migrasi & seeder
# =============================================================================
if command -v node >/dev/null 2>&1 && node -v | grep -qE '^v22\.'; then
  info "Node.js sudah v22: $(node -v)"
else
  info "=== Node.js 22 LTS (NodeSource) ==="
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

if ! command -v pm2 >/dev/null 2>&1; then
  info "=== PM2 global ==="
  $SUDO npm install -g pm2
fi

JWT_SECRET=$(openssl rand -hex 48)

info "=== .env (backend / server.js) ==="
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
  if [[ "$USE_NGINX" == "1" ]]; then
    echo "TRUST_PROXY=1"
  fi
} > "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
echo "VITE_API_URL=" > "$APP_DIR/frontend/.env.production"

info "=== npm install backend (akar proyek) ==="
cd "$APP_DIR"
npm install

info "=== Migrasi tabel billing (server.js) ==="
BILLING_SCHEMA_ONLY=1 node server.js

info "=== Seeder superadmin (WEB_ADMIN) ==="
node "$APP_DIR/scripts/setup-admin.js"

info "=== npm install & build frontend ==="
cd "$APP_DIR/frontend"
npm install
npm run build

# =============================================================================
# 6. PM2 & Nginx
# =============================================================================
info "=== PM2: billing ==="
pm2 delete billing 2>/dev/null || true
pm2 start "$APP_DIR/server.js" --name billing --cwd "$APP_DIR"
pm2 save
$SUDO env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" || true
pm2 save

if [[ "$USE_NGINX" == "1" ]]; then
  info "=== Nginx reverse proxy → 127.0.0.1:${APP_PORT} ==="
  NGINX_CONF=$($SUDO mktemp)
  cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAME};

    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
  $SUDO cp "$NGINX_CONF" "/etc/nginx/sites-available/${NGINX_SITE_NAME}"
  rm -f "$NGINX_CONF"
  $SUDO ln -sf "/etc/nginx/sites-available/${NGINX_SITE_NAME}" "/etc/nginx/sites-enabled/${NGINX_SITE_NAME}"
  $SUDO rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
  $SUDO nginx -t
  $SUDO systemctl enable --now nginx
  $SUDO systemctl reload nginx
fi

# =============================================================================
# 7. UFW & restart layanan
# =============================================================================
info "=== UFW ==="
$SUDO ufw allow OpenSSH
if [[ "$USE_NGINX" == "1" ]]; then
  $SUDO ufw allow 80/tcp comment 'RANIAH billing HTTP'
  $SUDO ufw allow 443/tcp comment 'RANIAH billing HTTPS' 2>/dev/null || true
else
  $SUDO ufw allow "${APP_PORT}/tcp" comment 'RANIAH billing'
fi
$SUDO ufw allow 1812/udp comment 'FreeRADIUS auth' 2>/dev/null || true
$SUDO ufw allow 1813/udp comment 'FreeRADIUS acct' 2>/dev/null || true
$SUDO ufw allow "${GENIEACS_CWMP_PORT}/tcp" comment 'GenieACS CWMP' 2>/dev/null || true
$SUDO ufw allow "${GENIEACS_FS_PORT}/tcp" comment 'GenieACS FS' 2>/dev/null || true
$SUDO ufw allow "${GENIEACS_UI_PORT}/tcp" comment 'GenieACS UI' 2>/dev/null || true
if [[ "${GENIEACS_OPEN_NBI}" == "1" ]]; then
  warn "Port NBI GenieACS ${GENIEACS_NBI_PORT} dibuka ke publik tanpa auth bawaan."
  $SUDO ufw allow "${GENIEACS_NBI_PORT}/tcp" comment 'GenieACS NBI'
fi
$SUDO ufw --force enable || true

$SUDO systemctl enable freeradius
$SUDO systemctl restart freeradius
[[ "$USE_NGINX" == "1" ]] && $SUDO systemctl reload nginx

SERVER_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')
[[ -n "${SERVER_IP}" ]] || SERVER_IP="127.0.0.1"

echo
ok "=== Instalasi RANIAH.NET Billing selesai ==="
if [[ "$USE_NGINX" == "1" ]]; then
  echo -e "${GREEN}Web      : http://${SERVER_IP}/  (Nginx → :${APP_PORT})${NC}"
else
  echo -e "${GREEN}Web      : http://${SERVER_IP}:${APP_PORT}${NC}"
fi
echo -e "${GREEN}Login    : ${WEB_ADMIN}${NC}"
echo -e "${GREEN}Database : PostgreSQL ${DB_NAME} (${DB_USER})${NC}"
echo -e "${GREEN}PM2      : pm2 ls · pm2 logs billing${NC}"
echo -e "${GREEN}RADIUS   : secret = (input Anda) · set sama di MikroTik${NC}"
echo
echo "Dokumentasi: ${APP_DIR}/README.md"