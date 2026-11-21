// Log aktivitas admin (audit trail) — "Log Aplikasi".
//
// Mencatat setiap aksi penting: LOGIN (berhasil/gagal) dan setiap request TULIS ke /api
// (POST/PUT/PATCH/DELETE = tambah/ubah/hapus). GET tidak dicatat karena terlalu ramai.
//
// Tiap baris disimpan lengkap supaya bisa diaudit: siapa (username + role), dari IP mana,
// dari aplikasi/perangkat apa (browser + OS diurai dari User-Agent), endpoint apa, hasilnya apa,
// dan kalimat "info aktivitas" yang mudah dibaca seperti tampilan Log Aplikasi.
//
// Sengaja fire-and-forget: kegagalan tulis log tidak boleh menggagalkan request aslinya.
const pool = require('../database');
const { resolveClientIp } = require('./client_ip');

const MAX_PATH = 255;
const MAX_MESSAGE = 300;
const MAX_SUMMARY = 255;
const MAX_UA = 255;
const MAX_VALUE = 40;
const MAX_FIELDS = 8;
const MAX_SUBJECT = 60;
const MAX_INFO = 500;

const APP_NAME = (process.env.APP_NAME || 'Sistem Billing').slice(0, 60);

// Field yang isinya rahasia: nilai ditulis sebagai "***".
const SECRET_FIELDS = /(password|secret|api_key|private_key|preshared|ovpn_config|token|pass|pin)/i;

// Endpoint yang responsnya berisi rahasia (keypair WireGuard) dan tidak perlu dicatat.
const SKIP_PATHS = [/^\/api\/sistem\/vpn\/wg\/keygen$/i];

// ---- Klasifikasi aksi & entitas -------------------------------------------
// Aturan path diperiksa lebih dulu (mis. Anda menghapus lewat POST /delete), baru jatuh ke metode HTTP.
const ACTION_BY_PATH = [
  { re: /^\/api\/auth\/login$/i, action: 'login' },
  { re: /^\/api\/sistem\/restart-service$/i, action: 'restart' },
  // Simpan konfigurasi & connect/disconnect VPN dicatat sebagai perubahan koneksi VPN.
  { re: /^\/api\/sistem\/vpn\/(?:save|action)$/i, action: 'edit' },
  // POST .../delete, /delete-massal, /hapus, /disconnect, /putus = hapus data.
  { re: /\/(?:delete|hapus)(?:$|[/-])/i, action: 'hapus' },
  { re: /\/(?:disconnect|putus)(?:$|[/-])/i, action: 'hapus' },
];
const ACTION_BY_METHOD = { POST: 'tambah', PUT: 'edit', PATCH: 'edit', DELETE: 'hapus' };

const ENTITY_BY_PATH = [
  [/^\/api\/langganan\/data/i, 'data langganan'],
  [/^\/api\/langganan\/profil/i, 'profil langganan'],
  [/^\/api\/langganan\/online/i, 'sesi langganan'],
  [/^\/api\/langganan\/isolir/i, 'isolir langganan'],
  [/^\/api\/hotspot/i, 'voucher hotspot'],
  [/^\/api\/admins/i, 'admin'],
  [/^\/api\/routers/i, 'router'],
  [/^\/api\/outlets/i, 'outlet'],
  [/^\/api\/wilayah/i, 'wilayah'],
  [/^\/api\/settings/i, 'pengaturan'],
  [/^\/api\/sistem\/restart-service$/i, 'layanan'],
  [/^\/api\/sistem\/vpn/i, 'koneksi VPN'],
  [/^\/api\/acs/i, 'perangkat ACS'],
  [/^\/api\/pelanggan/i, 'pelanggan'],
  [/^\/api\/users/i, 'user'],
  [/^\/api\/pppoe/i, 'akun PPPoE'],
];

const ACTION_VERB = {
  login: 'Login ke aplikasi',
  tambah: 'Menambah',
  edit: 'Mengubah',
  hapus: 'Menghapus',
  restart: 'Me-restart',
  akses: 'Mengakses',
};

// Kunci yang paling mungkin menjadi "nama objek" aksi, berurutan dari paling spesifik.
const SUBJECT_KEYS = [
  'nolayanan', 'username', 'pelanggan', 'nama', 'nama_outlet', 'nama_router', 'nama_profile',
  'kode_batch', 'nama_wilayah', 'deviceId', 'device_id', 'sn', 'email', 'service', 'protocol', 'id',
];

