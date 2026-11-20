const path = require('path');
const { Pool } = require('pg');
const loadEnv = require('./backend/load_env');
const {
  prepareQuery, wrapPgResult, mapPgError, ensureMysqlCompatFunctions,
} = require('./backend/pg_compat');

loadEnv(path.join(__dirname, '.env'));

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'oriza',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'orizabil',
  max: Number(process.env.DB_POOL_SIZE) || 10,
  idleTimeoutMillis: 30_000,
});

// Koneksi idle yang diputus server (mis. saat PostgreSQL di-restart dari menu zona waktu)
// memancarkan 'error' pada pool. Tanpa handler, Node menghentikan seluruh proses.
pool.on('error', (error) => {
  console.error('[database] koneksi idle terputus:', error.message);
});

async function runQuery(client, sql, params) {
  const { text, values } = prepareQuery(sql, params);
  try {
    const result = await client.query(text, values);
    return wrapPgResult(result);
  } catch (err) {
    throw mapPgError(err);
  }
}

function attachClientInterface(client) {
  // Simpan query asli milik pg. Tanpa ini runQuery memanggil client.query yang sudah
  // diganti di bawah, sehingga rekursi tanpa akhir (stack overflow) pada setiap query.
  const rawQuery = client.query;
  const rawRelease = client.release;
  const raw = { query: (text, values) => rawQuery.call(client, text, values) };

  client.query = async (sql, params) => runQuery(raw, sql, params);
  client.execute = client.query;

  client.beginTransaction = async () => {
    await client.query('BEGIN');
  };
  client.commit = async () => {
    await client.query('COMMIT');
  };
  client.rollback = async () => {
    await client.query('ROLLBACK');
  };

  // Client dikembalikan ke pool: lepas pembungkus agar pool.query tidak menerjemahkan SQL dua kali.
  client.release = (err) => {
    client.query = rawQuery;
    client.release = rawRelease;
    delete client.execute;
    delete client.beginTransaction;
    delete client.commit;
    delete client.rollback;
    return rawRelease.call(client, err);
  };

  return client;
}

pool.query = async (sql, params) => {
  const client = await pool.connect();
  try {
    return await runQuery(client, sql, params);
  } finally {
    client.release();
  }
};
pool.execute = pool.query;

pool.getConnection = async () => {
  const client = await pool.connect();
  return attachClientInterface(client);
};

pool.ensureCompat = async () => {
  const client = await pool.connect();
  try {
    await ensureMysqlCompatFunctions(client);
  } finally {
    client.release();
  }
};

module.exports = pool;