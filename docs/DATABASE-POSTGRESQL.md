# PostgreSQL untuk Sistem Billing

Web billing memakai **PostgreSQL** lewat driver `pg` dengan lapisan kompatibilitas SQL (`backend/pg_compat.js`) sehingga sebagian besar query gaya MySQL/MariaDB tetap berjalan.

## Instalasi baru

Jalankan `./install.sh` di server Ubuntu/Debian (root atau user + `sudo` — lihat [`INSTALL.md`](./INSTALL.md)). Installer:

1. Memasang PostgreSQL (paket distro) — **bukan** MariaDB/MySQL
2. Memasang FreeRADIUS dengan `freeradius-postgresql` (SQL → database billing)
3. Membuat role + database PostgreSQL
4. Menulis `.env` (`DB_PORT=5432`, `DB_SERVICE=postgresql`)
5. Menjalankan migrasi skema (`BILLING_SCHEMA_ONLY=1 node server.js`)
6. **Tidak** memasang Nginx; web billing lewat Node.js (port default 5000)

MariaDB di server yang sama (mis. proyek `acs-standalone`) **tidak** diinstal atau dihapus oleh `install.sh` billing.

## Migrasi dari MariaDB yang sudah jalan

**Panduan lengkap (server orizabil + FreeRADIUS):** [MIGRASI-MARIADB-KE-POSTGRESQL.md](./MIGRASI-MARIADB-KE-POSTGRESQL.md)

Ringkas:

```bash
cp scripts/.env.migrate.example scripts/.env.migrate   # isi password
chmod 600 scripts/.env.migrate
sudo ./scripts/migrate-mariadb-to-postgresql.sh
sudo ./scripts/freeradius-switch-to-postgresql.sh
pm2 restart billing
```

Menghapus MariaDB **hanya setelah** RADIUS dan seluruh layanan sudah diverifikasi di PostgreSQL.

## Tabel RADIUS

Tabel seperti `radcheck`, `radacct`, `radusergroup` **tidak** dibuat otomatis oleh `server.js`. Itu milik FreeRADIUS. Billing menulis/membaca tabel tersebut saat mengelola pelanggan, voucher, dan isolir.

Tanpa skema RADIUS, fitur autentikasi PPP/Hotspot tidak berfungsi meskipun halaman web bisa dibuka.

## Variabel lingkungan

| Variabel | Contoh |
|----------|--------|
| `DB_HOST` | `localhost` |
| `DB_PORT` | `5432` |
| `DB_USER` | `oriza` |
| `DB_PASSWORD` | (kuat) |
| `DB_NAME` | `orizabil` |
| `DB_SERVICE` | `postgresql` (untuk restart saat ganti timezone di menu Sistem) |

## Pengembangan lokal

```bash
npm install
# set .env ke PostgreSQL lokal
BILLING_SCHEMA_ONLY=1 node server.js
npm test
node server.js
```