"""Add the sub-items a meeting's import collapsed into its section headings ("7. REPORTS" with "a) CRD Regional
Housing First Program" under it in the agenda and minutes, but only "REPORTS" in the database).

The AI refinement of a few meetings returned only the top-level headings. Re-ingesting would delete and recreate every
item (losing recovered motions, staff placements and topic links), so this adds what is missing and changes nothing
else: each sub-item the minutes (or the agenda) print under a heading becomes an item with that heading as its parent,
and a motion moves from the heading (or the meeting's "Official recorded motions") to a new sub-item only when the
minutes place it there unambiguously. Existing rows are never edited apart from that motion move.

    uv run python -m pipeline.backfill.heading_subitems --meeting 58 [--meeting ...] [--apply --backup PATH]
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from pipeline.paths import BASE_DIR

MINUTES_CAP = 60_000
AGENDA_CAP = 14_000


class _Sub(BaseModel):
    item_order: str = Field(description='The sub-item\'s number as printed, written like "7.a", "10.1" or "5.a.2".')
    parent_order: str = Field(description='The top-level heading it sits under, e.g. "7" for "7. REPORTS".')
    title: str = Field(description="The sub-item's title exactly as printed (no page numbers, no 'Staff report' tails).")
    category: str = Field(description="One of: Land Use, Finance, Engineering, Bylaw, Public Safety, Transportation, "
                                      "Governance, Community Services, Parks and Recreation, Housing, Procedural.")
    summary: str = Field(description="One or two plain sentences saying what was decided or discussed, from the minutes only; "
                                     "empty when the minutes say nothing about it.")
    motion_ids: list[int] = Field(description="Ids of the listed motions the minutes record under this sub-item.")


class _Subs(BaseModel):
    items: list[_Sub]


PROMPT = """Below are a council meeting's minutes and the start of its agenda. The meeting's items were stored only as
the top-level section headings listed under HEADINGS. List every numbered or lettered sub-item printed under those
headings (for example "7. REPORTS a) CRD Regional Housing First Program" is sub-item 7.a of heading 7; a committee's
recommendations "5. COMMITTEE RESOLUTIONS a) Planning Committee - Feb 10 1. Application to rezone ..." give 5.a and
5.a.1). Include items added to the agenda at the meeting. Do not invent items: each title must be printed in the
text. Skip procedural lines (call to order, adjournment) and the motion text itself.

For each sub-item, list the ids of the MOTIONS below that the minutes record under it (by where the motion appears).
A motion belongs to at most one sub-item; leave it out if you can't tell.

HEADINGS
{headings}

MOTIONS
{motions}

MINUTES
{minutes}

