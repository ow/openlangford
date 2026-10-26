"""Correct meetings/source_meetings dates that were stored one day late (eSCRIBE UTC-epoch bug).

Source of truth: the portal's own display date (`MeetingDate`/`DateMedium`/`DateShort` in
source_meetings.raw->escribe_meeting, parsed by EscribeScraper._parse_meeting_date), cross-checked
against page 1 of the minutes PDF when it is in the archive.

DRY RUN BY DEFAULT: the connection is read-only, nothing is written except the JSON backup of the rows
that would change (research/meeting-dates/backups/). `--apply` runs one SERIALIZABLE transaction with
per-row compare-and-set on the old value.

What it changes
  * meetings.meeting_date                (only where it is exactly official + 1 day)
  * source_meetings.meeting_date         (same rule; also rows with no ingested meeting, e.g. cancelled)
What it deliberately does NOT change
  * archive folders / meetings.archive_path / source_meetings.archive_path (see README: renaming is not
    needed, and Archiver._pin_known_archive_paths keeps scrapes from forking the folder)
  * meetings.slug, unless `--rename-slugs` is passed. Then, in the same transaction, the old slug is recorded
    in meeting_slug_history (migration 47-26; the web 301s old slugs) and the slug becomes `{date}-{type}`,
    suffixed `-2` if another meeting holds it (e.g. 172). Renames run in two phases (tmp slug first) so chains
    such as 38 -> 174 cannot trip the unique index.

Guards (abort / hold)
  * any attendance evidence row (notes.local_date) for a target meeting equal to the OLD date: correcting
    the date afterwards would turn that evidence into "unknown" in apps/web/app/lib/attendance-evidence.ts.
    Correct the dates BEFORE writing attendance evidence for these meetings.
  * minutes PDF page 1 contradicts the official date (held, not changed)

Run from apps/pipeline:
  uv run python ../../research/meeting-dates/correct_meeting_dates.py [--apply] [--rename-slugs]
        [--archive-root /Users/owen/Projects/viewroyal]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.getcwd())
import psycopg2
from psycopg2.extras import RealDictCursor

from pipeline import config
from pipeline.ingestion.minutes_roster import first_page_text
from pipeline.scrapers.escribe import EscribeScraper

HERE = Path(__file__).parent
EXCLUDE_COLUMNS = {"embedding"}  # large vector; not touched, not needed for restore


def slugify(text: str) -> str:
    """Mirror of public.generate_slug (max_len ignored; type names are short)."""
    return re.sub(r"[^a-zA-Z0-9]+", "-", text.strip()).strip("-").lower()


def official_date(raw: dict | None) -> date | None:
    return EscribeScraper._parse_meeting_date((raw or {}).get("escribe_meeting") or {})


def minutes_pdf(cur, meeting_id: int, archive_path: str | None, archive_root: Path | None) -> Path | None:
    if not archive_root or not archive_path:
        return None
    cur.execute("SELECT file_path FROM documents WHERE meeting_id=%s AND category ILIKE '%%minute%%'", (meeting_id,))
    files = sorted((r["file_path"] for r in cur.fetchall() if (r["file_path"] or "").lower().endswith(".pdf")),
                   key=lambda f: "signed" not in f.lower())
    for f in files:
        p = archive_root / archive_path / f
        if p.is_file():
            return p
    return None


def page1_mentions(path: Path, day: date) -> bool | None:
    flat = re.sub(r",\s*", ", ", re.sub(r"\s+", " ", first_page_text(str(path))))
    if not re.search(r"(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, ?\d{4}", flat):
        return None  # unreadable / scanned: no evidence either way
    return f"{day.strftime('%B')} {day.day}, {day.year}" in flat


def build_plan(cur, archive_root: Path | None) -> dict:
    cur.execute("""
        SELECT s.id AS sid, s.source_id, s.meeting_date AS s_date, s.status AS s_status, s.raw, s.ingested_meeting_id,
               m.id AS mid, m.meeting_date AS m_date, m.slug, m.type::text AS mtype, m.archive_path, m.municipality_id
        FROM source_meetings s LEFT JOIN meetings m ON m.id = s.ingested_meeting_id
        WHERE s.source_type = 'escribe' ORDER BY s.id""")
    rows = cur.fetchall()
    plan = {"meetings": [], "source_only": [], "slug_only": [], "held": [], "counts": Counter()}
    for r in rows:
        off = official_date(r["raw"])
        if off is None:
            plan["held"].append({"source_meeting_id": r["sid"], "reason": "no consistent official date in raw"})
            continue
        s_bad = r["s_date"] != off
        m_bad = r["mid"] is not None and r["m_date"] != off
        if not (s_bad or m_bad):
            continue
        # Only the characterised failure: stored exactly one day late.
        for label, stored, bad in (("source_meetings", r["s_date"], s_bad), ("meetings", r["m_date"], m_bad)):
            if bad and stored - off != timedelta(days=1):
                plan["held"].append({"source_meeting_id": r["sid"], "meeting_id": r["mid"], "reason": f"{label} date {stored} is not official {off} + 1 day"})
                break
        else:
            entry = {"source_meeting_id": r["sid"], "source_id": r["source_id"], "official_date": off.isoformat(),
                     "source_old_date": r["s_date"].isoformat(), "source_needs_update": s_bad,
                     "meeting_id": r["mid"], "meeting_old_date": r["m_date"].isoformat() if r["mid"] else None,
                     "meeting_needs_update": m_bad, "type": r["mtype"], "old_slug": r["slug"], "archive_path": r["archive_path"],
                     "source_status": r["s_status"]}
            if m_bad:
                pdf = minutes_pdf(cur, r["mid"], r["archive_path"], archive_root)
                verdict = page1_mentions(pdf, off) if pdf else None
                entry["minutes_page1_has_official_date"] = verdict
                if verdict is False:
                    plan["held"].append({"meeting_id": r["mid"], "reason": f"minutes page 1 lacks official date {off}"}); continue
                plan["meetings"].append(entry)
            else:
                plan["source_only"].append(entry)
    # Slug-only pass: meetings whose date is already right (fixed earlier) but whose slug still has the old date.
    planned = {e["meeting_id"] for e in plan["meetings"]}
    cur.execute("SELECT id, meeting_date, slug, type::text AS type FROM meetings WHERE slug ~ '^\\d{4}-\\d{2}-\\d{2}-' AND left(slug, 10) <> meeting_date::text")
    for r in cur.fetchall():
        if r["id"] not in planned:
            plan["slug_only"].append({"meeting_id": r["id"], "official_date": r["meeting_date"].isoformat(), "type": r["type"], "old_slug": r["slug"]})
    ids = [e["meeting_id"] for e in plan["meetings"]]
    # Guard: attendance evidence keyed on the old date would flip to "unknown" in the web app.
    cur.execute("SELECT meeting_id, notes FROM attendance WHERE meeting_id = ANY(%s) AND notes LIKE '%%local_date%%'", (ids,))
    old = {e["meeting_id"]: e["meeting_old_date"] for e in plan["meetings"]}
    plan["evidence_conflicts"] = sorted({r["meeting_id"] for r in cur.fetchall()
                                         if (json.loads(r["notes"]) if r["notes"].startswith("{") else {}).get("local_date") == old[r["meeting_id"]]})
    # Slug proposal (chain-aware: slugs vacated by this batch become available).
    cur.execute("SELECT id, slug, municipality_id FROM meetings WHERE slug IS NOT NULL")
    taken = {(r["municipality_id"], r["slug"]): r["id"] for r in cur.fetchall()}
    cur.execute("SELECT to_regclass('public.meeting_slug_history') AS t")
    if cur.fetchone()["t"]:  # an existing redirect must not be shadowed by a new live slug
        cur.execute("SELECT municipality_id, old_slug, meeting_id FROM meeting_slug_history")
        taken.update({(r["municipality_id"], r["old_slug"]): r["meeting_id"] for r in cur.fetchall()})
    renames = plan["meetings"] + plan["slug_only"]
    cur.execute("SELECT id, municipality_id FROM meetings WHERE id = ANY(%s)", ([e["meeting_id"] for e in renames],))
    muni = {r["id"]: r["municipality_id"] for r in cur.fetchall()}
    for e in renames:
        taken.pop((muni[e["meeting_id"]], e["old_slug"]), None)
    for e in sorted(renames, key=lambda e: e["meeting_id"]):
        base = f"{e['official_date']}-{slugify(e['type'])}"
        cand, n = base, 1
        while (muni[e["meeting_id"]], cand) in taken:
            n += 1; cand = f"{base}-{n}"
        taken[(muni[e["meeting_id"]], cand)] = e["meeting_id"]
        e["proposed_slug"] = cand
        e["slug_collision_suffix"] = n > 1
    return plan


def backup(cur, plan: dict, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    mids = [e["meeting_id"] for e in plan["meetings"] + plan["slug_only"]]
    sids = [e["source_meeting_id"] for e in plan["meetings"] + plan["source_only"]]
    cols = lambda t: ", ".join(  # noqa: E731
        f'"{c}"' for c in _columns(cur, t) if c not in EXCLUDE_COLUMNS)
    cur.execute(f"SELECT {cols('meetings')} FROM meetings WHERE id = ANY(%s) ORDER BY id", (mids,))
    meetings = cur.fetchall()
    cur.execute(f"SELECT {cols('source_meetings')} FROM source_meetings WHERE id = ANY(%s) ORDER BY id", (sids,))
    sources = cur.fetchall()
    path = out_dir / f"meeting-dates-backup-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.json"
    path.write_text(json.dumps({"meetings": meetings, "source_meetings": sources, "plan": plan}, default=str, indent=1))
    return path


def _columns(cur, table: str) -> list[str]:
    cur.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=%s ORDER BY ordinal_position", (table,))
    return [r["column_name"] for r in cur.fetchall()]


def print_plan(plan: dict) -> None:
    ms = plan["meetings"]
    print(f"meetings to correct: {len(ms)}   source_meetings-only: {len(plan['source_only'])}   held: {len(plan['held'])}")
    print("by type:", dict(Counter(e["type"] for e in ms)))
    print("by year:", dict(sorted(Counter(e["official_date"][:4] for e in ms).items())))
    print("minutes page-1 check:", dict(Counter(str(e.get("minutes_page1_has_official_date")) for e in ms)))
    print(f"\n{'meeting':>7}  {'old date':10}  {'new date':10}  {'old slug':42} proposed slug")
    for e in ms:
        flag = "  <-- slug collision, suffixed" if e["slug_collision_suffix"] else ""
        print(f"{e['meeting_id']:>7}  {e['meeting_old_date']}  {e['official_date']}  {e['old_slug']:42} {e['proposed_slug']}{flag}")
    for e in plan["slug_only"]:
        print(f"slug-only meeting={e['meeting_id']}  {e['old_slug']} -> {e['proposed_slug']}")
    for e in plan["source_only"]:
        print(f"source-only src={e['source_meeting_id']}  {e['source_old_date']} -> {e['official_date']}  meeting_id={e['meeting_id']} status={e['source_status']}")
    for h in plan["held"]:
        print("HELD", h)
    if plan["evidence_conflicts"]:
        print("\nABORT-GUARD: attendance evidence at the old date exists for meetings", plan["evidence_conflicts"])


def apply_plan(conn, cur, plan: dict, rename_slugs: bool) -> None:
    if plan["evidence_conflicts"]:
        raise SystemExit("refusing: attendance evidence local_date would diverge from meeting_date")
    conn.set_session(isolation_level="SERIALIZABLE", readonly=False)  # must precede any statement
    if rename_slugs:
        cur.execute("SELECT to_regclass('public.meeting_slug_history') AS t")
        if not cur.fetchone()["t"]:
            raise SystemExit("refusing --rename-slugs: table meeting_slug_history does not exist (apply migration 47-26 first)")
    cur.execute("SET LOCAL lock_timeout = '5s'")
    cur.execute("SET LOCAL statement_timeout = '60s'")
    for e in plan["meetings"]:
        cur.execute("UPDATE meetings SET meeting_date=%s WHERE id=%s AND meeting_date=%s",
                    (e["official_date"], e["meeting_id"], e["meeting_old_date"]))
        assert cur.rowcount == 1, f"meeting {e['meeting_id']} changed under us"
    for e in plan["meetings"] + plan["source_only"]:
        if not e["source_needs_update"]:
            continue
        cur.execute("UPDATE source_meetings SET meeting_date=%s WHERE id=%s AND meeting_date=%s",
                    (e["official_date"], e["source_meeting_id"], e["source_old_date"]))
        assert cur.rowcount == 1, f"source_meeting {e['source_meeting_id']} changed under us"
    renames = plan["meetings"] + plan["slug_only"]
    if rename_slugs:
        for e in renames:  # two phases: the unique index is checked per row
            cur.execute("UPDATE meetings SET slug=%s WHERE id=%s AND slug=%s", (f"tmp-{e['meeting_id']}", e["meeting_id"], e["old_slug"]))
            assert cur.rowcount == 1
        for e in renames:
            # History row and new slug in the same transaction: the old URL never 404s.
            cur.execute("INSERT INTO meeting_slug_history (meeting_id, municipality_id, old_slug) SELECT id, municipality_id, %s FROM meetings WHERE id=%s",
                        (e["old_slug"], e["meeting_id"]))
            assert cur.rowcount == 1
            cur.execute("UPDATE meetings SET slug=%s WHERE id=%s AND slug=%s", (e["proposed_slug"], e["meeting_id"], f"tmp-{e['meeting_id']}"))
            assert cur.rowcount == 1
    # Post-conditions
    ids = [e["meeting_id"] for e in plan["meetings"]]
    cur.execute("SELECT count(*) AS n FROM meetings WHERE id = ANY(%s) AND meeting_date::text = ANY(%s)", (ids, [e["official_date"] for e in plan["meetings"]]))
    assert cur.fetchone()["n"] >= len(ids)
    conn.commit()
    print("committed")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--rename-slugs", action="store_true")
    ap.add_argument("--archive-root", default=os.environ.get("ARCHIVE_ROOT", str(Path(__file__).resolve().parents[2])))
    ap.add_argument("--backup-dir", default=str(HERE / "backups"))
    args = ap.parse_args()
    root = Path(args.archive_root)
    conn = psycopg2.connect(config.DATABASE_URL)
    conn.set_session(readonly=True)  # planning (and every dry run) cannot write
    cur = conn.cursor(cursor_factory=RealDictCursor)
    plan = build_plan(cur, root if (root / "archive").is_dir() else None)
    print_plan(plan)
    path = backup(cur, plan, Path(args.backup_dir))
    print(f"\nbackup written: {path}")
    if not args.apply:
        print("DRY RUN: no database writes. Re-run with --apply to commit.")
        conn.rollback()
        return
    conn.rollback()  # end the read-only transaction before switching session characteristics
    apply_plan(conn, cur, plan, args.rename_slugs)


if __name__ == "__main__":
    main()
