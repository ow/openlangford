"""Dry-run census of the history catch-up (pipeline.backfill.history_coverage) over every meeting of a body.

Runs the catch-up's own audit, read-only, in batches of 20 meetings: for each meeting it reports the motions the
catch-up would add (on their agenda item or in the "Official recorded motions" catch-all), earlier AI-read rows it
would rebind to the recorded wording, and what it holds back (by reason). Nothing is written to the database; the
JSON keeps every meeting's plan so a reviewer can read the exact motions and quotes.

    uv run python -m pipeline.backfill.motion_recovery --body Council --out DIR [--meeting ID ...] [--workers N]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlsplit


def _project_ref() -> str:
    from pipeline import config
    return (urlsplit(config.SUPABASE_URL).hostname or "").split(".")[0]


def audit_batch(meeting_ids: list[int]) -> list[dict]:
    """The catch-up audit for up to 20 meetings, on a read-only connection."""
    from pipeline.backfill.history_coverage import audit
    from pipeline.db import connect
    from pipeline.paths import BASE_DIR

    root = Path(BASE_DIR)
    connection = connect()
    connection.set_session(readonly=True)
    try:
        plans = []
        for meeting_id in meeting_ids:  # one at a time, so one meeting's failure is reported, not fatal
            try:
                plans += audit(connection, [meeting_id], 1, root, root / "reports" / "vote-policy" / "sources",
                               _project_ref())["meetings"]
            except Exception as error:
                connection.rollback()
                plans.append({"meeting_id": meeting_id, "coverage": f"error:{type(error).__name__}:{str(error)[:200]}"})
        return plans
    finally:
        connection.rollback()
        connection.close()


def meetings_for(body: str) -> list[int]:
    from pipeline.db import connect
    connection = connect()
    connection.set_session(readonly=True)
    try:
        with connection.cursor() as cursor:
            cursor.execute("""SELECT m.id FROM meetings m JOIN organizations o ON o.id = m.organization_id
                              WHERE o.classification = %s AND m.archive_path IS NOT NULL AND m.municipality_id = 1
                              ORDER BY m.meeting_date, m.id""", (body,))
            return [row[0] for row in cursor.fetchall()]
    finally:
        connection.rollback()
        connection.close()


def summarise(plan: dict) -> dict:
    new = plan.get("new_motions") or []
    return {"meeting_id": plan["meeting_id"], "date": plan.get("meeting_date"), "coverage": plan.get("coverage"),
            "stored": plan.get("stored_motions"), "parsed_blocks": plan.get("parsed_blocks"),
            "added": len(new), "on_item": sum(1 for m in new if m.get("parent_agenda_id")),
            "catch_all": sum(1 for m in new if not m.get("parent_agenda_id")),
            "rebound": len(plan.get("rebinds") or []),
            "held": dict(Counter(h.get("reason") for h in plan.get("held") or [])),
            "unmapped_legacy": len((plan.get("source_report") or {}).get("unmapped_legacy_ids") or [])}


def describe(rows: list[dict], label: str) -> str:
    totals, held, coverage = Counter(), Counter(), Counter()
    for r in rows:
        for key in ("stored", "parsed_blocks", "added", "on_item", "catch_all", "rebound", "unmapped_legacy"):
            totals[key] += r.get(key) or 0
        held.update(r.get("held") or {})
        coverage[(r.get("coverage") or "").split(":")[0]] += 1
    return "\n".join([
        f"## {label} ({len(rows)} meetings)", "",
        f"- Motions stored now: {totals['stored']}; recorded motions parsed from the minutes: {totals['parsed_blocks']}",
        f"- Would add: {totals['added']} ({totals['on_item']} on their agenda item, {totals['catch_all']} in the catch-all)",
        f"- Earlier AI-read rows rebound to the recorded wording: {totals['rebound']}",
        f"- Earlier rows still unmatched: {totals['unmapped_legacy']}",
        f"- Coverage: {dict(coverage.most_common())}",
        f"- Held (by reason): {dict(held.most_common())}"])


def run(ids: list[int], workers: int) -> list[dict]:
    batches = [ids[i:i + 20] for i in range(0, len(ids), 20)]
    plans = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for n, future in enumerate(as_completed([pool.submit(audit_batch, b) for b in batches]), 1):
            plans += future.result()
            print(f"  batch {n}/{len(batches)}", file=sys.stderr, flush=True)
    return sorted(plans, key=lambda p: (str(p.get("meeting_date")), p["meeting_id"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--body", default="Council")
    parser.add_argument("--meeting", type=int, action="append")
    parser.add_argument("--out", required=True)
    parser.add_argument("--label", default="Dry run")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    ids = args.meeting or meetings_for(args.body)
    plans = run(ids, args.workers)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "plans.json").write_text(json.dumps(plans, default=str, ensure_ascii=False))
    rows = [summarise(p) for p in plans]
    (out / "summary.json").write_text(json.dumps(rows, default=str, indent=1))
    (out / "summary.md").write_text(describe(rows, args.label))
    print(describe(rows, args.label))


if __name__ == "__main__":
    main()
