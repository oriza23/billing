const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_ROS_API_PORT,
  isIpv4,
  resolveRosConnectionOptions,
  apiCredentials,
} = require('../backend/pppoe_isolir/mikrotik_ros_api');

test('isIpv4 menolak host invalid', () => {
  assert.equal(isIpv4('not-an-ip'), false);
  assert.equal(isIpv4('256.1.1.1'), false);
  assert.equal(isIpv4('10.0.0.1'), true);
});

test('resolveRosConnectionOptions memakai port 8728 default', () => {
  const prevUser = process.env.MIKROTIK_API_USER;
  const prevPass = process.env.MIKROTIK_API_PASSWORD;
  const prevTls = process.env.MIKROTIK_API_TLS;
  process.env.MIKROTIK_API_USER = 'api';
  process.env.MIKROTIK_API_PASSWORD = 'secret';
  delete process.env.MIKROTIK_API_TLS;

  const opts = resolveRosConnectionOptions({ ip_address: '192.168.88.1' });
  assert.ok(opts);
  assert.equal(opts.port, DEFAULT_ROS_API_PORT);
  assert.equal(opts.host, '192.168.88.1');
  assert.equal(opts.user, 'api');
  assert.equal(opts.tls, undefined);

  process.env.MIKROTIK_API_USER = prevUser;
  process.env.MIKROTIK_API_PASSWORD = prevPass;
  if (prevTls === undefined) {
    delete process.env.MIKROTIK_API_TLS;
  } else {
    process.env.MIKROTIK_API_TLS = prevTls;
  }
});

test('resolveRosConnectionOptions null bila kredensial kosong', () => {
  const prevUser = process.env.MIKROTIK_API_USER;
  delete process.env.MIKROTIK_API_USER;
  assert.equal(resolveRosConnectionOptions({ ip_address: '10.0.0.1', api_user: '', api_password: '' }), null);
  if (prevUser !== undefined) {
    process.env.MIKROTIK_API_USER = prevUser;
  }
});

test('apiCredentials alias kompatibel', () => {
  const creds = apiCredentials({
    ip_address: '10.0.0.2',
    api_user: 'admin',
    api_password: 'x',
    api_port: 8728,
  });
  assert.equal(creds.user, 'admin');
  assert.equal(creds.port, 8728);
});
