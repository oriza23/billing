const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const WRITER = path.join(__dirname, '..', 'deploy', 'freeradius', 'write-sql-mod.js');

// Bentuk bawaan paket Debian/Ubuntu: dialect sqlite, driver null, dan server/port/login/password TERKOMENTAR.
const UBUNTU_DEFAULT = [
  'sql {',
  '\tdialect = "sqlite"',
  '\tdriver = "rlm_sql_null"',
  '#\tdriver = "rlm_sql_${dialect}"',
  '\tsqlite {',
  '\t\tfilename = "/tmp/freeradius.db"',
  '\t\tserver = "keep-me-in-subsection"',
  '\t}',
  '\t# Connection info:',
  '#\tserver = "localhost"',
  '#\tport = 3306',
  '#\tlogin = "radius"',
  '#\tpassword = "radpass"',
  '\tradius_db = "radius"',
  '\tacct_table1 = "radacct"',
  '\tpool {',
  '\t\tstart = ${thread[pool].start_servers}',
  '\t}',
  '\tread_clients = no',
  '\t$INCLUDE ${modconfdir}/${.:name}/main/${dialect}/queries.conf',
  '}',
  '',
].join('\n');

function setup(sqlText, envText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raniah-sqlmod-'));
  fs.mkdirSync(path.join(dir, 'raddb', 'mods-available'), { recursive: true });
  const sqlFile = path.join(dir, 'raddb', 'mods-available', 'sql');
  fs.writeFileSync(sqlFile, sqlText);
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, envText);
  return { dir, sqlFile, envFile, raddb: path.join(dir, 'raddb') };
}

function run(ctx) {
  return spawnSync(process.execPath, [WRITER, '--env', ctx.envFile, '--raddb', ctx.raddb], { encoding: 'utf8' });
}

const ENV = 'DB_USER=oriza\nDB_PASSWORD="Pass.w0rd!x"\nDB_NAME=orizabil\nDB_PORT=5433\n';

test('write-sql-mod: bawaan Ubuntu (kredensial terkomentar) menjadi aktif tepat sekali dari .env', () => {
  const ctx = setup(UBUNTU_DEFAULT, ENV);
  try {
    const result = run(ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Pass\.w0rd/, 'password tidak boleh dicetak');
    const out = fs.readFileSync(ctx.sqlFile, 'utf8');
    for (const [key, value] of Object.entries({
      driver: '"rlm_sql_postgresql"', dialect: '"postgresql"', server: '"127.0.0.1"', port: '5433',
      login: '"oriza"', password: '"Pass.w0rd!x"', radius_db: '"orizabil"', read_clients: 'yes', client_table: '"nas"',
    })) {
      const hits = out.split('\n').filter((l) => new RegExp(`^\\t${key} = `).test(l));
      assert.deepEqual(hits, [`\t${key} = ${value}`], key);
    }
    // Tepat satu $INCLUDE queries.conf aktif, dan berada setelah definisi parameter (variabel harus ada dulu).
    const lines = out.split('\n');
    const includes = lines.filter((l) => /^\t\$INCLUDE .*queries\.conf/.test(l));
    assert.equal(includes.length, 1);
    assert.ok(lines.indexOf(includes[0]) > lines.indexOf('\tacct_table1 = "radacct"'));
    // Sub-blok dan baris lain tidak disentuh.
    assert.match(out, /\t\tserver = "keep-me-in-subsection"/);
    assert.match(out, /start = \$\{thread\[pool\]\.start_servers\}/);
    // Backup bawaan dibuat sekali dan berisi aslinya.
    assert.equal(fs.readFileSync(`${ctx.sqlFile}.orig`, 'utf8'), UBUNTU_DEFAULT);
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('write-sql-mod: idempoten, juga saat .orig hilang, dan mengikuti perubahan .env', () => {
  const ctx = setup(UBUNTU_DEFAULT, ENV);
  try {
    assert.equal(run(ctx).status, 0);
    const first = fs.readFileSync(ctx.sqlFile, 'utf8');
    assert.equal(run(ctx).status, 0);
    assert.equal(fs.readFileSync(ctx.sqlFile, 'utf8'), first);
    fs.rmSync(`${ctx.sqlFile}.orig`);
    assert.equal(run(ctx).status, 0);
    assert.equal(fs.readFileSync(ctx.sqlFile, 'utf8'), first);
    assert.equal(fs.existsSync(`${ctx.sqlFile}.orig`), false, 'berkas terkelola tidak boleh disalin sebagai "bawaan"');
    fs.writeFileSync(ctx.envFile, ENV.replace('Pass.w0rd!x', 'Baru.Pass99').replace('5433', '5432'));
    assert.equal(run(ctx).status, 0);
    const changed = fs.readFileSync(ctx.sqlFile, 'utf8');
    assert.match(changed, /^\tpassword = "Baru\.Pass99"$/m);
    assert.match(changed, /^\tport = 5432$/m);
    assert.equal((changed.match(/^\tpassword = /gm) || []).length, 1);
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('write-sql-mod: DATABASE_URL dipakai bila DB_* tidak ada', () => {
  const ctx = setup(UBUNTU_DEFAULT, 'DATABASE_URL="postgresql://oriza:Pass.w0rd!x@127.0.0.1:5433/orizabil"\n');
  try {
    const result = run(ctx);
    assert.equal(result.status, 0, result.stderr);
    const out = fs.readFileSync(ctx.sqlFile, 'utf8');
    assert.match(out, /^\tserver = "127\.0\.0\.1"$/m);
    assert.match(out, /^\tport = 5433$/m);
    assert.match(out, /^\tlogin = "oriza"$/m);
    assert.match(out, /^\tpassword = "Pass\.w0rd!x"$/m);
    assert.match(out, /^\tradius_db = "orizabil"$/m);
    assert.match(out, /^\tdialect = "postgresql"$/m);
    assert.match(out, /^\tdriver = "rlm_sql_postgresql"$/m);
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('write-sql-mod: menolak password tidak aman dan .env tanpa kredensial (tidak menulis apa pun)', () => {
  for (const env of [
    'DB_USER=oriza\nDB_PASSWORD="ab$cdefgh"\nDB_NAME=orizabil\n',
    'DB_USER=oriza\nDB_PASSWORD="pendek"\nDB_NAME=orizabil\n',
    'DB_USER=oriza\nDB_NAME=orizabil\n',
    'DB_USER=bad-user\nDB_PASSWORD=Valid.Pass123\nDB_NAME=orizabil\n',
  ]) {
    const ctx = setup(UBUNTU_DEFAULT, env);
    try {
      const result = run(ctx);
      assert.notEqual(result.status, 0, env);
      assert.equal(fs.readFileSync(ctx.sqlFile, 'utf8'), UBUNTU_DEFAULT, 'berkas tidak boleh berubah');
    } finally {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  }
});
