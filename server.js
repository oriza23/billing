const express = require('express');
const cors = require('cors');
const pool = require('./database');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());
app.use('/api/pppoe', require('./backend/routes/pppoe'));
app.use('/api/hotspot', require('./backend/routes/hotspot'));
app.use('/api/admins', require('./backend/routes/admins'));

app.post('/api/login', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!username || !password) {
    return res.status(401).json({
      success: false,
      message: 'Username atau password salah',
    });
  }

  try {
    const [rows] = await pool.execute(
      'SELECT * FROM web_admins WHERE username = ? AND password = ?',
      [username, password],
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Username atau password salah',
      });
    }

    return res.json({
      success: true,
      message: 'Login berhasil',
      username: rows[0].username,
      role: rows[0].role,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memeriksa data login',
      error: error.message,
    });
  }
});

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

async function start() {
  await ensureAdminTable();
  await ensureHotspotProfilesTable();
  await ensureHotspotVouchersTable();
  app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error('Gagal menjalankan server:', error.message);
  process.exit(1);
});
