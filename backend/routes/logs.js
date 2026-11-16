// Log Aplikasi — daftar aktivitas admin (hasil pencatatan backend/activity_log.js).
//
// Menampilkan: siapa (nama lengkap + role), dari IP mana, info aktivitas (aksi + aksi terhadap
// entitas apa + aplikasi/browser), dan tanggal kejadian. Berguna untuk audit: siapa yang
// menambah/mengubah/menghapus data, dan siapa yang login dari mana.
//
// Tanpa filter tanggal/kata kunci -> mode "terbaru": ambil 100 kejadian terakhir (seperti tampilan
// bawaan Log Aplikasi) dan tombol pagination disembunyikan. Begitu difilter -> pagination server-side.
const express = require('express');
const pool = require('../../database');

const router = express.Router();

const MAX_PAGE_LIMIT = 200;
const LATEST_LIMIT = 100;
const ACTIONS = ['login', 'tambah', 'edit', 'hapus', 'akses'];
const SEARCH_COLUMNS = ['username', 'nama_lengkap', 'info_aktivitas', 'entity', 'subject', 'ip', 'message'];

function readText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 100) : '';
}

function likePattern(value) {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

function statusKind(status) {
  const code = Number(status) || 0;
  if (code >= 200 && code < 300) {
    return 'sukses';
  }
  if (code >= 300 && code < 400) {
    return 'dialihkan';
  }
  if (code >= 400) {
    return 'gagal';
  }
  return 'lainnya';
}

// Tanggal 'YYYY-MM-DD' -> valid atau null.
function readDate(value) {
  const text = readText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function labelOf(action) {
  return { login: 'Login', tambah: 'Tambah', edit: 'Edit', hapus: 'Hapus', akses: 'Akses' }[action] || 'Aksi';
}

router.get('/', async (req, res) => {
  try {
    const term = readText(req.query.q);
    const action = readText(req.query.action);
    const status = readText(req.query.status);
    const user = readText(req.query.user);
    const dateFrom = readDate(req.query.date_from);
    const dateTo = readDate(req.query.date_to);

    const where = [];
    const params = [];

    if (term) {
      where.push(`(${SEARCH_COLUMNS.map((column) => `${column} LIKE ?`).join(' OR ')})`);
      SEARCH_COLUMNS.forEach(() => params.push(likePattern(term)));
    }
    if (ACTIONS.includes(action)) {
      where.push('action = ?');
      params.push(action);
    }
    if (user) {
      where.push('username = ?');
      params.push(user);
    }
    if (status === 'gagal') {
      where.push('status >= 400');
    } else if (status === 'sukses') {
      where.push('status >= 200 AND status < 300');
    }
    if (dateFrom) {
      where.push('created_at >= ?');
      params.push(dateFrom);
    }
    if (dateTo) {
      where.push('created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      params.push(dateTo);
    }

    // Mode "terbaru" hanya saat benar-benar tanpa filter (bulan dikosongkan & tanpa kata kunci).
    const filtered = Boolean(term || action || user || dateFrom || dateTo);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    // Ringkasan jumlah per aksi untuk header kartu (mengikuti filter yang sama).
    const [summaryRows] = await pool.query(
      `SELECT action, COUNT(*) AS jumlah FROM web_activity_logs ${whereSql} GROUP BY action`,
      params,
    );
    const summary = { total: 0, login: 0, tambah: 0, edit: 0, hapus: 0 };
    for (const row of summaryRows) {
      const jumlah = Number(row.jumlah) || 0;
      summary.total += jumlah;
      if (summary[row.action] != null) {
        summary[row.action] = jumlah;
      }
    }

    // Mode terbaru: satu halaman berisi LATEST_LIMIT kejadian terakhir.
    let limit;
    let page;
    let total;
    let totalPages;
    if (filtered) {
      limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), MAX_PAGE_LIMIT);
      const requestedPage = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total FROM web_activity_logs ${whereSql}`,
        params,
      );
      total = Number(countRows[0]?.total) || 0;
      totalPages = Math.max(1, Math.ceil(total / limit));
      page = Math.min(requestedPage, totalPages);
    } else {
      limit = LATEST_LIMIT;
      page = 1;
      total = summary.total;
      totalPages = 1;
    }
    const offset = (page - 1) * limit;

    const [rows] = await pool.query(
      `SELECT id, created_at, username, nama_lengkap, role, action, entity, subject, method, path,
              status, duration_ms, ip, browser, os, device, app, info_aktivitas, message, request_summary
       FROM web_activity_logs
       ${whereSql}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    // Daftar user unik untuk dropdown filter.
    const [userRows] = await pool.query(
      `SELECT username, MAX(nama_lengkap) AS nama_lengkap, MAX(role) AS role
       FROM web_activity_logs
       WHERE username IS NOT NULL AND username <> ''
       GROUP BY username
       ORDER BY username ASC
       LIMIT 100`,
    );

    res.json({
      data: rows.map((row) => ({
        id: Number(row.id),
        created_at: row.created_at,
        username: row.username || '-',
        nama_lengkap: row.nama_lengkap || row.username || '-',
        role: row.role || '-',
        action: row.action || 'akses',
        action_label: labelOf(row.action),
        entity: row.entity || '',
        subject: row.subject || '',
        method: row.method,
        path: row.path,
        status: row.status,
        status_kind: statusKind(row.status),
        duration_ms: row.duration_ms,
        ip: row.ip || '-',
        browser: row.browser || '',
        os: row.os || '',
        device: row.device || '',
        app: row.app || '',
        info_aktivitas: row.info_aktivitas || '',
        message: row.message || '',
        request_summary: row.request_summary || '',
      })),
      total,
      page,
      limit,
      total_pages: totalPages,
      mode: filtered ? 'filter' : 'terbaru',
      summary,
      users: userRows.map((row) => ({
        username: row.username,
        nama_lengkap: row.nama_lengkap || row.username,
        role: row.role || '-',
      })),
      actions: ACTIONS,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil log aplikasi',
      error: error.message,
    });
  }
});

module.exports = router;
