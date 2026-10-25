# Meetings stored one day late (eSCRIBE epoch) - investigation and proposed fix

Status: read-only investigation, no production writes. Nothing here has been applied.
Run date 2026-10-25. Files: `correct_meeting_dates.py` (dry run by default), `plan.json` (the dry-run plan). Owner decision: correct dates AND rename slugs, with old-slug redirects (migration `supabase/migrations/47-26-meeting-slug-history.sql`, applied to production; `resolveSlugParam`, the markdown routes and the meeting API fall back to `meeting_slug_history`).

## Root cause

The eSCRIBE `Start` field (`"/Date(1669075200000)/"`) is not a UTC instant. The portal serialises the **Pacific wall-clock
start time as if it were US Eastern**. Measured on all 258 eSCRIBE meetings in `source_meetings`: epoch minus the printed
wall-clock time is exactly +4 h when Pacific is on PDT and +5 h when on PST, with no exceptions. (Hypothesis refinement: it
is not "Pacific converted to UTC"; the offset is 4/5 h, not 7/8 h, which is why 7 PM in *summer* is not affected.)

Reading that epoch as UTC (`datetime.fromtimestamp(ms/1000, tz=utc).date()`) yields the next calendar day whenever
wall time + 5 h crosses midnight, i.e. any PST start at or after 19:00. In PDT the threshold is 20:00, so 7 PM summer
meetings were never affected.

