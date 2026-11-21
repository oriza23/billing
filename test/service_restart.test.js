const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const test = require('node:test');
const assert = require('node:assert/strict');

const { secret } = require('../backend/config/jwt');
const requireAuth = require('../backend/middleware/auth');
const restartRouter = require('../backend/routes/service_restart');
const {
  restartService, resetRestartLock, isAllowed, systemctlCommand, SUDOERS_HINT,
} = require('../backend/service_restart');

function sign(role) {
  return jwt.sign({ username: 'admin', role }, secret, { algorithm: 'HS256', expiresIn: '5m' });
}

test('whitelist hanya web, postgresql, dan freeradius', () => {
  for (const name of ['web', 'postgresql', 'freeradius']) {
    assert.equal(isAllowed(name), true, name);
  }
  for (const name of ['', 'nginx', 'postgresql;reboot', 'systemctl', 'billing', 'WEB']) {
    assert.equal(isAllowed(name), false, name);
  }
});

test('systemctl: root tanpa sudo, user biasa memakai sudo -n', () => {
  assert.equal(systemctlCommand('postgresql', true), 'systemctl restart postgresql');
  assert.equal(systemctlCommand('freeradius', true), 'systemctl restart freeradius');
  assert.equal(systemctlCommand('postgresql', false), 'sudo -n systemctl restart postgresql');
  assert.equal(systemctlCommand('freeradius', false), 'sudo -n systemctl restart freeradius');
});

test('postgresql dan freeradius hanya menjalankan systemctl restart unit itu', async () => {
  for (const [service, unit] of [['postgresql', 'postgresql'], ['freeradius', 'freeradius']]) {
    resetRestartLock();
    const calls = [];
    const result = await restartService(service, {
      root: false,
      exec: (command, _options, callback) => {
        calls.push(command);
        callback(null, '', '');
      },
    });
    assert.deepEqual(calls, [`sudo -n systemctl restart ${unit}`], service);
    assert.equal(result.deferred, false);
    assert.match(result.message, /berhasil di-restart/);
  }
  resetRestartLock();
  const asRoot = [];
  await restartService('postgresql', {
    root: true,
    exec: (command, _options, callback) => {
      asRoot.push(command);
      callback(null, '', '');
    },
  });
  assert.deepEqual(asRoot, ['systemctl restart postgresql']);
  resetRestartLock();
  await assert.rejects(
    () => restartService('nginx'),
    (error) => error.status === 400 && /tidak diizinkan/.test(error.message),
  );
});

test('sudo tanpa NOPASSWD mengembalikan pesan izin yang jelas', async () => {
  resetRestartLock();
  await assert.rejects(
    () => restartService('postgresql', {
      root: false,
      exec: (_command, _options, callback) => {
        const error = new Error('sudo: a password is required');
        callback(error, '', 'sudo: a terminal is required to read the password');
      },
    }),
    (error) => error.status === 403 && error.message === SUDOERS_HINT,
  );
  resetRestartLock();
});

test('web menjawab dulu, lalu pm2 restart billing tanpa sudo', async () => {
  resetRestartLock();
  process.env.name = 'billing';
  let started = null;
  try {
    const result = await restartService('web', {
      exec: (command, _options, callback) => {
        started = command;
        callback(null, '', '');
      },
    });
    assert.equal(result.deferred, true);
    assert.match(result.message, /sedang di-restart/);
    result.start();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(started, 'pm2 restart billing');
    assert.equal(String(started).includes('sudo'), false);
  } finally {
    delete process.env.name;
    resetRestartLock();
  }
});

test('endpoint menolak role selain administrator dan layanan di luar whitelist', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', requireAuth);
  app.use('/api/sistem', restartRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function post(token, body) {
    const response = await fetch(`${base}/api/sistem/restart-service`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  try {
    assert.equal((await post('', { service: 'postgresql' })).status, 401);
    const petugas = await post(sign('petugas'), { service: 'freeradius' });
    assert.equal(petugas.status, 403);
    const bad = await post(sign('admin'), { service: 'nginx' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /tidak diizinkan/);
    const superadmin = await post(sign('superadmin'), { service: 'reboot' });
    assert.equal(superadmin.status, 400);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
