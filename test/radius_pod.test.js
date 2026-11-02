const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const radius = require('radius');
const { kickRadiusUser, POD_PORT } = require('../utils/radius-pod');

const SECRET = 'rahasia-mikrotik';

function fakeMikrotik(handler) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const received = [];
    socket.on('message', (message, remote) => {
      const request = radius.decode({ packet: message, secret: SECRET });
      received.push(request);
      handler(request, (code, secret = SECRET) => {
        socket.send(radius.encode_response({ packet: request, code, secret }), remote.port, remote.address);
      });
    });
    socket.bind(0, '127.0.0.1', () => resolve({
      port: socket.address().port,
      received,
      close: () => new Promise((done) => socket.close(done)),
    }));
  });
}

test('port bawaan PoD adalah 3799', () => {
  assert.equal(POD_PORT, 3799);
});

test('mengirim Disconnect-Request dengan User-Name dan sukses saat Disconnect-ACK', async () => {
  const router = await fakeMikrotik((request, reply) => reply('Disconnect-ACK'));
  const result = await kickRadiusUser('budi@isp', '127.0.0.1', SECRET, { port: router.port });
  await router.close();

  assert.deepEqual(result, { ok: true, code: 'Disconnect-ACK' });
  assert.equal(router.received.length, 1);
  assert.equal(router.received[0].code, 'Disconnect-Request');
  assert.equal(router.received[0].attributes['User-Name'], 'budi@isp');
});

test('Disconnect-NAK dilaporkan gagal', async () => {
  const router = await fakeMikrotik((request, reply) => reply('Disconnect-NAK'));
  const result = await kickRadiusUser('budi@isp', '127.0.0.1', SECRET, { port: router.port });
  await router.close();

  assert.equal(result.ok, false);
  assert.equal(result.code, 'Disconnect-NAK');
});

test('router diam: timeout dan paket dikirim ulang', async () => {
  const router = await fakeMikrotik(() => {});
  const result = await kickRadiusUser('budi@isp', '127.0.0.1', SECRET, { port: router.port, timeoutMs: 80 });
  await router.close();

  assert.equal(result.ok, false);
  assert.match(result.error, /Timeout/);
  assert.equal(router.received.length, 2);
});

test('secret balasan salah ditolak; argumen kosong ditolak tanpa kirim paket', async () => {
  const router = await fakeMikrotik((request, reply) => reply('Disconnect-ACK', 'secret-lain'));
  const bad = await kickRadiusUser('budi@isp', '127.0.0.1', SECRET, { port: router.port });
  await router.close();
  assert.equal(bad.ok, false);

  assert.equal((await kickRadiusUser('', '10.0.0.1', SECRET)).ok, false);
  assert.equal((await kickRadiusUser('x', '', SECRET)).ok, false);
  assert.equal((await kickRadiusUser('x', '10.0.0.1', '')).ok, false);
});
