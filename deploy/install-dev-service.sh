#!/usr/bin/env bash
# Pasang billing.service mode DEVELOPMENT (backend + Vite sekaligus).
#
#   sudo deploy/install-dev-service.sh
#
# Setelah ini:
#   sudo systemctl start|stop|restart|status billing
#
# Bukan untuk produksi — gunakan deploy/install-service.sh atau PM2 (USE_PM2=1).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT=/etc/systemd/system/billing.service
STACK="$APP_DIR/scripts/billing-dev-stack.sh"
MARKER="$APP_DIR/.billing-runtime-mode"

if [[ $EUID -ne 0 ]]; then
  echo "Jalankan sebagai root: sudo $0" >&2
  exit 1
fi

chmod +x "$STACK"
bash -n "$STACK"

if [[ -f "$UNIT" ]] && ! grep -q 'billing-dev-stack' "$UNIT" 2>/dev/null; then
  cp -a "$UNIT" "${UNIT}.production.bak"
  echo "Unit produksi disimpan ke ${UNIT}.production.bak"
fi

install -m 0644 "$APP_DIR/deploy/billing-dev.service" "$UNIT"
echo 'dev' > "$MARKER"
chmod 644 "$MARKER"

systemctl daemon-reload
systemctl enable billing
echo
echo "Mode DEV terpasang. Hentikan node/npm manual di terminal (Ctrl+C), lalu:"
echo "  sudo systemctl restart billing"
echo "  journalctl -u billing -f"
echo "Web: http://<IP>:5173 (UI) · API http://<IP>:5000"
echo "Dokumentasi: $APP_DIR/docs/DEV-RUNTIME.md"