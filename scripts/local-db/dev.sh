#!/usr/bin/env bash
# Run the web app (apps/web, `pnpm dev`) against the LOCAL Supabase stack.
# Connection settings come from `supabase status` and are exported for this process only;
# nothing is written to any .env file. Extra arguments go to `pnpm dev` (e.g. --port 5174).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

# .env files (production's settings) are fine: with OPEN_LANGFORD_LOCAL_DB=1, apps/web/vite.config.ts takes only
# OPENAI_API_KEY from them, and Wrangler is told not to load them into the Worker. A .dev.vars file would still be
# loaded into the Worker's bindings, so refuse that.
if [ -e "$REPO_DIR/apps/web/.dev.vars" ]; then
  echo "Found apps/web/.dev.vars: Wrangler would load it over the local settings. Move it aside to run locally." >&2
  exit 1
fi

"$LOCAL_DB_DIR/start.sh" >/dev/null
export_local_env
export ADMIN_EMAILS="${LOCAL_ADMIN_EMAIL:-admin@langford.local}"
export CF_REMOTE_BINDINGS=false            # no Wrangler login; Workers AI/remote bindings off
export CLOUDFLARE_INCLUDE_PROCESS_ENV=true # Worker `env` bindings take these values over wrangler.toml [vars]
export CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false
export OPEN_LANGFORD_LOCAL_DB=1            # vite.config.ts: only OPENAI_API_KEY comes from .env files
export AI_USAGE_LOGGING=false
# Production calls OpenAI through the Cloudflare AI Gateway binding, which isn't available locally: call OpenAI
# directly, with the key from your shell or the checkout's .env.
export AI_GATEWAY_ID=""
export EMAIL_ALERT_DISPATCH_ENABLED=false DISCORD_POSTS_ENABLED=false
export VITE_POSTHOG_KEY="" POSTHOG_PROJECT_ID=""
echo "Web app -> local Supabase at $SUPABASE_URL (Studio: http://127.0.0.1:54323)"
echo "Local admin login: $ADMIN_EMAILS / ${LOCAL_ADMIN_PASSWORD:-local-admin-password}"
# Cloudflare runs the Worker's cron in production; here dev.sh runs the five-minute jobs every five minutes while the
# server is up (LOCAL_CRON=false to leave them to cron.sh).
port=5173; prev=""
for arg in "$@"; do
  case "$arg" in --port=*) port="${arg#--port=}" ;; esac
  [ "$prev" = "--port" ] && port="$arg"
  prev="$arg"
done
if [ "${LOCAL_CRON:-true}" != "false" ]; then
  ( while sleep 300; do "$LOCAL_DB_DIR/cron.sh" --port "$port" >/dev/null 2>&1 || true; done ) &
  cron_pid=$!
  trap 'kill "$cron_pid" 2>/dev/null || true' EXIT INT TERM
fi
cd "$REPO_DIR/apps/web"
pnpm dev "$@"
