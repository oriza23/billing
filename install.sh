#!/usr/bin/env bash
# =============================================================================
# install.sh — RANIAH.NET ISP Billing System (Utama)
# Setup server: Debian 11 / Ubuntu 22.04+ (termasuk Ubuntu 24.04)
#
# Stack: PostgreSQL · FreeRADIUS (PostgreSQL) · Node.js 22 · React/Vite
# Repo: https://github.com/oriza23/billing
#
# Backend: server.js + folder backend/ (kode) di akar repositori (bukan paket npm terpisah).
# Frontend: frontend/ (React + Vite build → frontend/dist, dilayani Express).
# Default development: Node langsung (port 5000); PM2 dan Nginx hanya bila diminta.
#
# MariaDB: tidak dipasang. Proyek acs-standalone (jika ada) memakai installer sendiri.
# =============================================================================
set -euo pipefail

# APT non-interaktif: tanpa dialog debconf, tanpa prompt needrestart / "Pending kernel upgrade".
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_PORT="${APP_PORT:-5000}"
USE_NGINX="${USE_NGINX:-0}"
USE_PM2="${USE_PM2:-0}"
NGINX_SITE_NAME="${NGINX_SITE_NAME:-raniah-billing}"

GENIEACS_UI_PORT="${GENIEACS_UI_PORT:-3000}"
GENIEACS_CWMP_PORT="${GENIEACS_CWMP_PORT:-7547}"
GENIEACS_NBI_PORT="${GENIEACS_NBI_PORT:-7557}"
GENIEACS_FS_PORT="${GENIEACS_FS_PORT:-7567}"
GENIEACS_OPEN_NBI="${GENIEACS_OPEN_NBI:-0}"

# Subnet tunnel VPN (server ini VPN client ke CHR) yang boleh mengakses semua port server lewat UFW.
# Kosongkan (VPN_SUBNET="") untuk tidak membuat aturan itu. Harus CIDR IPv4 dengan prefix /16../32.
VPN_SUBNET="${VPN_SUBNET-10.210.0.0/24}"

RADDB="${RADDB:-/etc/freeradius/3.0}"
RADIUS_SCHEMA="${RADIUS_SCHEMA:-${RADDB}/mods-config/sql/main/postgresql/schema.sql}"
CLIENTS_MARKER="BEGIN-ORIZABIL-BILLING-INSTALL"

GREEN='\033[1;32m'
YELLOW='\033[1;33m'
CYAN='\033[1;36m'
RED='\033[1;31m'
NC='\033[0m'

# Dua mode: root langsung, atau user biasa (mis. ubuntu) yang punya akses sudo.
RUN_USER=$(id -un)
RUN_GROUP=$(id -gn)
if [[ "$(id -u)" -eq 0 ]]; then
  IS_ROOT=1
  APP_USER="${SUDO_USER:-root}"
else
  IS_ROOT=0
  APP_USER="$RUN_USER"
fi
APP_HOME=$(getent passwd "$APP_USER" | cut -d: -f6)

die() { echo -e "${RED}$*${NC}" >&2; exit 1; }
info() { echo -e "${YELLOW}$*${NC}"; }
ok() { echo -e "${GREEN}$*${NC}"; }
warn() { echo -e "${RED}$*${NC}"; }

# Non-root: pastikan sudo ada dan minta password SEKARANG, bukan gagal di tengah instalasi.
# Timestamp sudo diperbarui di latar belakang karena apt upgrade bisa lebih lama dari 15 menit.
if [[ "$IS_ROOT" -eq 0 ]]; then
  command -v sudo >/dev/null 2>&1 \
    || die "Perintah sudo tidak ditemukan. Jalankan sebagai root, atau pasang sudo dan beri user ${RUN_USER} akses sudo."
  info "Menjalankan sebagai ${RUN_USER} (bukan root): meminta autentikasi sudo..."
  sudo -v || die "Autentikasi sudo gagal. User ${RUN_USER} harus punya akses sudo."
  ( while kill -0 "$$" 2>/dev/null; do sudo -n true 2>/dev/null || exit 0; sleep 50; done ) &
  SUDO_KEEPALIVE_PID=$!
  trap 'kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true' EXIT
fi

