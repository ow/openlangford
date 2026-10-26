# Historical council terms (2008–2018)

Inserted 2026-10-25 (data only; no code changes). Council terms and Council memberships for the three terms before 2018–2022.

## Scripts
- `fetch_minutes.py OUT_DIR` – downloads GSPR (Glyphdex API) `council_minutes` markdown into OUT_DIR.
- `build_plan.py MINUTES_DIR` – parses PRESENT/ABSENT blocks of every minutes doc (GSPR 2008-12 onward; our DB `documents` Minutes for 2015-12..2018-11-04) and writes `plan.json`.
- `apply.py [--apply]` – dry-run print, or backup + insert-only transaction (idempotent via not-exists guards).
- `backup-2026-10-25.json` – all `council_terms` and Council `memberships` rows before the insert.

## Result
| Term | Start (inaugural) | End |
|---|---|---|
| 2008–2011 Council | 2008-12-01 | 2011-12-04 |
| 2011–2014 Council | 2011-12-05 | 2014-11-30 |
| 2014–2018 Council | 2014-12-01 | 2018-11-04 (term 3, 2018–2022, starts 2018-11-05: no gap/overlap) |

Members in every term (7 rows per term, 21 total, `council_term_id` set): Mayor Stew Young (143); Councillors Denise Blackwell (133), Matt Sahlstrom (134), Lanny Seaton (135), Winnie Sifert (363), Lillian Szpak (35), Roger Wade (137).

## Evidence
- Inaugural minutes of 2008-12-01, 2011-12-05 and 2014-12-01 each list exactly these seven in PRESENT.
- Scanned 48 / 65 / 87 rosters (2008-12-01..2011-12-04, ..2014-11-30, ..2018-11-04). No other Mayor/Councillor name appears in any PRESENT or ABSENT block; remaining capitalised names are staff (Bowden, Baldwin, Mahovlich, Kaercher, Ternent, Kryklywyj, Coneybeer, ...). No resignations, by-elections or deaths: all seven were present in the final weeks of each term (`first_present`/`last_present` in plan.json). Absences, and Blackwell as Acting Mayor when Young was away, are not membership changes.
- Date logic: start = inaugural date (oath-taking); end = day before the next inaugural. Matches the 2018 convention (end 2022-11-06, successor 2022-11-07). The existing Young row 2018-11-05..11-18 (no term id) continues unchanged; the 2014 Mayor row ends 2018-11-04.

## Uncertainties
- `election_id` is NULL for the new terms: `elections` only has 2018/2022/2026, and 2008/2011/2014 results were not imported (not verified, so not invented).
- Service before Dec 2008 is not modelled; the GSPR archive has only the Dec 2008 inaugural for 2008.
- Roster parsing of OCR text is fuzzy. One 2016-09-06 special meeting doc has no roster and was skipped; agenda packages are excluded. A mid-term change would still have shown in neighbouring rosters.
- Duplicate people variants exist (`B. Sifert` #392, `S. Sifert` #91, `Councillors (Blackwell` #211); left alone, canonical `Winnie Sifert` #363 used. No people created.