Raw values (`source_meetings.raw->'escribe_meeting'`; the `Start` epoch and our stored date vs the portal's own fields):

| meeting | MeetingTime | Start epoch | epoch as UTC | stored `meeting_date` | MeetingDate / DateLong / DateMedium / DateShort | minutes page 1 |
| --- | --- | --- | --- | --- | --- | --- |
| 173 Special Council | 7:00 PM (PST) | 1669075200000 | 2022-11-22 00:00Z | 2022-11-22 | November 21, 2022 / Nov 21, 2022 | November 21, 2022 |
| 162 CoW | 7:00 PM (PST) | 1738281600000 | 2025-01-31 00:00Z | 2025-01-31 | January 30, 2025 | January 30, 2025 |
| 167 CoW | 7:00 PM (PST) | 1765238400000 | 2025-12-09 00:00Z | 2025-12-09 | December 08, 2025 / Dec 8, 2025 | Dec 8, 2025 |
| 200 Special Council (control) | 2:30 PM | 1671651000000 | 2022-12-21 19:30Z | 2022-12-21 | December 21, 2022 | matches |
| 160 Special Council (control) | 1:30 PM | 1765823400000 | 2025-12-15 18:30Z | 2025-12-15 | December 15, 2025 | matches |

`FormattedStart` ("Monday, November 21, 2022 @ 7:00 PM") and the video `AriaLabel` ("... 11/21/2022 7:00:00 PM") agree with the display dates.

Code:

* The original bug: `apps/pipeline/pipeline/scrapers/escribe.py` `_parse_meeting_date` took the `Start` epoch as UTC before any display
  field (removed in commit `3db25f63`, 2026-10-19). Everything in the database was ingested on 2026-05-27 with the old code
  (`source_meetings.discovered_at` 2026-05-27 01:16-01:20 UTC), so the main-branch scraper is already correct for display dates
  but **no data was repaired** (`existing_date_corrections_applied: false` in `research/data-integrity/2026-10-19/escribe-date-repair-verification.json`).
* The date then flows unchanged: `Archiver._meeting_archive_root` (`pipeline/orchestrator.py`, folder `"{date} {time} {type} [{id8}]"`),
  `meeting_source_record` -> `upsert_source_meetings` (`pipeline/ops.py`, `meeting_date`, `archive_path`), and the ingester (meeting row,
  `slug` from the INSERT-only trigger `trigger_meeting_slug`: `meeting_date::text || '-' || generate_slug(type)`).
* Two defects remained after `3db25f63`, fixed on this branch:
  1. `_parse_meeting_date` still used the epoch **as UTC** when the display fields are absent. It now converts through
     `America/Toronto` (`ESCRIBE_EPOCH_TZ`), which recovers the Pacific wall clock exactly (validated on 258/258; `America/Vancouver`
     only happens to give the right date because of the 3-4 h shift).
  2. `pipeline/video/isilive.py` `_meeting_date_key` (the ISI video map, matched against the **folder name date**) still keyed on the UTC
     epoch. With only the scraper fixed, new correctly-dated folders would stop matching their videos. It now calls the scraper's parser.

## Scope (all numbers from the live read-only database)

258 eSCRIBE `source_meetings` rows (6 more rows are `official_schedule`). Compared: stored date, portal display date
(America/Vancouver wall clock; `Start` epoch converted via Toronto gives the same), and minutes PDF page 1 where a PDF exists in the archive.

* Portal display date vs epoch-as-UTC date: they differ for **58** source rows, always the epoch being exactly +1 day. For those 58 rows our
  `source_meetings.meeting_date` equals the epoch-as-UTC date in 58/58, and the portal date in 0/58.
* `meetings.meeting_date` wrong (stored exactly +1 day vs portal date): **36 meetings** = the 29 council-classified meetings held in
  `research/attendance/2022-2026-term/plan.json` (all 29 reproduce, none extra) plus **7 Community Advisory Committee** meetings (13, 36, 188, 234, 241, 314, 336).
* Another **15** meetings (15, 23, 159, 164, 169, 202, 205, 208, 232, 274, 284, 307, 309, 342, 358) were already date-corrected in `meetings`
  (the "fifteen source-date corrections" applied earlier), but their `source_meetings.meeting_date` is still the wrong date (all 15 verified off by one).
* **7 cancelled** source rows without a meeting (35, 36, 92, 241, 242, 243, 251) carry the wrong date too.
  Total `source_meetings` to correct: 36 + 15 + 7 = 58.
* Minutes cross-check: for all 36 wrong meetings, page 1 of the minutes contains the portal date and not the stored date (36/36). No meeting where
  the sources disagree. Meetings where the portal date is right: 171 have both dates identical and a readable page 1; 12 have an unreadable/
  scanned page 1, 8 have no PDF; meeting 267 (2021-04-19) has page 1 dated April 12, 2021 (a different issue, date is not off by one, ignore).
* By type (36 meetings): Committee of the Whole 14, Regular Council 12, Advisory Committee 7, Special Council 3.
  By year: 2022: 2, 2023: 8, 2024: 11, 2025: 10, 2026: 5.
* By start time: 35 are 7:00 PM and 1 is 7:15 PM, all in PST months (Nov-Mar). Zero affected meetings in PDT, zero affected before 7 PM.
  Of 154 "7:00 PM" meetings, 57 are affected = exactly the PST ones.
* Goldstream Public Record comparison (~22 of 119 off): not re-run here (no access to that archive in this task). The pattern (2023+, evening,
  one day late) is consistent with this root cause; the Goldstream matches should drop to ~0 after correction.

Full list with old/new dates: `plan.json` / the table printed by `correct_meeting_dates.py`.

## Impact of correcting dates

| Area | Effect | Handling |
| --- | --- | --- |
| `meetings.slug` | `YYYY-MM-DD-type`, set by an INSERT-only trigger, so a date update does **not** change it. Slug date will keep being one day off (already true for the 15 corrected earlier: slug date != meeting_date). | Default: leave slugs. Optional rename needs redirect support (below). |
| Old-slug redirects | Originally none for meetings. Now: table `meeting_slug_history` (47-26) and a fallback in `resolveSlugParam` (detail, documents, document viewer, explorer), `publicMarkdown` (summary.md, content.md) and the meetings API endpoint; 301 keeps sub-path and query. | `--rename-slugs` records the old slug and sets the new slug in one transaction; refuses without the table. Note: 174's new slug is 38's old slug, so 38's history row is shadowed by the live slug (live slug wins). |
| Slug collisions | Corrected date+type slug already held by another meeting: only **172** (2024-12-17 Special Council 7 PM -> 2024-12-16; slug `2024-12-16-special-council` belongs to meeting 329, the 12:30 PM Special Council the same day; trigger convention would give `-2`). 174 -> `2024-02-13-committee-of-the-whole` is held by 38, but 38 itself moves to 02-12 (chain; script handles it via a two-phase rename). No collisions on `(meeting_date, type)` (no such unique index; only `idx_meetings_slug_muni`). | Script computes chain-aware proposals; 172 gets `-2`. |
| Archive folders / `archive_path` | Folder names contain the date (`2022-11-22 700pm Special Council [c145d400]`); `meetings.archive_path` (UNIQUE) equals `source_meetings.archive_path` in all 36; `documents.file_path` is relative to it; 218 meetings' `meta` embed archive paths (e.g. `cached_transcript_backfill.source_path`). | Not renamed (see below). |
| `source_meetings` | 58 rows have the wrong `meeting_date`; the next scrape would rewrite them anyway (and, unpinned, also `archive_path` to a new folder). | Script updates `meeting_date` only. |
| Attendance evidence | `attendance.notes.local_date` must equal `meeting_date` (`apps/web/app/lib/attendance-evidence.ts` returns "unknown" otherwise). Existing 1499 evidence rows all match their meeting date; **none exist for the 36** (they are the "held" ones). | Correct dates **first**, then rebuild/apply the attendance plan (`build_plan.py` will then pass the page-1 date check). Script aborts if any evidence at the old date exists. |
| Sitemap | `sitemap.server.ts` uses `slug` for the path and `latestDate(updated_at, meeting_date)` for lastmod: paths unchanged by a date-only fix; `updated_at` bumps via `set_timestamp_meetings`. | none |
| Alerts / update detection | `update_detector.py`/`notifier.py` only format `meeting_date` for the push text; subscriptions (`subscriptions` table) are keyed on matter/topic/person/keyword, not dates. Date shown in alerts becomes correct. | none |
| Memberships / roster by date | No membership start/end falls between the old and new date for any of the 36 (checked), so roster-at-date is unchanged. | none |
| Ballot/motion source validation | `canonical_motions.source_validation_inputs` includes `meeting.meeting_date`; a normal ingest after correction takes the refresh path once (as documented in `research/data-integrity/2026-10-19/fifteen-source-date-correction-writer-design-v1.md`). `participant_roles.py` tolerates catalog +-1 day. | Expected, one-time. |
| Calendar | None of the 36 has `calendar_source_id`; `official_schedule` rows are all future (2026-11/12). | none |

### Archive folders: renaming is not needed

Renaming 36+ folders would require updating the UNIQUE `archive_path`, `documents`, 218 `meta` blobs, cached transcripts and the
`.url`/`.sha256` sidecars atomically, for no user-visible gain (users never see folder names). Precedent: the earlier fifteen corrections
deliberately kept archive identifiers. The real hazard is the opposite: with the scraper fixed, `_meeting_archive_root` would produce
`2022-11-21 ...` for the next scrape, `upsert_source_meetings` would repoint `source_meetings.archive_path`, `download_documents` would
re-download into a second folder, and any re-ingest (`find_scheduled_meeting` -> `update ... archive_path`) would move the meeting to the new
path. `Archiver._pin_known_archive_paths` (this branch) pins already-ingested eSCRIBE sources to their stored archive path; new meetings get
correct folder names. Test: `tests/orchestrator/test_archive_path_pinning.py`.

## Proposed fix (this branch)

Code
* `pipeline/scrapers/escribe.py`: epoch fallback via `America/Toronto` (+ comment documenting the quirk).
* `pipeline/video/isilive.py`: `_meeting_date_key` uses the scraper's official-date parser (video map must agree with folder dates).
* `pipeline/orchestrator.py`: `_pin_known_archive_paths` called from `discover_source_meetings`; `_meeting_archive_root` honours the pin.
* Tests: `tests/scrapers/test_escribe_epoch_fallback.py` (real 173/162/167 epochs, afternoon controls, PDT/PST evenings, ISI key),
  `tests/scrapers/test_escribe_dates.py` (one expectation changed: epoch-only fallback now returns the local date), `tests/orchestrator/test_archive_path_pinning.py`.
  `uv run pytest tests/scrapers tests/video tests/orchestrator/test_archive_path_pinning.py`: 70 passed.
  (`tests/orchestrator/test_orchestrator.py` errors on a missing `pipeline.orchestrator.VimeoClient` attribute; unrelated and pre-existing.)

Data (not run)
* `correct_meeting_dates.py`: derives the portal date from `source_meetings.raw`, requires stored == portal + 1 day exactly (anything else is held),
  cross-checks minutes page 1 (hold on contradiction), aborts on attendance evidence at the old date, writes a JSON backup (full rows, minus embedding),
  prints the plan, and with `--apply` runs one SERIALIZABLE transaction with per-row compare-and-set. Dry run uses a read-only connection.
  Dry run result: 36 meetings, 22 source-only rows, 0 held; minutes page-1 check True for 36/36; plan in `plan.json`.
* Recommended order: (1) merge scraper/pin code so the next scrape cannot reintroduce or fork; (2) `--apply` date correction (date-only);
  (3) rerun the attendance plan for the 29 held council meetings; (4) next ingest refreshes ballot source validation once.
* Slugs: dates and slugs are corrected together. The history table and redirect fallback are in place (47-26 + web), so run with
  `--rename-slugs` (handles the 172 collision and the 38/174 chain).
