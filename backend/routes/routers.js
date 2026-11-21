const express = require('express');
const pool = require('../../database');
const requireRole = require('../middleware/requireRole');
const {
  ALL_SERVER, JENIS_SERVER, MAX_SERVER_NAME, validServerName, normalizeJenis, serverNameTaken,
} = require('../router_servers');
const { renameServerBindings } = require('../langganan_radius');

const {
  MAX_SECRET_LENGTH, isValidIpv4, previewNasSync, syncAfterRouterChange,
} = require('../radius_nas');

const router = express.Router();
const requireAdmin = requireRole('admin');

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function readRouterBody(body) {
  return {
    namaRouter: readText(body?.nama_router).slice(0, 100),
    ipAddress: readText(body?.ip_address).slice(0, 50),
    secret: readText(body?.secret).slice(0, 100),
    deskripsi: readText(body?.deskripsi),
  };
}

// Pesan error bila data router tidak bisa dipakai sebagai client FreeRADIUS, atau '' bila valid.
function routerBodyError({ ipAddress, secret }) {
  if (!isValidIpv4(ipAddress)) {
    return 'IP address harus berupa IPv4 yang valid (contoh 192.168.1.1)';
  }
  if (secret.length > MAX_SECRET_LENGTH) {
    return `Secret maksimal ${MAX_SECRET_LENGTH} karakter`;
  }
  return '';
}

async function ipAlreadyUsed(ipAddress, exceptId = 0) {
  const [rows] = await pool.execute(
    'SELECT id FROM routers WHERE ip_address = ? AND id <> ? LIMIT 1',
    [ipAddress, exceptId],
  );
  return rows.length > 0;
}

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, nama_router, ip_address, secret, deskripsi, status, created_at FROM routers ORDER BY id DESC',
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data router',
      error: error.message,
    });
  }
});

// Daftar server semua router (sumber dropdown Server di Buat VC dan registrasi
// PPPoE). Filter opsional: ?jenis=hotspot|pppoe. Server bertipe 'both' (Hotspot &
// PPPoE) ikut tampil di kedua filter. ?jenis=both hanya menampilkan server 'both'.
router.get('/servers', async (req, res) => {
  const jenis = readText(req.query?.jenis);
  if (jenis && !JENIS_SERVER.includes(jenis)) {
    return res.status(400).json({
      success: false,
      message: 'Jenis server harus hotspot, pppoe, atau both',
    });
  }
  let where = '';
  if (jenis === 'both') {
    where = 'WHERE s.jenis = ?';
  } else if (jenis) {
    where = "WHERE s.jenis IN (?, 'both')";
  }

  try {
    const [rows] = await pool.execute(
      `SELECT s.id, s.router_id, r.nama_router, s.jenis, s.nama
       FROM router_servers s
       JOIN routers r ON r.id = s.router_id
       ${where}
       ORDER BY r.nama_router ASC, s.jenis ASC, s.nama ASC`,
      jenis ? [jenis] : [],
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil data server',
      error: error.message,
    });
  }
});

router.post('/:id/servers', requireAdmin, async (req, res) => {
  const id = readId(req.params.id);
  const jenis = normalizeJenis(req.body?.jenis);
  const nama = readText(req.body?.nama);

  if (!id || !jenis) {
    return res.status(400).json({
      success: false,
      message: 'Router dan jenis server (hotspot, pppoe, atau keduanya) wajib dipilih',
    });
  }
  if (!validServerName(nama)) {
    return res.status(400).json({
      success: false,
      message: `Nama server wajib diisi, maksimal ${MAX_SERVER_NAME} karakter, dan tidak boleh "${ALL_SERVER}"`,
    });
  }

  try {
    const [routerRows] = await pool.execute('SELECT id FROM routers WHERE id = ? LIMIT 1', [id]);
    if (routerRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Router tidak ditemukan',
      });
    }

    if (await serverNameTaken(pool, { routerId: id, nama, jenis })) {
      return res.status(409).json({
        success: false,
        message: 'Server dengan nama itu sudah ada di router ini',
      });
    }

    const [result] = await pool.execute(
      'INSERT INTO router_servers (router_id, jenis, nama) VALUES (?, ?, ?)',
      [id, jenis, nama],
    );
    return res.json({
      success: true,
      message: 'Server berhasil disimpan',
      id: result.insertId,
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: 'Server dengan nama itu sudah ada di router ini',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Gagal menyimpan server',
      error: error.message,
    });
  }
});

