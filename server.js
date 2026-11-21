const express = require('express');
const cors = require('cors');
const path = require('path');
const securityHeaders = require('./backend/security_headers');
const pool = require('./database');
const { ensureWebAdminColumns, backfillNamaLengkap } = require('./backend/web_admins');
const requireAuth = require('./backend/middleware/auth');
const ensureBootstrapAdmin = require('./backend/bootstrap_admin');
const { startExpiredVoucherEnforcement } = require('./backend/hotspot_quota');
const { startIsolirEnforcement } = require('./backend/langganan_isolir');
const { ensurePppoeIsolirSchema } = require('./backend/pppoe_isolir/schema');
const { startCron } = require('./utils/cron');
const { ensureTable: ensureRouterServers } = require('./backend/router_servers');
const { ensureProtocolSeparation, syncRouterLocks } = require('./backend/langganan_radius');
const { ensureTables: ensureAcsTables } = require('./backend/acs');
const { ensureNasTable, syncAfterRouterChange } = require('./backend/radius_nas');
const { mountFrontend } = require('./backend/serve_frontend');
const {
  ensureTable: ensureActivityLogTable, activityLogger, backfillLegacy,
} = require('./backend/activity_log');

const app = express();
const PORT = Number(process.env.PORT) || 5000;

// Sembunyikan versi framework dan kirim header keamanan pada semua respons.
app.disable('x-powered-by');
app.use(securityHeaders);

// CORS: kosong = semua origin (perilaku lama). Isi CORS_ORIGINS (dipisah koma) untuk membatasi,
// mis. CORS_ORIGINS=https://billing.contoh.id,http://localhost:5173
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function corsOrigin(origin, callback) {
  if (!origin || CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) {
    return callback(null, true);
  }
  return callback(null, false);
}

// Hanya aktifkan bila ada reverse proxy (Nginx, Caddy, Cloudflare Tunnel, dll).
// Tanpa proxy: biarkan mati — IP pelanggan diambil dari koneksi TCP langsung.
if (String(process.env.TRUST_PROXY || '') === '1') {
  // Satu hop (Nginx/Caddy): req.ip = IP yang ditambahkan proxy, bukan nilai X-Forwarded-For buatan klien.
  app.set('trust proxy', 1);
}

app.use(cors({ origin: corsOrigin, maxAge: 600 }));
app.use(express.json({ limit: '3mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Audit trail: catat semua request tulis (POST/PUT/PATCH/DELETE) ke /api. Username diambil dari JWT
// (atau body saat login), jadi pencatat harus berada SETELAH express.json tapi SEBELUM router.
app.use('/api', activityLogger());

// Hanya login yang publik; semua rute /api lain wajib JWT.
// /healthz sengaja di luar /api agar bisa dipantau monitoring tanpa token (detail opsional).
app.use('/healthz', require('./backend/routes/healthz'));
app.use('/api/auth', require('./backend/routes/auth'));
app.use('/api', requireAuth);

app.use('/api/pppoe', require('./backend/routes/pppoe'));
app.use('/api/hotspot', require('./backend/routes/hotspot'));
app.use('/api/admins', require('./backend/routes/admins'));
app.use('/api/users', require('./backend/routes/users'));
app.use('/api/routers', require('./backend/routes/routers'));
const outletsRouter = require('./backend/routes/outlets');
app.use('/api/outlets', outletsRouter);
const langgananProfilRouter = require('./backend/routes/langganan_profil');
app.use('/api/langganan/profil', langgananProfilRouter);
const langgananDataRouter = require('./backend/routes/langganan_data');
app.use('/api/langganan/data', langgananDataRouter);
const pppoeIsolirRoutes = require('./backend/routes/pppoe_isolir');
const isolirMikrotikRoutes = require('./backend/routes/isolir');
app.use('/api/langganan/isolir', pppoeIsolirRoutes);
app.use('/api/isolir', isolirMikrotikRoutes);
app.use('/api/buka-isolir', isolirMikrotikRoutes.bukaIsolirRouter);
app.use('/api/wilayah', require('./backend/routes/wilayah'));
app.use('/api/langganan/online', require('./backend/routes/langganan_online'));
const pelangganRouter = require('./backend/routes/pelanggan');
app.use('/api/pelanggan', pelangganRouter);
const settingsRouter = require('./backend/routes/settings');
app.use('/api/settings', settingsRouter);
app.use('/api/system', require('./backend/routes/system_health'));
app.use('/api/sistem', require('./backend/routes/service_restart'));
app.use('/api/sistem/vpn', require('./backend/routes/vpn'));
app.use('/api/logs', require('./backend/routes/logs'));
app.use('/api/acs', require('./backend/routes/acs'));

// Produksi: sajikan hasil `npm run build` (frontend/dist) di port yang sama dengan API.
// Letakkan paling akhir agar tidak menimpa route /api.
const frontendServed = mountFrontend(app);

// Penangan error terakhir: klien menerima JSON ringkas, stack trace hanya masuk log server.
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }
  const known = {
    'entity.parse.failed': { status: 400, message: 'Body JSON tidak valid' },
    'entity.too.large': { status: 413, message: 'Ukuran data melebihi batas' },
  }[error.type];
  const status = known?.status || Number(error.status || error.statusCode) || 500;
  if (status >= 500) {
    console.error(`[${req.method} ${req.originalUrl}]`, error);
  }
  const message = known?.message
    || (status >= 500 ? 'Terjadi kesalahan pada server' : (error.message || 'Permintaan tidak valid'));
  res.status(status).json({ success: false, message });
});


async function ensureAdminTable() {
  await ensureBootstrapAdmin(pool);
  await ensureWebAdminColumns(pool);
  // Isi nama lengkap lama dengan username agar Log Aplikasi tidak menampilkan "-".
  await backfillNamaLengkap(pool);
}

