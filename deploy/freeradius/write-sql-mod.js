#!/usr/bin/env node
'use strict';
/**
 * Tulis ${RADDB}/mods-available/sql secara deterministik dari .env (sumber kebenaran tunggal).
 *
 * Kenapa bukan sed: pada paket Debian/Ubuntu, server/port/login/password di blok `sql { }` bawaan
 * TERKOMENTAR ("#<tab>server = ...") dan dialect/driver bawaan adalah sqlite/rlm_sql_null. Substitusi
 * teks yang hanya menyentuh baris aktif tidak mengubah apa pun, sehingga FreeRADIUS jatuh ke default
 * (login = OS user "freerad") dan gagal dengan: FATAL: role "freerad" does not exist.
 *
 * Cara kerja:
 *   1. Sumber = mods-available/sql.orig (dibuat sekali dari berkas bawaan). Tanpa .orig, berkas saat ini.
 *   2. Di dalam blok sql { } pada kedalaman 1: SEMUA baris aktif untuk key terkelola dibuang (tidak ada
 *      duplikat), lalu blok koneksi ditulis tepat setelah `sql {` dan $INCLUDE queries.conf di akhir blok
 *      (queries.conf merujuk variabel yang harus sudah terdefinisi). Sub-blok (mysql { }, pool { }) tidak disentuh.
 *   3. Hasil diparse ulang dan diverifikasi sebelum ditulis atomik (tmp + rename).
 * Idempoten: dijalankan berulang menghasilkan berkas identik.
 *
 * Pemakaian: node write-sql-mod.js [--env /var/www/billing/.env] [--raddb /etc/freeradius/3.0]
 * Password tidak pernah dicetak.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const ENV_FILE = argValue('--env', path.resolve(__dirname, '..', '..', '.env'));
const RADDB = argValue('--raddb', process.env.RADDB || '/etc/freeradius/3.0');
const OUT_FILE = path.join(RADDB, 'mods-available', 'sql');
const ORIG_FILE = `${OUT_FILE}.orig`;

const MANAGED_KEYS = new Set([
  'driver', 'dialect', 'server', 'port', 'login', 'password', 'radius_db', 'read_clients', 'client_table',
]);
const INCLUDE_LINE = '\t$INCLUDE ${modconfdir}/${.:name}/main/${dialect}/queries.conf';
const CONN_BEGIN = '# >>> RANIAH conn >>> (ditulis install.sh dari .env, jangan diedit manual)';
const CONN_END = '# <<< RANIAH conn <<<';
const INC_BEGIN = '# >>> RANIAH include >>>';
const INC_END = '# <<< RANIAH include <<<';

// Karakter aman untuk password di .env, string FreeRADIUS ("$" memicu ekspansi, "\" dan quote perlu escape),
// dan DATABASE_URL. Harus sama dengan DB_PASSWORD_CHARSET di install.sh.
const PASSWORD_RE = /^[A-Za-z0-9._@+=:,!~^*/-]{8,}$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function fail(code, message) {
  process.stderr.write(`write-sql-mod: ${message}\n`);
  process.exit(code);
}

// Parser .env: semantik sama dengan backend/load_env.js (kutip luar dibuang, tanpa unescape).
function parseEnv(file) {
  const out = {};
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (value.length >= 2 && (
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    )) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

// Pecah satu baris: kode tanpa komentar (kutip dipertahankan) dan selisih kurung kurawal di luar kutip.
function scan(line) {
  let code = '';
  let quote = null;
  let delta = 0;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      code += c;
      if (c === '\\' && i + 1 < line.length) { code += line[i + 1]; i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; code += c; continue; }
    if (c === '#') break;
    if (c === '{') delta += 1;
    if (c === '}') delta -= 1;
    code += c;
  }
  return { code, delta };
}

function frString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function stripManaged(lines) {
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('# >>> RANIAH')) { skipping = true; continue; }
    if (t.startsWith('# <<< RANIAH')) { skipping = false; continue; }
    if (!skipping) out.push(line);
  }
  return out;
}

// Kumpulkan assignment aktif di kedalaman 1 blok sql { } dan INCLUDE aktif, untuk verifikasi.
function collectActive(lines) {
  const found = {};
  let includes = 0;
  let depth = 0;
  let inSql = false;
  let sqlBlocks = 0;
  for (const line of lines) {
    const { code, delta } = scan(line);
    if (!inSql) {
      if (/^\s*sql\s*\{/.test(code)) { inSql = true; sqlBlocks += 1; depth = delta; }
      continue;
    }
    if (depth === 1 && delta === 0) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(code);
      if (m && MANAGED_KEYS.has(m[1])) (found[m[1]] = found[m[1]] || []).push(m[2]);
      if (/^\s*\$INCLUDE\b/.test(code) && /queries\.conf/.test(code)) includes += 1;
    }
    depth += delta;
    if (depth <= 0) { inSql = false; }
  }
  return { found, includes, sqlBlocks };
}

