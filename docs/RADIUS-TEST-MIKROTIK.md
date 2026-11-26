# Tes FreeRADIUS — VPS ↔ MikroTik (Hotspot & PPPoE)

Installer **tidak** menjalankan `freeradius -XC` secara default (hindari masalah izin log). Yang dijamin installer:

1. `mods-available/sql` sama dengan kredensial di `.env`
2. `systemctl restart freeradius` sukses
3. UFW membuka **UDP 1812** (auth) dan **1813** (accounting)

**Tes yang Anda maksud (Hotspot + PPP dari MikroTik)** — itu sumber kebenaran di produksi.

## Prasyarat di VPS

```bash
sudo systemctl status freeradius --no-pager
sudo ss -ulnp | grep -E ':1812|:1813'
```

Log live saat user login:

```bash
sudo tail -f /var/log/freeradius/radius.log
```

## NAS di panel billing

1. Login web billing → **Router / NAS** → tambah IP router MikroTik (NAS).
2. **RADIUS Secret** harus sama dengan di MikroTik (`/radius`).
3. Setelah simpan, entri masuk ke tabel `nas` (FreeRADIUS `read_clients = yes`).

## MikroTik — Hotspot

Ganti `IP-VPS` dan `SECRET` (sama dengan di panel / `RADIUS_SECRET` saat install):

```text
/radius
add address=IP-VPS secret=SECRET service=hotspot timeout=3000ms

/ip hotspot profile
set [find default=yes] use-radius=yes

/ip hotspot user
# uji user yang ada di billing (radcheck), atau buat user hotspot di panel
```

Dari client: sambung Wi‑Fi hotspot → login. Di VPS, `radius.log` harus ada `Access-Accept` atau pesan penolakan yang jelas (`Access-Reject`).

## MikroTik — PPPoE (atau PPP)

```text
/radius
add address=IP-VPS secret=SECRET service=ppp timeout=3000ms

/ppp profile
set default use-radius=yes
```

Tes dial PPPoE dengan pelanggan yang sudah ada di billing (username/password di `radcheck`).

## Opsional: radtest di VPS (tanpa MikroTik)

```bash
sudo apt install -y freeradius-utils   # paket radtest
# SECRET = RADIUS_SECRET dari .env; user/pass = entri radcheck
radtest USER PASS 127.0.0.1 0 SECRET
```

## Jika auth gagal

| Gejala | Cek |
|--------|-----|
| Tidak ada log sama sekali | UFW, IP NAS salah, MikroTik tidak reach VPS |
| `Unknown client` | NAS belum di panel / IP tidak di tabel `nas` |
| `Access-Reject` | User tidak ada di `radcheck`, password salah, profil hotspot/ppp |
| Service mati | `journalctl -u freeradius -n 50`, `radius.log` |

Pengecekan config manual (installer sudah menjalankannya otomatis sebagai `freerad`). Selalu sebagai `freerad`, jangan `freeradius -X` sebagai root:

```bash
sudo runuser -u freerad -- freeradius -Cx -lstdout
```

## Dokumen terkait

- [`docs/INSTALL.md`](./INSTALL.md) — instalasi server
- [`docs/MULTI_NAS.md`](./MULTI_NAS.md) — banyak router NAS