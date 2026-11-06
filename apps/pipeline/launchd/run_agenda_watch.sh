#!/usr/bin/env bash
# The agenda watch: puts newly posted council agendas in the database before the meeting (agenda items, topics,
# embeddings; no minutes, audio or video). Unchanged agendas are skipped, so a run with nothing new costs one
# calendar request and a few database reads. Installed by launchd/install_agenda_watch.sh.
# main.py holds the pipeline lock (logs/pipeline.lock): if a manual run is going, this run exits at once, and a
# manual run started during this one exits the same way.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PIPELINE_DIR="$PROJECT_ROOT/apps/pipeline"
LOG_DIR="$PROJECT_ROOT/data/langford/logs"

mkdir -p "$LOG_DIR"

set -a
source "$PROJECT_ROOT/.env"
set +a

cd "$PIPELINE_DIR"
exec "$PIPELINE_DIR/.venv/bin/python" -u main.py --upcoming-agendas
