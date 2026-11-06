# Shared settings for scripts/local-db/*.sh (sourced, not run).
LOCAL_DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$LOCAL_DB_DIR/../.." && pwd)"
SUPABASE_CLI_VERSION="${SUPABASE_CLI_VERSION:-3.0.0}"
DB_CONTAINER="${DB_CONTAINER:-supabase_db_langford-local}"

supa() { npx --yes "supabase@$SUPABASE_CLI_VERSION" --workdir "$LOCAL_DB_DIR" "$@"; }

# psql inside the local database container (never a remote database).
lpsql() { docker exec -i -e PGOPTIONS="${PGOPTIONS:-}" "$DB_CONTAINER" psql -X -U "${PGUSER_LOCAL:-postgres}" -d "${LOCAL_DB_NAME:-postgres}" -v ON_ERROR_STOP=1 "$@"; }

local_db_running() { docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; }

# Exports the local stack's connection settings into this shell (nothing is written to disk).
export_local_env() {
  local status
  status="$(supa status -o env 2>/dev/null)" || { echo "Local Supabase is not running (scripts/local-db/start.sh)." >&2; return 1; }
  eval "$(printf '%s\n' "$status" | grep -E '^(API_URL|DB_URL|PUBLISHABLE_KEY|SECRET_KEY|ANON_KEY|SERVICE_ROLE_KEY)=' | sed 's/^/LOCAL_/')"
  case "$LOCAL_API_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "Refusing: API URL is not local ($LOCAL_API_URL)" >&2; return 1;; esac
  export SUPABASE_URL="$LOCAL_API_URL" VITE_SUPABASE_URL="$LOCAL_API_URL"
  export SUPABASE_SECRET_KEY="$LOCAL_SECRET_KEY" SUPABASE_PUBLISHABLE_DEFAULT_KEY="$LOCAL_PUBLISHABLE_KEY"
  export VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY="$LOCAL_PUBLISHABLE_KEY"
  export DATABASE_URL="$LOCAL_DB_URL"
}
