/**
 * Pengaturan Payment Gateway (JSON di app_settings.setting_key = payment_gateway_config).
 * QRIS string juga disinkronkan ke qris_static_payload agar portal isolir lama tetap jalan.
 */

const pool = require('../../database');
const { QRIS_STATIC_KEY } = require('./schema');

const PAYMENT_SETTINGS_KEY = 'payment_gateway_config';
const ACTIVE_GATEWAYS = new Set(['tripay', 'qris']);
const TRIPAY_ENV = new Set(['sandbox', 'production']);

const DEFAULT_PAYMENT_SETTINGS = {
  active_gateway: 'qris',
  tripay: {
    merchant_code: '',
    api_key: '',
    private_key: '',
    environment: 'sandbox',
  },
  qris: {
    qris_string: '',
    qris_image_url: '',
    qris_fee_nontunai: null,
  },
};

function deepMerge(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const val = patch[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      out[key] = deepMerge(base[key] || {}, val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function normalizeSettings(raw) {
  const merged = deepMerge(DEFAULT_PAYMENT_SETTINGS, raw && typeof raw === 'object' ? raw : {});
  if (!ACTIVE_GATEWAYS.has(merged.active_gateway)) {
    merged.active_gateway = 'qris';
  }
  if (!TRIPAY_ENV.has(merged.tripay.environment)) {
    merged.tripay.environment = 'sandbox';
  }
  const fee = merged.qris.qris_fee_nontunai;
  if (fee === '' || fee === undefined) {
    merged.qris.qris_fee_nontunai = null;
  } else if (fee != null) {
    const n = Number(fee);
    merged.qris.qris_fee_nontunai = Number.isFinite(n) && n >= 0 ? n : null;
  }
  merged.tripay.merchant_code = String(merged.tripay.merchant_code || '').trim();
  merged.tripay.api_key = String(merged.tripay.api_key || '').trim();
  merged.tripay.private_key = String(merged.tripay.private_key || '').trim();
  merged.qris.qris_string = String(merged.qris.qris_string || '').trim();
  merged.qris.qris_image_url = String(merged.qris.qris_image_url || '').trim();
  return merged;
}

async function readPaymentSettings(db = pool) {
  const [rows] = await db.execute(
    'SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1',
    [PAYMENT_SETTINGS_KEY],
  );
  if (rows[0]?.setting_value) {
    try {
      return normalizeSettings(JSON.parse(rows[0].setting_value));
    } catch {
      // JSON rusak: bangun ulang dari default + legacy QRIS.
    }
  }

  const [legacy] = await db.execute(
    'SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1',
    [QRIS_STATIC_KEY],
  );
  const legacyQris = String(legacy[0]?.setting_value || process.env.QRIS_STATIC_PAYLOAD || '').trim();
  return normalizeSettings(
    legacyQris ? { qris: { qris_string: legacyQris } } : {},
  );
}

async function writePaymentSettings(settings, db = pool) {
  const normalized = normalizeSettings(settings);
  const json = JSON.stringify(normalized);
  await db.execute(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [PAYMENT_SETTINGS_KEY, json],
  );
  if (normalized.qris.qris_string) {
    await db.execute(
      `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [QRIS_STATIC_KEY, normalized.qris.qris_string],
    );
  }
  return normalized;
}

/**
 * Gabungkan input POST (multipart/text) ke pengaturan yang ada.
 * Field secret kosong = pertahankan nilai lama (admin tidak wajib ketik ulang API key).
 */
async function applyPaymentSettingsUpdate(body, { qrisImageUrl } = {}, db = pool) {
  const current = await readPaymentSettings(db);
  const patch = { tripay: {
      merchant_code: body.tripay_merchant_code ?? body.merchant_code,
      environment: body.tripay_environment ?? body.environment,
    },
    qris: {
      qris_string: body.qris_string,
      qris_fee_nontunai: body.qris_fee_nontunai,
    },
  };

  const apiKey = body.tripay_api_key ?? body.api_key;
  const privateKey = body.tripay_private_key ?? body.private_key;
  if (apiKey != null && String(apiKey).trim() !== '') {
    patch.tripay.api_key = String(apiKey).trim();
  }
  if (privateKey != null && String(privateKey).trim() !== '') {
    patch.tripay.private_key = String(privateKey).trim();
  }

  if (qrisImageUrl) {
    patch.qris.qris_image_url = qrisImageUrl;
  } else if (body.qris_image_url != null && String(body.qris_image_url).trim() !== '') {
    patch.qris.qris_image_url = String(body.qris_image_url).trim();
  }

  if (body.active_gateway != null && String(body.active_gateway).trim() !== '') {
    const gw = String(body.active_gateway).trim().toLowerCase();
    if (!ACTIVE_GATEWAYS.has(gw)) {
      const err = new Error('active_gateway harus tripay atau qris');
      err.statusCode = 400;
      throw err;
    }
    patch.active_gateway = gw;
  }

  const merged = normalizeSettings(deepMerge(current, patch));
  if (body.tripay_environment != null || body.environment != null) {
    const env = String(body.tripay_environment ?? body.environment ?? '').trim().toLowerCase();
    if (env && !TRIPAY_ENV.has(env)) {
      const err = new Error('environment Tripay harus sandbox atau production');
      err.statusCode = 400;
      throw err;
    }
  }

  return writePaymentSettings(merged, db);
}

/** Respons API (admin): tripay secrets ditandai configured, tidak dikirim utuh. */
function toAdminResponse(settings) {
  const s = normalizeSettings(settings);
  return {
    active_gateway: s.active_gateway,
    tripay: {
      merchant_code: s.tripay.merchant_code,
      environment: s.tripay.environment,
      api_key_configured: Boolean(s.tripay.api_key),
      api_key_preview: s.tripay.api_key ? `••••${s.tripay.api_key.slice(-4)}` : '',
      private_key_configured: Boolean(s.tripay.private_key),
      private_key_preview: s.tripay.private_key ? `••••${s.tripay.private_key.slice(-4)}` : '',
    },
    qris: { ...s.qris },
  };
}

/** Untuk edit form: kirim secret penuh hanya bila ?include_secrets=1 */
function toAdminResponseDetailed(settings, includeSecrets) {
  const base = toAdminResponse(settings);
  if (includeSecrets) {
    base.tripay.api_key = settings.tripay.api_key;
    base.tripay.private_key = settings.tripay.private_key;
    delete base.tripay.api_key_preview;
    delete base.tripay.private_key_preview;
  }
  return base;
}

module.exports = {
  PAYMENT_SETTINGS_KEY,
  DEFAULT_PAYMENT_SETTINGS,
  ACTIVE_GATEWAYS,
  TRIPAY_ENV,
  readPaymentSettings,
  writePaymentSettings,
  applyPaymentSettingsUpdate,
  toAdminResponse,
  toAdminResponseDetailed,
  normalizeSettings,
};
