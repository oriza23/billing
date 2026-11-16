/**
 * Terjemahan SQL gaya MySQL/MariaDB ke PostgreSQL untuk pool kompatibel mysql2.
 */

const DUP_CONFLICT = [
  {
    test: /INSERT\s+INTO\s+settings\s/i,
    conflict: '(key_name)',
  },
  {
    test: /INSERT\s+INTO\s+app_settings\s/i,
    conflict: '(setting_key)',
  },
  {
    test: /INSERT\s+INTO\s+acs_devices\s/i,
    conflict: '(server_id, device_id)',
  },
  {
    test: /INSERT\s+IGNORE\s+INTO\s+data_wilayah\s/i,
    conflict: '(nama_wilayah)',
  },
];

function mapPgError(err) {
  if (!err || err.code === 'ER_DUP_ENTRY') {
    return err;
  }
  if (err.code === '23505') {
    const mapped = new Error(err.message);
    mapped.code = 'ER_DUP_ENTRY';
    mapped.errno = 1062;
    mapped.pgCode = err.code;
    mapped.detail = err.detail;
    mapped.stack = err.stack;
    return mapped;
  }
  return err;
}

function expandBulkValues(sql, params) {
  if (!/VALUES\s+\?/i.test(sql) || !params || params.length !== 1) {
    return { sql, params };
  }
  const rows = params[0];
  if (!Array.isArray(rows) || rows.length === 0) {
    return { sql: sql.replace(/VALUES\s+\?/i, 'VALUES (DEFAULT) WHERE FALSE'), params: [] };
  }
  if (!Array.isArray(rows[0])) {
    return { sql, params };
  }

  const colCount = rows[0].length;
  const tuples = [];
  const flat = [];
  let n = 0;
  for (const row of rows) {
    const ph = [];
    for (let c = 0; c < colCount; c += 1) {
      n += 1;
      ph.push(`$${n}`);
      flat.push(row[c]);
    }
    tuples.push(`(${ph.join(', ')})`);
  }
  const newSql = sql.replace(/VALUES\s+\?/i, `VALUES ${tuples.join(', ')}`);
  return { sql: newSql, params: flat };
}

function convertPlaceholders(sql, params) {
  const expanded = expandBulkValues(sql, params);
  let text = expanded.sql;
  const values = expanded.params || [];
  let index = 0;
  text = text.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
  return { text, values };
}

