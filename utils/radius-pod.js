/**
 * Packet of Disconnect (RFC 5176) ke MikroTik: dgram (UDP) + paket `radius`.
 * Tidak memakai RouterOS API (8728).
 *
 * MikroTik: /radius incoming set accept=yes port=3799, dan secret harus sama
 * dengan secret RADIUS router.
 */

const dgram = require('dgram'); // bawaan Node.js (UDP)
// Modul eksternal. Jika belum terpasang, jalankan: npm install radius
const radius = require('radius');

const POD_PORT = 3799;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_RETRIES = 1;

/**
 * Kirim Disconnect-Request untuk username ke MikroTik dan tunggu balasannya.
 * Socket selalu ditutup (balasan, timeout, atau error). Tidak pernah throw:
 * resolve { ok, code?, error? }.
 *
 * @param {string} username      nilai atribut User-Name
 * @param {string} mikrotikIp    IPv4 router (NAS)
 * @param {string} radiusSecret  shared secret RADIUS router
 * @param {{ port?: number, timeoutMs?: number, retries?: number }} [options]
 */
const kickRadiusUser = async (username, mikrotikIp, radiusSecret, options = {}) => {
  const {
    port = POD_PORT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
  } = options;

  return new Promise((resolve) => {
    const user = String(username || '').trim();
    if (!user || !mikrotikIp || !radiusSecret) {
      resolve({ ok: false, error: 'username, mikrotikIp, dan radiusSecret wajib diisi' });
      return;
    }

    let packet;
    try {
      packet = radius.encode({
        code: 'Disconnect-Request',
        secret: radiusSecret,
        attributes: [['User-Name', user]],
      });
    } catch (error) {
      resolve({ ok: false, error: `Gagal menyusun paket: ${error.message}` });
      return;
    }
    const identifier = packet.readUInt8(1);

    const socket = dgram.createSocket('udp4');
    let attemptsLeft = retries + 1;
    let timer = null;
    let done = false;

    function finish(result) {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    }

    function send() {
      attemptsLeft -= 1;
      socket.send(packet, port, mikrotikIp, (error) => {
        if (error) {
          finish({ ok: false, error: `Gagal mengirim UDP: ${error.message}` });
        }
      });
      timer = setTimeout(() => {
        if (attemptsLeft > 0) {
          send();
        } else {
          finish({ ok: false, error: `Timeout: ${mikrotikIp}:${port} tidak membalas` });
        }
      }, timeoutMs);
    }

    socket.on('error', (error) => finish({ ok: false, error: `Socket error: ${error.message}` }));

    socket.on('message', (message, remote) => {
      // Hanya balasan dari router yang dituju dan untuk paket ini.
      if (remote.address !== mikrotikIp || message.length < 20 || message.readUInt8(1) !== identifier) {
        return;
      }
      try {
        if (!radius.verify_response({ request: packet, response: message, secret: radiusSecret })) {
          finish({ ok: false, error: 'Authenticator balasan tidak cocok (secret salah?)' });
          return;
        }
        const reply = radius.decode({ packet: message, secret: radiusSecret });
        if (reply.code === 'Disconnect-ACK') {
          finish({ ok: true, code: reply.code });
        } else {
          const cause = reply.attributes?.['Error-Cause'];
          finish({
            ok: false,
            code: reply.code,
            error: `${reply.code}${cause ? ` (Error-Cause: ${cause})` : ''}`,
          });
        }
      } catch (error) {
        finish({ ok: false, error: `Balasan tidak valid: ${error.message}` });
      }
    });

    send();
  });
};

module.exports = { kickRadiusUser, POD_PORT };
