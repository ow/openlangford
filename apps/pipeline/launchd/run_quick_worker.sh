#!/usr/bin/env bash
# The quick worker: staff page fixes and "find missing" searches from the site's review bar. Seconds-long jobs
# that run on their own worker so they never wait behind a meeting ingest. Installed by launchd/install_quick_worker.sh.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PIPELINE_DIR="$PROJECT_ROOT/apps/pipeline"

set -a
source "$PROJECT_ROOT/.env"
set +a

cd "$PIPELINE_DIR"
exec "$PIPELINE_DIR/.venv/bin/python" -u worker.py --job-types fix_page,find_matter_links --poll-interval 3
