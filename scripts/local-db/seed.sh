#!/usr/bin/env bash
# Seed the local database with production's public data.
#   seed.sh                          load the last export (scripts/local-db/data) into the local database
#   seed.sh --export --env-file F    first re-export from production (READ-ONLY), then load
#     [--months N]                   transcript/document-section slice, default 12 months of meetings
# The env file is only read for DATABASE_URL, in memory; nothing is written to any .env file.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
export_args=(); do_export=false
while [ $# -gt 0 ]; do
  case "$1" in
    --export) do_export=true ;;
    --env-file|--months) export_args+=("$1" "$2"); shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
if $do_export; then
  uv run --no-project --with psycopg2-binary --with python-dotenv \
    python "$LOCAL_DB_DIR/export_public_data.py" ${export_args[@]+"${export_args[@]}"}
fi
"$LOCAL_DB_DIR/load-seed.sh"
