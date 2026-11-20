#!/usr/bin/env bash
# Pasang billing sebagai service systemd dengan pengguna khusus (hardening).
#
#   sudo deploy/install-service.sh
#
# Hasil:
#  - user sistem `billing` (tanpa login) pemilik /var/www/billing
#  - billing.service (User=billing, Restart=always, ProtectSystem=strict)
#  - /etc/sudoers.d/billing: hanya restart PostgreSQL/FreeRADIUS & ubah zona waktu
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT=/etc/systemd/system/billing.service
SUDOERS=/etc/sudoers.d/billing

if [[ $EUID -ne 0 ]]; then
  echo "Jalankan sebagai root: sudo $0" >&2
  exit 1
fi

if ! id -u billing >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/billing --create-home --shell /usr/sbin/nologin billing
fi

chown -R billing:billing "$APP_DIR"
chmod 600 "$APP_DIR/.env" 2>/dev/null || true
chmod 700 "$APP_DIR/uploads"
chmod 750 "$APP_DIR/uploads/admin-profiles" 2>/dev/null || true

install -m 0644 "$APP_DIR/deploy/billing.service" "$UNIT"
install -m 0440 "$APP_DIR/deploy/sudoers.d-billing" "$SUDOERS"
visudo -c -f "$SUDOERS" >/dev/null

systemctl daemon-reload
systemctl enable billing
systemctl restart billing
sleep 2
systemctl --no-pager status billing | head -5