async function ensureHotspotProfilesTable() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS hotspot_profiles (id INT AUTO_INCREMENT PRIMARY KEY, nama_profile VARCHAR(100), mikrotik_group VARCHAR(100) UNIQUE, address_list VARCHAR(100), rate_limit VARCHAR(50), shared INT DEFAULT 1, masa_aktif INT, masa_aktif_satuan VARCHAR(20), harga_jual INT, komisi_reseller INT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)',
  );
}

async function ensureHotspotVouchersTable() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS hotspot_vouchers (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(100) UNIQUE, password VARCHAR(100), profile VARCHAR(100), router VARCHAR(50), server VARCHAR(50), mitra VARCHAR(50), outlet VARCHAR(50), hpp INT, komisi INT, harga INT, status VARCHAR(20) DEFAULT 'No', admin VARCHAR(50), kode_batch VARCHAR(50), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
  );
  await pool.query(
    'ALTER TABLE hotspot_vouchers ADD COLUMN IF NOT EXISTS kode_batch VARCHAR(50)',
  );
  // Nama server MikroTik bisa sampai 100 karakter.
  await pool.query('ALTER TABLE hotspot_vouchers MODIFY server VARCHAR(100)');
}

async function ensureRoutersTable() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS routers (id INT AUTO_INCREMENT PRIMARY KEY, nama_router VARCHAR(100), ip_address VARCHAR(50), secret VARCHAR(100), deskripsi TEXT, status VARCHAR(20) DEFAULT 'Aktif', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
  );
}

async function ensureOutletsTable() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS outlets (id INT AUTO_INCREMENT PRIMARY KEY, nama_outlet VARCHAR(100) UNIQUE, pemilik VARCHAR(100), phone VARCHAR(50), mitra VARCHAR(50) DEFAULT 'RANIAH', alamat TEXT, status VARCHAR(20) DEFAULT 'Aktif', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
  );
}

async function ensureDataWilayahTable() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS data_wilayah (id INT AUTO_INCREMENT PRIMARY KEY, nama_wilayah VARCHAR(100) UNIQUE NOT NULL)',
  );
  // Salin wilayah yang sudah pernah dipakai di data langganan (aman diulang, nama bersifat unik).
  await pool.query(
    `INSERT IGNORE INTO data_wilayah (nama_wilayah)
     SELECT DISTINCT TRIM(wilayah) FROM langganan_pelanggan
     WHERE wilayah IS NOT NULL AND TRIM(wilayah) <> '' AND CHAR_LENGTH(TRIM(wilayah)) <= 100`,
  );
}

async function start() {
  await pool.ensureCompat();
  await ensureAdminTable();
  await ensurePppoeIsolirSchema(pool);
  await ensureHotspotProfilesTable();
  await ensureHotspotVouchersTable();
  await ensureRoutersTable();
  await ensureNasTable(pool);
  await syncAfterRouterChange(pool);
  await ensureOutletsTable();
  await outletsRouter.ensureTglGabungColumn();
  await langgananProfilRouter.ensureTable();
  await langgananDataRouter.ensureTable();
  await ensureRouterServers();
  await ensureProtocolSeparation(pool);
  const routerLocks = await syncRouterLocks(pool);
  if (routerLocks.locked || routerLocks.opened || routerLocks.skipped) {
    console.log(
      `Kunci router RADIUS: ${routerLocks.locked} dikunci, ${routerLocks.opened} dibuka (ALL ROUTER), ${routerLocks.skipped} dilewati (router tidak dikenal).`,
    );
  }
  await ensureAcsTables();
  await ensureDataWilayahTable();
  await pelangganRouter.ensureTable();
  await settingsRouter.ensureTable();
  await ensureActivityLogTable();
  await require('./backend/vpn').ensureTable(pool);
  // Baris lama (versi sebelumnya) belum punya action/info: isi ulang agar tampil utuh.
  await backfillLegacy();
  if (String(process.env.BILLING_SCHEMA_ONLY || '') === '1') {
    console.log('Skema database siap (BILLING_SCHEMA_ONLY).');
    process.exit(0);
  }
  const timezone = await settingsRouter.loadTimezone();
  console.log(`Zona waktu server: ${timezone}`);
  const osTimezone = require('./backend/system_time').readOsTimezone();
  if (osTimezone !== timezone) {
    console.warn(`Peringatan: zona waktu OS (${osTimezone || 'tidak diketahui'}) berbeda dengan pengaturan web (${timezone}). Simpan ulang di menu Sistem > Pengaturan untuk menyamakan.`);
  }
  // Express 5 mengirim error bind (mis. EADDRINUSE) ke callback listen. Tanpa pengecekan ini,
  // server kedua tetap mencetak "berjalan" padahal port dipakai proses lama (kode lama + cron ganda).
  app.listen(PORT, (error) => {
    if (error) {
      console.error(
        error.code === 'EADDRINUSE'
          ? `Port ${PORT} sudah dipakai proses lain. Hentikan proses lama dulu: fuser -k ${PORT}/tcp`
          : `Gagal membuka port ${PORT}: ${error.message}`,
      );
      process.exit(1);
    }
    // Penjadwal hanya dijalankan setelah port benar-benar terbuka, supaya tidak ada cron ganda.
    startExpiredVoucherEnforcement();
    startIsolirEnforcement();
    startCron();
    console.log(`Server berjalan di http://localhost:${PORT}${frontendServed ? ' (API + frontend dist)' : ' (hanya API; frontend/dist belum dibuild)'}`);
  });
}

start().catch((error) => {
  console.error('Gagal menjalankan server:', error.message);
  process.exit(1);
});
