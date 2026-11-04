#!/usr/bin/env bash
# Apply sql/bootstrap.sql, the local-only fixups and every supabase/migrations file (in filename order)
# to the LOCAL database, skipping files already recorded in supabase_migrations.schema_migrations.
# Safe to re-run: after pulling new migrations it applies only the new ones. Never touches production.
#
# Differences from production's `supabase db push` runner, all local-only:
#   - fixups/*.sql run just before the migration they unblock (see each file for why),
#   - check_function_bodies is off (as in pg_dump restores): early migrations create functions that
#     reference objects production had from its pre-migration history,
#   - each file's session loads pgvector first, so `SET hnsw.ef_search` in function definitions works,
#   - files containing CREATE INDEX CONCURRENTLY (or their own BEGIN/COMMIT) aren't wrapped in one transaction.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
local_db_running || { echo "Local database container is not running; run scripts/local-db/start.sh" >&2; exit 1; }

PGOPTIONS="-c client_min_messages=warning" lpsql -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
SQL
applied="$(lpsql -At -c "select version from supabase_migrations.schema_migrations")"

files=()
for f in "$LOCAL_DB_DIR"/fixups/pre/*.sql; do [ -e "$f" ] && files+=("$f"); done
files+=("$REPO_DIR/sql/bootstrap.sql")
while IFS= read -r f; do files+=("$f"); done < <(
  for f in "$LOCAL_DB_DIR"/fixups/*.sql "$REPO_DIR"/supabase/migrations/*.sql; do
    [ -e "$f" ] && printf '%s %s\n' "$(basename "$f")" "$f"
  done | sort | cut -d' ' -f2-)

count=0
for f in "${files[@]}"; do
  base="$(basename "$f" .sql)"
  if [ "$f" = "$REPO_DIR/sql/bootstrap.sql" ]; then version="00000000000000"; name="local_bootstrap"
  else version="${base%%_*}"; name="${base#*_}"; fi
  case "$version" in ''|*[!0-9]*) echo "skip (not a migration file name): $base"; continue;; esac
  # Fixups may share a timestamp with a real migration (they sort after it by name); key them apart.
  case "$f" in "$LOCAL_DB_DIR"/fixups/*) version="$base"; name="local_fixup";; esac
  if grep -qx "$version" <<<"$applied"; then continue; fi
  # One transaction per file, unless it manages its own (BEGIN/COMMIT) or uses CREATE INDEX CONCURRENTLY.
  single=(-1); grep -qiE "concurrently|^[[:space:]]*(begin|commit)[[:space:]]*;" "$f" && single=()
  echo "applying $base"
  { echo "DO \$\$ BEGIN IF to_regtype('vector') IS NOT NULL THEN PERFORM '[1]'::vector; END IF; END \$\$;"; cat "$f"; } \
    | PGOPTIONS="-c check_function_bodies=off -c client_min_messages=warning" lpsql -q ${single[@]+"${single[@]}"} >/dev/null \
    || { echo "FAILED: $base" >&2; exit 1; }
  lpsql -q -c "insert into supabase_migrations.schema_migrations(version, name) values ('$version', '$name')"
  count=$((count + 1))
done
PGOPTIONS="-c check_function_bodies=off -c client_min_messages=warning" lpsql -q < "$LOCAL_DB_DIR/fixups/post/parity.sql"
# Hand-applied files from sql/ that production has (not covered by bootstrap.sql or the migrations).
PGOPTIONS="-c client_min_messages=warning" lpsql -q < "$REPO_DIR/sql/add_canonical_motion_identity.sql"
if [ "$(lpsql -At -c "select to_regprocedure('public.publish_source_bound_key_statement(text,text)') is null")" = t ]; then
  PGOPTIONS="-c client_min_messages=warning" lpsql -q < "$REPO_DIR/sql/add_source_bound_key_statement_rpc.sql"
fi
# PostgREST caches the schema; make it reload.
lpsql -q -c "notify pgrst, 'reload schema'"
echo "Applied $count file(s)."
