#!/usr/bin/env bash
# Compare the local schema (public schema objects, extensions, grants) with production's, as captured
# by the last export (data/prod-schema.txt, read-only). Lines starting "prod:" exist only in production;
# "local:" only locally (expected for migrations that haven't reached production yet).
set -euo pipefail
source "$(dirname "$0")/lib.sh"
prod="$LOCAL_DB_DIR/data/prod-schema.txt"
[ -f "$prod" ] || { echo "No $prod; run seed.sh --export first." >&2; exit 1; }
diff <(sort "$prod") <(lpsql -At < "$LOCAL_DB_DIR/schema-fingerprint.sql" | sort) \
  | sed -n 's/^< /prod:  /p; s/^> /local: /p' || true
