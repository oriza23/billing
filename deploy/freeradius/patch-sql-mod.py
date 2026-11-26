#!/usr/bin/env python3
# Tulis ulang mods-available/sql dari sql.orig + kredensial DB (sumber: env proses).
# Dipakai install.sh; idempotent setiap dijalankan ulang.
from __future__ import annotations

import os
import re
import sys

CONNECTION_KEYS = frozenset({
    "dialect",
    "driver",
    "server",
    "port",
    "login",
    "password",
    "radius_db",
    "read_clients",
})


def radius_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def build_assignments() -> dict[str, str]:
    user = os.environ["DB_USER"]
    password = radius_escape(os.environ["DB_PASSWORD"])
    dbname = os.environ["DB_NAME"]
    port = (os.environ.get("DB_PORT") or "5432").strip()
    return {
        "dialect": '\tdialect = "postgresql"\n',
        "driver": '\tdriver = "rlm_sql_postgresql"\n',
        "server": '\tserver = "127.0.0.1"\n',
        "port": f"\tport = {port}\n",
        "login": f'\tlogin = "{user}"\n',
        "password": f'\tpassword = "{password}"\n',
        "radius_db": f'\tradius_db = "{dbname}"\n',
        "read_clients": "\tread_clients = yes\n",
    }


def patch_sql_block(lines: list[str], assigns: dict[str, str]) -> list[str]:
    out: list[str] = []
    in_sql = False
    depth = 0
    patched = set()

    for line in lines:
        code = line.split("#", 1)[0]
        stripped = code.strip()

        if not in_sql:
            if re.match(r"^\s*sql\s*\{", stripped):
                in_sql = True
                depth = 0
            out.append(line)
            if in_sql:
                depth += code.count("{") - code.count("}")
            continue

        replaced = False
        if depth == 1 and not stripped.startswith("#"):
            for key in CONNECTION_KEYS:
                if key in patched:
                    continue
                if re.match(rf"^{re.escape(key)}\s*=", stripped):
                    out.append(assigns[key])
                    patched.add(key)
                    replaced = True
                    break
            if not replaced and "$INCLUDE" in code and "queries.conf" in code:
                if stripped.startswith("#"):
                    uncommented = re.sub(r"^\s*#\s*", "\t", line.lstrip(), count=1)
                    if not uncommented.endswith("\n"):
                        uncommented += "\n"
                    out.append(uncommented)
                    replaced = True

        if not replaced:
            out.append(line)

        depth += code.count("{") - code.count("}")
        if depth <= 0:
            in_sql = False
            depth = 0

    missing = CONNECTION_KEYS - patched
    if missing:
        print(f"patch-sql-mod: key tidak ditemukan di blok sql: {sorted(missing)}", file=sys.stderr)
        sys.exit(2)

    return out


def main() -> None:
    raddb = os.environ.get("RADDB", "/etc/freeradius/3.0")
    orig = os.path.join(raddb, "mods-available", "sql.orig")
    dst = os.path.join(raddb, "mods-available", "sql")
    for var in ("DB_USER", "DB_PASSWORD", "DB_NAME"):
        if not os.environ.get(var):
            print(f"patch-sql-mod: {var} kosong", file=sys.stderr)
            sys.exit(1)
    if not os.path.isfile(orig):
        print(f"patch-sql-mod: tidak ada {orig}", file=sys.stderr)
        sys.exit(1)

    lines = open(orig, encoding="utf-8").read().splitlines(keepends=True)
    assigns = build_assignments()
    patched_lines = patch_sql_block(lines, assigns)

    # Pastikan baris $INCLUDE aktif
    include_ok = any(
        "$INCLUDE" in ln and "queries.conf" in ln and not ln.lstrip().startswith("#")
        for ln in patched_lines
    )
    if not include_ok:
        print("patch-sql-mod: $INCLUDE queries.conf tidak aktif", file=sys.stderr)
        sys.exit(2)

    with open(dst, "w", encoding="utf-8") as f:
        f.writelines(patched_lines)


if __name__ == "__main__":
    main()