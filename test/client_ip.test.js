const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveClientIp, normalizeIp, isLoopback } = require('../backend/payment/client_ip');

function fakeReq({ ip, remoteAddress, headers = {}, trustEnv } = {}) {
  const prev = process.env.TRUST_PROXY;
  if (trustEnv !== undefined) {
    process.env.TRUST_PROXY = trustEnv;
  }
  return {
    ip,
    socket: { remoteAddress },
    headers,
    _restore() {
      if (trustEnv !== undefined) {
        if (prev === undefined) {
          delete process.env.TRUST_PROXY;
        } else {
          process.env.TRUST_PROXY = prev;
        }
      }
    },
  };
}

test('normalizeIp: ::ffff: dan ::1', () => {
  assert.equal(normalizeIp('::ffff:103.172.122.64'), '103.172.122.64');
  assert.equal(normalizeIp('::1'), '127.0.0.1');
});

test('resolveClientIp: TRUST_PROXY + X-Forwarded-For', () => {
  const req = fakeReq({
    ip: '127.0.0.1',
    headers: { 'x-forwarded-for': '103.172.122.64, 10.0.0.1' },
    trustEnv: '1',
  });
  try {
    assert.equal(resolveClientIp(req), '103.172.122.64');
  } finally {
    req._restore();
  }
});

test('resolveClientIp: tanpa TRUST_PROXY tetapi peer loopback + X-Forwarded-For (Nginx lokal)', () => {
  const req = fakeReq({
    ip: '127.0.0.1',
    headers: { 'x-forwarded-for': '114.122.167.157' },
    trustEnv: '',
  });
  try {
    assert.equal(resolveClientIp(req), '114.122.167.157');
  } finally {
    req._restore();
  }
});

test('resolveClientIp: koneksi langsung tanpa header proxy', () => {
  const req = fakeReq({
    ip: '::ffff:192.168.69.100',
    trustEnv: '',
  });
  try {
    assert.equal(resolveClientIp(req), '192.168.69.100');
  } finally {
    req._restore();
  }
});

test('isLoopback mengenali 127.0.0.1', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('103.1.1.1'), false);
});
