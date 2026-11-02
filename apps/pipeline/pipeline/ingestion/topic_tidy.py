"""Tidy topics that shouldn't exist (stage ``topic-tidy``).

Two kinds slipped through ingest:

- Heading topics: an agenda section heading ("DEVELOPMENT VARIANCE PERMIT (block)") carried its sub-items'
  addresses, looked eligible, became a topic, and unrelated applications were matched into it. Ingest now refuses
  headings (matter_matching.SECTION_HEADING) and never matches into one; here each existing heading topic's items
  are rehomed the way ingest files an item (an existing topic by identifier, address or title, else a new one),
  heading items themselves are left unfiled, and the heading topic is hidden as a container.
- Empty topics: re-processing a meeting can file its items under different topics and leave the old ones with
  nothing on them. An empty topic with a same-named live sibling becomes that sibling's alias (its address
  redirects there); otherwise it's hidden as "no_records" (shown again automatically if something links to it).

Items staff placed by hand (agenda_items.meta.staff_matter) are never moved.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from pipeline.ingestion.matter_matching import MatterMatcher, is_generic_or_procedural_matter, is_matter_eligible
from pipeline.ingestion.staff_fixes import staff_matter


class _Filer:
    """Just enough of the ingester to file an item under a topic the way ingest does."""

    def __init__(self, supabase, municipality_id: int):
        self.supabase = supabase
        self.municipality_id = municipality_id
        self.matcher = MatterMatcher(supabase, municipality_id)
        self.matcher.load()

    last_matter_match = None

    def file(self, item: dict, date: str | None, dry_run: bool) -> int | None:
        from pipeline.ingestion.ingester import MeetingIngester
        from pipeline.ingestion.matter_names import file_numbers

        numbers = file_numbers(item.get("title"))
        addresses = item.get("related_address") or []
        return MeetingIngester.get_or_create_matter(self, numbers[0] if numbers else None, item.get("title"), date, dry_run,
                                            related_addresses=addresses)


def _visible(cur, where: str, params: tuple = ()) -> list[tuple]:
    cur.execute(f"""select m.id, m.title, coalesce(m.meta->>'display_title', m.title), m.municipality_id, m.meta
                    from matters m where m.meta->>'canonical_matter_id' is null and m.meta->>'hidden' is null and {where}""",
                params)
    return cur.fetchall()


def heading_topics(cur) -> list[tuple]:
    return [r for r in _visible(cur, "true") if is_generic_or_procedural_matter(r[1])]


def empty_topics(cur, ids: list[int] | None = None) -> list[tuple]:
    where = """not exists (select 1 from agenda_items a where a.matter_id = m.id)
      and not exists (select 1 from agenda_items a where a.matter_id::text in
                      (select jsonb_array_elements_text(coalesce(m.meta->'merged_matter_ids', '[]'::jsonb))))
      and not exists (select 1 from matter_links l where l.matter_id = m.id and l.kind = 'mention' and not l.hidden)
      and not exists (select 1 from matter_report_mentions r where r.matter_id = m.id and not r.hidden)"""
    if ids is not None:
        where += " and m.id = any(%s)"
        return _visible(cur, where, (ids,))
    return _visible(cur, where)


def run(supabase, *, dry_run: bool = True, matter_ids: list[int] | None = None, log=print) -> dict[str, Any]:
    from pipeline.db import connect
    from pipeline.ingestion.matter_summaries import refresh_matter_summaries

    conn = connect()
    conn.set_session(readonly=True)
    cur = conn.cursor()
    headings = heading_topics(cur) if matter_ids is None else [r for r in heading_topics(cur) if r[0] in matter_ids]
    plan_items: dict[int, list[dict]] = {}
    for mid, *_ in headings:
        cur.execute("""select a.id, a.title, a.related_address, a.plain_english_summary, a.meta, mt.meeting_date
                       from agenda_items a join meetings mt on mt.id = a.meeting_id where a.matter_id = %s order by mt.meeting_date""",
                    (mid,))
        plan_items[mid] = [dict(zip(["id", "title", "related_address", "summary", "meta", "date"], r)) for r in cur.fetchall()]
    conn.rollback()
    now = datetime.now(timezone.utc).isoformat()
    report: dict[str, Any] = {"headings": [], "empty_aliased": [], "empty_hidden": [], "touched": []}

    filer = _Filer(supabase, headings[0][3]) if headings else None
    for mid, title, display, municipality_id, meta in headings:
        moves = []
        for item in plan_items[mid]:
            if staff_matter(item["meta"]):
                continue  # placed by staff
            eligible, why = is_matter_eligible(identifier=None, title=item["title"], related_addresses=item["related_address"] or [],
                                                summary=item["summary"])
            target = None
            if eligible:
                filer.matcher.matters = [m for m in filer.matcher.matters if m["id"] != mid]
                target = filer.file(item, str(item["date"]), dry_run)
                if target == mid:
                    target = None
            moves.append({"item": item["id"], "title": (item["title"] or "").splitlines()[0][:90], "to": target, "why": why})
            if not dry_run:
                note = getattr(filer, "last_matter_match", None) if target else None
                supabase.table("agenda_items").update({"matter_id": target, "meta": {**(item["meta"] or {}),
                    **({"matter_match": note} if note else {})}}).eq("id", item["id"]).execute()
                supabase.table("property_links").update({"matter_id": target}).eq("agenda_item_id", item["id"]).execute()
            if target:
                report["touched"].append(target)
        report["headings"].append({"id": mid, "title": title, "moves": moves})
        log(f"  [tidy] heading topic {mid} '{title}': {len(moves)} item(s) rehomed")
        if not dry_run:
            supabase.table("matters").update({"meta": {**(meta or {}), "hidden": "container",
                                                       "tidied": {"at": now, "reason": "section heading", "items": moves}}}).eq("id", mid).execute()

    conn = connect()
    conn.set_session(readonly=True)
    cur = conn.cursor()
    empties = empty_topics(cur, matter_ids)
    siblings: dict[int, int | None] = {}
    for mid, title, display, _, meta in empties:
        cur.execute("""select m.id from matters m where m.id <> %s and m.meta->>'canonical_matter_id' is null
                       and m.meta->>'hidden' is null and coalesce(m.meta->>'display_title', m.title) = %s
                       and exists (select 1 from agenda_items a where a.matter_id = m.id) order by m.first_seen limit 1""",
                    (mid, display))
        row = cur.fetchone()
        siblings[mid] = row[0] if row else None
    conn.rollback()
    conn.close()
    for mid, title, display, _, meta in empties:
        sibling = siblings[mid]
        if sibling:
            report["empty_aliased"].append({"id": mid, "title": display, "into": sibling})
            report["touched"].append(sibling)
            if not dry_run:
                supabase.table("matters").update({"meta": {**(meta or {}), "canonical_matter_id": sibling,
                                                           "merge_reason": "empty duplicate (topic tidy)"}}).eq("id", mid).execute()
                target = supabase.table("matters").select("meta").eq("id", sibling).single().execute().data
                tmeta = target.get("meta") or {}
                merged = sorted(set(tmeta.get("merged_matter_ids") or []) | {mid})
                supabase.table("matters").update({"meta": {**tmeta, "merged_matter_ids": merged}}).eq("id", sibling).execute()
        else:
            report["empty_hidden"].append({"id": mid, "title": display})
            if not dry_run:
                supabase.table("matters").update({"meta": {**(meta or {}), "hidden": "no_records",
                                                           "tidied": {"at": now, "reason": "nothing on it"}}}).eq("id", mid).execute()
    log(f"  [tidy] {len(report['headings'])} heading topic(s), {len(report['empty_aliased'])} empty duplicate(s) redirected, "
        f"{len(report['empty_hidden'])} empty topic(s) hidden" + (" (dry run)" if dry_run else ""))
    if not dry_run and report["touched"]:
        refresh_matter_summaries(supabase, sorted(set(report["touched"])))
    return report


def describe(report: dict) -> str:
    return json.dumps(report, default=str, indent=1)
