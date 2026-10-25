# Council attendance evidence, 2022-2026 term (issue #56)

Backfills `council-attendance/v1` evidence for every Council-classified meeting from 2022-11-07 to
today (168 meetings: status not Planned/cancelled, date <= build date 2026-10-25).

## Method (`build_plan.py`, no writes)

- Minutes PDF per meeting: the signed PDF if present, else any PDF. SHA-256 is of the original file.
- Page 1 is read with `pdftotext -layout` (`pipeline/ingestion/minutes_roster.py`) so the two-column
  PRESENT / ABSENT / ATTENDING headers parse correctly. Only PRESENT and ABSENT/REGRETS names are used;
  staff under ATTENDING are ignored.
- The page-1 date must equal the meeting date (otherwise the whole meeting is held).
- Every member of the Council organization whose membership is active on the date must match exactly one
  roster entry by surname (present or absent); otherwise that member is held.
- present -> attendance_mode `Unknown`, absent -> `Absent`; evidence in `notes` with source_page 1 and the
  verbatim roster section as source_quote.
- `compare.py` diffs the plan against existing rows (`disagreements.json`). `apply.py` upserts on
  (meeting_id, person_id) in one transaction (dry run by default), asserting `before.json` is still current.
  Nothing is deleted. `before.json` is every attendance row of the 168 meetings before applying (3018 rows).
- `ARCHIVE_ROOT` env var points at the checkout holding `archive/` (needed from a git worktree).

## Result

130 meetings read, 894 records (866 present, 28 absent), 811 written (788 updated, 23 inserted, 83 already identical).

## Holds (44 meetings fully or partly held)

| Reason | Count | Notes |
| --- | --- | --- |
| page-1 date does not match meeting date | 29 meetings | Always the minutes date is exactly one day BEFORE our `meeting_date` (e.g. minutes "November 21, 2022", meeting 173 stored as 2022-11-22). Evening meetings stored with the next day's date looks like a UTC date conversion error in `meeting_date`; needs a decision before the meeting dates or evidence local_date are changed. Includes meeting 162 (Jan 30 vs Jan 31 2025). Meeting 167 (2025-12-09) page 1 shows Dec 8 2025 as well. |
| no extractable page-1 date | 1 (270) | Scanned or unreadable page 1. |
| minutes are not a PDF | 6 (389-394, 402) | July-Oct 2026 meetings only have `Minutes.html`; no original PDF to hash. |
| no minutes | 1 (303) | Apr 11 2023 CoW. |
| no named roster on page 1 | 1 (256) | "PRESENT;" misread by the scan. |
| 0 roster matches (member held) | 6 members in 6 meetings | Guiry 221, 289; Goodmanson 326 ("Good manson"), 310, 346 ("ABSENT: Mayor S. Good manson"), 268 (narrative "Mayor Goodmanson was not present", not in a roster). Scan/OCR noise; the other members of those meetings were recorded. |

## Disagreements with the older AI rows

786 old rows agree, 83 were the earlier evidence rows (same state), 23 inserted. Two AI rows said present and
the roster says absent: meeting 229 (2024-04-08 Special Council) Kimberley Guiry, and meeting 159 (2026-03-02
Regular Council) Mark Morley. See `disagreements.json`.