const ACTION_LABEL = {
  login: 'Login',
  tambah: 'Tambah',
  edit: 'Edit',
  hapus: 'Hapus',
  akses: 'Akses',
};

// ---- Parser User-Agent (tanpa dependensi) ---------------------------------
// Urutan penting: Edge/Opera memuat kata "Chrome", jadi diperiksa lebih dulu.
const BROWSER_RULES = [
  [/\bEdg[ea]?\/([\d.]+)/, 'Edge'],
  [/\bOPR\/([\d.]+)/, 'Opera'],
  [/\bOpera\/([\d.]+)/, 'Opera'],
  [/\bFirefox\/([\d.]+)/, 'Firefox'],
  [/\bChrome\/([\d.]+)/, 'Chrome'],
  [/Version\/([\d.]+).*Safari/, 'Safari'],
  [/\bSafari\/([\d.]+)/, 'Safari'],
];

const OS_RULES = [
  [/Windows NT 10/, 'Windows'],
  [/Windows NT 6\.3/, 'Windows 8.1'],
  [/Windows NT 6\.1/, 'Windows 7'],
  [/Windows NT/, 'Windows'],
  [/Android[ /]([\d.]+)?/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Mac OS X/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Ubuntu/, 'Ubuntu'],
  [/Linux/, 'Linux'],
];

function parseUserAgent(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) {
    return { browser: '', os: '', device: '' };
  }
  let browser = '';
  for (const [re, name] of BROWSER_RULES) {
    const match = re.exec(ua);
    if (match) {
      browser = match[1] ? `${name} ${String(match[1]).split('.')[0]}` : name;
      break;
    }
  }
  let os = '';
  for (const [re, name] of OS_RULES) {
    if (re.test(ua)) {
      os = name;
      break;
    }
  }
  let device = 'Desktop';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) {
    device = 'Mobile';
  } else if (/Tablet|iPad/i.test(ua)) {
    device = 'Tablet';
  } else if (/(curl|wget|node|axios|postman)/i.test(ua)) {
    device = 'API';
  }
  return { browser, os, device };
}

function classifyAction(method, path) {
  for (const rule of ACTION_BY_PATH) {
    if (rule.re.test(path)) {
      return rule.action;
    }
  }
  return ACTION_BY_METHOD[String(method || '').toUpperCase()] || 'akses';
}

function entityOf(path) {
  for (const [re, label] of ENTITY_BY_PATH) {
    if (re.test(path)) {
      return label;
    }
  }
  return 'data';
}

// ---- Peringkas body & hasil ----------------------------------------------
function summarizeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return '';
  }
  const keys = Object.keys(body).slice(0, MAX_FIELDS);
  const parts = [];
  for (const key of keys) {
    const value = body[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (SECRET_FIELDS.test(key)) {
      parts.push(`${key}=***`);
    } else if (typeof value === 'string') {
      parts.push(`${key}=${value.slice(0, MAX_VALUE)}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${value}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}=[${value.length}]`);
    } else {
      parts.push(`${key}={…}`);
    }
  }
  const extra = Object.keys(body).length - keys.length;
  if (extra > 0) {
    parts.push(`+${extra} lain`);
  }
  return parts.join(' ').slice(0, MAX_SUMMARY);
}

function summarizeResult(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const parts = [];
        if (typeof payload.message === 'string' && payload.message.trim()) {
    parts.push(payload.message.trim().slice(0, MAX_MESSAGE));
  }
  for (const key of ['total', 'berhasil', 'gagal', 'changed', 'count', 'updated']) {
    const value = payload[key];
    if (typeof value === 'number') {
      parts.push(`${key}=${value}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}=${value.length}`);
    }
  }
  if (payload.partial === true) {
    parts.push('sebagian');
  }
  if (typeof payload.wanPath === 'string' && payload.wanPath) {
    parts.push(`wanPath=${payload.wanPath.slice(0, 120)}`);
  }
  return parts.join(' • ').slice(0, MAX_MESSAGE);
}

