# Pipeline workers (launchd)

The pipeline's background workers on the Mac. Each loads secrets from the repo root `.env` at start (nothing secret
lives here). The workers read jobs from `pipeline_jobs`; the agenda watch runs on a timer.

| Worker | Jobs | Starts | Install |
|---|---|---|---|
| `com.viewroyal.langford-quick-worker` | `fix_page`, `find_matter_links` (the site's review bar) | at login, restarts itself | `./launchd/install_quick_worker.sh` |
| `com.viewroyal.langford-archive-worker-2`, `-3` | `ingest_meeting`, `diarize_meeting` | on demand (`launchctl kickstart gui/$(id -u)/<label>`) | `./launchd/install_archive_workers.sh` |
| `com.viewroyal.langford-agenda-watch` | `main.py --upcoming-agendas` | every 2 hours, 07:05 to 21:05 | `./launchd/install_agenda_watch.sh` |

On a new machine: clone, create `apps/pipeline/.venv` (`uv sync`), put `.env` at the repo root, run the installers.
Logs go to `data/langford/logs/`.

## Agenda watch

Puts a meeting's agenda in the database as soon as the City posts it, so the meeting page (and alerts) can show
what's coming. Each run reads the eSCRIBE calendar (14 days back, 60 ahead) and, for each meeting from today on
with a posted agenda, downloads only the agenda and ingests it the normal way (agenda items, topics, map
locations, embeddings). It never downloads minutes, audio or video, and never sends or queues email.

- **Cheap when nothing changed.** A meeting whose stored agenda link and items are current is skipped before any
  download or model call. A new agenda link (eSCRIBE posts a revised agenda under a new document ID) re-ingests
  that meeting and updates the same agenda items.
- **No duplicate meetings.** The calendar sync's "Planned" meeting gets the agenda; the watch never adds a second
  meeting for the same eSCRIBE meeting.
- **Past meetings** in the window are listed but left to the full run, which brings minutes and video.
- **Lock.** It runs through `main.py`, which holds `logs/pipeline.lock`: while a manual run is going the watch exits
  at once (logged as "Another pipeline run is in progress"), and a manual run started during a watch run exits the
  same way, so start it again a minute later. The archive workers don't take this lock.
- **Check by hand:** `uv run python main.py --upcoming-agendas --dry-run` prints what it would do, writing nothing.
- **Remove:** `launchctl bootout gui/$(id -u)/com.viewroyal.langford-agenda-watch`.

The code is `pipeline/upcoming_agendas.py` and `Archiver.run_upcoming_agendas`; see also `docs/calendar-sync.md`.
