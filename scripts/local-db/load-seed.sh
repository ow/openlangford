#!/usr/bin/env bash
# Load scripts/local-db/data (from export_public_data.py) into the LOCAL database: truncates the
# exported tables, COPYs the files in with triggers off, resets identity sequences and reports any rows
# whose foreign keys point outside the copy. Never touches production.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
data="$LOCAL_DB_DIR/data"
[ -f "$data/tables.txt" ] || { echo "No exported data in $data; run seed.sh --export first." >&2; exit 1; }
local_db_running || { echo "Local database is not running; run start.sh" >&2; exit 1; }

export PGUSER_LOCAL=supabase_admin   # superuser, to load with triggers (and FK triggers) off
tables=()
while IFS= read -r t; do [ -n "$t" ] && tables+=("$t"); done < "$data/tables.txt"
list="$(printf 'public.%s,' "${tables[@]}")"; list="${list%,}"
PGOPTIONS="-c client_min_messages=warning" lpsql -q -c "truncate $list restart identity cascade"

for t in "${tables[@]}"; do
  f="$data/$t.csv.gz"
  cols="$(gunzip -c "$f" 2>/dev/null | head -1 || true)"
  PGOPTIONS="-c session_replication_role=replica" lpsql -q -c "copy public.$t ($cols) from stdin with (format csv, header true)" < <(gunzip -c "$f")
  printf '  %-28s %s rows\n' "$t" "$(lpsql -At -c "select count(*) from public.$t")"
done

# Identity/serial sequences to max(id), then planner stats.
lpsql -q <<'SQL'
DO $$
DECLARE r record; seq text;
BEGIN
  FOR r IN SELECT c.table_name, c.column_name FROM information_schema.columns c
           WHERE c.table_schema = 'public' AND (c.is_identity = 'YES' OR c.column_default LIKE 'nextval(%') LOOP
    seq := pg_get_serial_sequence(format('public.%I', r.table_name), r.column_name);
    IF seq IS NOT NULL THEN
      EXECUTE format('SELECT setval(%L, coalesce((SELECT max(%I) FROM public.%I), 0) + 1, false)', seq, r.column_name, r.table_name);
    END IF;
  END LOOP;
END $$;
ANALYZE;
SQL

# Foreign keys that don't hold (rows were loaded with FK triggers off).
lpsql -At <<'SQL'
DO $$
DECLARE r record; n bigint; bad int := 0;
BEGIN
  FOR r IN SELECT con.conrelid::regclass AS tbl, con.confrelid::regclass AS ref, con.conname,
                  (SELECT string_agg(format('t.%I', a.attname), ',' ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(n, ord)
                     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS cols,
                  (SELECT string_agg(format('r.%I', a.attname), ',' ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(n, ord)
                     JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n) AS refcols
           FROM pg_constraint con WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace LOOP
    EXECUTE format('SELECT count(*) FROM %s t WHERE (%s) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %s r WHERE (%s) = (%s))',
                   r.tbl, r.cols, r.ref, r.refcols, r.cols) INTO n;
    IF n > 0 THEN RAISE WARNING 'FK %: % rows of % point outside %', r.conname, n, r.tbl, r.ref; bad := bad + 1; END IF;
  END LOOP;
  IF bad = 0 THEN RAISE NOTICE 'All foreign keys hold.'; END IF;
END $$;
SQL
lpsql -q -c "notify pgrst, 'reload schema'"
