#!/usr/bin/env bash
# Start the local Supabase stack (Docker). On a brand-new stack, also builds the schema and loads
# the public data if it has been exported (seed.sh --export). Prints the local URLs.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
if ! local_db_running; then
  supa start
fi
# A fresh database has no recorded migrations yet: build it.
if [ "$(lpsql -At -c "select to_regclass('supabase_migrations.schema_migrations') is null or not exists (select 1 from supabase_migrations.schema_migrations)")" = t ]; then
  "$LOCAL_DB_DIR/apply-migrations.sh"
  if [ -f "$LOCAL_DB_DIR/data/tables.txt" ]; then "$LOCAL_DB_DIR/load-seed.sh"; fi
  "$LOCAL_DB_DIR/create-admin.sh"
else
  # Pick up migrations added since the last run.
  "$LOCAL_DB_DIR/apply-migrations.sh"
fi
supa status
