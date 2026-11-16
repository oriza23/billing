# Migrasi MariaDB → PostgreSQL (orizabil + FreeRADIUS)

Panduan ini untuk server produksi yang **masih memakai MariaDB** (satu database `orizabil` untuk billing + RADIUS), seperti lingkungan Hasdin saat ini.

## Ringkasan alur

| Urutan | Tindakan |
|--------|----------|
| 1 | Backup & siapkan `scripts/.env.migrate` |
| 2 | `sudo ./scripts/migrate-mariadb-to-postgresql.sh` (pgloader + `.env` billing) |
| 3 | `sudo ./scripts/freeradius-switch-to-postgresql.sh` |
| 4 | Tes web + autentikasi PPP/hotspot |
| 5 | Opsional: hapus MariaDB (`install.sh` prompt purge atau manual) |

Perkiraan downtime: **5–30 menit** (tergantung ukuran `radacct`).

## 1. Persiapan

```bash
cd /var/www/billing
cp scripts/.env.migrate.example scripts/.env.migrate
chmod 600 scripts/.env.migrate
# Edit: MYSQL_PASSWORD (MariaDB sekarang), PG_PASSWORD (password baru PostgreSQL)
chmod +x scripts/migrate-mariadb-to-postgresql.sh
chmod +x scripts/freeradius-switch-to-postgresql.sh
```

Password MariaDB saat ini bisa dibaca dari `/etc/freeradius/3.0/mods-available/sql` (blok `login` / `password`) — **jangan** commit file itu ke git.

Opsional — bandingkan jumlah baris sebelum/sesudah:

```bash
mariadb orizabil -e "
SELECT 'web_admins' t, COUNT(*) n FROM web_admins
UNION SELECT 'langganan_pelanggan', COUNT(*) FROM langganan_pelanggan
UNION SELECT 'radcheck', COUNT(*) FROM radcheck
UNION SELECT 'radacct', COUNT(*) FROM radacct;"
```

## 2. Migrasi data (pgloader)

```bash
sudo ./scripts/migrate-mariadb-to-postgresql.sh
```

Script ini:

- Membuat `backups/migrate-*/orizabil.sql.gz`
- Memasang PostgreSQL + pgloader bila belum ada
- Menghentikan **PM2 billing** dan **freeradius**
- Menjalankan pgloader (skema + data)
- Menulis/memperbarui `.env` billing ke PostgreSQL
- Menjalankan `BILLING_SCHEMA_ONLY=1 node server.js`

Artefak ada di folder `backups/migrate-*/` (`pgloader.log`, `counts.txt`).

## 3. FreeRADIUS ke PostgreSQL

```bash
sudo ./scripts/freeradius-switch-to-postgresql.sh
```

Perubahan pada `/etc/freeradius/3.0/mods-available/sql`:

- `dialect = "postgresql"`
- `driver = "rlm_sql_${dialect}"`
- `port = 5432`, kredensial dari `.env` / `.env.migrate`

Backup otomatis: `sql.bak.YYYYMMDD-HHMMSS`.

Detail manual (jika skrip tidak dipakai): lihat [deploy/freeradius/sql-postgresql.md](../deploy/freeradius/sql-postgresql.md).

## 4. Nyalakan billing

```bash
cd /var/www/billing
pm2 start server.js --name billing --cwd /var/www/billing
pm2 save
```

Cek:

- Login admin web
- Menu Langganan Online (butuh `radacct`)
- Tambah/edit pelanggan PPP (butuh `radcheck`)
- Voucher hotspot (bulk insert)

## 5. Hapus MariaDB (opsional)

Hanya setelah **24–48 jam** stabil:

```bash
sudo systemctl stop mariadb
sudo apt-get purge -y 'mariadb*' 'mysql*'
sudo apt-get autoremove -y
```

## Rollback darurat

1. Kembalikan FreeRADIUS: `cp /etc/freeradius/3.0/mods-available/sql.bak.* /etc/freeradius/3.0/mods-available/sql`
2. `systemctl restart freeradius`
3. Restore `.env` dari `backups/migrate-*/.env.before`
4. `pm2 restart billing`
5. Jika perlu restore penuh MariaDB: `gunzip -c backups/migrate-*/orizabil.sql.gz | mariadb orizabil`

## Catatan teknis

- **Nama kolom RADIUS** di MariaDB Anda sudah huruf kecil (`radacctid`, …). pgloader mempertahankan itu; cocok dengan query billing.
- Skema resmi FreeRADIUS PostgreSQL memakai PascalCase; tidak perlu diimpor ulang jika pgloader sudah memindahkan seluruh tabel dari MariaDB.
- Billing memakai lapisan `backend/pg_compat.js`; tidak perlu ubah route manual setelah DB pindah.

## Bantuan

- Konfig umum PostgreSQL: [DATABASE-POSTGRESQL.md](./DATABASE-POSTGRESQL.md)
- Modul hotspot_time: [deploy/freeradius/README.md](../deploy/freeradius/README.md)