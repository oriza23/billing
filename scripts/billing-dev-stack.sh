#!/usr/bin/env bash
# Jalankan backend (node server.js :5000) dan frontend Vite (:5173) dalam satu proses systemd.
# Dipanggil oleh billing.service setelah deploy/install-dev-service.sh — jangan jalankan manual
# bersamaan dengan `node server.js` / `npm run dev` di terminal.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${APP_PORT:-5000}"
FRONTEND_PORT="${VITE_DEV_PORT:-5173}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
NPM_BIN="${NPM_BIN:-/usr/bin/npm}"

port_busy() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH "sport = :$port" 2>/dev/null | grep -q .
    return $?
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser "${port}/tcp" >/dev/null 2>&1
    return $?
  fi
  return 1
}

die() {
  echo "billing-dev-stack: $*" >&2
  exit 1
}

for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if port_busy "$port"; then
    die "port $port sudah dipakai. Hentikan proses manual (Ctrl+C di terminal) atau: sudo systemctl stop billing"
  fi
done

[[ -x "$NODE_BIN" ]] || die "Node tidak ditemukan: $NODE_BIN"
[[ -x "$NPM_BIN" ]] || die "npm tidak ditemukan: $NPM_BIN"
[[ -f "$APP_DIR/server.js" ]] || die "server.js tidak ada di $APP_DIR"
[[ -f "$APP_DIR/frontend/package.json" ]] || die "frontend/ belum ada"

cleanup() {
  local sig="${1:-TERM}"
  trap - EXIT INT TERM
  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "-$sig" "$FRONTEND_PID" 2>/dev/null || true
  fi
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "-$sig" "$BACKEND_PID" 2>/dev/null || true
  fi
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}

on_signal() {
  cleanup TERM
  exit 0
}

trap on_signal INT TERM
trap 'cleanup TERM' EXIT

cd "$APP_DIR"
export NODE_ENV="${NODE_ENV:-development}"
"$NODE_BIN" server.js &
BACKEND_PID=$!
sleep 1
kill -0 "$BACKEND_PID" 2>/dev/null || die "backend gagal start (port $BACKEND_PORT?)"

cd "$APP_DIR/frontend"
"$NPM_BIN" run dev -- --host &
FRONTEND_PID=$!
sleep 2
kill -0 "$FRONTEND_PID" 2>/dev/null || die "frontend Vite gagal start (port $FRONTEND_PORT?)"

echo "billing-dev-stack: backend PID $BACKEND_PID (:$BACKEND_PORT), frontend PID $FRONTEND_PID (:$FRONTEND_PORT)"

# Keluar bila salah satu mati; EXIT trap mematikan yang lain agar systemd bisa restart.
while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 2
done
die "salah satu proses berhenti"
exit 1