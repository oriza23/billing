# FreeRADIUS: modul SQL ke PostgreSQL

File sistem: `/etc/freeradius/3.0/mods-available/sql`

Gunakan script otomatis:

```bash
sudo /var/www/billing/scripts/freeradius-switch-to-postgresql.sh
```

## Perubahan manual (referensi)

1. Pasang driver:

```bash
sudo apt install freeradius-postgresql
```

2. Edit blok utama `sql { ... }`:

```text
dialect = "postgresql"
driver = "rlm_sql_${dialect}"
```

3. Connection info (samakan dengan `.env` billing):

```text
server = "localhost"
port = 5432
login = "oriza"
password = "ISI_DARI_ENV"
radius_db = "orizabil"
```

4. Pastikan modul aktif:

```bash
sudo ln -sf ../mods-available/sql /etc/freeradius/3.0/mods-enabled/sql
sudo freeradius -XC
sudo systemctl restart freeradius
```

**Jangan** mengubah `mods-config/sql/main/postgresql/queries.conf` kecuali Anda tahu dampaknya — versi paket Debian sudah selaras dengan skema hasil migrasi dari MySQL (nama kolom lowercase).

## MariaDB → PostgreSQL yang sudah di server ini

Sebelum migrasi, contoh konfigurasi lama:

```text
dialect = "mysql"
driver = "rlm_sql_mysql"
port = 3306
radius_db = "orizabil"
```

Setelah migrasi, hanya dialect, driver, port, dan password yang perlu diselaraskan dengan PostgreSQL.

## Paket yang dibutuhkan

| Paket | Fungsi |
|-------|--------|
| `freeradius` | Server RADIUS |
| `freeradius-postgresql` | `rlm_sql_postgresql` |
| `postgresql` | Database |

Schema SQL resmi (instalasi baru tanpa pgloader):  
`/etc/freeradius/3.0/mods-config/sql/main/postgresql/schema.sql`  
— **tidak wajib** dijalankan jika seluruh DB sudah dipindah dengan pgloader dari MariaDB.