// Nama objek yang dikenai aksi (mis. nolayanan/username/nama) dari body, params, atau respons.
function subjectOf(req, payload) {
  const sources = [req.body, req.params, payload];
  for (const key of SUBJECT_KEYS) {
    for (const source of sources) {
      const value = source && typeof source === 'object' ? source[key] : undefined;
      if (typeof value === 'string' && value.trim()) {
        return value.trim().slice(0, MAX_SUBJECT);
      }
      if (typeof value === 'number') {
        return String(value);
      }
    }
  }
  return '';
}

function composeInfo({ action, status, entity, subject, browser, os, message }) {
  if (action === 'login') {
    const verb = status >= 200 && status < 300 ? 'Berhasil login ke aplikasi' : 'Gagal login ke aplikasi';
    const platform = [browser, os].filter(Boolean).join(' · ') || 'Aplikasi Web';
    const suffix = verb.startsWith('Gagal') && message ? ` (${message})` : '';
    return `${verb} via ${APP_NAME} — ${platform}${suffix}`.slice(0, MAX_INFO);
  }
  const verb = ACTION_VERB[action] || ACTION_VERB.akses;
  const target = subject ? ` ${entity}: ${subject}` : ` ${entity}`;
  const failed = status >= 400 ? ' (gagal)' : '';
  const detail = !failed && message ? ` — ${message}` : '';
  return `${verb}${target}${failed}${detail}`.slice(0, MAX_INFO);
}

