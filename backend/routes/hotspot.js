const crypto = require('crypto');
const express = require('express');
const pool = require('../../database');

const router = express.Router();

const MASA_AKTIF_SATUAN = ['JAM', 'HARI', 'BULAN'];
const MASA_AKTIF_DETIK = {
  JAM: 3600,
  HARI: 86400,
  BULAN: 2592000,
};

function masaAktifKeDetik(jumlah, satuan) {
  return jumlah * MASA_AKTIF_DETIK[satuan];
}

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

router.get('/profil', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT *, (harga_jual - komisi_reseller) AS hpp FROM hotspot_profiles ORDER BY id DESC',
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
  const namaProfile = readText(req.body?.nama_profile);
  const mikrotikGroup = readText(req.body?.mikrotik_group);
  const addressList = readText(req.body?.address_list);
  const rateLimit = readText(req.body?.rate_limit);
  const shared = readInteger(req.body?.shared ?? 1);
  const masaAktif = readInteger(req.body?.masa_aktif);
  const masaAktifSatuan = readText(req.body?.masa_aktif_satuan).toUpperCase();
  const hargaJual = readInteger(req.body?.harga_jual);
  const komisiReseller = readInteger(req.body?.komisi_reseller);

  if (!namaProfile || !mikrotikGroup || !Number.isInteger(masaAktif) || masaAktif < 1
    || !MASA_AKTIF_SATUAN.includes(masaAktifSatuan)
    || !Number.isInteger(hargaJual) || hargaJual < 0
    || !Number.isInteger(komisiReseller) || komisiReseller < 0
    || !Number.isInteger(shared) || shared < 1) {
    return res.status(400).json({
      success: false,
      message: 'Data profil belum lengkap atau tidak valid',
    });
  }

  const connection = await pool.getConnection();
  let committed = false;

  try {
    await connection.beginTransaction();
    await connection.execute(
      'INSERT INTO hotspot_profiles (nama_profile, mikrotik_group, address_list, rate_limit, shared, masa_aktif, masa_aktif_satuan, harga_jual, komisi_reseller) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        namaProfile,
        mikrotikGroup,
        addressList,
        rateLimit,
        shared,
        masaAktif,
        masaAktifSatuan,
        hargaJual,
        komisiReseller,
      ],
    );
    await connection.execute('DELETE FROM radgroupreply WHERE groupname = ?', [mikrotikGroup]);
    await connection.commit();
    committed = true;

    const totalDetik = String(masaAktifKeDetik(masaAktif, masaAktifSatuan));
    const radiusInserts = [
      pool.execute(
        "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Port-Limit', ':=', ?)",
        [mikrotikGroup, String(shared)],
      ),
      pool.execute(
        "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Session-Timeout', ':=', ?)",
        [mikrotikGroup, totalDetik],
      ),
    ];

    if (rateLimit) {
      radiusInserts.push(pool.execute(
        "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Mikrotik-Rate-Limit', ':=', ?)",
        [mikrotikGroup, rateLimit],
      ));
    }

    if (addressList) {
      radiusInserts.push(pool.execute(
        "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Mikrotik-Address-List', ':=', ?)",
        [mikrotikGroup, addressList],
      ));
    }

    await Promise.all(radiusInserts);

    return res.json({
      success: true,
      message: 'Profil berhasil disimpan',
    });
  } catch (error) {
    if (!committed) {
      await connection.rollback();
    } else {
      await pool.execute('DELETE FROM radgroupreply WHERE groupname = ?', [mikrotikGroup]);
      await pool.execute('DELETE FROM hotspot_profiles WHERE mikrotik_group = ?', [mikrotikGroup]);
    }
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: 'Mikrotik group sudah digunakan',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Gagal menyimpan profil',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

async function deleteProfileFromBothTables(executor, groupname) {
  await executor.execute('DELETE FROM radgroupreply WHERE groupname = ?', [groupname]);
  await executor.execute('DELETE FROM hotspot_profiles WHERE mikrotik_group = ?', [groupname]);
}

router.post('/profil/delete-massal', async (req, res) => {
  const groupnames = Array.isArray(req.body?.groupnames)
    ? [...new Set(
      req.body.groupnames
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    )]
    : [];

  if (groupnames.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Pilih minimal satu data',
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    for (const groupname of groupnames) {
      await deleteProfileFromBothTables(connection, groupname);
    }
    await connection.commit();

    return res.json({
      success: true,
      message: 'Profil berhasil dihapus',
      jumlah: groupnames.length,
    });
  } catch (error) {
    await connection.rollback();
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus profil',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

router.put('/profil/:groupname', async (req, res) => {
  const groupname = typeof req.params.groupname === 'string' ? req.params.groupname.trim() : '';
  const rateLimit = typeof req.body?.rate_limit === 'string' ? req.body.rate_limit.trim() : '';
  const masaAktif = readInteger(req.body?.masa_aktif);
  const masaAktifSatuan = readText(req.body?.masa_aktif_satuan).toUpperCase();

  if (!groupname || !rateLimit
    || !Number.isInteger(masaAktif) || masaAktif < 1
    || !MASA_AKTIF_SATUAN.includes(masaAktifSatuan)) {
    return res.status(400).json({
      success: false,
      message: 'Data profil belum lengkap atau tidak valid',
    });
  }

  const totalDetik = String(masaAktifKeDetik(masaAktif, masaAktifSatuan));

  try {
    const [profiles] = await pool.execute(
      'SELECT id FROM hotspot_profiles WHERE mikrotik_group = ? LIMIT 1',
      [groupname],
    );

    if (profiles.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Profil tidak ditemukan',
      });
    }

    await pool.execute(
      "DELETE FROM radgroupreply WHERE groupname = ? AND attribute IN ('Max-All-Session', 'Session-Timeout')",
      [groupname],
    );

    await Promise.all([
      pool.execute(
        'UPDATE hotspot_profiles SET masa_aktif = ?, masa_aktif_satuan = ?, rate_limit = ? WHERE mikrotik_group = ?',
        [masaAktif, masaAktifSatuan, rateLimit, groupname],
      ),
      pool.execute(
        "UPDATE radgroupreply SET value = ? WHERE groupname = ? AND attribute = 'Mikrotik-Rate-Limit'",
        [rateLimit, groupname],
      ),
      pool.execute(
        "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Session-Timeout', ':=', ?)",
        [groupname, totalDetik],
      ),
    ]);

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

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await deleteProfileFromBothTables(connection, groupname);
    await connection.commit();

    return res.json({
      success: true,
      message: 'Profil berhasil dihapus',
    });
  } catch (error) {
    await connection.rollback();
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus profil',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

function readInteger(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return NaN;
}

const CHARSETS = {
  'huruf-kecil': 'abcdefghijklmnopqrstuvwxyz',
  'huruf-besar': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'huruf-campuran': 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'angka-huruf': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
};

const JENIS_VOUCHER = ['username=password', 'username+password'];
const MAX_CODE_LENGTH = 32;

function combinationSpace(charsetSize, length) {
  let total = 1n;
  const base = BigInt(charsetSize);
  for (let index = 0; index < length; index += 1) {
    total *= base;
    if (total > 1000000000000000n) {
      return total;
    }
  }
  return total;
}

function countTakenCodes(usernames, prefix, length, charset) {
  const alphabet = new Set(charset);
  let taken = 0n;

  for (const username of usernames) {
    if (typeof username !== 'string' || !username.startsWith(prefix)) {
      continue;
    }
    const body = username.slice(prefix.length);
    if (body.length !== length) {
      continue;
    }
    let matches = true;
    for (const character of body) {
      if (!alphabet.has(character)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      taken += 1n;
    }
  }

  return taken;
}

function resolveCodeLength(usernames, prefix, jumlah, requestedLength, charset) {
  let length = requestedLength;

  while (length <= MAX_CODE_LENGTH) {
    const space = combinationSpace(charset.length, length);
    const taken = countTakenCodes(usernames, prefix, length, charset);
    const remaining = space > taken ? space - taken : 0n;
    if (remaining >= BigInt(jumlah)) {
      return length;
    }
    length += 1;
  }

  const error = new Error('Kombinasi kode tidak cukup');
  error.code = 'CODE_EXHAUSTED';
  throw error;
}

function randomFromCharset(charset, length) {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += charset[crypto.randomInt(charset.length)];
  }
  return code;
}

function createVoucherBatch({
  jumlah,
  panjang,
  prefix,
  charset,
  usedUsernames,
  separatePassword,
}) {
  const reserved = new Set(usedUsernames);
  const vouchers = [];
  let attempts = 0;
  const attemptLimit = Math.max(jumlah * 40, 200);

  while (vouchers.length < jumlah && attempts < attemptLimit) {
    attempts += 1;
    const username = `${prefix}${randomFromCharset(charset, panjang)}`;
    if (reserved.has(username)) {
      continue;
    }

    let password = username;
    if (separatePassword) {
      let guard = 0;
      do {
        password = randomFromCharset(charset, panjang);
        guard += 1;
      } while (password === username && guard < 8);
      if (password === username) {
        continue;
      }
    }

    reserved.add(username);
    vouchers.push({ username, password });
  }

  if (vouchers.length < jumlah) {
    const error = new Error('Kode unik tidak cukup');
    error.code = 'CODE_EXHAUSTED';
    throw error;
  }

  return vouchers;
}

async function insertVoucher(voucher, record) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await connection.execute(
      "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)",
      [voucher.username, voucher.password],
    );
    if (record.nasIp) {
      await connection.execute(
        "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'NAS-IP-Address', '==', ?)",
        [voucher.username, record.nasIp],
      );
    }
    await connection.execute(
      'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
      [voucher.username, record.mikrotikGroup],
    );
    await connection.execute(
      'INSERT INTO hotspot_vouchers (username, password, profile, router, server, mitra, outlet, hpp, komisi, harga, admin, kode_batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        voucher.username,
        voucher.password,
        record.profile,
        record.router,
        record.server,
        record.mitra,
        record.outlet,
        record.hpp,
        record.komisi,
        record.harga,
        record.admin,
        record.kodeBatch,
      ],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function deleteVoucherEverywhere(executor, username) {
  const [groupResult] = await executor.execute(
    'DELETE FROM radusergroup WHERE username = ?',
    [username],
  );
  const [checkResult] = await executor.execute(
    'DELETE FROM radcheck WHERE username = ?',
    [username],
  );
  const [webResult] = await executor.execute(
    'DELETE FROM hotspot_vouchers WHERE username = ?',
    [username],
  );
  return groupResult.affectedRows + checkResult.affectedRows + webResult.affectedRows;
}

function formatDurasiDetik(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const jam = String(Math.floor(total / 3600)).padStart(2, '0');
  const menit = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const detik = String(total % 60).padStart(2, '0');
  return `${jam}:${menit}:${detik}`;
}

function formatKuotaTerpakai(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const megabyte = value / (1024 * 1024);
  if (megabyte >= 1024) {
    const gigabyte = megabyte / 1024;
    const rounded = gigabyte >= 10 ? Math.round(gigabyte) : Math.round(gigabyte * 10) / 10;
    return `${rounded}GB`;
  }
  return `${Math.round(megabyte)}MB`;
}

function hitungTanggalExpired(tglAktif, durasiMaksimal) {
  const maksimal = Number(durasiMaksimal);
  if (!tglAktif || !Number.isFinite(maksimal) || maksimal <= 0) {
    return null;
  }
  const mulai = tglAktif instanceof Date ? new Date(tglAktif.getTime()) : new Date(tglAktif);
  if (Number.isNaN(mulai.getTime())) {
    return null;
  }
  return new Date(mulai.getTime() + (maksimal * 1000));
}

router.get('/voucher-terjual', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
        v.id,
        v.username,
        v.password,
        v.profile,
        v.router,
        v.server,
        v.mitra,
        v.outlet,
        v.hpp,
        v.komisi,
        v.harga,
        v.admin,
        v.kode_batch,
        v.created_at,
        COALESCE(SUM(a.acctsessiontime), 0) AS durasi_terpakai,
        COALESCE(SUM(COALESCE(a.acctinputoctets, 0) + COALESCE(a.acctoutputoctets, 0)), 0) AS kuota_terpakai,
        MIN(a.acctstarttime) AS tgl_aktif,
        MAX(g.value) AS durasi_maksimal
      FROM hotspot_vouchers v
      LEFT JOIN radacct a ON a.username = v.username
      LEFT JOIN hotspot_profiles hp
        ON hp.nama_profile = v.profile OR hp.mikrotik_group = v.profile
      LEFT JOIN radgroupreply g
        ON g.groupname = hp.mikrotik_group AND g.attribute = 'Session-Timeout'
      WHERE v.status = 'Yes' OR a.radacctid IS NOT NULL
      GROUP BY
        v.id, v.username, v.password, v.profile, v.router, v.server, v.mitra,
        v.outlet, v.hpp, v.komisi, v.harga, v.admin, v.kode_batch, v.created_at
      ORDER BY tgl_aktif DESC, v.id DESC`,
    );

    const data = rows.map((row) => {
      const terpakai = Number(row.durasi_terpakai) || 0;
      const maksimal = Number(row.durasi_maksimal);
      const punyaBatas = Number.isFinite(maksimal) && maksimal > 0;
      const statusExpired = punyaBatas && terpakai >= maksimal ? 'EXPIRED' : 'AKTIF';
      const tglExpired = hitungTanggalExpired(row.tgl_aktif, punyaBatas ? maksimal : null);

      return {
        id: row.id,
        username: row.username,
        password: row.password,
        profile: row.profile,
        router: row.router,
        server: row.server,
        mitra: row.mitra,
        outlet: row.outlet,
        hpp: Number(row.hpp) || 0,
        komisi: Number(row.komisi) || 0,
        harga: Number(row.harga) || 0,
        saldo: null,
        admin: row.admin,
        kode_batch: row.kode_batch,
        created_at: row.created_at,
        tgl_aktif: row.tgl_aktif,
        tgl_expired: tglExpired,
        durasi_terpakai: terpakai,
        durasi_maksimal: punyaBatas ? maksimal : null,
        kuota_terpakai: Number(row.kuota_terpakai) || 0,
        durasi: `${formatDurasiDetik(terpakai)} / ${punyaBatas ? formatDurasiDetik(maksimal) : 'UNLIMITED'}`,
        kuota: `${formatKuotaTerpakai(row.kuota_terpakai)} / UNLIMITED`,
        status_expired: statusExpired,
      };
    });

    res.json(data);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil voucher terjual',
      error: error.message,
    });
  }
});

router.get('/voucher', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM hotspot_vouchers ORDER BY created_at DESC',
    );

    res.json(rows);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data voucher',
      error: error.message,
    });
  }
});

router.post('/voucher/generate', async (req, res) => {
  const jumlah = readInteger(req.body?.jumlah);
  const panjangDiminta = readInteger(req.body?.panjang);
  const mikrotikGroup = readText(req.body?.mikrotik_group);
  const prefix = readText(req.body?.prefix);
  const jenisVoucher = readText(req.body?.jenis_voucher);
  const kodeKombinasi = readText(req.body?.kode_kombinasi);
  const routerName = readText(req.body?.router);
  const serverName = readText(req.body?.server);
  const outlet = readText(req.body?.outlet);
  const mitra = readText(req.body?.mitra);
  const admin = readText(req.body?.admin) || 'System';
  const charset = CHARSETS[kodeKombinasi];

  if (!Number.isInteger(jumlah) || jumlah < 1 || jumlah > 500) {
    return res.status(400).json({
      success: false,
      message: 'Jumlah voucher harus antara 1 dan 500',
    });
  }

  if (!Number.isInteger(panjangDiminta) || panjangDiminta < 6 || panjangDiminta > MAX_CODE_LENGTH) {
    return res.status(400).json({
      success: false,
      message: 'Panjang karakter minimal 6',
    });
  }

  if (prefix.length > 3 || (prefix && !/^[A-Za-z0-9]+$/.test(prefix))) {
    return res.status(400).json({
      success: false,
      message: 'Prefix maksimal 3 karakter huruf atau angka',
    });
  }

  if (!JENIS_VOUCHER.includes(jenisVoucher) || !charset) {
    return res.status(400).json({
      success: false,
      message: 'Jenis voucher atau kode kombinasi tidak valid',
    });
  }

  if (!mikrotikGroup) {
    return res.status(400).json({
      success: false,
      message: 'Profil wajib dipilih',
    });
  }

  try {
    const [profiles] = await pool.execute(
      'SELECT nama_profile, harga_jual, komisi_reseller, (harga_jual - komisi_reseller) AS hpp FROM hotspot_profiles WHERE mikrotik_group = ? LIMIT 1',
      [mikrotikGroup],
    );

    if (profiles.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Profil tidak ditemukan',
      });
    }

    const profile = profiles[0];
    const record = {
      mikrotikGroup,
      profile: profile.nama_profile || mikrotikGroup,
      router: routerName,
      server: serverName,
      mitra,
      outlet,
      hpp: Number(profile.hpp) || 0,
      komisi: Number(profile.komisi_reseller) || 0,
      harga: Number(profile.harga_jual) || 0,
      admin,
    };
    const [existingRows] = await pool.execute(
      'SELECT username FROM radcheck UNION SELECT username FROM hotspot_vouchers',
    );
    const usedUsernames = existingRows.map((row) => row.username);
    const panjang = resolveCodeLength(usedUsernames, prefix, jumlah, panjangDiminta, charset);
    const vouchers = createVoucherBatch({
      jumlah,
      panjang,
      prefix,
      charset,
      usedUsernames,
      separatePassword: jenisVoucher === 'username+password',
    });

    let nasIp = '';
    if (routerName && routerName !== 'ALL ROUTER') {
      const [routerRows] = await pool.execute(
        'SELECT ip_address FROM routers WHERE nama_router = ? LIMIT 1',
        [routerName],
      );
      nasIp = routerRows[0]?.ip_address || '';
    }

    const kodeBatch = Math.floor(Date.now() / 1000).toString();
    record.kodeBatch = kodeBatch;
    record.nasIp = nasIp;
    await Promise.all(vouchers.map((voucher) => insertVoucher(voucher, record)));

    return res.json({
      success: true,
      message: 'Voucher berhasil dibuat',
      jumlah: vouchers.length,
      panjang,
      jenis_voucher: jenisVoucher,
      kode_kombinasi: kodeKombinasi,
      prefix,
      router: routerName,
      server: serverName,
      outlet,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.code === 'CODE_EXHAUSTED'
        ? 'Gagal menghasilkan kode voucher yang unik'
        : 'Gagal membuat voucher',
      error: error.message,
    });
  }
});

router.post('/voucher/delete-massal', async (req, res) => {
  const usernames = Array.isArray(req.body?.usernames)
    ? [...new Set(
      req.body.usernames
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    )]
    : [];

  if (usernames.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Pilih minimal satu voucher',
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM radusergroup WHERE username IN (?)', [usernames]);
    await connection.query('DELETE FROM radcheck WHERE username IN (?)', [usernames]);
    await connection.query('DELETE FROM hotspot_vouchers WHERE username IN (?)', [usernames]);
    await connection.commit();

    return res.json({
      success: true,
      message: 'Voucher berhasil dihapus',
      jumlah: usernames.length,
    });
  } catch (error) {
    await connection.rollback();
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus voucher',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

router.delete('/voucher/:username', async (req, res) => {
  const username = typeof req.params.username === 'string' ? req.params.username.trim() : '';

  if (!username) {
    return res.status(400).json({
      success: false,
      message: 'Kode voucher wajib diisi',
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const removed = await deleteVoucherEverywhere(connection, username);
    await connection.commit();

    if (removed === 0) {
      return res.status(404).json({
        success: false,
        message: 'Voucher tidak ditemukan',
      });
    }

    return res.json({
      success: true,
      message: 'Voucher berhasil dihapus',
    });
  } catch (error) {
    await connection.rollback();
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus voucher',
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

module.exports = router;
