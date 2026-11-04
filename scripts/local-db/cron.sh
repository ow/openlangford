#!/usr/bin/env bash
# Run the web Worker's scheduled jobs once on the local dev server (dev.sh), as Cloudflare's cron would:
# the five-minute jobs by default (reader report assessments, the database server sampler, email dispatch,
# which dev.sh turns off), or another schedule from wrangler.toml with --cron.
#   scripts/local-db/cron.sh [--port 5173] [--cron "17 */12 * * *"]
set -euo pipefail
port=5173; cron="*/5 * * * *"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) port="$2"; shift ;;
    --cron) cron="$2"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
curl -fsS -m 300 "http://localhost:$port/cdn-cgi/handler/scheduled?cron=$(printf '%s' "$cron" | sed 's/ /+/g')" >/dev/null
echo "Ran the \"$cron\" jobs on localhost:$port"
