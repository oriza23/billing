const express = require('express');
const pool = require('../../database');

const router = express.Router();
const STATUS = ['Aktif', 'Non Aktif', 'Isolir'];

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readStatus(value) {
  const status = readText(value) || 'Aktif';
  return STATUS.includes(status) ? status : null;
}

function readProfileId(value) {
  if (value === '' || value == null) {
    return null;
  }
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function readDate(value) {
  const text = readText(value);
  if (!text) {
    return null;
  }
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function readDateTime(value) {
  const text = readText(value).replace('T', ' ');
  if (!text) {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(text)) {
    return null;
  }
  if (text.length === 10) {
    return `${text} 00:00:00`;
  }
  if (text.length === 16) {
    return `${text}:00`;
  }
  return text;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function formatDateTime(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  return readDateTime(String(value));
}

function readCustomer(body) {
  return {
    nolayanan: readText(body?.nolayanan),
    pelanggan: readText(body?.pelanggan),
    ktg: readText(body?.ktg) || 'PPP',
    media_tipe: readText(body?.media_tipe),
    profil_id: readProfileId(body?.profil_id),
    jns_tagihan: readText(body?.jns_tagihan) || 'PRABAYAR',
    siklus: readText(body?.siklus) || 'BULAN',
    tgl_aktif: readDate(body?.tgl_aktif),
    tgl_isolir: readDateTime(body?.tgl_isolir),
    username: readText(body?.username),
    password: readText(body?.password),
    ip_address: readText(body?.ip_address),
    mac_address: readText(body?.mac_address),
    router: readText(body?.router),
    server: readText(body?.server),
    acs: readText(body?.acs),
    addr_list: readText(body?.addr_list),
    wilayah: readText(body?.wilayah),
    alamat_pasang: readText(body?.alamat_pasang),
    tgl_pasang: readDate(body?.tgl_pasang),
    mitra: readText(body?.mitra),
    kode_unik: readText(body?.kode_unik),
    note: readText(body?.note),
    status: readStatus(body?.status),
  };
}

function customerIsValid(customer) {
  return Boolean(customer.pelanggan && customer.username && customer.status);
}

function mapCustomer(row) {
  return {
    id: row.id,
    nolayanan: row.nolayanan || '',
    pelanggan: row.pelanggan || '',
    ktg: row.ktg || '',
    media_tipe: row.media_tipe || '',
    profil_id: row.profil_id,
    nama_profil: row.nama_profil || '',
    harga_profil: row.harga_profil == null ? null : Number(row.harga_profil),
    jns_tagihan: row.jns_tagihan || '',
    siklus: row.siklus || '',
    tgl_aktif: formatDate(row.tgl_aktif),
    tgl_isolir: formatDateTime(row.tgl_isolir),
    username: row.username || '',
    password: row.password || '',
    ip_address: row.ip_address || '',
    mac_address: row.mac_address || '',
    router: row.router || '',
    server: row.server || '',
    acs: row.acs || '',
    addr_list: row.addr_list || '',
    wilayah: row.wilayah || '',
    alamat_pasang: row.alamat_pasang || '',
    tgl_pasang: formatDate(row.tgl_pasang),
    mitra: row.mitra || '',
    kode_unik: row.kode_unik || '',
    note: row.note || '',
    status: row.status || 'Aktif',
  };
}

const SELECT_CUSTOMERS = `SELECT c.id, c.nolayanan, c.pelanggan, c.ktg, c.media_tipe, c.profil_id,
  p.nama_profile AS nama_profil, p.harga AS harga_profil,
  c.jns_tagihan, c.siklus, c.tgl_aktif, c.tgl_isolir, c.username, c.password,
  c.ip_address, c.mac_address, c.router, c.server, c.acs, c.addr_list, c.wilayah,
  c.alamat_pasang, c.tgl_pasang, c.mitra, c.kode_unik, c.note, c.status
 FROM langganan_pelanggan c
 LEFT JOIN langganan_profiles p ON p.id = c.profil_id`;

async function ensureTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS langganan_pelanggan (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nolayanan VARCHAR(50),
      pelanggan VARCHAR(150) NOT NULL,
      ktg VARCHAR(20) DEFAULT 'PPP',
      media_tipe VARCHAR(50),
      profil_id INT NULL,
      jns_tagihan VARCHAR(30) DEFAULT 'PRABAYAR',
      siklus VARCHAR(20) DEFAULT 'BULAN',
      tgl_aktif DATE NULL,
      tgl_isolir DATETIME NULL,
      username VARCHAR(100) NOT NULL,
      password VARCHAR(100),
      ip_address VARCHAR(50),
      mac_address VARCHAR(50),
      router VARCHAR(100),
      server VARCHAR(100),
      acs VARCHAR(100),
      addr_list VARCHAR(100),
      wilayah VARCHAR(100),
      alamat_pasang TEXT,
      tgl_pasang DATE NULL,
      mitra VARCHAR(100),
      kode_unik VARCHAR(50),
      note TEXT,
      status ENUM('Aktif', 'Non Aktif', 'Isolir') DEFAULT 'Aktif',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_langganan_pelanggan_profil
        FOREIGN KEY (profil_id) REFERENCES langganan_profiles(id)
        ON DELETE SET NULL
    )`,
  );
  // Index untuk JOIN radacct.username -> langganan_pelanggan.username (halaman Langganan Online).
  await pool.query(
    'ALTER TABLE langganan_pelanggan ADD INDEX IF NOT EXISTS idx_langganan_username (username)',
  );
}

router.ensureTable = ensureTable;

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`${SELECT_CUSTOMERS} ORDER BY c.id DESC`);
    res.json(rows.map(mapCustomer));
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data langganan',
      error: error.message,
    });
  }
});

function sqlValues(customer) {
  return [
    customer.nolayanan,
    customer.pelanggan,
    customer.ktg,
    customer.media_tipe,
    customer.profil_id,
    customer.jns_tagihan,
    customer.siklus,
    customer.tgl_aktif,
    customer.tgl_isolir,
    customer.username,
    customer.password,
    customer.ip_address,
    customer.mac_address,
    customer.router,
    customer.server,
    customer.acs,
    customer.addr_list,
    customer.wilayah,
    customer.alamat_pasang,
    customer.tgl_pasang,
    customer.mitra,
    customer.kode_unik,
    customer.note,
    customer.status,
  ];
}

const KODE_UNIK_MIN = 10;
const KODE_UNIK_MAX = 999;
const KODE_UNIK_MAX_TRIES = 200;
const INSERT_LOCK = 'langganan_pelanggan_insert';

async function generateKodeUnik(conn) {
  for (let attempt = 0; attempt < KODE_UNIK_MAX_TRIES; attempt += 1) {
    const kode = String(Math.floor(Math.random() * (KODE_UNIK_MAX - KODE_UNIK_MIN + 1)) + KODE_UNIK_MIN);
    const [rows] = await conn.execute(
      `SELECT kode_unik FROM langganan_pelanggan
       WHERE kode_unik = ? AND status IN ('Aktif', 'Isolir') LIMIT 1`,
      [kode],
    );
    if (rows.length === 0) {
      return kode;
    }
  }
  return null;
}

router.post('/', async (req, res) => {
  const customer = readCustomer(req.body);
  if (!customerIsValid(customer)) {
    return res.status(400).json({
      success: false,
      message: 'Nama pelanggan, username, dan status wajib diisi',
    });
  }
  if (customer.nolayanan && !/^\d+$/.test(customer.nolayanan)) {
    return res.status(400).json({
      success: false,
      message: 'No Layanan hanya boleh berisi angka!',
    });
  }

  // Kode unik dibuat otomatis oleh backend; acs & mitra belum diinput dari form.
  customer.acs = '';
  customer.mitra = '';
  customer.kode_unik = '';

  let conn;
  let locked = false;
  try {
    conn = await pool.getConnection();
    // Serialisasi proses simpan agar pengecekan unik tidak bentrok antar request bersamaan.
    const [[lockRow]] = await conn.query('SELECT GET_LOCK(?, 10) AS got', [INSERT_LOCK]);
    locked = Number(lockRow.got) === 1;
    if (!locked) {
      return res.status(503).json({
        success: false,
        message: 'Server sedang sibuk, silakan coba lagi',
      });
    }

    if (customer.nolayanan) {
      const [existing] = await conn.execute(
        'SELECT nolayanan FROM langganan_pelanggan WHERE nolayanan = ? LIMIT 1',
        [customer.nolayanan],
      );
      if (existing.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'No Layanan sudah terdaftar!',
        });
      }
    }

    const kodeUnik = await generateKodeUnik(conn);
    if (!kodeUnik) {
      return res.status(409).json({
        success: false,
        message: 'Kode unik habis, tidak ada angka tersedia',
      });
    }
    customer.kode_unik = kodeUnik;

    const [result] = await conn.execute(
      `INSERT INTO langganan_pelanggan
        (nolayanan, pelanggan, ktg, media_tipe, profil_id, jns_tagihan, siklus, tgl_aktif, tgl_isolir,
         username, password, ip_address, mac_address, router, server, acs, addr_list, wilayah,
         alamat_pasang, tgl_pasang, mitra, kode_unik, note, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sqlValues(customer),
    );
    return res.json({
      success: true,
      message: 'Data langganan berhasil disimpan',
      id: result.insertId,
      kode_unik: kodeUnik,
    });
  } catch (error) {
    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({
        success: false,
        message: 'Profil langganan tidak ditemukan',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Gagal menyimpan data langganan',
      error: error.message,
    });
  } finally {
    if (conn) {
      if (locked) {
        await conn.query('SELECT RELEASE_LOCK(?)', [INSERT_LOCK]).catch(() => {});
      }
      conn.release();
    }
  }
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const customer = readCustomer(req.body);
  if (!Number.isInteger(id) || id < 1 || !customerIsValid(customer)) {
    return res.status(400).json({
      success: false,
      message: 'Data langganan belum lengkap atau tidak valid',
    });
  }

  try {
    const [result] = await pool.execute(
      `UPDATE langganan_pelanggan
       SET nolayanan = ?, pelanggan = ?, ktg = ?, media_tipe = ?, profil_id = ?, jns_tagihan = ?,
           siklus = ?, tgl_aktif = ?, tgl_isolir = ?, username = ?, password = ?, ip_address = ?,
           mac_address = ?, router = ?, server = ?, addr_list = ?, wilayah = ?,
           alamat_pasang = ?, tgl_pasang = ?, note = ?, status = ?
       WHERE id = ?`,
      [...sqlValues(customer).filter((_, index) => ![15, 20, 21].includes(index)), id],
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Data langganan tidak ditemukan',
      });
    }
    return res.json({
      success: true,
      message: 'Data langganan berhasil diperbarui',
    });
  } catch (error) {
    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({
        success: false,
        message: 'Profil langganan tidak ditemukan',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui data langganan',
      error: error.message,
    });
  }
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({
      success: false,
      message: 'Data langganan tidak valid',
    });
  }

  try {
    const [result] = await pool.execute('DELETE FROM langganan_pelanggan WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Data langganan tidak ditemukan',
      });
    }
    return res.json({
      success: true,
      message: 'Data langganan berhasil dihapus',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus data langganan',
      error: error.message,
    });
  }
});

module.exports = router;
