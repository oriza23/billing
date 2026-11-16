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
  client.query = async (sql, params) => runQuery(client, sql, params);
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

  const release = client.release.bind(client);
  client.release = () => {
    release();
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