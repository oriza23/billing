const express = require('express');
const cors = require('cors');
const pool = require('./database');
const requireAuth = require('./backend/middleware/auth');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// Login bersifat publik; semua route /api lainnya wajib membawa token JWT.
app.use('/api/auth', require('./backend/routes/auth'));
app.use('/api', requireAuth);

app.use('/api/pppoe', require('./backend/routes/pppoe'));
app.use('/api/hotspot', require('./backend/routes/hotspot'));
app.use('/api/admins', require('./backend/routes/admins'));
app.use('/api/routers', require('./backend/routes/routers'));
const outletsRouter = require('./backend/routes/outlets');
app.use('/api/outlets', outletsRouter);
const langgananProfilRouter = require('./backend/routes/langganan_profil');
app.use('/api/langganan/profil', langgananProfilRouter);
const langgananDataRouter = require('./backend/routes/langganan_data');
app.use('/api/langganan/data', langgananDataRouter);
const langgananMaster = require('./backend/routes/langganan_master');
app.use('/api/langganan/server', langgananMaster.serverRouter);
app.use('/api/wilayah', require('./backend/routes/wilayah'));
app.use('/api/langganan/online', require('./backend/routes/langganan_online'));
const pelangganRouter = require('./backend/routes/pelanggan');
app.use('/api/pelanggan', pelangganRouter);
const settingsRouter = require('./backend/routes/settings');
app.use('/api/settings', settingsRouter);
app.use('/api/system', require('./backend/routes/system_health'));

async function ensureAdminTable() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS web_admins (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(50) UNIQUE, password VARCHAR(255), role VARCHAR(20) DEFAULT 'admin')",
  );

  const [rows] = await pool.query('SELECT COUNT(*) AS total FROM web_admins');
  if (Number(rows[0].total) === 0) {
    await pool.execute(
      "INSERT IGNORE INTO web_admins (username, password) VALUES ('admin', 'admin12345')",
    );
  }
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
  await ensureHotspotProfilesTable();
  await ensureHotspotVouchersTable();
  await ensureRoutersTable();
  await ensureOutletsTable();
  await outletsRouter.ensureTglGabungColumn();
  await langgananProfilRouter.ensureTable();
  await langgananDataRouter.ensureTable();
  await langgananMaster.ensureTables();
  await ensureDataWilayahTable();
  await pelangganRouter.ensureTable();
  await settingsRouter.ensureTable();
  const timezone = await settingsRouter.loadTimezone();
  console.log(`Zona waktu server: ${timezone}`);
  const osTimezone = require('./backend/system_time').readOsTimezone();
  if (osTimezone !== timezone) {
    console.warn(`Peringatan: zona waktu OS (${osTimezone || 'tidak diketahui'}) berbeda dengan pengaturan web (${timezone}). Simpan ulang di menu Sistem > Pengaturan untuk menyamakan.`);
  }
  app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error('Gagal menjalankan server:', error.message);
  process.exit(1);
});