AGENDA (start)
{agenda}"""


def norm_order(order: str | None) -> str:
    """'7.', '7', '7a', '7(a)', '7 a)' and '7.a' all become '7' / '7.a'."""
    o = (order or "").strip().lower().rstrip(".")
    o = re.sub(r"[()\s]+", ".", o)
    o = re.sub(r"(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)", ".", o)
    return re.sub(r"\.+", ".", o).strip(".")


def words_pattern(text: str, n: int = 5) -> re.Pattern | None:
    words = [w for w in re.findall(r"[A-Za-z0-9]+", text or "") if len(w) > 1][:n]
    if len(words) < 2:
        return None
    return re.compile(r"\W+".join(re.escape(w) for w in words), re.I)


def located(text: str, title: str) -> int:
    """Where the title is printed in the text (its first five words, any punctuation between), or -1."""
    for n in (5, 4, 3):
        pat = words_pattern(title, n)
        if pat and (m := pat.search(text)):
            return m.start()
    return -1


def numbers(text: str) -> set[str]:
    """Distinctive numbers: three to five digits that aren't a year, any bylaw number ("Bylaw No. 1955", whatever its
    digits), and permit or file codes ("DVP21-0002", "Z21-0019")."""
    t = text or ""
    plain = {n for n in re.findall(r"(?<![\d.\-])\d{3,5}(?![\d.\-])", t) if not re.fullmatch(r"(19[5-9]\d|20[0-3]\d)", n)}
    bylaws = set(re.findall(r"\bbylaw\s*(?:nos?\.?\s*)?(\d{3,5})\b", t, re.I))
    codes = {c.upper() for c in re.findall(r"\b[A-Z]{1,4}\d{2}-\d{3,4}\b", t, re.I)}
    return plain | bylaws | codes


def slugify(text: str) -> str:
    s = re.sub(r"[^\w\s-]", "", str(text or "").lower().strip())
    return re.sub(r"[-\s]+", "-", s).strip("-_")


def sources(archive_path: str) -> tuple[str, str]:
    folder = Path(BASE_DIR) / archive_path
    read = lambda name: (folder / name).read_text(errors="ignore") if (folder / name).exists() else ""
    agenda = read("agenda.md")
    agenda = agenda.split("\n---\n", 1)[0][:AGENDA_CAP]
    return read("minutes.md")[:MINUTES_CAP], agenda


def check_plan(subs: list[dict], headings: dict[str, dict], existing: list[dict], minutes: str, agenda: str,
               motions: list[dict]) -> dict[str, Any]:
    """Keep the sub-items that are printed in the text, sit under a stored heading and aren't stored already; keep a
    motion move only when the motion sits on that heading (or the catch-all) and the minutes print it after the
    sub-item's title and before the next sub-item's."""
    have_orders = {norm_order(e["item_order"]) for e in existing}
    have_titles = {slugify(e["title"])[:60] for e in existing}
    add, held = [], []
    for s in subs:
        order, parent = norm_order(s["item_order"]), norm_order(s["parent_order"])
        why = None
        if parent not in headings or not order.startswith(parent + "."):
            why = "not under a stored heading"
        elif order in have_orders or slugify(s["title"])[:60] in have_titles:
            why = "already stored"
        elif located(minutes, s["title"]) < 0 and located(agenda, s["title"]) < 0:
            why = "title not found in the minutes or agenda"
        (held if why else add).append({**s, "item_order": order, "parent_order": parent, **({"why": why} if why else {})})
    # The minutes' order of the new sub-items, for placing motions.
    spots = sorted(((located(minutes, s["title"]), s["item_order"]) for s in add), key=lambda x: x[0])
    spots = [x for x in spots if x[0] >= 0]
    by_id = {m["id"]: m for m in motions}
    claimed: dict[int, list[str]] = {}
    for s in add:
        for mid in s.get("motion_ids") or []:
            claimed.setdefault(mid, []).append(s["item_order"])
    moves, motion_held = [], []
    for mid, orders in claimed.items():
        m = by_id.get(mid)
        if not m:
            continue
        if len(orders) != 1:
            motion_held.append({"motion_id": mid, "why": "claimed by several sub-items"})
            continue
        order = orders[0]
        parent = order.split(".")[0]
        if not (m["on_container"] or norm_order(m["item_order"]) == parent):
            motion_held.append({"motion_id": mid, "why": f"not on heading {parent} or the catch-all"})
            continue
        at = located(minutes, m["text"]) if m["text"] else -1
        start = next((p for p, o in spots if o == order), -1)
        nxt = min((p for p, o in spots if p > start), default=len(minutes) + 1)
        placed = at >= 0 and start >= 0 and start <= at < nxt
        # OCR often rewords a motion slightly ("Bylaw 1885" / "Bylaw No. 1885"): a number the motion shares with
        # this sub-item's title and no other new sub-item's (a bylaw, address or permit number) places it too.
        shared = numbers(m["text"]) & numbers(next(s["title"] for s in add if s["item_order"] == order))
        if not placed and shared and not any(shared & numbers(s["title"]) for s in add if s["item_order"] != order):
            placed = True
        # The heading's only sub-item: a motion recorded under that heading can only be about it.
        if not placed and not m["on_container"] and sum(1 for s in add if s["parent_order"] == parent) == 1:
            placed = True
        if not placed:
            motion_held.append({"motion_id": mid, "why": "the minutes don't place it under that sub-item"})
            continue
        moves.append({"motion_id": mid, "to_order": order})
    return {"add": add, "held": held, "moves": moves, "motions_held": motion_held}


def plan_meeting(cur, meeting_id: int) -> dict[str, Any]:
    from pipeline import ai

    cur.execute("select archive_path, meeting_date from meetings where id = %s", (meeting_id,))
    archive_path, day = cur.fetchone()
    cur.execute("select id, item_order, title from agenda_items where meeting_id = %s order by id", (meeting_id,))
    existing = [{"id": i, "item_order": o, "title": t} for i, o, t in cur.fetchall()]
    headings = {norm_order(e["item_order"]): e for e in existing if re.fullmatch(r"\d+", norm_order(e["item_order"]) or "x")}
    container = next((e["id"] for e in existing if e["item_order"] == "official-recorded-motions"), None)
    cur.execute("""select m.id, m.text_content, a.item_order, m.agenda_item_id from motions m
                   join agenda_items a on a.id = m.agenda_item_id where m.meeting_id = %s order by m.id""", (meeting_id,))
    motions = [{"id": i, "text": t or "", "item_order": o, "on_container": aid == container} for i, t, o, aid in cur.fetchall()]
    minutes, agenda = sources(archive_path)
    result = ai.json(PROMPT.format(
        headings="\n".join(f"{k}. {v['title']}" for k, v in sorted(headings.items(), key=lambda kv: int(kv[0]))),
        motions="\n".join(f"[{m['id']}] (now under {m['item_order']}) {m['text'][:220]}" for m in motions),
        minutes=minutes, agenda=agenda), stage="extraction", schema=_Subs)
    subs = [s.model_dump() for s in result.items]
    checked = check_plan(subs, headings, existing, minutes, agenda, motions)
    return {"meeting_id": meeting_id, "date": str(day), "headings": {k: v["id"] for k, v in headings.items()}, **checked}


def apply_plan(conn, plan: dict) -> dict:
    """Insert the planned sub-items and make the planned motion moves, in one transaction."""
    from pipeline.ingestion.matter_matching import extract_addresses

    meeting_id = plan["meeting_id"]
    ids: dict[str, int] = {}
    with conn.cursor() as cur:
        for s in sorted(plan["add"], key=lambda s: [int(p) if p.isdigit() else p for p in s["item_order"].split(".")]):
            parent_order = s["item_order"].rsplit(".", 1)[0]
            parent_id = ids.get(parent_order) or plan["headings"].get(s["parent_order"])
            addresses = extract_addresses(s["title"])
            slug = f"{meeting_id}-{slugify(s['item_order'])}-{slugify(s['title'])}"[:200]
            cur.execute("""insert into agenda_items (meeting_id, parent_id, item_order, title, category, plain_english_summary,
                                                     related_address, slug, meta)
                           values (%s, %s, %s, %s, %s, %s, %s, %s, %s) on conflict do nothing returning id""",
                        (meeting_id, parent_id, s["item_order"], s["title"][:500], s["category"], s["summary"] or None,
                         json.dumps(addresses) if addresses else None, slug,
                         json.dumps({"key_quotes": [], "added_by": "heading_subitems_backfill"})))
            row = cur.fetchone()
            if row:
                ids[s["item_order"]] = row[0]
        moved = []
        for mv in plan["moves"]:
            target = ids.get(mv["to_order"])
            if not target:
                continue
            cur.execute("""update motions set agenda_item_id = %s,
                             meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('moved_from_heading', agenda_item_id)
                           where id = %s and meeting_id = %s returning id""", (target, mv["motion_id"], meeting_id))
            if cur.fetchone():
                moved.append(mv["motion_id"])
    return {"meeting_id": meeting_id, "added": ids, "moved": moved}


def main():
    from pipeline.db import connect, run_write

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--meeting", type=int, action="append", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--plans", help="Write (dry run) or read (--apply) the plans as JSON here.")
    args = parser.parse_args()
    if args.apply:
        plans = json.loads(Path(args.plans).read_text())
        for p in plans:
            if p["meeting_id"] in args.meeting:
                print(json.dumps(run_write(lambda cur: apply_plan(cur.connection, p))))
        return
    conn = connect()
    conn.set_session(readonly=True)
    plans = []
    try:
        with conn.cursor() as cur:
            for mid in args.meeting:
                plans.append(plan_meeting(cur, mid))
    finally:
        conn.rollback()
        conn.close()
    if args.plans:
        Path(args.plans).write_text(json.dumps(plans, indent=1, default=str))
    for p in plans:
        print(f"meeting {p['meeting_id']} ({p['date']}): add {len(p['add'])}, held {len(p['held'])}, "
              f"move {len(p['moves'])} motions, held {len(p['motions_held'])}")


if __name__ == "__main__":
    main()


STOP = {"the", "and", "for", "from", "with", "report", "staff", "council", "langford", "city", "bylaw", "amendment",
        "zoning", "application", "appendix", "minutes", "meeting", "committee", "attachment", "file"}


def doc_match(doc_title: str, subs: list[dict]) -> dict | None:
    """The one new sub-item a document attached to a heading belongs to: a shared bylaw, address or permit number
    counts three, each shared significant word one; it needs at least three and a clear lead over the next."""
    words = lambda t: {w for w in re.findall(r"[a-z]{4,}", (t or "").lower()) if w not in STOP}
    scored = sorted(((3 * len(numbers(doc_title) & numbers(s["title"])) + len(words(doc_title) & words(s["title"])), s)
                     for s in subs), key=lambda x: -x[0])
    if not scored or scored[0][0] < 3 or (len(scored) > 1 and scored[1][0] >= scored[0][0]):
        return None
    return scored[0][1]


def move_documents(conn, meeting_id: int) -> dict:
    """Documents (and their sections) attached to a heading move to the new sub-item they match, when one does."""
    moved, held = [], []
    with conn.cursor() as cur:
        cur.execute("""select id, item_order, title from agenda_items where meeting_id = %s
                       and meta->>'added_by' = 'heading_subitems_backfill'""", (meeting_id,))
        subs = [{"id": i, "item_order": o, "title": t} for i, o, t in cur.fetchall()]
        cur.execute(r"""select e.id, e.title, a.item_order from extracted_documents e join agenda_items a on a.id = e.agenda_item_id
                        where a.meeting_id = %s and a.item_order ~ '^\d+\.?$'""", (meeting_id,))
        for doc_id, title, order in cur.fetchall():
            parent = norm_order(order)
            under = [s for s in subs if norm_order(s["item_order"]).startswith(parent + ".")]
            best = doc_match(title, under) or doc_match(title, subs)
            if not best:
                held.append(doc_id)
                continue
            cur.execute("update extracted_documents set agenda_item_id = %s where id = %s", (best["id"], doc_id))
            cur.execute("update document_sections set agenda_item_id = %s where extracted_document_id = %s", (best["id"], doc_id))
            moved.append((doc_id, best["item_order"]))
    return {"meeting_id": meeting_id, "moved": moved, "held": held}
