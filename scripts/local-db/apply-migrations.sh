#!/usr/bin/env bash
# Apply every supabase/migrations file (in filename order) to the LOCAL database, skipping files already
# recorded in supabase_migrations.schema_migrations. supabase/migrations is the only schema source:
# the baseline file builds the whole schema on an empty database, later files change it.
# Safe to re-run: after pulling new migrations it applies only the new ones. Never touches production.
#
# Differences from production's `supabase db push` runner, all local-only:
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

count=0
for f in "$REPO_DIR"/supabase/migrations/*.sql; do
  [ -e "$f" ] || continue
  base="$(basename "$f" .sql)"
  version="${base%%_*}"; name="${base#*_}"
  case "$version" in ''|*[!0-9]*) echo "skip (not a migration file name): $base"; continue;; esac
  if grep -qx "$version" <<<"$applied"; then continue; fi
  # One transaction per file, unless it manages its own (BEGIN/COMMIT) or uses CREATE INDEX CONCURRENTLY.
  single=(-1); grep -qiE "concurrently|^[[:space:]]*(begin|commit)[[:space:]]*;" "$f" && single=()
  echo "applying $base"
  { echo "DO \$\$ BEGIN IF to_regtype('vector') IS NOT NULL THEN PERFORM '[1]'::vector; END IF; END \$\$;"; cat "$f"; } \
    | PGOPTIONS="-c client_min_messages=warning" lpsql -q ${single[@]+"${single[@]}"} >/dev/null \
    || { echo "FAILED: $base" >&2; exit 1; }
  lpsql -q -c "insert into supabase_migrations.schema_migrations(version, name) values ('$version', '$name')"
  count=$((count + 1))
done
# PostgREST caches the schema; make it reload.
lpsql -q -c "notify pgrst, 'reload schema'"
echo "Applied $count file(s)."
