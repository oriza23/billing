# Isolir PPPoE (Walled Garden) — rancangan

## Perbedaan dengan isolir lama

| Aspek | `backend/langganan_isolir.js` (existing) | `backend/pppoe_isolir/*` (baru) |
|--------|------------------------------------------|----------------------------------|
| Setelah isolir | `Auth-Type := Reject` (login ditolak) | Grup RADIUS `profil_isolir` (login OK, walled garden) |
| Profil MikroTik | Tidak diubah | Redial ke PPP profile isolir setelah CoA kick |
| Trigger otomatis | `tgl_isolir <= NOW()` tiap 60 detik | Cron `0 0 * * *` + `jatuh_tempo` / `tgl_isolir` |

Migrasi bertahap: jalankan keduanya tidak disarankan untuk PPP yang sama. Matikan sweep lama atau alihkan ke `runAutoIsolirBatch`.

## Kolom database (`langganan_pelanggan`)

| Kolom | Tipe | Fungsi |
|--------|------|--------|
| `status` | ENUM | `'Isolir'` = sedang isolir (sudah ada) |
| `tgl_isolir` | DATETIME | Batas layanan / auto isolir by datetime (sudah ada) |
| `jatuh_tempo` | DATE | Jatuh tempo tagihan → cron midnight (sudah ada) |
| `profil_id` | INT | Profil langganan normal → grup RADIUS (sudah ada) |
| `profil_id_sebelum_isolir` | INT NULL | **Baru** — backup sebelum isolir |
| `tgl_isolir_dijalankan` | DATETIME NULL | **Baru** — audit kapan isolir dijalankan |
| `isolir_sumber` | ENUM | **Baru** — `manual` / `cron` / `jatuh_tempo` / `tgl_isolir` |

Setting global: `app_settings.pppoe_isolir_group` = nama PPP Profile / RADIUS group (default `profil_isolir`).

## MikroTik

1. Buat **PPP Profile** `profil_isolir` dengan rate limit / address-list walled garden.
2. Pastikan **RADIUS** mengirim `Mikrotik-Group := profil_isolir` untuk grup tersebut (`radgroupreply`).
3. **Kick**: CoA Disconnect (`disconnectUser`) + `/ppp/active/remove` via **RouterOS API** (`node-routeros`, port **8728**).
4. **Secret profile**: `/ppp/secret/set` → `profile=profil_isolir` by username; RADIUS `radusergroup` + `radreply` `Mikrotik-Group`.

### Modul Node.js

| File | Peran |
|------|--------|
| `backend/pppoe_isolir/mikrotik_ros_api.js` | Koneksi `node-routeros`, print/set secret, remove active |
| `backend/pppoe_isolir/mikrotik.js` | DB router, RADIUS radreply, CoA + orkestrasi isolir |

RouterOS **v6 dan v7** (API klasik). REST v7+ tidak dipakai.

### Kredensial RouterOS API

Per router (`routers.api_user`, `api_password`, `api_port`) atau env:

| Env | Default |
|-----|---------|
| `MIKROTIK_API_USER` / `MIKROTIK_API_PASSWORD` | wajib untuk API |
| `MIKROTIK_API_PORT` | **8728** (8729 jika TLS) |
| `MIKROTIK_API_TLS` | `1` = API over TLS |
| `MIKROTIK_API_INSECURE` | `1` = terima sertifikat self-signed (TLS) |
| `MIKROTIK_API_TIMEOUT_MS` | 12000 |

Pastikan di router: **IP → Services → api** enabled (port 8728).

Tanpa kredensial API, isolir tetap jalan lewat RADIUS + CoA kick saja.

## API

```
POST /api/langganan/isolir/:id       { "kick": true }
POST /api/langganan/isolir/:id/buka  { "kick": true }
POST /api/isolir/:id                 (alias)
POST /api/buka-isolir/:id            (alias)
```

Respons mencakup `mikrotik` (secret profile) dan `kick` (`coa` + `mikrotik.removed`).

## Cron

```bash
npm install node-cron
```

Env:

- `PPPoE_ISOLIR_CRON=1` (default aktif)
- `PPPoE_ISOLIR_CRON_EXPR=0 0 * * *`
- `PPPoE_ISOLIR_GROUP=profil_isolir`
- `PPPoE_ISOLIR_TZ=Asia/Makassar` (opsional)

## Langkah integrasi di `server.js`

```javascript
const { ensurePppoeIsolirSchema } = require('./backend/pppoe_isolir/schema');
const { startPppoeIsolirCron } = require('./backend/pppoe_isolir/cron');

// di start():
await ensurePppoeIsolirSchema(pool);
startPppoeIsolirCron();

app.use('/api/langganan/isolir', require('./backend/routes/pppoe_isolir'));
```

## TODO lanjutan

1. Sinkronkan `buildAccountRows` / `writeAccount` agar status `Isolir` + mode walled garden tidak menulis Reject (konflik dengan sweep lama).
2. UI tombol Isolir / Buka Isolir di `LanggananData.jsx`.
3. Uji integrasi: isolir → kick → redial → IP dari pool isolir.
4. Atur rate / address-list di PPP Profile `profil_isolir` di router (bukan hanya `radgroupreply`).
