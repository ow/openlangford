#!/usr/bin/env bash
# Rebuild the local database from scratch: empty database, schema (apply-migrations.sh), public data
# (load-seed.sh, from the last export) and the local admin account. Local only.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
local_db_running || supa start
supa db reset --no-seed --yes
"$LOCAL_DB_DIR/apply-migrations.sh"
if [ -f "$LOCAL_DB_DIR/data/tables.txt" ]; then
  "$LOCAL_DB_DIR/load-seed.sh"
else
  echo "No exported data yet; run seed.sh --export --env-file <path to an env file with production DATABASE_URL>."
fi
"$LOCAL_DB_DIR/create-admin.sh"
