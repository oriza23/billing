const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { mountFrontend } = require('../backend/serve_frontend');

function makeDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>SPA</html>');
  fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  return dir;
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('dist belum ada: tidak ada yang dipasang', () => {
  const app = express();
  assert.equal(mountFrontend(app, path.join(os.tmpdir(), 'tidak-ada-dist')), false);
});

test('dist disajikan satu origin dengan API: halaman, fallback SPA, aset, dan API tetap terpisah', async () => {
  const app = express();
  app.get('/api/ping', (req, res) => res.json({ pong: true }));
  assert.equal(mountFrontend(app, makeDist()), true);

  await withServer(app, async (base) => {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.equal(await root.text(), '<html>SPA</html>');
    assert.equal(root.headers.get('cache-control'), 'no-cache');

    const deepLink = await fetch(`${base}/langganan/data`);
    assert.equal(deepLink.status, 200);
    assert.equal(await deepLink.text(), '<html>SPA</html>');

    const asset = await fetch(`${base}/assets/app-abc123.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control'), /immutable/);

    const api = await fetch(`${base}/api/ping`);
    assert.deepEqual(await api.json(), { pong: true });

    assert.equal((await fetch(`${base}/api/tidak-ada`)).status, 404, 'API yang tidak ada bukan HTML SPA');
    assert.equal((await fetch(`${base}/assets/hilang.js`)).status, 404, 'file yang tidak ada bukan HTML SPA');
    assert.equal((await fetch(`${base}/langganan/data`, { method: 'POST' })).status, 404);
  });
});
