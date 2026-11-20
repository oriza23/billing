const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const checks = require('../backend/health_checks');
const healthzRouter = require('../backend/routes/healthz');

const ONLINE = { status: 'Online', latency_ms: 1 };
const OFFLINE = { status: 'Offline', detail: 'timeout' };
const ORIGINAL = { db: checks.checkDatabase, radius: checks.checkRadius };

function stub(db, radius) {
  checks.checkDatabase = async () => db;
  checks.checkRadius = async () => radius;
}

async function withServer(fn) {
  const app = express();
  app.use('/healthz', healthzRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('publik: 200 tanpa detail saat semua Online', async () => {
  stub(ONLINE, ONLINE);
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { success: true, status: 'ok' });
  });
});

test('publik: 503 degraded bila database bermasalah, tanpa bocor detail', async () => {
  stub(OFFLINE, ONLINE);
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.deepEqual(body, { success: false, status: 'degraded' });
    assert.equal(body.database, undefined);
  });
});

test('detail hanya muncul dengan X-Health-Token yang cocok', async () => {
  const before = process.env.HEALTH_TOKEN;
  process.env.HEALTH_TOKEN = 'rahasia-monitoring';
  stub(ONLINE, OFFLINE);
  try {
    await withServer(async (base) => {
      const wrong = await fetch(`${base}/healthz`, { headers: { 'X-Health-Token': 'salah' } });
      assert.equal(wrong.status, 503);
      assert.equal((await wrong.json()).database, undefined);

      const right = await fetch(`${base}/healthz`, { headers: { 'X-Health-Token': 'rahasia-monitoring' } });
      assert.equal(right.status, 503);
      const body = await right.json();
      assert.equal(body.status, 'degraded');
      assert.equal(body.database.status, 'Online');
      assert.equal(body.radius.detail, 'timeout');
      assert.ok(body.checked_at);
    });
  } finally {
    if (before === undefined) {
      delete process.env.HEALTH_TOKEN;
    } else {
      process.env.HEALTH_TOKEN = before;
    }
  }
});

test('HEALTH_TOKEN kosong: header apa pun tetap tidak membuka detail', async () => {
  const before = process.env.HEALTH_TOKEN;
  delete process.env.HEALTH_TOKEN;
  stub(ONLINE, ONLINE);
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/healthz`, { headers: { 'X-Health-Token': '' } });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).database, undefined);
    });
  } finally {
    if (before !== undefined) {
      process.env.HEALTH_TOKEN = before;
    }
  }
});

test.after(() => {
  checks.checkDatabase = ORIGINAL.db;
  checks.checkRadius = ORIGINAL.radius;
});