function build(sourceLines, conf) {
  const lines = stripManaged(sourceLines);
  const connBlock = [
    `\t${CONN_BEGIN}`,
    '\tdriver = "rlm_sql_postgresql"',
    '\tdialect = "postgresql"',
    '\tserver = "127.0.0.1"',
    `\tport = ${conf.port}`,
    `\tlogin = ${frString(conf.user)}`,
    `\tpassword = ${frString(conf.password)}`,
    `\tradius_db = ${frString(conf.database)}`,
    '\tread_clients = yes',
    '\tclient_table = "nas"',
    `\t${CONN_END}`,
  ];
  const includeBlock = [`\t${INC_BEGIN}`, INCLUDE_LINE, `\t${INC_END}`];

  const out = [];
  let state = 'before'; // before -> inside -> done
  let depth = 0;
  for (const line of lines) {
    if (state === 'before') {
      out.push(line);
      const { code, delta } = scan(line);
      if (/^\s*sql\s*\{/.test(code)) {
        depth = delta;
        state = 'inside';
        out.push(...connBlock);
      }
      continue;
    }
    if (state === 'done') { out.push(line); continue; }

    const { code, delta } = scan(line);
    if (depth === 1 && delta === 0) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(code);
      if (m && MANAGED_KEYS.has(m[1])) continue;
      if (/^\s*\$INCLUDE\b/.test(code) && /queries\.conf/.test(code)) continue;
    }
    if (depth + delta <= 0) {
      out.push(...includeBlock, line);
      state = 'done';
      depth += delta;
      continue;
    }
    depth += delta;
    out.push(line);
  }
  if (state !== 'done') fail(3, `blok "sql { ... }" tidak ditemukan atau tidak seimbang di sumber`);
  return out;
}

function verify(lines, conf) {
  const { found, includes, sqlBlocks } = collectActive(lines);
  const expected = {
    driver: '"rlm_sql_postgresql"',
    dialect: '"postgresql"',
    server: '"127.0.0.1"',
    port: String(conf.port),
    login: frString(conf.user),
    password: frString(conf.password),
    radius_db: frString(conf.database),
    read_clients: 'yes',
    client_table: '"nas"',
  };
  if (sqlBlocks !== 1) fail(4, `verifikasi: harus tepat satu blok sql { }, ditemukan ${sqlBlocks}`);
  for (const [key, value] of Object.entries(expected)) {
    const got = found[key] || [];
    if (got.length !== 1) fail(4, `verifikasi: "${key}" harus aktif tepat 1x, ditemukan ${got.length}x`);
    if (got[0] !== value) fail(4, `verifikasi: nilai "${key}" tidak sesuai dengan .env`);
  }
  if (includes !== 1) fail(4, `verifikasi: $INCLUDE queries.conf harus aktif tepat 1x, ditemukan ${includes}x`);
  let depth = 0;
  for (const line of lines) depth += scan(line).delta;
  if (depth !== 0) fail(4, 'verifikasi: kurung kurawal tidak seimbang');
}

function main() {
  if (!fs.existsSync(ENV_FILE)) fail(2, `.env tidak ditemukan: ${ENV_FILE}`);
  const env = parseEnv(ENV_FILE);
  const conf = {
    user: env.DB_USER || '',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || '',
    port: Number.parseInt(env.DB_PORT || '5432', 10),
  };
  if (!IDENT_RE.test(conf.user)) fail(2, 'DB_USER di .env kosong/tidak valid');
  if (!IDENT_RE.test(conf.database)) fail(2, 'DB_NAME di .env kosong/tidak valid');
  if (!Number.isInteger(conf.port) || conf.port < 1 || conf.port > 65535) fail(2, 'DB_PORT di .env tidak valid');
  if (!PASSWORD_RE.test(conf.password)) {
    fail(2, 'DB_PASSWORD di .env kosong atau memuat karakter yang tidak aman untuk FreeRADIUS (boleh: A-Z a-z 0-9 . _ @ + = : , ! ~ ^ * / -, min. 8). '
      + 'Ganti dengan: openssl rand -hex 16');
  }
  if (!fs.existsSync(OUT_FILE)) fail(2, `berkas tidak ada (freeradius-postgresql terpasang?): ${OUT_FILE}`);

  const current = fs.readFileSync(OUT_FILE, 'utf8');
  // Backup bawaan SEKALI. Bila berkas saat ini sudah hasil tulisan kita dan .orig hilang, jangan menyalin
  // berkas terkelola sebagai "bawaan"; buildnya tetap idempoten karena blok terkelola dibuang dulu.
  if (!fs.existsSync(ORIG_FILE) && !current.includes('# >>> RANIAH')) {
    const st = fs.statSync(OUT_FILE);
    fs.copyFileSync(OUT_FILE, ORIG_FILE);
    fs.chmodSync(ORIG_FILE, st.mode & 0o777);
    try { fs.chownSync(ORIG_FILE, st.uid, st.gid); } catch (_) { /* bukan root: biarkan */ }
  }
  const source = fs.existsSync(ORIG_FILE) ? fs.readFileSync(ORIG_FILE, 'utf8') : current;
  const sourceLines = source.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

  const result = build(sourceLines, conf);
  verify(result, conf);
  const text = `${result.join('\n')}\n`;

  if (text === current) {
    process.stdout.write(`sql: sudah sesuai .env (server=127.0.0.1 port=${conf.port} login=${conf.user} radius_db=${conf.database}, password: ***)\n`);
    return;
  }
  const st = fs.statSync(OUT_FILE);
  const tmp = `${OUT_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: st.mode & 0o777 });
  try { fs.chownSync(tmp, st.uid, st.gid); } catch (_) { /* bukan root: biarkan */ }
  fs.renameSync(tmp, OUT_FILE);
  process.stdout.write(`sql: ditulis (server=127.0.0.1 port=${conf.port} login=${conf.user} radius_db=${conf.database}, password: ***)\n`);
}

main();