function transformMysqlDialect(sql) {
  let s = sql;

  s = s.replace(/`/g, '"');

  // CREATE TABLE / kolom
  s = s.replace(/\bBIGINT\s+AUTO_INCREMENT\s+PRIMARY\s+KEY\b/gi, 'BIGSERIAL PRIMARY KEY');
  s = s.replace(/\bINT\s+AUTO_INCREMENT\s+PRIMARY\s+KEY\b/gi, 'SERIAL PRIMARY KEY');
  s = s.replace(/\s+AUTO_INCREMENT\b/gi, '');
  s = s.replace(/\bDATETIME\b/gi, 'TIMESTAMP');
  s = s.replace(/\s+CHARACTER\s+SET\s+utf8mb4\s+COLLATE\s+utf8mb4_bin/gi, '');
  s = s.replace(/\s+CHARACTER\s+SET\s+\w+\s+COLLATE\s+\w+/gi, '');
  s = s.replace(/ENUM\s*\([^)]+\)/gi, 'VARCHAR(32)');
  s = s.replace(/,\s*UNIQUE\s+KEY\s+\w+\s*\(([^)]+)\)/gi, ', UNIQUE ($1)');
  s = s.replace(/,\s*KEY\s+\w+\s*\([^)]+\)/gi, '');
  s = s.replace(/\bON\s+UPDATE\s+CURRENT_TIMESTAMP\b/gi, '');

  s = s.replace(/\bIFNULL\s*\(/gi, 'COALESCE(');
  s = s.replace(/\bBINARY\s+/gi, '');
  s = s.replace(/\s+FROM\s+DUAL\b/gi, '');
  s = s.replace(/\bCURDATE\s*\(\s*\)/gi, 'CURRENT_DATE');
  s = s.replace(/\bNOW\s*\(\s*\)/gi, 'NOW()');

  s = s.replace(
    /DATE_FORMAT\s*\(\s*([^,]+),\s*'%Y-%m'\s*\)\s*=\s*DATE_FORMAT\s*\(\s*NOW\s*\(\s*\)\s*,\s*'%Y-%m'\s*\)/gi,
    "to_char($1, 'YYYY-MM') = to_char(NOW(), 'YYYY-MM')",
  );
  s = s.replace(
    /DATE_FORMAT\s*\(\s*([^,]+),\s*'%d\/%m\/%Y %H:%i:%s'\s*\)/gi,
    "to_char($1, 'DD/MM/YYYY HH24:MI:SS')",
  );

  s = s.replace(
    /DATE_ADD\s*\(\s*GREATEST\s*\(\s*COALESCE\s*\(\s*jatuh_tempo\s*,\s*CURRENT_DATE\s*\)\s*,\s*CURRENT_DATE\s*\)\s*,\s*INTERVAL\s+1\s+MONTH\s*\)/gi,
    "(GREATEST(COALESCE(jatuh_tempo, CURRENT_DATE), CURRENT_DATE) + INTERVAL '1 month')",
  );
  s = s.replace(
    /DATE_ADD\s*\(\s*([^,]+)\s*,\s*INTERVAL\s+1\s+DAY\s*\)/gi,
    '($1::timestamp + INTERVAL \'1 day\')',
  );
  s = s.replace(
    /DATE_ADD\s*\(\s*([^,]+)\s*,\s*INTERVAL\s+([^)]+)\s+SECOND\s*\)/gi,
    "($1 + ($2 || ' seconds')::interval)",
  );

  s = s.replace(
    /ALTER\s+TABLE\s+(\w+)\s+MODIFY\s+(\w+)\s+VARCHAR\s*\(\s*(\d+)\s*\)/gi,
    'ALTER TABLE $1 ALTER COLUMN $2 TYPE VARCHAR($3)',
  );

  s = s.replace(
    /ALTER\s+TABLE\s+(\w+)\s+ADD\s+INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(([^)]+)\)/gi,
    'CREATE INDEX IF NOT EXISTS $2 ON $1 ($3)',
  );

  s = s.replace(/\bTINYINT\s*\(\s*1\s*\)/gi, 'SMALLINT');

  if (/INSERT\s+IGNORE\s+INTO\s+data_wilayah\b/i.test(s)) {
    s = s.replace(/INSERT\s+IGNORE\s+INTO/i, 'INSERT INTO');
    if (!/ON\s+CONFLICT/i.test(s)) {
      s = `${s.trim().replace(/;?\s*$/, '')} ON CONFLICT (nama_wilayah) DO NOTHING`;
    }
  }

  if (/ON\s+DUPLICATE\s+KEY\s+UPDATE/i.test(s)) {
    const dupIdx = s.search(/ON\s+DUPLICATE\s+KEY\s+UPDATE/i);
    const head = s.slice(0, dupIdx);
    let tail = s.slice(dupIdx).replace(/^ON\s+DUPLICATE\s+KEY\s+UPDATE\s+/i, '');
    tail = tail.replace(/VALUES\s*\(\s*([a-zA-Z0-9_".]+)\s*\)/gi, 'EXCLUDED.$1');
    const rule = DUP_CONFLICT.find((item) => item.test.test(s));
    const noop = /^[a-zA-Z0-9_".]+\s*=\s*[a-zA-Z0-9_".]+(?:\s*,\s*[a-zA-Z0-9_".]+\s*=\s*[a-zA-Z0-9_".]+)*\s*$/i.test(tail.trim())
      && !/EXCLUDED\./i.test(tail);
    if (noop && rule) {
      s = `${head.trim()} ON CONFLICT ${rule.conflict} DO NOTHING`;
    } else if (rule) {
      s = `${head.trim()} ON CONFLICT ${rule.conflict} DO UPDATE SET ${tail.trim().replace(/;\s*$/, '')}`;
    } else {
      s = head;
    }
  }

  const trimmed = s.trim();
  const skipReturning = /^INSERT\s+INTO\s+(settings|app_settings|rad\w*)\b/i.test(trimmed);
  if (
    /^INSERT\s+INTO\b/i.test(trimmed)
    && !/\bRETURNING\b/i.test(trimmed)
    && !skipReturning
  ) {
    s = s.replace(/;\s*$/, '');
    s = `${s} RETURNING id`;
  }

  return s;
}

function prepareQuery(sql, params) {
  const dialect = transformMysqlDialect(sql);
  const { text, values } = convertPlaceholders(dialect, params);
  return { text, values };
}

function resultHeader(rowCount, rows) {
  const header = {
    affectedRows: rowCount ?? 0,
    insertId: 0,
    changedRows: 0,
  };
  if (rows && rows.length > 0 && rows[0].id != null) {
    header.insertId = Number(rows[0].id) || rows[0].id;
  }
  return header;
}

function wrapPgResult(pgResult) {
  const { command, rows, rowCount } = pgResult;
  if (command === 'SELECT' || command === 'SHOW') {
    return [rows, []];
  }
  return [resultHeader(rowCount, rows), []];
}

const ENSURE_FUNCTIONS_SQL = `
CREATE OR REPLACE FUNCTION get_lock(p_name text, p_timeout int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  ok boolean;
  deadline timestamptz := clock_timestamp() + make_interval(secs => GREATEST(COALESCE(p_timeout, 0), 0));
BEGIN
  LOOP
    ok := pg_try_advisory_lock(hashtext(p_name));
    IF ok THEN RETURN 1; END IF;
    IF clock_timestamp() >= deadline THEN RETURN 0; END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION release_lock(p_name text)
RETURNS int LANGUAGE plpgsql AS $$
BEGIN
  IF pg_advisory_unlock(hashtext(p_name)) THEN RETURN 1; END IF;
  RETURN 0;
END;
$$;
`;

async function ensureMysqlCompatFunctions(client) {
  await client.query(ENSURE_FUNCTIONS_SQL);
}

module.exports = {
  prepareQuery,
  wrapPgResult,
  mapPgError,
  ensureMysqlCompatFunctions,
};