const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const securityHeaders = require('../backend/security_headers');

async function withServer(fn) {
  const app = express();
  app.use(securityHeaders);
  app.get('/ok', (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('header keamanan dasar terkirim pada respons biasa', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/ok`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(res.headers.get('permissions-policy'), 'geolocation=(self), microphone=(), camera=()');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(res.headers.get('content-security-policy'), /tile\.openstreetmap\.org/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });
});

test('HSTS tidak dikirim pada HTTP polos, dikirim bila X-Forwarded-Proto https', async () => {
  await withServer(async (base) => {
    const plain = await fetch(`${base}/ok`);
    assert.equal(plain.headers.get('strict-transport-security'), null);

    const proxied = await fetch(`${base}/ok`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(proxied.headers.get('strict-transport-security'), /max-age=15552000/);
  });
});

test('isHttps menerima req.secure maupun header proxy berantai', () => {
  assert.equal(securityHeaders.isHttps({ secure: true, headers: {} }), true);
  assert.equal(securityHeaders.isHttps({ secure: false, headers: { 'x-forwarded-proto': 'https, http' } }), true);
  assert.equal(securityHeaders.isHttps({ secure: false, headers: { 'x-forwarded-proto': 'http' } }), false);
  assert.equal(securityHeaders.isHttps({ secure: false, headers: {} }), false);
});
