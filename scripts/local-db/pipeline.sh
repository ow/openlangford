#!/usr/bin/env bash
# Run a pipeline command (apps/pipeline, `uv run python ...`) against the LOCAL Supabase stack, e.g.
#   scripts/local-db/pipeline.sh main.py --stage matter-summaries --target 310 --dry-run
#   scripts/local-db/pipeline.sh worker.py --job-types fix_page,find_matter_links --poll-interval 3
# The pipeline's load_dotenv() never overrides a variable already set, so everything that could reach production
# is set here first: the database settings point at the local stack, and the settings that write somewhere else
# (R2 picture uploads, Discord, the email outbox) are blanked. The OpenAI key and model settings still come from
# the checkout's .env, for the AI stages.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[ $# -gt 0 ] || { echo "Usage: scripts/local-db/pipeline.sh <script.py> [args...]" >&2; exit 2; }
"$LOCAL_DB_DIR/start.sh" >/dev/null
export_local_env
export SUPABASE_KEY="$SUPABASE_SECRET_KEY" SUPABASE_SERVICE_KEY="$SUPABASE_SECRET_KEY"
export SUPABASE_DB_PASSWORD="" SUPABASE_POOLER_REGION=""
export R2_ACCESS_KEY_ID="" R2_SECRET_ACCESS_KEY="" R2_ENDPOINT_URL="" R2_BUCKET_NAME=""
export DISCORD_WEBHOOK_URL="" PIPELINE_EMAIL_OUTBOX=false ALERT_WORKER_KEY=""
export AI_USAGE_LOGGING=false
echo "Pipeline -> local Supabase at $SUPABASE_URL" >&2
cd "$REPO_DIR/apps/pipeline"
exec uv run python "$@"
