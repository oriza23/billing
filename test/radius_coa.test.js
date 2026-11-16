const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const radius = require('radius');
const { sendDisconnectRequest, disconnectUserRadius } = require('../utils/radius_coa');

const SECRET = 'rahasia-nas';

// NAS palsu di loopback. handler(request, reply) menentukan balasan; tanpa balasan = timeout.
function startFakeNas(handler) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const received = [];
    socket.on('message', (message, remote) => {
      const request = radius.decode({ packet: message, secret: SECRET });
      received.push(request);
      handler(request, (code, secret = SECRET, attributes = []) => {
        const reply = radius.encode_response({ packet: request, code, secret, attributes });
        socket.send(reply, remote.port, remote.address);
      });
    });
    socket.bind(0, '127.0.0.1', () => {
      resolve({
        port: socket.address().port,
        received,
        close: () => new Promise((done) => socket.close(done)),
      });
    });
  });
}

test('PoD diterima NAS dengan atribut benar dan dibalas Disconnect-ACK', async () => {
  const nas = await startFakeNas((request, reply) => reply('Disconnect-ACK'));
  const result = await sendDisconnectRequest({
    host: '127.0.0.1', port: nas.port, secret: SECRET, username: 'budi@isp', sessionId: 'abc123', framedIp: '10.10.0.5',
  });
  await nas.close();

  assert.equal(result.ok, true);
  assert.equal(result.code, 'Disconnect-ACK');
  assert.equal(nas.received.length, 1);
  assert.equal(nas.received[0].code, 'Disconnect-Request');
  assert.equal(nas.received[0].attributes['User-Name'], 'budi@isp');
  assert.equal(nas.received[0].attributes['Acct-Session-Id'], 'abc123');
  assert.equal(nas.received[0].attributes['Framed-IP-Address'], '10.10.0.5');
});

test('Disconnect-NAK dilaporkan sebagai gagal beserta Error-Cause', async () => {
  const nas = await startFakeNas((request, reply) => reply('Disconnect-NAK', SECRET, [['Error-Cause', 503]]));
  const result = await sendDisconnectRequest({ host: '127.0.0.1', port: nas.port, secret: SECRET, username: 'budi@isp' });
  await nas.close();

  assert.equal(result.ok, false);
  assert.equal(result.code, 'Disconnect-NAK');
  assert.match(result.error, /Disconnect-NAK/);
});

test('NAS diam: timeout setelah percobaan ulang dengan paket yang sama', async () => {
  const nas = await startFakeNas(() => {});
  const result = await sendDisconnectRequest({
    host: '127.0.0.1', port: nas.port, secret: SECRET, username: 'budi@isp', timeoutMs: 80, retries: 1,
  });
  await nas.close();

  assert.equal(result.ok, false);
  assert.match(result.error, /Timeout/);
  assert.equal(nas.received.length, 2, '1 kirim awal + 1 percobaan ulang');
  assert.equal(nas.received[0].identifier, nas.received[1].identifier);
});

test('balasan bertanda tangan secret lain ditolak', async () => {
  const nas = await startFakeNas((request, reply) => reply('Disconnect-ACK', 'secret-lain'));
  const result = await sendDisconnectRequest({ host: '127.0.0.1', port: nas.port, secret: SECRET, username: 'budi@isp' });
  await nas.close();

  assert.equal(result.ok, false);
  assert.match(result.error, /Authenticator|tidak valid/i);
});

test('argumen tidak valid ditolak tanpa mengirim paket', async () => {
  assert.equal((await sendDisconnectRequest({ host: 'bukan-ip', secret: SECRET, username: 'x' })).ok, false);
  assert.equal((await sendDisconnectRequest({ host: '10.0.0.1', secret: '', username: 'x' })).ok, false);
  assert.equal((await sendDisconnectRequest({ host: '10.0.0.1', secret: SECRET, username: ' ' })).ok, false);
});

test('disconnectUserRadius: satu PoD per sesi aktif, router tak dikenal dihitung gagal', async () => {
  const db = {
    async execute(sql, params) {
      if (/FROM radacct/.test(sql)) {
        return [[
          { nasipaddress: '10.0.0.1', framedipaddress: '172.16.0.2', acctsessionid: 's1' },
          { nasipaddress: '10.9.9.9', framedipaddress: '172.16.0.3', acctsessionid: 's2' },
        ]];
      }
      return [params[0] === '10.0.0.1' ? [{ secret: SECRET }] : []];
    },
  };
  const sent = [];
  const send = async (args) => { sent.push(args); return { ok: true, code: 'Disconnect-ACK' }; };

  const result = await disconnectUserRadius(db, 'budi@isp', { send });

  assert.equal(result.diputus, 1);
  assert.equal(result.gagal, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].host, '10.0.0.1');
  assert.equal(sent[0].sessionId, 's1');
});