# Jalankan perintah sebagai root: langsung bila sudah root, lewat sudo bila bukan.
# Dipakai untuk semua perintah sistem (apt-get, systemctl, ufw, menulis ke /etc, chown, visudo, ...).
run_root() {
  if [[ "$IS_ROOT" -eq 1 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

# apt-get non-interaktif. sudo membuang environment, jadi variabelnya dikirim eksplisit lewat env.
apt_get() {
  run_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1 \
    apt-get -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}

# Perintah PostgreSQL (psql, createuser, createdb, ...) selalu sebagai user postgres.
# cd / agar tidak ada peringatan "could not change directory" dari folder milik user lain.
run_postgres() {
  (cd / && run_root runuser -u postgres -- "$@")
}

# Node.js minimal v22 (LTS) dan npm wajib ada sebelum tahap npm install / npm run build.
NODE_MIN_MAJOR=22

node_major() {
  local major
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || major=0
  [[ "$major" =~ ^[0-9]+$ ]] || major=0
  echo "$major"
}

node_ok() {
  command -v npm >/dev/null 2>&1 && (( $(node_major) >= NODE_MIN_MAJOR ))
}

ensure_node() {
  if node_ok; then
    ok "Node.js $(node -v) dan npm $(npm -v) sudah memenuhi syarat (minimal v${NODE_MIN_MAJOR})."
    return 0
  fi
  local current="belum terpasang"
  if command -v node >/dev/null 2>&1; then
    current="$(node -v)"
  fi
  info "Node.js ${current}: butuh minimal v${NODE_MIN_MAJOR}. Memasang Node.js ${NODE_MIN_MAJOR}.x LTS dari NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x" \
    | run_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a bash - \
    || die "Gagal menyiapkan repositori NodeSource. Periksa koneksi internet VPS lalu jalankan ulang install.sh."
  apt_get install -y nodejs
  hash -r
  node_ok || die "Node.js >= v${NODE_MIN_MAJOR} dan npm tidak berhasil dipasang. Pasang manual lalu jalankan ulang install.sh."
  ok "Terpasang: Node.js $(node -v), npm $(npm -v)"
}

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

# Nilai .env yang aman untuk karakter khusus (# spasi $ dan sejenisnya).
dotenv_quote() {
  local v=$1
  v=${v//\\/\\\\}
  v=${v//\"/\\\"}
  printf '"%s"' "$v"
}

generate_db_password() {
  # 32 karakter hex (128 bit), memenuhi syarat minimal 20 karakter.
  openssl rand -hex 16
}

assert_db_password_ready() {
  [[ -n "${DB_PASSWORD:-}" ]] || die "DB_PASSWORD kosong. Ulangi input password database atau biarkan kosong agar dibuat otomatis."
  [[ "$DB_PASSWORD" != *$'\n'* ]] || die "DB_PASSWORD tidak boleh mengandung baris baru."
  (( ${#DB_PASSWORD} >= 8 )) || die "Password database minimal 8 karakter."
}

# URL postgres:// untuk alat eksternal (psql, backup). User, password, dan nama DB di-encode.
build_database_url() {
  DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD" DB_NAME="$DB_NAME" DB_PORT="5432" python3 - <<'PY'
import os, urllib.parse
user = urllib.parse.quote(os.environ["DB_USER"], safe="")
password = urllib.parse.quote(os.environ["DB_PASSWORD"], safe="")
name = urllib.parse.quote(os.environ["DB_NAME"], safe="")
port = os.environ.get("DB_PORT", "5432")
host = os.environ.get("DB_HOST", "localhost")
print(f"postgresql://{user}:{password}@{host}:{port}/{name}")
PY
}

# Wajib sebelum node server.js / migrasi: file .env ada dan DB_PASSWORD tidak kosong (bukan string kosong di Node).
validate_dotenv_db() {
  local env_file="$APP_DIR/.env"
  [[ -f "$env_file" ]] || die "File .env tidak ada di ${APP_DIR}. Tahap penulisan .env gagal atau dilewati."
  local line val
  line=$(grep -E '^DB_PASSWORD=' "$env_file" | tail -1) || true
  [[ -n "$line" ]] || die "Baris DB_PASSWORD tidak ditemukan di .env."
  val="${line#DB_PASSWORD=}"
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  [[ -n "$val" ]] || die "DB_PASSWORD di .env kosong. Periksa tahap PostgreSQL (role/password) dan penulisan .env."
  ( cd "$APP_DIR" && node -e "
const path=require('path');
require('./backend/load_env')(path.join(process.cwd(),'.env'));
const p=process.env.DB_PASSWORD;
if(typeof p!=='string'||p.length===0){process.exit(2);}
" ) || die "Node tidak bisa membaca DB_PASSWORD dari .env (harus string tidak kosong). Periksa isi ${env_file}."
}

test_db_login() {
  PGPASSWORD="$DB_PASSWORD" psql -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c 'SELECT 1 AS ok;' \
    || die "Login PostgreSQL gagal untuk ${DB_USER}@${DB_NAME}. Password role tidak cocok dengan DB_PASSWORD."
}

if [[ ! -f "$APP_DIR/server.js" || ! -f "$APP_DIR/frontend/package.json" ]]; then
  die "Jalankan script di folder clone billing (ada server.js dan frontend/package.json)."
fi

[[ "$USE_NGINX" == "0" || "$USE_NGINX" == "1" ]] || die "USE_NGINX harus 0 atau 1."
[[ "$USE_PM2" == "0" || "$USE_PM2" == "1" ]] || die "USE_PM2 harus 0 atau 1."

echo -e "${CYAN}=== RANIAH.NET — Installer Billing (PostgreSQL + FreeRADIUS + Node.js) ===${NC}"
echo

# =============================================================================
# 1. INPUT INTERAKTIF
# =============================================================================
read -r -p "Nama Database (DB_NAME) [orizabil]: " DB_NAME
DB_NAME=${DB_NAME:-orizabil}

read -r -p "Username DB (DB_USER) [oriza]: " DB_USER
DB_USER=${DB_USER:-oriza}

read -r -s -p "Password DB (DB_PASSWORD) [Enter = otomatis]: " DB_PASSWORD
echo
if [[ -z "$DB_PASSWORD" ]]; then
  DB_PASSWORD=$(generate_db_password)
  ok "Password DB dibuat otomatis (${#DB_PASSWORD} karakter)."
fi
assert_db_password_ready

echo
read -r -p "Username Superadmin Web (WEB_ADMIN) [admin]: " WEB_ADMIN
WEB_ADMIN=${WEB_ADMIN:-admin}

read -r -s -p "Password Superadmin Web (WEB_PASS): " WEB_PASS
echo
if [[ -z "$WEB_PASS" ]]; then
  die "WEB_PASS wajib diisi (minimal 8 karakter)."
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
[[ "$WEB_ADMIN" =~ ^[A-Za-z0-9._-]{1,50}$ ]] || die "WEB_ADMIN tidak valid."
[[ ${#WEB_PASS} -ge 8 ]] || die "WEB_PASS minimal 8 karakter."

echo
info "Ringkasan:"
echo "  DB         : PostgreSQL ${DB_NAME} (${DB_USER}@localhost:5432)"
echo "  Web admin  : ${WEB_ADMIN}"
echo "  RADIUS     : NAS dari menu Router (sinkron ke tabel nas)"
if [[ "$USE_NGINX" == "1" ]]; then
  echo "  Publik web : Nginx :80 → Node :${APP_PORT}"
else
  echo "  Publik web : http://IP:${APP_PORT} (tanpa Nginx)"
fi
if [[ "$USE_PM2" == "1" ]]; then
  echo "  Proses app : PM2"
else
  echo "  Proses app : jalankan manual dengan npm start"
fi
read -r -p "Lanjut instalasi? [y/N]: " CONFIRM
CONFIRM=${CONFIRM:-N}
[[ "$CONFIRM" =~ ^[yY] ]] || die "Instalasi dibatalkan."

SUPERADMIN_USER="$WEB_ADMIN"
SUPERADMIN_PASS="$WEB_PASS"
SUPERADMIN_NAMA="$WEB_ADMIN_NAMA"

# =============================================================================
# 2. OS & dependensi
# =============================================================================
info "=== apt update & upgrade ==="
apt_get update
apt_get upgrade -y

info "=== Paket dasar: curl, wget, git, PostgreSQL ==="
apt_get install -y \
  ca-certificates curl wget git openssl ufw \
  postgresql postgresql-contrib \
  build-essential

info "=== Node.js & npm (wajib sebelum build) ==="
ensure_node

# Paket VPN client untuk menu Sistem > Koneksi VPN (WireGuard / OpenVPN / SSTP / L2TP ke MikroTik CHR).
# Dipasang terpisah: bila satu paket tidak tersedia di repo, instalasi billing tetap lanjut.
info "=== Paket VPN client: wireguard-tools, openvpn, sstp-client, xl2tpd, ppp ==="
apt_get install -y wireguard-tools openvpn sstp-client xl2tpd ppp \
  || warn "Sebagian paket VPN gagal dipasang. Menu Koneksi VPN tetap tampil; pasang manual: apt install wireguard-tools openvpn sstp-client xl2tpd ppp"
# Unit bawaan Ubuntu membatasi openvpn-server@ ke 10 proses. auth-user-pass-verify
# lalu gagal fork (errno 11). Drop-in ini melepas batas itu sebelum service dihidupkan.
run_root install -d -m 0755 /etc/systemd/system/openvpn-server@raniah-server.service.d
run_root tee /etc/systemd/system/openvpn-server@raniah-server.service.d/override.conf >/dev/null <<'EOF'
[Unit]
After=network-online.target
Wants=network-online.target

[Service]
ExecStartPre=/bin/mkdir -p /run/openvpn-server
LimitNPROC=infinity
TasksMax=infinity
EOF
run_root systemctl daemon-reload || true
# strongSwan (swanctl) hanya dipakai L2TP/IPsec saat IPsec Pre-Shared Key diisi. Terpisah dari
# xl2tpd supaya L2TP murni tetap berjalan walau paket ini tidak tersedia.
info "=== Paket IPsec opsional untuk L2TP/IPsec: strongswan-swanctl, charon-systemd ==="
apt_get install -y strongswan-swanctl charon-systemd \
  || warn "Paket strongSwan gagal dipasang. L2TP murni tetap bisa dipakai; untuk L2TP/IPsec pasang manual: apt install strongswan-swanctl charon-systemd"
# Paket Debian/Ubuntu langsung menyalakan xl2tpd (UDP 1701) dan strongSwan (UDP 500/4500) dengan
# konfigurasi bawaan. Keduanya hanya dibutuhkan saat L2TP dihubungkan (raniah-l2tp.service yang
# menyalakannya), jadi dimatikan agar port tidak terbuka percuma. Dilewati bila L2TP sedang aktif
# (instalasi ulang) supaya tunnel yang berjalan tidak terputus.
if ! systemctl is-active --quiet raniah-l2tp 2>/dev/null; then
  for L2TP_SVC in xl2tpd strongswan strongswan-starter strongswan-swanctl; do
    if systemctl cat "${L2TP_SVC}.service" >/dev/null 2>&1; then
      run_root systemctl disable --now "${L2TP_SVC}.service" >/dev/null 2>&1 || true
    fi
  done
fi

# Tuning jaringan untuk tunnel VPN (RADIUS sensitif terhadap latensi/RTO). Buffer UDP lebih besar
# untuk WireGuard/OpenVPN (sndbuf/rcvbuf 384 KiB di .ovpn butuh rmem_max/wmem_max >= nilainya),
# MTU probing untuk TCP (SSTP) di jalur PPPoE, dan rp_filter loose (2) agar balasan yang masuk
# lewat interface tunnel tidak dibuang. Idempoten: berkas ditimpa dengan isi yang sama.
info "=== Tuning sysctl VPN: /etc/sysctl.d/99-raniah-vpn.conf ==="
SYSCTL_VPN_FILE=/etc/sysctl.d/99-raniah-vpn.conf
SYSCTL_VPN_TMP=$(mktemp)
cat > "$SYSCTL_VPN_TMP" <<'EOF'
# RANIAH billing: tuning jaringan untuk koneksi VPN (WireGuard/OpenVPN/SSTP/L2TP) ke MikroTik CHR.
net.core.rmem_max=26214400
net.core.wmem_max=26214400
net.ipv4.udp_rmem_min=16384
net.ipv4.udp_wmem_min=16384
net.ipv4.tcp_mtu_probing=1
net.ipv4.conf.all.rp_filter=2
EOF
run_root install -m 0644 "$SYSCTL_VPN_TMP" "$SYSCTL_VPN_FILE"
rm -f "$SYSCTL_VPN_TMP"
# Di LXC/kontainer sebagian parameter read-only (hanya host yang boleh mengubahnya). Itu tidak
# boleh menggagalkan instalasi: coba sysctl --system, bila ada yang gagal terapkan per parameter
# dan laporkan mana yang ditolak.
if ! run_root sysctl --system >/dev/null 2>&1; then
  SYSCTL_DENIED=()
  while IFS='=' read -r SYSCTL_KEY SYSCTL_VAL; do
    [[ "$SYSCTL_KEY" =~ ^net\.[a-z0-9_.]+$ ]] || continue
    run_root sysctl -w "${SYSCTL_KEY}=${SYSCTL_VAL}" >/dev/null 2>&1 || SYSCTL_DENIED+=("$SYSCTL_KEY")
  done < "$SYSCTL_VPN_FILE"
  if (( ${#SYSCTL_DENIED[@]} > 0 )); then
    warn "Parameter sysctl ditolak (read-only di kontainer/host): ${SYSCTL_DENIED[*]}. Berkas tetap tersimpan; set di host Proxmox bila perlu."
  fi
fi

if [[ "$USE_NGINX" == "1" ]]; then
  info "=== Nginx reverse proxy ==="
  apt_get install -y nginx
fi

if systemctl is-active mariadb >/dev/null 2>&1 || systemctl is-active mysql >/dev/null 2>&1; then
  info "MariaDB/MySQL terdeteksi (mis. acs-standalone): tidak diubah oleh installer billing."
fi

# =============================================================================
# 3. PostgreSQL
# =============================================================================
info "=== PostgreSQL: role, database, hak akses ==="
run_root systemctl enable --now postgresql

DB_USER_SQL=$(sql_escape_pg "$DB_USER")
DB_PASSWORD_SQL=$(sql_escape_pg "$DB_PASSWORD")
DB_NAME_SQL=$(sql_escape_pg "$DB_NAME")

run_postgres psql -v ON_ERROR_STOP=1 <<SQL
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

test_db_login
ok "PostgreSQL: role ${DB_USER} dan database ${DB_NAME} siap (password terverifikasi)."

# =============================================================================
# 4. FreeRADIUS + PostgreSQL
# =============================================================================
info "=== FreeRADIUS + freeradius-postgresql ==="
apt_get install -y freeradius freeradius-postgresql
if dpkg -s freeradius-mysql >/dev/null 2>&1; then
  apt_get purge -y freeradius-mysql || true
fi

run_root test -f "$RADIUS_SCHEMA" || die "Skema RADIUS tidak ada: $RADIUS_SCHEMA"

info "=== Impor skema SQL RADIUS ke ${DB_NAME} ==="
# schema.sql milik freerad (mode 640): user postgres tidak bisa membukanya. Dibaca root, dialirkan lewat stdin.
run_root cat "$RADIUS_SCHEMA" | run_postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -f -

run_postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
GRANT ALL ON SCHEMA public TO "${DB_USER_SQL}";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${DB_USER_SQL}";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${DB_USER_SQL}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${DB_USER_SQL}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${DB_USER_SQL}";
SQL

SQL_MOD="${RADDB}/mods-available/sql"
STAMP=$(date +%Y%m%d-%H%M%S)
run_root cp -a "$SQL_MOD" "${SQL_MOD}.bak.${STAMP}"

info "=== mods-enabled/sql → PostgreSQL ==="
run_root sed -i \
  -e 's/^[[:space:]]*dialect[[:space:]]*=.*/\tdialect = "postgresql"/' \
  -e 's/^[[:space:]]*driver[[:space:]]*=.*/\tdriver = "rlm_sql_postgresql"/' \
  "$SQL_MOD"

RAD_ESC_PASS=$(freeradius_escape "$DB_PASSWORD")
run_root sed -i \
  -e 's/^[[:space:]]*server[[:space:]]*=.*/\tserver = "localhost"/' \
  -e 's/^[[:space:]]*port[[:space:]]*=.*/\tport = 5432/' \
  -e "s/^[[:space:]]*login[[:space:]]*=.*/\tlogin = \"${DB_USER}\"/" \
  -e "s/^[[:space:]]*password[[:space:]]*=.*/\tpassword = \"${RAD_ESC_PASS}\"/" \
  -e "s/^[[:space:]]*radius_db[[:space:]]*=.*/\tradius_db = \"${DB_NAME}\"/" \
  "$SQL_MOD"

run_root ln -sf ../mods-available/sql "${RADDB}/mods-enabled/sql"

HOTSPOT_MOD="$APP_DIR/deploy/freeradius/mods-available/hotspot_time"
if [[ -f "$HOTSPOT_MOD" ]]; then
  run_root install -o freerad -g freerad -m 640 "$HOTSPOT_MOD" "${RADDB}/mods-available/hotspot_time"
  run_root ln -sf ../mods-available/hotspot_time "${RADDB}/mods-enabled/hotspot_time" 2>/dev/null || true
fi

info "=== clients.conf (MikroTik / NAS) ==="
# Tidak ada client catch-all (0.0.0.0/0). Setiap router ditambahkan lewat menu Router di web,
# lalu disinkronkan otomatis ke tabel nas (lihat docs/MULTI_NAS.md). Hapus sisa blok
# install lama bila ada, supaya NAS yang tidak terdaftar ditolak.
CLIENTS_CONF="${RADDB}/clients.conf"
if run_root grep -q "$CLIENTS_MARKER" "$CLIENTS_CONF" 2>/dev/null; then
  run_root sed -i "/# --- ${CLIENTS_MARKER} ---/,/# --- ${CLIENTS_MARKER}-END ---/d" "$CLIENTS_CONF"
  info "Blok catch-all lama (${CLIENTS_MARKER}) dihapus dari clients.conf."
fi

if ! run_root freeradius -XC >"/tmp/freeradius-install-${STAMP}.log" 2>&1; then
  die "freeradius -XC gagal — lihat /tmp/freeradius-install-${STAMP}.log"
fi

# =============================================================================
# 5. Node.js 22, npm, backend, frontend build, migrasi & seeder
# =============================================================================
info "=== Verifikasi Node.js & npm ==="
ensure_node
# Upgrade npm bersifat opsional: npm bawaan Node 22 sudah cukup untuk build.
run_root npm install -g 'npm@^12' || warn "Upgrade npm ke ^12 dilewati; memakai npm $(npm -v)."
hash -r
node -v && npm -v

# npm install / build berjalan sebagai user ini, jadi folder proyek harus miliknya. Bila tidak
# (mis. sisa instalasi sebelumnya milik billing atau root), node_modules, frontend/dist dan .env
# gagal ditulis. Di akhir instalasi kepemilikan dikembalikan ke user service.
if [[ "$IS_ROOT" -eq 0 ]]; then
  info "=== Kepemilikan folder aplikasi → ${RUN_USER}:${RUN_GROUP} (untuk npm install & build) ==="
  run_root chown -R "${RUN_USER}:${RUN_GROUP}" "$APP_DIR"
fi

if [[ "$USE_PM2" == "1" ]] && ! command -v pm2 >/dev/null 2>&1; then
  info "=== PM2 global ==="
  run_root npm install -g pm2
fi

JWT_SECRET=$(openssl rand -hex 48)
DATABASE_URL=$(build_database_url)

info "=== .env (backend / server.js) ==="
assert_db_password_ready
umask 077
{
  echo "PORT=${APP_PORT}"
  echo "DB_HOST=localhost"
  echo "DB_PORT=5432"
  echo "DB_USER=${DB_USER}"
  echo "DB_PASSWORD=$(dotenv_quote "$DB_PASSWORD")"
  echo "DB_NAME=${DB_NAME}"
  echo "DB_SERVICE=postgresql"
  echo "DATABASE_URL=$(dotenv_quote "$DATABASE_URL")"
  echo "JWT_SECRET=${JWT_SECRET}"
  echo "JWT_EXPIRES_IN=12h"
  echo "BOOTSTRAP_ADMIN_USERNAME=${WEB_ADMIN}"
  echo "BOOTSTRAP_ADMIN_PASSWORD=$(dotenv_quote "$WEB_PASS")"
  echo "SETUP_ADMIN_NAMA_LENGKAP=${WEB_ADMIN_NAMA}"
  if [[ "$USE_NGINX" == "1" ]]; then
    echo "TRUST_PROXY=1"
  fi
} > "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
echo "VITE_API_URL=" > "$APP_DIR/frontend/.env.production"
validate_dotenv_db
test_db_login

info "=== npm install backend (akar proyek) ==="
cd "$APP_DIR"
npm install

info "=== Migrasi tabel billing (server.js) ==="
validate_dotenv_db
BILLING_SCHEMA_ONLY=1 node server.js

info "=== Seeder superadmin (WEB_ADMIN) ==="
validate_dotenv_db
node "$APP_DIR/scripts/setup-admin.js"

info "=== npm install & build frontend ==="
cd "$APP_DIR/frontend"
npm install
npm run build

# =============================================================================
# 6. Optional PM2 & Nginx
# =============================================================================
if [[ "$USE_PM2" == "1" ]]; then
  info "=== PM2: billing ==="
  pm2 delete billing 2>/dev/null || true
  pm2 start "$APP_DIR/server.js" --name billing --cwd "$APP_DIR"
  pm2 save
  run_root env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" || true
  pm2 save
else
  info "PM2 dilewati. Jalankan backend dengan: cd \"$APP_DIR\" && npm start"
fi

if [[ "$USE_NGINX" == "1" ]]; then
  info "=== Nginx reverse proxy → 127.0.0.1:${APP_PORT} ==="
  NGINX_CONF=$(mktemp)
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
  run_root install -m 0644 "$NGINX_CONF" "/etc/nginx/sites-available/${NGINX_SITE_NAME}"
  rm -f "$NGINX_CONF"
  run_root ln -sf "/etc/nginx/sites-available/${NGINX_SITE_NAME}" "/etc/nginx/sites-enabled/${NGINX_SITE_NAME}"
  run_root rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
  run_root nginx -t
  run_root systemctl enable --now nginx
  run_root systemctl reload nginx
fi

# =============================================================================
# 7. UFW & restart layanan
# =============================================================================
info "=== UFW ==="
# Hanya port yang dibutuhkan billing, FreeRADIUS, dan GenieACS. Server ini adalah VPN CLIENT,
# jadi tidak ada port inbound VPN (1194, 1701, 500/4500, 51820, 9921, dst. tidak dibuka).
# Aturan yang sudah ada tidak dihapus oleh installer; hapus sisa uji coba dengan: ufw delete allow <port>/<proto>.
run_root ufw default deny incoming
run_root ufw default allow outgoing
# SSH dibuka lebih dulu, sebelum ufw enable, supaya sesi tidak terputus.
run_root ufw allow OpenSSH
run_root ufw allow "${APP_PORT}/tcp" comment 'Billing web' 2>/dev/null || true
if [[ "$USE_NGINX" == "1" ]]; then
  run_root ufw allow 80/tcp comment 'Web HTTP (Nginx/reverse proxy)' 2>/dev/null || true
  run_root ufw allow 443/tcp comment 'Web HTTPS (Nginx/reverse proxy)' 2>/dev/null || true
fi
run_root ufw allow 1812/udp comment 'FreeRADIUS auth' 2>/dev/null || true
run_root ufw allow 1813/udp comment 'FreeRADIUS acct' 2>/dev/null || true
run_root ufw allow "${GENIEACS_CWMP_PORT}/tcp" comment 'GenieACS CWMP (TR-069)' 2>/dev/null || true
run_root ufw allow "${GENIEACS_FS_PORT}/tcp" comment 'GenieACS File Server' 2>/dev/null || true
run_root ufw allow "${GENIEACS_UI_PORT}/tcp" comment 'GenieACS UI' 2>/dev/null || true
if [[ "${GENIEACS_OPEN_NBI}" == "1" ]]; then
  warn "Port NBI GenieACS ${GENIEACS_NBI_PORT} dibuka ke publik tanpa auth bawaan."
  run_root ufw allow "${GENIEACS_NBI_PORT}/tcp" comment 'GenieACS NBI'
fi
if [[ -n "$VPN_SUBNET" ]]; then
  # Validasi ketat: /0../15 akan membuka semua port ke sebagian besar internet.
  if [[ "$VPN_SUBNET" =~ ^(([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3}))/([0-9]{1,2})$ ]] \
    && (( 10#${BASH_REMATCH[2]} <= 255 && 10#${BASH_REMATCH[3]} <= 255 && 10#${BASH_REMATCH[4]} <= 255 && 10#${BASH_REMATCH[5]} <= 255 )) \
    && (( 10#${BASH_REMATCH[6]} >= 16 && 10#${BASH_REMATCH[6]} <= 32 )); then
    run_root ufw allow from "$VPN_SUBNET" comment 'Subnet VPN (client ke CHR)' 2>/dev/null || true
  else
    warn "VPN_SUBNET='${VPN_SUBNET}' tidak valid (wajib CIDR IPv4 prefix /16../32); aturan UFW subnet VPN dilewati."
  fi
fi
run_root ufw --force enable || true
run_root ufw reload || true

run_root systemctl enable freeradius
run_root systemctl restart freeradius

# User aplikasi: $SUDO_USER bila installer dijalankan lewat sudo, selain itu user aktif.
# Root tidak perlu sudoers. User lain hanya boleh: restart postgresql/freeradius (menu Pengaturan)
# dan mengelola 4 unit VPN tetap + xl2tpd (menu Koneksi VPN), semuanya tanpa wildcard.
if [[ "$APP_USER" == "root" ]]; then
  info "Node berjalan sebagai root, /etc/sudoers.d/raniah-services tidak diperlukan."
elif [[ ! "$APP_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  warn "User ${APP_USER} tidak dipakai untuk sudoers restart."
else
  info "=== Helper VPN (root-owned) ==="
  run_root bash "$APP_DIR/deploy/install-vpn-helper.sh" || warn "Helper VPN gagal dipasang; menu Koneksi VPN tidak bisa menulis konfigurasi."

  info "=== sudoers layanan & VPN untuk ${APP_USER} ==="
  VPN_UNITS=(wg-quick@wg-billing openvpn-client@raniah-vpn raniah-sstp raniah-l2tp)
  SUDO_CMDS=()
  for SYSTEMCTL_BIN in /bin/systemctl /usr/bin/systemctl; do
    SUDO_CMDS+=("${SYSTEMCTL_BIN} restart postgresql" "${SYSTEMCTL_BIN} restart freeradius" "${SYSTEMCTL_BIN} reload freeradius")
    for VPN_UNIT in "${VPN_UNITS[@]}"; do
      SUDO_CMDS+=(
        "${SYSTEMCTL_BIN} enable --now ${VPN_UNIT}"
        "${SYSTEMCTL_BIN} restart ${VPN_UNIT}"  # menu Koneksi VPN: Restart VPN / Hubungkan ulang
        "${SYSTEMCTL_BIN} disable --now ${VPN_UNIT}"
        "${SYSTEMCTL_BIN} reset-failed ${VPN_UNIT}"
      )
    done
    # xl2tpd (daemon L2TP) ikut dimatikan saat L2TP dilepas, tanpa hak restart/enable-nya.
    SUDO_CMDS+=("${SYSTEMCTL_BIN} disable --now xl2tpd" "${SYSTEMCTL_BIN} reset-failed xl2tpd")
  done
  SUDO_CMDS+=("/usr/bin/wg show wg-billing dump" "/usr/local/sbin/raniah-vpn-helper apply")
  # Restart/connect/disconnect tidak memakai systemctl restart mentah. Helper root yang
  # menghentikan unit, membunuh proses yatim, menunggu interface hilang, lalu start.
  for VPN_PROTO in wireguard openvpn sstp l2tp server ovpn-server l2tp-server; do
    for VPN_ACTION in stop start restart disable; do
      SUDO_CMDS+=("/usr/local/sbin/raniah-vpn-helper cycle ${VPN_PROTO} ${VPN_ACTION}")
    done
  done
  # wg-server adalah VPN Server (hub NAS). Port UDP-nya tidak dibuka di blok UFW instalasi;
  # helper membukanya hanya saat mode server diaktifkan, dan menutupnya saat mode client menyala.
  SUDO_CMDS+=(
    "/usr/bin/systemctl enable --now wg-quick@wg-server"
    "/usr/bin/systemctl restart wg-quick@wg-server"
    "/usr/bin/systemctl disable --now wg-quick@wg-server"
    "/usr/bin/systemctl reset-failed wg-quick@wg-server"
    "/usr/bin/wg show wg-server dump"
    "/usr/bin/journalctl -u wg-quick@wg-server -n 20 --no-pager"
    "/usr/local/sbin/raniah-vpn-helper apply-server"
    "/usr/bin/systemctl enable --now openvpn-server@raniah-server"
    "/usr/bin/systemctl restart openvpn-server@raniah-server"
    "/usr/bin/systemctl disable --now openvpn-server@raniah-server"
    "/usr/bin/systemctl reset-failed openvpn-server@raniah-server"
    "/usr/bin/journalctl -u openvpn-server@raniah-server -n 20 --no-pager"
    "/usr/bin/cat /etc/openvpn/server/raniah-pki/ca.crt"
    "/usr/bin/cat /run/openvpn-server/status-raniah.log"
    "/usr/local/sbin/raniah-vpn-helper apply-ovpn-server"
    "/usr/local/sbin/raniah-vpn-helper apply-l2tp-server"
    "/usr/local/sbin/raniah-vpn-helper start-l2tp-server"
    "/usr/local/sbin/raniah-vpn-helper stop-l2tp-server"
  )
  # Log unit VPN ditampilkan di UI saat koneksi belum tersambung. SSTP/L2TP 20 baris
  # supaya pesan TLS/sertifikat/auth tidak terpotong baris Exit pppd. Log L2TP menggabungkan
  # xl2tpd karena pppd dan xl2tpd berjalan di bawah xl2tpd.service.
  for VPN_UNIT in "${VPN_UNITS[@]}"; do
    case "$VPN_UNIT" in
      raniah-sstp) SUDO_CMDS+=("/usr/bin/journalctl -u raniah-sstp -n 20 --no-pager") ;;
      raniah-l2tp) SUDO_CMDS+=("/usr/bin/journalctl -u raniah-l2tp -u xl2tpd -n 20 --no-pager") ;;
      *) SUDO_CMDS+=("/usr/bin/journalctl -u ${VPN_UNIT} -n 10 --no-pager") ;;
    esac
  done
  printf -v SUDO_LIST '%s, ' "${SUDO_CMDS[@]}"
  SUDO_LIST="${SUDO_LIST%, }"

  SUDOERS_TMP=$(mktemp)
  cat > "$SUDOERS_TMP" <<EOF
# RANIAH billing: restart layanan (Pengaturan) dan koneksi VPN (Sistem > Koneksi VPN), tanpa password.
# Penulisan konfigurasi VPN hanya lewat helper root-owned yang memvalidasi ulang inputnya.
${APP_USER} ALL=(root) NOPASSWD: ${SUDO_LIST}
EOF
  run_root visudo -cf "$SUDOERS_TMP"
  run_root install -m 0440 "$SUDOERS_TMP" /etc/sudoers.d/raniah-services
  run_root chmod 0440 /etc/sudoers.d/raniah-services
  if ! run_root visudo -cf /etc/sudoers.d/raniah-services; then
    run_root rm -f /etc/sudoers.d/raniah-services
    rm -f "$SUDOERS_TMP"
    die "sudoers /etc/sudoers.d/raniah-services tidak valid, berkas dibatalkan."
  fi
  run_root rm -f /etc/sudoers.d/raniah-restart
  rm -f "$SUDOERS_TMP"
fi
if [[ "$USE_NGINX" == "1" ]]; then
  run_root systemctl reload nginx
fi

# =============================================================================
# 8. Kepemilikan akhir & restart billing.service
# =============================================================================
# Service systemd berjalan sebagai user billing (deploy/install-service.sh). Build tadi dibuat oleh
# user yang menjalankan installer, jadi kepemilikan dikembalikan ke billing:billing sebelum restart.
# Mode PM2 berjalan sebagai ${APP_USER}, jadi kepemilikannya tidak diubah.
if run_root systemctl cat billing.service >/dev/null 2>&1; then
  if [[ "$USE_PM2" != "1" ]] && getent passwd billing >/dev/null 2>&1; then
    info "=== Kepemilikan folder aplikasi → billing:billing ==="
    run_root chown -R billing:billing "$APP_DIR"
  fi
  info "=== Restart billing.service ==="
  run_root systemctl restart billing.service || warn "billing.service gagal direstart. Cek: journalctl -u billing -n 30 --no-pager"
else
  info "billing.service belum terpasang; folder aplikasi tetap milik ${RUN_USER}. Untuk service systemd: sudo deploy/install-service.sh"
fi

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
if [[ "$USE_PM2" == "1" ]]; then
  echo -e "${GREEN}Proses   : pm2 ls · pm2 logs billing${NC}"
else
  echo -e "${GREEN}Node.js  : cd \"$APP_DIR\" && npm start${NC}"
fi
echo -e "${GREEN}RADIUS   : secret = (input Anda) · set sama di MikroTik${NC}"
echo

# Catatan Koneksi VPN di kontainer (LXC/Proxmox). Hanya informasi, tidak menggagalkan instalasi.
# WireGuard langsung jalan. OpenVPN butuh /dev/net/tun. SSTP dan L2TP butuh /dev/ppp, modul
# ppp_generic + ppp_async, dan kontainer Privileged. `|| true` karena
# systemd-detect-virt keluar 1 di server fisik/VPS.
CONTAINER_TYPE="$(systemd-detect-virt -c 2>/dev/null || true)"
if [[ -n "$CONTAINER_TYPE" && "$CONTAINER_TYPE" != "none" ]]; then
  echo -e "${CYAN}Catatan: terdeteksi kontainer (${CONTAINER_TYPE}). Menu Sistem > Koneksi VPN:${NC}"
  echo "  WireGuard : langsung jalan di Unprivileged maupun Privileged, tanpa device tambahan."
  echo "  OpenVPN   : Unprivileged maupun Privileged, wajib passthrough /dev/net/tun."
  echo "  SSTP/L2TP : wajib modul ppp_generic + ppp_async, passthrough /dev/ppp, dan kontainer Privileged"
  echo "              (unprivileged: 0). Tanpa itu pppd gagal: Couldn't set tty to PPP discipline: Operation not permitted."
  echo "              Kontainer Unprivileged yang sudah ada: Backup & Restore, hilangkan centang Unprivileged container."
  echo "  Di host Proxmox:"
  echo "    modprobe ppp_generic && modprobe ppp_async"
  echo "    printf 'ppp_generic\\nppp_async\\n' > /etc/modules-load.d/ppp.conf && chmod 666 /dev/ppp"
  VPN_DEV_NOTES=()
  [[ -c /dev/ppp ]] || VPN_DEV_NOTES+=("  SSTP/L2TP: /dev/ppp belum ada. Tambahkan ke /etc/pve/lxc/<CTID>.conf:
              lxc.cgroup2.devices.allow: c 108:0 rwm
              lxc.mount.entry: /dev/ppp dev/ppp none bind,create=file")
  [[ -c /dev/net/tun ]] || VPN_DEV_NOTES+=("  OpenVPN : /dev/net/tun belum ada. Tambahkan ke /etc/pve/lxc/<CTID>.conf:
              lxc.cgroup2.devices.allow: c 10:200 rwm
              lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file")
  if (( ${#VPN_DEV_NOTES[@]} > 0 )); then
    echo "  Device yang belum ada di kontainer ini (lalu pct reboot <CTID>):"
    printf '%s\n' "${VPN_DEV_NOTES[@]}"
  fi
  echo "  Detail: ${APP_DIR}/README.md (Catatan Pengguna Proxmox LXC)."
  echo
fi
echo "Dokumentasi: ${APP_DIR}/README.md"