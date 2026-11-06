#!/usr/bin/env bash
# Lint NEW Supabase migration files in a pull request. Lints only; nothing is applied.
# Usage: .github/scripts/lint-migrations.sh <base-ref-or-sha>   (run from the repo root, history fetched)
set -euo pipefail

base="${1:?usage: lint-migrations.sh <base-ref-or-sha>}"
dir="supabase/migrations"
fail=0
err() { echo "::error file=$1::$2"; fail=1; }

# Files added by this PR (modified/renamed applied migrations are flagged separately).
mapfile -t added < <(git diff --name-only --diff-filter=A "$base"...HEAD -- "$dir")
mapfile -t changed < <(git diff --name-only --no-renames --diff-filter=MD "$base"...HEAD -- "$dir")

# One exception: a baseline squash. When the PR adds <ts>_baseline.sql, applied files may leave this
# directory as long as each one reappears unchanged under supabase/migrations_archive/ (see supabase/BASELINE-RUNBOOK.md).
baseline="$(printf '%s\n' "${added[@]}" | grep -E '/[0-9]{14}_baseline\.sql$' || true)"
for f in "${changed[@]}"; do
  [ -n "$f" ] || continue
  if [ -n "$baseline" ] && ! git cat-file -e "HEAD:$f" 2>/dev/null; then
    archived="supabase/migrations_archive/$(basename "$f")"
    if git cat-file -e "HEAD:$archived" 2>/dev/null && [ "$(git rev-parse "$base:$f")" = "$(git rev-parse "HEAD:$archived")" ]; then
      continue
    fi
    err "$f" "Removed from $dir but not archived unchanged as $archived."
    continue
  fi
  err "$f" "Applied migrations must never be modified, renamed or deleted. Add a new migration instead."
done

if [ "${#added[@]}" -eq 0 ] || [ -z "${added[0]}" ]; then
  echo "No new migration files."; exit "$fail"
fi

# Highest timestamp among migrations that already exist on the base.
max_existing="$(git ls-tree --name-only "$base" -- "$dir/" | sed -E 's#.*/##' | grep -E '^[0-9]{14}_' | cut -c1-14 | sort | tail -1 || true)"
echo "Highest existing timestamp on base: ${max_existing:-none}"

for f in "${added[@]}"; do
  name="$(basename "$f")"
  if ! [[ "$name" =~ ^[0-9]{14}_[a-z0-9_]+\.sql$ ]]; then
    err "$f" "Name must be <14-digit UTC timestamp>_<snake_case_name>.sql (npx supabase migration new <name>)."
    continue
  fi
  ts="${name:0:14}"
  if ! date -u -d "${ts:0:4}-${ts:4:2}-${ts:6:2} ${ts:8:2}:${ts:10:2}:${ts:12:2}" >/dev/null 2>&1; then
    err "$f" "Timestamp $ts is not a valid UTC date-time."
  fi
  # A baseline squash reuses the latest applied version on purpose (production already records it).
  if [[ "$name" =~ _baseline\.sql$ ]] && [ "$ts" = "$max_existing" ]; then
    echo "$name reuses the latest applied version (baseline squash)."
  elif [ -n "$max_existing" ] && ! [[ "$ts" > "$max_existing" ]]; then
    err "$f" "Timestamp $ts must be greater than every existing migration (highest on base: $max_existing). supabase db push would skip or reject it."
  fi
  # CONCURRENTLY cannot run inside the transaction supabase db push wraps each file in.
  # Comment lines (-- ...) are ignored.
  if grep -vE '^[[:space:]]*--' "$f" | grep -iqE 'create[[:space:]]+(unique[[:space:]]+)?index[[:space:]]+concurrently|drop[[:space:]]+index[[:space:]]+concurrently|reindex.*concurrently'; then
    err "$f" "CONCURRENTLY index operations cannot run inside supabase db push's transaction. Use a plain CREATE INDEX."
  fi
  if [ ! -s "$f" ]; then err "$f" "Migration file is empty."; fi
done

[ "$fail" -eq 0 ] && echo "Migration lint passed for ${#added[@]} new file(s)."
exit "$fail"
