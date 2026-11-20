# Banyak router (NAS) ke satu billing lewat FreeRADIUS

Tabel `routers` di web billing adalah sumber data. Setiap router yang ditambah, diubah, atau
dihapus di menu **Manajemen Router** otomatis disinkronkan ke tabel `nas` milik FreeRADIUS
(`backend/radius_nas.js`), sehingga FreeRADIUS mengenali tiap router dengan **secret-nya sendiri**
dan menjadi induk autentikasi PPPoE dan Hotspot untuk semua router.

## Aturan sinkronisasi

- Baris `nas` yang dikelola aplikasi diberi `description = 'billing-router:<id>'`. Baris yang diisi
  manual tidak pernah diubah atau dihapus.
- Router dilewati (dan dilaporkan) bila statusnya bukan `Aktif`, IP bukan IPv4, secret kosong,
  atau secret lebih dari **60 karakter** (batas kolom `nas.secret`).
- IP yang sama tidak boleh dipakai dua router, dan tidak boleh bentrok dengan baris `nas` manual.
- Sinkronisasi juga berjalan saat aplikasi start.

## Agar FreeRADIUS memakai daftar terbaru

FreeRADIUS hanya membaca tabel `nas` **saat start**, jadi setelah router berubah perlu restart:

```bash
sudo systemctl restart freeradius
```

Atau otomatis: set `FREERADIUS_RESTART_ON_SYNC=1` di `.env` (aplikasi harus berjalan dengan hak
untuk `systemctl restart freeradius`; restart didebounce 2 detik dan hanya bila ada perubahan).

Setup awal / cek konfigurasi (aman diulang, tidak me-restart tanpa `--restart`):

```bash
sudo ./scripts/freeradius-enable-nas-sync.sh
```

## Migrasi dari clients.conf

Router yang masih punya blok `client` statis di `/etc/freeradius/3.0/clients.conf` **dan** masuk
tabel `nas` akan menimbulkan `Failed to add duplicate client` di log FreeRADIUS. Hapus blok statis
itu; tabel `nas` sudah jadi sumbernya. Installer baru tidak lagi membuat client `0.0.0.0/0`, dan
instalasi lama yang masih punya blok `BEGIN-ORIZABIL-BILLING-INSTALL` akan dibersihkan otomatis
oleh `install.sh`. Script `freeradius-enable-nas-sync.sh` memberi peringatan bila blok itu masih ada.

## Endpoint (admin)

- `GET  /api/routers/nas-sync` — lihat selisih tanpa mengubah apa pun.
- `POST /api/routers/nas-sync` — paksa sinkron ulang.
- `POST/PUT/DELETE /api/routers` — mengembalikan field `radius_sync` (`reload`:
  `tidak_perlu` | `manual` | `dijadwalkan`).

## Pembatasan login per NAS dan per server

Setiap akun (PPPoE pelanggan, langganan, voucher hotspot) punya dua pilihan:

| Pilihan | Atribut radcheck yang ditulis | Arti |
|---------|------------------------------|------|
| Router = `ALL ROUTER` | (tidak ada) | Boleh login dari NAS mana pun |
| Router = nama router | `NAS-IP-Address == <ip router>` | Hanya dari router itu |
| Server = `ALL SERVER` | (tidak ada) | Boleh di server mana pun |
| Server = nama server | `Called-Station-Id == <nama server>` | Hanya dari server itu |

Nama server harus terdaftar di menu Router untuk router yang dipilih (jenis `pppoe` untuk PPPoE,
`hotspot` untuk voucher). Server yang tidak terdaftar ditolak saat disimpan.

Status **Isolir** / **Non Aktif** menambah `Auth-Type := Reject`, sehingga login ditolak tanpa
menghapus akun.

### Isolir dan putus sesi

Isolir, buka isolir, dan `/api/pppoe/disconnect` mengirim PoD/CoA **ke NAS tempat sesi aktif
berjalan** (`radacct.nasipaddress`), memakai secret router tersebut. Tidak lagi memakai router
"pertama yang aktif". Bila sebuah sesi berada di NAS yang tidak ada di menu Router, sesi itu
dilaporkan gagal, bukan diputus lewat router lain.

### Mengubah atau menghapus router

- **Ganti IP router**: `radcheck.NAS-IP-Address` akun yang memakai IP lama ikut diganti.
- **Ganti nama router**: `langganan_pelanggan.router` dan `hotspot_vouchers.router` ikut diganti.
- **Hapus router**: ditolak (HTTP 409) selama masih dipakai oleh langganan, akun PPPoE, atau
  voucher. Pindahkan dulu akun-akun itu ke `ALL ROUTER` atau router lain.

## Syarat agar pembatasan NAS berfungsi

`NAS-IP-Address` yang dikirim MikroTik adalah IP sumber tempat ia menghubungi RADIUS
(`/radius` → src-address, atau IP interface yang dipakai). **IP di menu Router harus sama
persis dengan IP itu.** Bila berbeda (mis. router memakai VPN atau interface lain), login akan
ditolak. Cek di FreeRADIUS (`radiusd -X`) baris `NAS-IP-Address` saat ada login.

Untuk hotspot, `Called-Station-Id` berisi nama server Hotspot (sudah terverifikasi dari log
`radacct`). Untuk PPPoE, nilai `Called-Station-Id` belum terverifikasi di lingkungan ini (belum ada
sesi PPPoE aktif yang bisa dibaca). Sebelum mengandalkan pembatasan server untuk PPPoE, cek nilai
yang dikirim dengan `radiusd -X` saat satu pelanggan PPPoE login, dan pastikan sama dengan nama
server di menu Router.
