/**
 * Packet of Disconnect (PoD, RFC 5176) murni Node.js lewat paket `radius`.
 * Tidak butuh binary radclient maupun RouterOS API (8728): cukup UDP ke NAS port 3799.
 *
 * Prasyarat di MikroTik:
 *   /radius incoming set accept=yes port=3799
 *   - entri /radius service=ppp memakai address server yang SAMA dengan IP sumber paket ini
 *   - secret = secret RADIUS router (kolom routers.secret)
 *   - firewall input mengizinkan UDP 3799 dari server billing (idealnya lewat VPN)
 */

const dgram = require('dgram');
const radius = require('radius');

const COA_PORT = 3799;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_RETRIES = 1;

function isIpv4(value) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(String(value || ''))) {
    return false;
  }
  return String(value).split('.').every((octet) => Number(octet) <= 255);
}

function buildAttributes({ username, sessionId, framedIp, nasIp }) {
  const attributes = [['User-Name', username]];
  if (sessionId) {
    attributes.push(['Acct-Session-Id', String(sessionId)]);
  }
  if (isIpv4(framedIp)) {
    attributes.push(['Framed-IP-Address', framedIp]);
  }
  if (isIpv4(nasIp)) {
    attributes.push(['NAS-IP-Address', nasIp]);
  }
  return attributes;
}

/**
 * Kirim satu Disconnect-Request dan tunggu ACK/NAK.
 * Resolve selalu dengan objek (tidak throw): { ok, code, error? }.
 */
function sendDisconnectRequest({
  host,
  secret,
  username,
  sessionId,
  framedIp,
  nasIp,
  port = COA_PORT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
}) {
  return new Promise((resolve) => {
    if (!isIpv4(host) || !secret || !String(username || '').trim()) {
      resolve({ ok: false, error: 'host (IPv4), secret, dan username wajib diisi' });
      return;
    }

    let request;
    try {
      request = radius.encode({
        code: 'Disconnect-Request',
        secret,
        identifier: Math.floor(Math.random() * 256),
        attributes: buildAttributes({ username: String(username).trim(), sessionId, framedIp, nasIp }),
      });
    } catch (error) {
      resolve({ ok: false, error: `Gagal menyusun paket: ${error.message}` });
      return;
    }
    const requestId = request.readUInt8(1);

    const socket = dgram.createSocket('udp4');
    let attemptsLeft = retries + 1;
    let timer = null;
    let finished = false;

    function finish(result) {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    }

    function transmit() {
      attemptsLeft -= 1;
      socket.send(request, port, host, (error) => {
        if (error) {
          finish({ ok: false, error: `Gagal mengirim UDP: ${error.message}` });
        }
      });
      timer = setTimeout(() => {
        if (attemptsLeft > 0) {
          transmit();
        } else {
          finish({ ok: false, error: `Timeout: NAS ${host}:${port} tidak membalas` });
        }
      }, timeoutMs);
    }

    socket.on('error', (error) => finish({ ok: false, error: `Socket error: ${error.message}` }));

    socket.on('message', (message, remote) => {
      // Abaikan paket dari alamat lain atau dengan identifier yang tidak cocok.
      if (remote.address !== host || message.length < 20 || message.readUInt8(1) !== requestId) {
        return;
      }
      let valid;
      let decoded;
      try {
        valid = radius.verify_response({ request, response: message, secret });
        decoded = radius.decode({ packet: message, secret });
      } catch (error) {
        finish({ ok: false, error: `Balasan tidak valid: ${error.message}` });
        return;
      }
      if (!valid) {
        finish({ ok: false, error: 'Authenticator balasan tidak cocok (secret salah?)' });
        return;
      }
      if (decoded.code === 'Disconnect-ACK') {
        finish({ ok: true, code: decoded.code });
      } else {
        const cause = decoded.attributes?.['Error-Cause'];
        finish({
          ok: false,
          code: decoded.code,
          error: `${decoded.code}${cause ? ` (Error-Cause: ${cause})` : ''}`,
        });
      }
    });

    transmit();
  });
}

/**
 * Putus semua sesi aktif (radacct, acctstoptime IS NULL) milik username.
 * Kontrak sama dengan disconnectUser di backend/langganan_isolir.js:
 * { diputus, gagal } + rincian per sesi. Secret diambil dari router tempat sesi berjalan.
 */
async function disconnectUserRadius(db, username, options = {}) {
  const result = { diputus: 0, gagal: 0, detail: [] };
  if (!username) {
    return result;
  }
  const send = options.send || sendDisconnectRequest;

  const [sessions] = await db.execute(
    `SELECT nasipaddress, framedipaddress, acctsessionid
     FROM radacct WHERE username = ? AND acctstoptime IS NULL`,
    [username],
  );

  for (const session of sessions) {
    // eslint-disable-next-line no-await-in-loop
    const [routers] = await db.execute(
      'SELECT secret FROM routers WHERE ip_address = ? LIMIT 1',
      [session.nasipaddress],
    );
    const secret = routers[0]?.secret || '';
    if (!isIpv4(session.nasipaddress) || !secret) {
      result.gagal += 1;
      result.detail.push({ nas: session.nasipaddress, ok: false, error: 'Router/secret tidak dikenal' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const response = await send({
      host: session.nasipaddress,
      secret,
      username,
      sessionId: session.acctsessionid,
      framedIp: session.framedipaddress,
      ...options.request,
    });
    result.detail.push({ nas: session.nasipaddress, ...response });
    if (response.ok) {
      result.diputus += 1;
    } else {
      result.gagal += 1;
    }
  }
  return result;
}

module.exports = {
  COA_PORT,
  sendDisconnectRequest,
  disconnectUserRadius,
};
