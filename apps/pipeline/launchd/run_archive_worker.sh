#!/usr/bin/env bash
# An archive worker: meeting ingest and diarization jobs (the heavy, Mac-only work). Installed as
# com.viewroyal.langford-archive-worker-<n> by launchd/install_archive_workers.sh; started on demand.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PIPELINE_DIR="$PROJECT_ROOT/apps/pipeline"
LOG_DIR="$PROJECT_ROOT/data/langford/logs"

mkdir -p "$LOG_DIR"

set -a
source "$PROJECT_ROOT/.env"
set +a

cd "$PIPELINE_DIR"
exec "$PIPELINE_DIR/.venv/bin/python" -u worker.py --job-types ingest_meeting,diarize_meeting --poll-interval 5