// ---- Tabel & penyimpanan --------------------------------------------------
async function ensureTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS web_activity_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      username VARCHAR(50) DEFAULT NULL,
      nama_lengkap VARCHAR(100) DEFAULT NULL,
      role VARCHAR(20) DEFAULT NULL,
      action VARCHAR(20) DEFAULT NULL,
      entity VARCHAR(60) DEFAULT NULL,
      subject VARCHAR(60) DEFAULT NULL,
      method VARCHAR(10) NOT NULL,
      path VARCHAR(255) NOT NULL,
      status INT DEFAULT NULL,
      duration_ms INT DEFAULT NULL,
      ip VARCHAR(64) DEFAULT NULL,
      user_agent VARCHAR(255) DEFAULT NULL,
      browser VARCHAR(60) DEFAULT NULL,
      os VARCHAR(60) DEFAULT NULL,
      device VARCHAR(20) DEFAULT NULL,
      app VARCHAR(60) DEFAULT NULL,
      info_aktivitas VARCHAR(500) DEFAULT NULL,
      message VARCHAR(300) DEFAULT NULL,
      request_summary VARCHAR(255) DEFAULT NULL,
      KEY idx_log_created (created_at),
      KEY idx_log_username (username),
      KEY idx_log_action (action)
    )`,
  );
  // Kolom tambahan bila tabel lebih dulu dibuat oleh versi sebelumnya (aman diulang).
  const columns = [
    'nama_lengkap VARCHAR(100) NULL',
    'action VARCHAR(20) NULL',
    'entity VARCHAR(60) NULL',
    'subject VARCHAR(60) NULL',
    'browser VARCHAR(60) NULL',
    'os VARCHAR(60) NULL',
    'device VARCHAR(20) NULL',
    'app VARCHAR(60) NULL',
    'info_aktivitas VARCHAR(500) NULL',
  ];
  for (const definition of columns) {
    // eslint-disable-next-line no-await-in-loop
    await pool.query(`ALTER TABLE web_activity_logs ADD COLUMN IF NOT EXISTS ${definition}`);
  }
  await backfillLegacy();
}

// Baris lama (dibuat versi sebelumnya) belum punya action/entity/info. Isi ulang dari method+path,
// dan lengkapi browser/OS dari user_agent yang tersimpan agar tampilannya seragam.
async function backfillLegacy() {
  try {
    const [rows] = await pool.query(
      `SELECT id, username, action, method, path, status, browser, os, user_agent, nama_lengkap, info_aktivitas
       FROM web_activity_logs
       WHERE action IS NULL OR info_aktivitas IS NULL OR browser IS NULL
       ORDER BY id ASC LIMIT 1000`,
    );
    for (const row of rows) {
      const ua = parseUserAgent(row.user_agent);
      const action = row.action || classifyAction(row.method, row.path);
      const entity = action === 'login' ? 'aplikasi' : entityOf(row.path);
      const browser = row.browser || ua.browser || null;
      const os = row.os || ua.os || null;
      const info = row.info_aktivitas || composeInfo({
        action,
        status: Number(row.status) || 0,
        entity,
        subject: '',
        browser: browser || '',
        os: os || '',
        message: '',
      });
      // eslint-disable-next-line no-await-in-loop
      await pool.execute(
        `UPDATE web_activity_logs
         SET action = ?, entity = ?, browser = ?, os = ?, device = COALESCE(device, ?),
             nama_lengkap = COALESCE(nama_lengkap, username), info_aktivitas = ?
         WHERE id = ?`,
        [action, entity, browser, os, ua.device || null, info, row.id],
      );
    }
  } catch (error) {
    console.warn(`[Log Aktivitas] backfill: ${error.message}`);
  }
}

function clientIp(req) {
  return resolveClientIp(req).slice(0, 64);
}

// Identitas pelaku dari JWT (route terproteksi) atau body (route login).
// Route login mengisi res.locals.logIdentity karena req.user belum ada di sana.
function actorOf(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const username = req.user?.username || body.username || '';
  const role = req.user?.role || '';
  const nama = req.user?.nama_lengkap || req.user?.nama || '';
  return {
    username: typeof username === 'string' && username ? username.slice(0, 50) : null,
    role: typeof role === 'string' && role ? role.slice(0, 20) : null,
    nama_lengkap: typeof nama === 'string' && nama ? nama.slice(0, 100) : null,
  };
}

async function write(req, res, durationMs) {
  const payload = res.locals?.logPayload;
  const identity = res.locals?.logIdentity || {};
  const path = String(req.originalUrl || req.url || '').split('?')[0].slice(0, MAX_PATH);
  const status = Number.isInteger(res.statusCode) ? res.statusCode : null;
  const actor = actorOf(req);
  const username = actor.username || (typeof identity.username === 'string' ? identity.username.slice(0, 50) : null);
  const role = actor.role || (typeof identity.role === 'string' ? identity.role.slice(0, 20) : null);
  const namaLengkap = actor.nama_lengkap
    || (typeof identity.nama_lengkap === 'string' ? identity.nama_lengkap.slice(0, 100) : null);
  const action = classifyAction(req.method, path);
  const entity = action === 'login' ? 'aplikasi' : entityOf(path);
  const subject = action === 'login' ? '' : subjectOf(req, payload);
  const userAgent = String(req.headers['user-agent'] || '');
  const { browser, os, device } = parseUserAgent(userAgent);
  const message = summarizeResult(payload);

  const info = composeInfo({
    action, status: status ?? 0, entity, subject, browser, os, message,
  });

  try {
    await pool.execute(
      `INSERT INTO web_activity_logs
        (username, nama_lengkap, role, action, entity, subject, method, path, status, duration_ms,
         ip, user_agent, browser, os, device, app, info_aktivitas, message, request_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        username,
        namaLengkap || username,
        role,
        action,
        entity,
        subject || null,
        String(req.method || '').slice(0, 10),
        path,
        status,
        Math.max(0, Math.round(durationMs)),
        clientIp(req),
        userAgent.slice(0, MAX_UA),
        browser || null,
        os || null,
        device || null,
        APP_NAME,
        info,
        message || null,
        summarizeRequest(req.body) || null,
      ],
    );
  } catch (error) {
    // Tabel bisa belum siap (server baru start) — jangan ganggu request aslinya.
    console.warn(`[Log Aktivitas] ${req.method} ${path}: ${error.message}`);
  }
}

// Middleware: pasang sekali pada prefix yang ingin dicatat (biasanya '/api').
function activityLogger({ includeReads = false } = {}) {
  return function activityLog(req, res, next) {
    if (!includeReads && req.method === 'GET') {
      return next();
    }
    if (SKIP_PATHS.some((re) => re.test(String(req.originalUrl || req.url || '').split('?')[0]))) {
      return next();
    }
    const started = Date.now();
    const originalJson = res.json.bind(res);
    // Payload disimpan sebentar untuk diringkas; tidak mengubah nilai yang dikirim ke klien.
    res.json = (payload) => {
      res.locals.logPayload = payload;
      return originalJson(payload);
    };
    res.on('finish', () => {
      void write(req, res, Date.now() - started);
    });
    return next();
  };
}

module.exports = {
  ensureTable,
  activityLogger,
  backfillLegacy,
  summarizeRequest,
  summarizeResult,
  parseUserAgent,
  classifyAction,
  entityOf,
  composeInfo,
  ACTION_LABEL,
  APP_NAME,
  MAX_PATH,
};
