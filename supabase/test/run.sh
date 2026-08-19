#!/usr/bin/env bash
# Run every migration and seed file against a throwaway PostgreSQL database,
# then assert the result looks like a working project.
#
# This exists because "the SQL is written" and "the SQL runs" are different
# claims, and only one of them is worth making to someone who is going to
# paste it into a SQL editor.
#
#   supabase/test/run.sh                      # uses $PGHOST/$PGPORT/$PGUSER
#   PGHOST=/var/tmp/rotapg PGPORT=5433 PGUSER=rota supabase/test/run.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="${ROTASORTER_TEST_DB:-rotasorter_test}"

psql_q() { psql -v ON_ERROR_STOP=1 -q -X "$@"; }

echo "==> Recreating $DB"
psql_q -d postgres -c "drop database if exists $DB" >/dev/null
psql_q -d postgres -c "create database $DB" >/dev/null

run_file() {
  local label="$1" file="$2"
  printf '  %-42s' "$label"
  if psql_q -d "$DB" -f "$file" >/dev/null 2>"$ROOT/.sqlerr"; then
    echo "ok"
  else
    echo "FAILED"
    sed 's/^/      /' "$ROOT/.sqlerr" >&2
    rm -f "$ROOT/.sqlerr"
    exit 1
  fi
  rm -f "$ROOT/.sqlerr"
}

echo "==> Supabase shim"
run_file "00_supabase_shim.sql" "$ROOT/supabase/test/00_supabase_shim.sql"

echo "==> Migrations"
for file in "$ROOT"/supabase/migrations/*.sql; do
  # 0000_reset.sql is the teardown, exercised separately at the end.
  [[ "$(basename "$file")" == 0000_* ]] && continue
  run_file "$(basename "$file")" "$file"
done

echo "==> Seeds"
for file in "$ROOT"/supabase/seed/*.sql; do
  run_file "$(basename "$file")" "$file"
done

echo "==> Checks"
psql_q -d "$DB" -f "$ROOT/supabase/test/98_functions.sql"
psql_q -d "$DB" -f "$ROOT/supabase/test/99_assertions.sql"
echo "==> Reset, then rebuild from scratch"
run_file "0000_reset.sql" "$ROOT/supabase/migrations/0000_reset.sql"
for file in "$ROOT"/supabase/migrations/*.sql "$ROOT"/supabase/seed/*.sql; do
  [[ "$(basename "$file")" == 0000_* ]] && continue
  run_file "$(basename "$file") (again)" "$file"
done
psql_q -d "$DB" -f "$ROOT/supabase/test/99_assertions.sql" >/dev/null
echo "  reset and rebuild produced the same database"

echo "==> All good."
