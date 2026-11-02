const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./database');
const { ensureWebAdminColumns } = require('./backend/web_admins');
const requireAuth = require('./backend/middleware/auth');
const ensureBootstrapAdmin = require('./backend/bootstrap_admin');
const { startExpiredVoucherEnforcement } = require('./backend/hotspot_quota');
const { startIsolirEnforcement } = require('./backend/langganan_isolir');
const { ensurePppoeIsolirSchema } = require('./backend/pppoe_isolir/schema');
const { startCron } = require('./utils/cron');
const { ensureTable: ensureRouterServers } = require('./backend/router_servers');
const { ensureTables: ensureAcsTables } = require('./backend/acs');
const { mountFrontend } = require('./backend/serve_frontend');
const { ensurePaymentSchema } = require('./backend/payment/schema');

const app = express();
const PORT = Number(process.env.PORT) || 5000;

// Hanya aktifkan bila ada reverse proxy (Nginx, Caddy, Cloudflare Tunnel, dll).
// Tanpa proxy: biarkan mati — IP pelanggan diambil dari koneksi TCP langsung.
if (String(process.env.TRUST_PROXY || '') === '1') {
  app.set('trust proxy', true);
}

app.use(cors());
app.use(express.json({ limit: '3mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Login & portal isolir / webhook pembayaran bersifat publik (dilindungi secret/IP, bukan JWT).
app.use('/api/auth', require('./backend/routes/auth'));
app.use('/api/isolir', require('./backend/routes/isolir_portal'));
app.use('/api/payment', require('./backend/routes/payment'));
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
app.use('/api/acs', require('./backend/routes/acs'));

// Produksi: sajikan hasil `npm run build` (frontend/dist) di port yang sama dengan API.
// Letakkan paling akhir agar tidak menimpa route /api.
const frontendServed = mountFrontend(app);

async function ensureAdminTable() {
  await ensureBootstrapAdmin(pool);
  await ensureWebAdminColumns(pool);
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
  await ensureAdminTable();
  await ensurePppoeIsolirSchema(pool);
  await ensurePaymentSchema(pool);
  await ensureHotspotProfilesTable();
  await ensureHotspotVouchersTable();
  await ensureRoutersTable();
  await ensureOutletsTable();
  await outletsRouter.ensureTglGabungColumn();
  await langgananProfilRouter.ensureTable();
  await langgananDataRouter.ensureTable();
  await ensureRouterServers();
  await ensureAcsTables();
  await ensureDataWilayahTable();
  await pelangganRouter.ensureTable();
  await settingsRouter.ensureTable();
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