router.put('/servers/:serverId', requireAdmin, async (req, res) => {
  const serverId = readId(req.params.serverId);
  const routerId = readId(req.body?.router_id);
  const jenis = normalizeJenis(req.body?.jenis);
  const nama = readText(req.body?.nama);

  if (!serverId || !routerId || !jenis) {
    return res.status(400).json({
      success: false,
      message: 'Server, router, dan jenis server (hotspot, pppoe, atau keduanya) wajib dipilih',
    });
  }
  if (!validServerName(nama)) {
    return res.status(400).json({
      success: false,
      message: `Nama server wajib diisi, maksimal ${MAX_SERVER_NAME} karakter, dan tidak boleh "${ALL_SERVER}"`,
    });
  }

  const connection = await pool.getConnection();
  try {
    const [serverRows] = await connection.execute(
      'SELECT nama, router_id FROM router_servers WHERE id = ? LIMIT 1',
      [serverId],
    );
    const current = serverRows[0];
    if (!current) {
      return res.status(404).json({ success: false, message: 'Server tidak ditemukan' });
    }

    const [routerRows] = await connection.execute(
      'SELECT id, nama_router, ip_address FROM routers WHERE id = ? LIMIT 1',
      [routerId],
    );
    if (routerRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Router tidak ditemukan',
      });
    }

    const [oldRouterRows] = await connection.execute(
      'SELECT nama_router, ip_address FROM routers WHERE id = ? LIMIT 1',
      [current.router_id],
    );
    const oldRouter = oldRouterRows[0] || null;

    if (await serverNameTaken(connection, { routerId, nama, jenis, exceptId: serverId })) {
      return res.status(409).json({
        success: false,
        message: 'Server dengan nama itu sudah ada di router ini',
      });
    }

    await connection.beginTransaction();
    const [result] = await connection.execute(
      'UPDATE router_servers SET router_id = ?, jenis = ?, nama = ? WHERE id = ?',
      [routerId, jenis, nama, serverId],
    );
    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Server tidak ditemukan',
      });
    }

    // Nama berubah: Called-Station-Id akun yang terikat ke router lama ikut diganti.
    // Router tempat akun dikunci adalah router sebelum edit, karena NAS-IP-nya IP itu.
    let calledStationSync = null;
    if (current.nama !== nama && oldRouter) {
      calledStationSync = await renameServerBindings(connection, {
        oldName: current.nama,
        newName: nama,
        routerName: oldRouter.nama_router,
        routerIp: oldRouter.ip_address,
      });
    }
    await connection.commit();

    return res.json({
      success: true,
      message: 'Server berhasil diperbarui',
      called_station_sync: calledStationSync,
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: 'Server dengan nama itu sudah ada di router ini',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Gagal menyimpan perubahan server',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

router.delete('/servers/:serverId', requireAdmin, async (req, res) => {
  const serverId = readId(req.params.serverId);
  if (!serverId) {
    return res.status(400).json({
      success: false,
      message: 'Server tidak valid',
    });
  }

  try {
    const [result] = await pool.execute('DELETE FROM router_servers WHERE id = ?', [serverId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Server tidak ditemukan',
      });
    }
    return res.json({
      success: true,
      message: 'Server berhasil dihapus',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus server',
      error: error.message,
    });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  const { namaRouter, ipAddress, secret, deskripsi } = readRouterBody(req.body);

  if (!namaRouter || !ipAddress || !secret) {
    return res.status(400).json({
      success: false,
      message: 'Nama router, IP address, dan secret wajib diisi',
    });
  }

  const bodyError = routerBodyError({ ipAddress, secret });
  if (bodyError) {
    return res.status(400).json({ success: false, message: bodyError });
  }

  try {
    if (await ipAlreadyUsed(ipAddress)) {
      return res.status(409).json({
        success: false,
        message: 'IP address itu sudah dipakai router lain',
      });
    }

    const [result] = await pool.execute(
      'INSERT INTO routers (nama_router, ip_address, secret, deskripsi) VALUES (?, ?, ?, ?)',
      [namaRouter, ipAddress, secret, deskripsi],
    );
    const radiusSync = await syncAfterRouterChange(pool);

    return res.json({
      success: true,
      message: 'Router berhasil disimpan',
      id: result.insertId,
      radius_sync: radiusSync,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menyimpan router',
      error: error.message,
    });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  const id = readId(req.params.id);
  const { namaRouter, ipAddress, secret, deskripsi } = readRouterBody(req.body);

  if (!id || !namaRouter || !ipAddress || !secret) {
    return res.status(400).json({
      success: false,
      message: 'Data router belum lengkap atau tidak valid',
    });
  }

  const bodyError = routerBodyError({ ipAddress, secret });
  if (bodyError) {
    return res.status(400).json({ success: false, message: bodyError });
  }

  const connection = await pool.getConnection();
  try {
    const [oldRows] = await connection.execute(
      'SELECT nama_router, ip_address FROM routers WHERE id = ? LIMIT 1',
      [id],
    );
    const old = oldRows[0];
    if (!old) {
      return res.status(404).json({ success: false, message: 'Router tidak ditemukan' });
    }
    if (await ipAlreadyUsed(ipAddress, id)) {
      return res.status(409).json({
        success: false,
        message: 'IP address itu sudah dipakai router lain',
      });
    }

    await connection.beginTransaction();

    // Akun yang membatasi NAS memakai IP router: ikut pindah bila IP berubah.
    if (String(old.ip_address).trim() !== ipAddress) {
      await connection.execute(
        "UPDATE radcheck SET value = ? WHERE attribute = 'NAS-IP-Address' AND value = ?",
        [ipAddress, String(old.ip_address).trim()],
      );
    }
    // Pelanggan & voucher menyimpan NAMA router: ikut diganti bila nama berubah.
    if (old.nama_router !== namaRouter) {
      await connection.execute(
        'UPDATE langganan_pelanggan SET router = ? WHERE router = ?',
        [namaRouter, old.nama_router],
      );
      await connection.execute(
        'UPDATE hotspot_vouchers SET router = ? WHERE router = ?',
        [namaRouter, old.nama_router],
      );
    }

    await connection.execute(
      'UPDATE routers SET nama_router = ?, ip_address = ?, secret = ?, deskripsi = ? WHERE id = ?',
      [namaRouter, ipAddress, secret, deskripsi, id],
    );
    await connection.commit();

    const radiusSync = await syncAfterRouterChange(pool);

    return res.json({
      success: true,
      message: 'Router berhasil diperbarui',
      radius_sync: radiusSync,
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui router',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const id = readId(req.params.id);

  if (!id) {
    return res.status(400).json({
      success: false,
      message: 'Router tidak valid',
    });
  }

  try {
    const [routerRows] = await pool.execute(
      'SELECT nama_router, ip_address FROM routers WHERE id = ? LIMIT 1',
      [id],
    );
    const target = routerRows[0];
    if (!target) {
      return res.status(404).json({ success: false, message: 'Router tidak ditemukan' });
    }

    // Jangan hapus router yang masih dipakai: akun RADIUS-nya akan ditolak diam-diam.
    const [[{ n: akunNas }]] = await pool.execute(
      "SELECT COUNT(*) AS n FROM radcheck WHERE attribute = 'NAS-IP-Address' AND value = ?",
      [String(target.ip_address).trim()],
    );
    const [[{ n: pelanggan }]] = await pool.execute(
      'SELECT COUNT(*) AS n FROM langganan_pelanggan WHERE router = ?',
      [target.nama_router],
    );
    const [[{ n: voucher }]] = await pool.execute(
      'SELECT COUNT(*) AS n FROM hotspot_vouchers WHERE router = ?',
      [target.nama_router],
    );
    if (Number(akunNas) + Number(pelanggan) + Number(voucher) > 0) {
      return res.status(409).json({
        success: false,
        message: `Router masih dipakai: ${pelanggan} langganan, ${akunNas} akun PPPoE, ${voucher} voucher. `
          + 'Pindahkan ke ALL ROUTER atau router lain dulu.',
      });
    }

    // Server milik router ikut dihapus agar tidak jadi data yatim.
    await pool.execute('DELETE FROM router_servers WHERE router_id = ?', [id]);
    const [result] = await pool.execute(
      'DELETE FROM routers WHERE id = ?',
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Router tidak ditemukan',
      });
    }

    const radiusSync = await syncAfterRouterChange(pool);

    return res.json({
      success: true,
      message: 'Router berhasil dihapus',
      radius_sync: radiusSync,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus router',
      error: error.message,
    });
  }
});

// Status sinkronisasi router -> tabel nas FreeRADIUS (tanpa mengubah apa pun).
router.get('/nas-sync', requireAdmin, async (req, res) => {
  try {
    const preview = await previewNasSync(pool);
    return res.json({ success: true, in_sync: !preview.changed, ...preview });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal membaca status sinkronisasi NAS',
      error: error.message,
    });
  }
});

// Paksa sinkronisasi ulang semua router ke tabel nas.
router.post('/nas-sync', requireAdmin, async (req, res) => {
  const result = await syncAfterRouterChange(pool);
  if (!result.ok) {
    return res.status(500).json({
      success: false,
      message: 'Gagal sinkronisasi NAS',
      error: result.error,
    });
  }
  return res.json({ success: true, message: 'Sinkronisasi NAS selesai', ...result });
});

module.exports = router;
