# Pipeline workers (launchd)

The pipeline's background workers on the Mac. Each reads jobs from `pipeline_jobs` and loads secrets from the
repo root `.env` at start (nothing secret lives here).

| Worker | Jobs | Starts | Install |
|---|---|---|---|
| `com.viewroyal.langford-quick-worker` | `fix_page`, `find_matter_links` (the site's review bar) | at login, restarts itself | `./launchd/install_quick_worker.sh` |
| `com.viewroyal.langford-archive-worker-2`, `-3` | `ingest_meeting`, `diarize_meeting` | on demand (`launchctl kickstart gui/$(id -u)/<label>`) | `./launchd/install_archive_workers.sh` |

On a new machine: clone, create `apps/pipeline/.venv` (`uv sync`), put `.env` at the repo root, run both installers.
Logs go to `data/langford/logs/`.
