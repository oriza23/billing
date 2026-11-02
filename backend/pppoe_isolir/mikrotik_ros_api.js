/**
 * Klien MikroTik RouterOS API (port 8728 / 8729 TLS) via node-routeros.
 * Kompatibel RouterOS v6 dan v7 (bukan REST).
 */

const { RouterOSAPI } = require('node-routeros');

const DEFAULT_ROS_API_PORT = 8728;
const DEFAULT_ROS_API_TLS_PORT = 8729;
const DEFAULT_TIMEOUT_MS = 12000;

function isIpv4(value) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(String(value || ''))) {
    return false;
  }
  return String(value).split('.').every((octet) => Number(octet) <= 255);
}

/**
 * Kredensial & opsi koneksi (DB routers.* atau env MIKROTIK_API_*).
 */
function resolveRosConnectionOptions(router) {
  const user = String(router?.api_user || process.env.MIKROTIK_API_USER || '').trim();
  const password = String(router?.api_password || process.env.MIKROTIK_API_PASSWORD || '');
  const host = String(router?.ip_address || '').trim();

  if (!user || !password || !isIpv4(host)) {
    return null;
  }

  const useTls = String(process.env.MIKROTIK_API_TLS || '') === '1';
  const port = Number(router?.api_port)
    || Number(process.env.MIKROTIK_API_PORT)
    || (useTls ? DEFAULT_ROS_API_TLS_PORT : DEFAULT_ROS_API_PORT);

  const timeout = Number(process.env.MIKROTIK_API_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const options = {
    host,
    user,
    password,
    port,
    timeout,
  };

  if (useTls) {
    options.tls = {
      rejectUnauthorized: process.env.MIKROTIK_API_INSECURE !== '1',
    };
  }

  return options;
}

/** @deprecated gunakan resolveRosConnectionOptions */
function apiCredentials(router) {
  const opts = resolveRosConnectionOptions(router);
  if (!opts) {
    return null;
  }
  return {
    user: opts.user,
    password: opts.password,
    port: opts.port,
    useTls: Boolean(opts.tls),
  };
}

function formatRosError(error) {
  if (!error) {
    return 'Kesalahan MikroTik API tidak diketahui';
  }
  if (typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

function createRosClient(options) {
  return new RouterOSAPI(options);
}

/**
 * Connect → jalankan callback(api) → close. Satu siklus per operasi (aman untuk cron/isolir).
 */
async function withRouterApi(router, callback) {
  const options = resolveRosConnectionOptions(router);
  if (!options) {
    const skipped = new Error('Kredensial atau IP router API tidak tersedia');
    skipped.skipped = true;
    throw skipped;
  }

  const api = createRosClient(options);
  await api.connect();
  try {
    return await callback(api);
  } finally {
    if (api.connected || api.connecting) {
      await api.close().catch(() => {});
    }
  }
}

function rosQueryFilter(field, value) {
  return `?${field}=${value}`;
}

/** /ppp/secret/print ?name=... */
async function printPppSecrets(api, username) {
  const rows = await api.write('/ppp/secret/print', [rosQueryFilter('name', username)]);
  return Array.isArray(rows) ? rows : [];
}

/** /ppp/secret/set =.id=*N =profile=... */
async function setPppSecretProfileById(api, secretId, profileName) {
  await api.write('/ppp/secret/set', [
    `=.id=${secretId}`,
    `=profile=${profileName}`,
  ]);
}

/** /ppp/active/print ?name=... */
async function printPppActive(api, username) {
  const rows = await api.write('/ppp/active/print', [rosQueryFilter('name', username)]);
  return Array.isArray(rows) ? rows : [];
}

/** /ppp/active/remove =.id=*N */
async function removePppActiveById(api, sessionId) {
  await api.write('/ppp/active/remove', [`=.id=${sessionId}`]);
}

/**
 * Set profil PPP secret berdasarkan nama user (CLI: /ppp secret set profile=...).
 */
async function setPppSecretProfileOnRouter(router, username, profileName) {
  if (!router || !username || !profileName) {
    return { ok: false, skipped: true, reason: 'Data router/username/profile kosong' };
  }

  try {
    const result = await withRouterApi(router, async (api) => {
      const secrets = await printPppSecrets(api, username);
      const secret = secrets.find((row) => String(row.name) === String(username));
      if (!secret?.['.id']) {
        return { ok: false, error: `PPP secret "${username}" tidak ditemukan di MikroTik` };
      }
      await setPppSecretProfileById(api, secret['.id'], profileName);
      return { ok: true, profile: profileName, secret_id: secret['.id'] };
    });
    return result;
  } catch (error) {
    if (error.skipped) {
      return { ok: false, skipped: true, reason: error.message };
    }
    return { ok: false, error: formatRosError(error) };
  }
}

/**
 * Kick: hapus semua /ppp/active dengan name=username (setara remove [find name=...]).
 */
async function removePppActiveByUsernameOnRouter(router, username) {
  if (!router || !username) {
    return { ok: false, skipped: true, removed: 0, gagal: 0, reason: 'Router/username kosong' };
  }

  try {
    const result = await withRouterApi(router, async (api) => {
      const sessions = await printPppActive(api, username);
      const matched = sessions.filter((row) => String(row.name) === String(username));

      let removed = 0;
      let gagal = 0;
      const errors = [];

      for (const session of matched) {
        if (!session['.id']) {
          gagal += 1;
          continue;
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          await removePppActiveById(api, session['.id']);
          removed += 1;
        } catch (removeError) {
          gagal += 1;
          errors.push(formatRosError(removeError));
        }
      }

      return {
        ok: gagal === 0,
        removed,
        gagal,
        errors,
      };
    });
    return result;
  } catch (error) {
    if (error.skipped) {
      return { ok: false, skipped: true, removed: 0, gagal: 0, reason: error.message };
    }
    return { ok: false, removed: 0, gagal: 1, error: formatRosError(error) };
  }
}

module.exports = {
  DEFAULT_ROS_API_PORT,
  DEFAULT_ROS_API_TLS_PORT,
  isIpv4,
  resolveRosConnectionOptions,
  apiCredentials,
  createRosClient,
  withRouterApi,
  printPppSecrets,
  setPppSecretProfileById,
  printPppActive,
  removePppActiveById,
  setPppSecretProfileOnRouter,
  removePppActiveByUsernameOnRouter,
  formatRosError,
};
