/**
 * Helper MikroTik RouterOS API (port 8728) — node-routeros.
 * Satu koneksi per operasi; selalu di-close di finally.
 */

const { RouterOSAPI } = require('node-routeros');

const ROUTEROS_API_PORT = 8728;
const DEFAULT_TIMEOUT_MS = 12000;
const ISOLIR_PROFILE = 'profil_isolir';

function normalizeError(error) {
  if (!error) {
    return 'Kesalahan MikroTik API tidak diketahui';
  }
  const message = String(error.message || error).trim();
  if (/timed?\s*out|timeout|ETIMEDOUT|ECONNABORTED/i.test(message)) {
    return 'Timeout koneksi MikroTik API';
  }
  return message || 'Kesalahan MikroTik API tidak diketahui';
}

function assertConnectionArgs(host, user, pass) {
  if (!String(host || '').trim()) {
    throw new Error('Host router wajib diisi');
  }
  if (!String(user || '').trim()) {
    throw new Error('User API wajib diisi');
  }
  if (pass === undefined || pass === null) {
    throw new Error('Password API wajib diisi');
  }
}

function assertArgs(host, user, pass, pppoeUsername) {
  assertConnectionArgs(host, user, pass);
  if (!String(pppoeUsername || '').trim()) {
    throw new Error('Username PPPoE wajib diisi');
  }
}

function buildClient(host, user, pass) {
  const timeout = Number(process.env.MIKROTIK_API_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  return new RouterOSAPI({
    host: String(host).trim(),
    user: String(user).trim(),
    password: String(pass),
    port: ROUTEROS_API_PORT,
    timeout,
  });
}

async function closeClient(api) {
  if (!api) {
    return;
  }
  try {
    if (api.connected || api.connecting) {
      await api.close();
    }
  } catch {
    // Abaikan error saat menutup socket agar tidak menutupi hasil operasi utama.
  }
}

/**
 * Connect → jalankan fn(api) → close (finally).
 */
async function withRouterConnection(host, user, pass, fn) {
  assertConnectionArgs(host, user, pass);
  const api = buildClient(host, user, pass);
  try {
    await api.connect();
    return await fn(api);
  } finally {
    await closeClient(api);
  }
}

/**
 * /ppp/secret/set profile=<profileName> untuk name=pppoeUsername.
 */
async function setPppProfile(host, user, pass, pppoeUsername, profileName) {
  try {
    assertArgs(host, user, pass, pppoeUsername);
    const username = String(pppoeUsername).trim();
    const profile = String(profileName || '').trim();
    if (!profile) {
      return { ok: false, error: 'Nama profil PPP wajib diisi' };
    }

    const result = await withRouterConnection(host, user, pass, async (api) => {
      const secrets = await api.write('/ppp/secret/print', [`?name=${username}`]);
      const rows = Array.isArray(secrets) ? secrets : [];
      const secret = rows.find((row) => String(row.name) === username);

      if (!secret?.['.id']) {
        return {
          ok: false,
          error: `PPP secret "${username}" tidak ditemukan`,
        };
      }

      await api.write('/ppp/secret/set', [
        `=.id=${secret['.id']}`,
        `=profile=${profile}`,
      ]);

      return {
        ok: true,
        username,
        profile,
        secret_id: secret['.id'],
      };
    });

    return result;
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

/** @alias setPppProfile dengan profil isolir bawaan */
async function setIsolir(host, user, pass, pppoeUsername) {
  return setPppProfile(host, user, pass, pppoeUsername, ISOLIR_PROFILE);
}

/**
 * /ppp/active/remove untuk semua sesi name=pppoeUsername (kick / redial).
 */
async function kickSession(host, user, pass, pppoeUsername) {
  try {
    assertArgs(host, user, pass, pppoeUsername);
    const username = String(pppoeUsername).trim();

    const result = await withRouterConnection(host, user, pass, async (api) => {
      const active = await api.write('/ppp/active/print', [`?name=${username}`]);
      const rows = (Array.isArray(active) ? active : []).filter(
        (row) => String(row.name) === username,
      );

      let removed = 0;
      const errors = [];

      for (const session of rows) {
        if (!session['.id']) {
          errors.push('Sesi aktif tanpa .id');
          continue;
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          await api.write('/ppp/active/remove', [`=.id=${session['.id']}`]);
          removed += 1;
        } catch (removeError) {
          errors.push(normalizeError(removeError));
        }
      }

      return {
        ok: errors.length === 0,
        username,
        removed,
        gagal: errors.length,
        errors,
      };
    });

    return result;
  } catch (error) {
    return { ok: false, removed: 0, gagal: 1, error: normalizeError(error) };
  }
}

module.exports = {
  ROUTEROS_API_PORT,
  DEFAULT_TIMEOUT_MS,
  ISOLIR_PROFILE,
  setPppProfile,
  setIsolir,
  kickSession,
};
