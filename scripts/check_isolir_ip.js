#!/usr/bin/env node
/**
 * Diagnosa pencocokan IP isolir ↔ radacct (jalankan di server billing).
 *
 *   node scripts/check_isolir_ip.js
 *   node scripts/check_isolir_ip.js 10.10.50.23
 */

const pool = require('../database');
const { findCustomerBySessionIp } = require('../backend/payment/resolve_customer_by_ip');
const { listActiveSessionIps } = require('../backend/payment/isolir_debug');

async function main() {
  const testIp = process.argv[2] || '';
  console.log('TRUST_PROXY =', process.env.TRUST_PROXY || '(tidak di-set, OK untuk tanpa Nginx)');
  console.log('--- Sesi PPP aktif (radacct) ---');
  const sessions = await listActiveSessionIps(pool, 50);
  if (sessions.length === 0) {
    console.log('(kosong) Tidak ada sesi dengan acctstoptime IS NULL.');
    console.log('Pastikan pelanggan PPP online dan FreeRADIUS menulis radacct.');
  } else {
    console.table(sessions.map((row) => ({
      ip: row.ip,
      username: row.username,
      pelanggan: row.pelanggan || '-',
      status: row.status || '-',
      login: row.acctstarttime,
    })));
  }

  if (testIp) {
    console.log(`\n--- Simulasi lookup IP: ${testIp} ---`);
    const result = await findCustomerBySessionIp(pool, testIp);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('\nTip: node scripts/check_isolir_ip.js <IP-pelanggan> untuk uji lookup.');
    console.log('Dari HP pelanggan isolir, buka /isolir lalu bandingkan IP di respons API /api/isolir/me');
  }

  await pool.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
