const express = require('express');
const { exec } = require('child_process');
const pool = require('../../database');

const router = express.Router();

router.get('/profil', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT groupname, value AS rate_limit FROM radgroupreply WHERE attribute = 'Mikrotik-Rate-Limit'",
    );

    res.json(rows);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data profil',
      error: error.message,
    });
  }
});

router.post('/profil', async (req, res) => {
  const groupname = typeof req.body?.groupname === 'string' ? req.body.groupname.trim() : '';
  const rateLimit = typeof req.body?.rate_limit === 'string' ? req.body.rate_limit.trim() : '';

  if (!groupname || !rateLimit) {
    return res.status(400).json({
      success: false,
      message: 'Nama profil dan limit kecepatan wajib diisi',
    });
  }

  try {
    await pool.execute(
      "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Mikrotik-Rate-Limit', ':=', ?)",
      [groupname, rateLimit],
    );

    return res.json({
      success: true,
      message: 'Profil berhasil disimpan',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menyimpan profil',
      error: error.message,
    });
  }
});

router.put('/profil/:groupname', async (req, res) => {
  const groupname = typeof req.params.groupname === 'string' ? req.params.groupname.trim() : '';
  const rateLimit = typeof req.body?.rate_limit === 'string' ? req.body.rate_limit.trim() : '';

  if (!groupname || !rateLimit) {
    return res.status(400).json({
      success: false,
      message: 'Nama profil dan limit kecepatan wajib diisi',
    });
  }

  try {
    const [result] = await pool.execute(
      "UPDATE radgroupreply SET value = ? WHERE groupname = ? AND attribute = 'Mikrotik-Rate-Limit'",
      [rateLimit, groupname],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Profil tidak ditemukan',
      });
    }

    return res.json({
      success: true,
      message: 'Profil berhasil diperbarui',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui profil',
      error: error.message,
    });
  }
});

router.delete('/profil/:groupname', async (req, res) => {
  const groupname = typeof req.params.groupname === 'string' ? req.params.groupname.trim() : '';

  if (!groupname) {
    return res.status(400).json({
      success: false,
      message: 'Nama profil wajib diisi',
    });
  }

  try {
    await pool.execute('DELETE FROM radgroupreply WHERE groupname = ?', [groupname]);

    return res.json({
      success: true,
      message: 'Profil berhasil dihapus',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus profil',
      error: error.message,
    });
  }
});

router.post('/pelanggan', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const paket = typeof req.body?.paket === 'string' ? req.body.paket.trim() : '';

  if (!username || !password || !paket) {
    return res.status(400).json({
      success: false,
      message: 'Username, password, dan paket wajib diisi',
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await connection.execute(
      "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)",
      [username, password],
    );

    await connection.execute(
      'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
      [username, paket],
    );

    await connection.commit();

    return res.json({
      success: true,
      message: 'Pelanggan berhasil disimpan',
    });
  } catch (error) {
    await connection.rollback();

    return res.status(500).json({
      success: false,
      message: 'Gagal menyimpan pelanggan',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

router.get('/pelanggan', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT c.username, c.value AS password, IFNULL(ug.groupname, 'Tanpa Profil') AS paket FROM radcheck c LEFT JOIN radusergroup ug ON c.username = ug.username WHERE c.attribute = 'Cleartext-Password'",
    );

    res.json(rows);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data pelanggan',
      error: error.message,
    });
  }
});

router.put('/pelanggan/:username', async (req, res) => {
  const username = typeof req.params.username === 'string' ? req.params.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const paket = typeof req.body?.paket === 'string' ? req.body.paket.trim() : '';

  if (!username || !password || !paket) {
    return res.status(400).json({
      success: false,
      message: 'Password dan paket wajib diisi',
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [updated] = await connection.execute(
      "UPDATE radcheck SET value = ? WHERE username = ? AND attribute = 'Cleartext-Password'",
      [password, username],
    );

    if (updated.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Pelanggan tidak ditemukan',
      });
    }

    await connection.execute('DELETE FROM radusergroup WHERE username = ?', [username]);

    await connection.execute(
      'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
      [username, paket],
    );

    await connection.commit();

    return res.json({
      success: true,
      message: 'Pelanggan berhasil diperbarui',
    });
  } catch (error) {
    await connection.rollback();

    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui pelanggan',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

router.delete('/pelanggan/:username', async (req, res) => {
  const username = typeof req.params.username === 'string' ? req.params.username.trim() : '';

  if (!username) {
    return res.status(400).json({
      success: false,
      message: 'Username wajib diisi',
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await connection.execute('DELETE FROM radusergroup WHERE username = ?', [username]);
    await connection.execute('DELETE FROM radcheck WHERE username = ?', [username]);

    await connection.commit();

    return res.json({
      success: true,
      message: 'Pelanggan berhasil dihapus',
    });
  } catch (error) {
    await connection.rollback();

    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus pelanggan',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

router.get('/online', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT username, framedipaddress AS ip_address, acctstarttime AS login_time FROM radacct WHERE acctstoptime IS NULL',
    );

    res.json(rows);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data pelanggan online',
      error: error.message,
    });
  }
});

router.post('/disconnect', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const ipAddress = typeof req.body?.ip_address === 'string' ? req.body.ip_address.trim() : '';

  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username) || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ipAddress)) {
    return res.status(400).json({
      success: false,
      message: 'Username atau IP address tidak valid',
    });
  }

  const octets = ipAddress.split('.').map(Number);
  if (octets.some((octet) => octet > 255)) {
    return res.status(400).json({
      success: false,
      message: 'Username atau IP address tidak valid',
    });
  }

  const command = `echo "Framed-IP-Address='${ipAddress}'" | radclient -x 192.168.223.250:3799 disconnect RaniahRadius123!`;

  exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({
        success: false,
        message: 'Gagal memutus koneksi pelanggan',
        detail: (stderr || stdout || '').replace(/RaniahRadius123!/g, '').trim(),
      });
    }

    return res.json({
      success: true,
      message: 'Koneksi pelanggan berhasil diputus',
    });
  });
});

module.exports = router;
