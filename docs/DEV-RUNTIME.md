# Menjalankan billing — mode development vs produksi

Dokumen ini untuk **developer** dan **agen AI** yang menyentuh server billing. Baca sebelum menyarankan `node server.js`, `npm run dev`, atau `systemctl restart billing`.

**Instalasi pertama kali di VPS (Debian/Ubuntu, root atau non-root):** panduan lengkap di [`INSTALL.md`](./INSTALL.md), bukan di file ini.

## Ringkasan

| Mode | Port | Cara jalan | Start / stop / restart |
|------|------|------------|-------------------------|
| **Dev (disarankan di server lab)** | **5000** API + **5173** UI Vite | Satu unit systemd | `sudo systemctl start\|stop\|restart billing` |
| Dev manual (legacy) | 5000 + 5173 | Dua terminal | Ctrl+C masing-masing — **jangan** bersamaan dengan systemd |
| **Produksi** | **5000** saja (atau **80** lewat Nginx) | `frontend/dist` + satu proses Node | PM2 atau `billing.service` produksi |

Cek mode terpasang:

```bash
cat /var/www/billing/.billing-runtime-mode 2>/dev/null || echo "(belum ada — kemungkinan manual atau produksi)"
systemctl cat billing 2>/dev/null | head -5
```

- Isi file mode = `dev` → systemd menjalankan **backend + Vite** lewat `scripts/billing-dev-stack.sh`.
- Unit memuat `node server.js` saja, `User=billing` → mode **produksi** (`deploy/install-service.sh`).

## Pasang mode dev (sekali)

```bash
cd /var/www/billing
sudo deploy/install-dev-service.sh
```

Lalu **hentikan** proses manual di terminal (Ctrl+C pada `node server.js` dan `npm run dev`), baru:

```bash
sudo systemctl restart billing
```

## Perintah harian (dev systemd)

| Aksi | Perintah |
|------|----------|
| Mulai | `sudo systemctl start billing` |
| Berhenti | `sudo systemctl stop billing` |
| Restart (backend + frontend sekaligus) | `sudo systemctl restart billing` |
| Status | `systemctl status billing` |
| Log live | `journalctl -u billing -f` |

**URL:** UI `http://<IP-server>:5173` · API `http://<IP-server>:5000` (axios dev memanggil hostname:5000).

## Instruksi untuk agen AI

1. **Jangan** menyarankan `node server.js` atau `npm run dev` jika `.billing-runtime-mode` = `dev` dan `billing.service` aktif — gunakan **`sudo systemctl restart billing`**.
2. Saat user minta “restart backend” di tahap dev dengan systemd: **`sudo systemctl restart billing`** (Vite ikut restart; itu disengaja).
3. **Jangan** `systemctl restart billing` saat user sengaja menjalankan manual di terminal tanpa install dev — cek `ss -tlnp sport = :5000` / proses di terminal dulu.
4. Setelah mengubah kode **backend** saja: `sudo systemctl restart billing` cukup; setelah mengubah kode frontend Vite, restart yang sama memuat ulang dev server.
5. Setelah `npm run build` dan ingin uji satu port: hentikan dev, jalankan `npm start` (hanya 5000 + `dist`) — itu **bukan** systemd dev.
6. **Produksi nanti:** ikuti [`INSTALL.md`](./INSTALL.md) (`USE_PM2=1 ./install.sh` atau `deploy/install-service.sh`); pulihkan unit dari `/etc/systemd/system/billing.service.production.bak` bila perlu. Jangan pasang `install-dev-service.sh` di produksi.

## Satu port vs dua port

- **Dua port (dev):** hot reload React di 5173; backend API di 5000. Ini default Vite + axios di repo ini.
- **Satu port (uji build):** `cd frontend && npm run build && cd .. && npm start` → hanya **5000** menyajikan `dist`. Tanpa hot reload.

Firewall (UFW): **5173 tidak dibuka** ke publik; akses UI dev dari LAN/VPN saja.

## Pulih ke unit produksi

```bash
sudo systemctl stop billing
sudo cp /etc/systemd/system/billing.service.production.bak /etc/systemd/system/billing.service
sudo systemctl daemon-reload
sudo deploy/install-service.sh   # atau konfigurasi PM2
```