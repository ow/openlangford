"""Tidy topics that shouldn't exist (stage ``topic-tidy``).

Two kinds slipped through ingest:

- Heading topics: an agenda section heading ("DEVELOPMENT VARIANCE PERMIT (block)") carried its sub-items'
  addresses, looked eligible, became a topic, and unrelated applications were matched into it. Ingest now refuses
  headings (matter_matching.SECTION_HEADING) and never matches into one; here each existing heading topic's items
  are rehomed the way ingest files an item (an existing topic by identifier, address or title, else a new one),
  heading items themselves are left unfiled, and the heading topic is hidden as a container.
- Heading entries: a topic (titled by the model, e.g. "Bylaw readings and adoption") whose entry is itself a section
  heading ("BYLAWS", "PUBLIC HEARING", "REPORTS", "Planning, Zoning and Affordable Housing Committee - October 23rd,
  2017"). The heading check looked at topic titles, which the model had made specific; the entry's own heading is
  what shows it's a section. Such entries are taken off their topic (in-camera "rise and report" and public
  participation entries excepted: those often carry one real decision or a resident's own subject).
- Empty topics: re-processing a meeting can file its items under different topics and leave the old ones with
  nothing on them. An empty topic with a same-named live sibling becomes that sibling's alias (its address
  redirects there); otherwise it's hidden as "no_records" (shown again automatically if something links to it).

Items staff placed by hand (agenda_items.meta.staff_matter) are never moved.
"""
from __future__ import annotations

import json
import re
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


# Headings that often hold one real decision, or a resident's own subject: left on their topics.
KEEP_HEADINGS = re.compile(r"in[\s‘’'-]*camera|rise and report|public participation|council resolution|presentation", re.I)
MONTH_DAY = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b"
COMMITTEE_DATED = re.compile(rf"(?:committee\b|^protective services|^planning,? zoning)[^-–—]*[-–—]\s*{MONTH_DAY}", re.I)


def bare_heading(title: str) -> bool:
    """A heading with nothing after it ("BYLAWS", "12. REPORTS", "PUBLIC HEARINGS", "Protective Services Committee -
    June 22, 2021"), not a section prefix followed by the item's own subject ("REPORTS - Show and Shine lane
    closures", "COMMITTEE RESOLUTIONS a) Peatt Road 3D crosswalk")."""
    rest = re.sub(r"^\s*\d+[.)]?\s*", "", title)
    if COMMITTEE_DATED.search(rest):
        return True
    return not re.search(r"\s[-–—:]\s*\S|:\s*\S|\b[a-z]\)\s", rest)


# A summary that only says the section held other business ("Public hearings were opened and closed for four bylaws
# listed below", "Committee recommendations on multiple planning matters").
SECTION_SUMMARY = re.compile(
    r"\b(?:listed (?:below|in)|as listed|sub-?items|items were listed|were opened and closed"
    r"|(?:multiple|several|various) (?:bylaws|zoning bylaws|staff reports|reports|planning (?:matters|recommendations|applications)"
    r"|(?:committee )?recommendations|items|matters|bylaw readings)"
    r"|committee(?:'s)? minutes and (?:multiple|considered))\b", re.I)


# A section name and nothing else ("REPORTS", "10. BYLAWS"): as a topic's only entry it is the section, whatever its
# summary says (the summary then describes every item under it, "Council considered five staff reports…").
SECTION_WORD = re.compile(r"^\s*(?:\d+[.)]?\s*)?(?:staff\s+)?(?:reports?|bylaws?|correspondence|business arising|new business"
                          r"|unfinished business|consent agenda)\s*$", re.I)


def heading_entries(cur, ids: list[int] | None = None) -> list[tuple]:
    """(item id, topic id, title, meta) for entries that are bare section headings on a visible topic: a heading
    title AND nothing of their own (sub-items carry the business, or the summary is empty or only describes the
    section). Older imports often titled a real item with its section ("REPORTS - Show and Shine lane closures",
    "12. REPORTS" holding the budget decision): those have a summary of their own and stay."""
    cur.execute("""select a.id, a.matter_id, a.title, a.meta, a.meeting_id, coalesce(a.item_order, ''),
                          coalesce(a.plain_english_summary, ''),
                          (select count(*) from agenda_items b where b.meeting_id = a.meeting_id and b.id <> a.id
                             and a.item_order is not null and b.item_order like rtrim(a.item_order, '.') || '_%%'
                             and length(b.item_order) > length(rtrim(a.item_order, '.')))
                   from agenda_items a join matters m on m.id = a.matter_id
                   where m.meta->>'canonical_matter_id' is null and m.meta->>'hidden' is null""")
    first = lambda t: (t or "").split("\n")[0].strip()
    out = []
    rows = cur.fetchall()
    sizes = __import__("collections").Counter(r[1] for r in rows)
    for i, mid, t, meta, _meeting, _order, summary, subs in rows:
        if ids is not None and mid not in ids:
            continue
        head = first(t)
        if not is_generic_or_procedural_matter(head) or KEEP_HEADINGS.search(head) or not bare_heading(head):
            continue
        # A bare heading with no summary of its own on a topic with other entries was likely filed there by address
        # (an old "PUBLIC HEARING" entry for that rezoning): left alone. As a topic's only entry, it made the topic.
        # A summary of its own that says something specific keeps it, whatever its heading.
        if SECTION_SUMMARY.search(summary) or (not summary.strip() and (subs or sizes[mid] == 1)) \
                or (sizes[mid] == 1 and SECTION_WORD.match(" ".join((t or "").split()))):  # the whole title, not just line one
            out.append((i, mid, t, meta))
    return out


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
    report["heading_entries"] = []
    for item_id, mid, title, meta in heading_entries(cur, matter_ids):
        if staff_matter(meta):
            continue  # placed by staff
        report["heading_entries"].append({"item": item_id, "from": mid, "title": (title or "").splitlines()[0][:90]})
        report["touched"].append(mid)
        if not dry_run:
            supabase.table("agenda_items").update({"matter_id": None, "meta": {**(meta or {}), "matter_match": {
                "reason": "section_heading_entry", "from": mid, "at": now}}}).eq("id", item_id).execute()
            supabase.table("property_links").update({"matter_id": None}).eq("agenda_item_id", item_id).execute()
    log(f"  [tidy] {len(report['heading_entries'])} section-heading entr{'y' if len(report['heading_entries']) == 1 else 'ies'} taken off topics")
    if not dry_run and report["heading_entries"]:
        # A topic the heading made, now with no entries of its own, is hidden even if a stray mention still points
        # at it (the empty-topic rule below keeps topics with mentions).
        emptied = sorted({e["from"] for e in report["heading_entries"]})
        rows = supabase.table("agenda_items").select("matter_id").in_("matter_id", emptied).execute().data or []
        for mid in sorted(set(emptied) - {r["matter_id"] for r in rows}):
            meta = supabase.table("matters").select("meta").eq("id", mid).single().execute().data.get("meta") or {}
            if meta.get("hidden") or meta.get("canonical_matter_id"):
                continue
            supabase.table("matters").update({"meta": {**meta, "hidden": "container",
                "tidied": {"at": now, "reason": "made from a section heading"}}}).eq("id", mid).execute()
            report.setdefault("heading_topics_hidden", []).append(mid)
        log(f"  [tidy] {len(report.get('heading_topics_hidden', []))} topic(s) made from a section heading hidden")
    if report["heading_entries"] and dry_run:
        # In a dry run nothing moved, so count topics the pass would empty as empty too.
        left = {e["from"] for e in report["heading_entries"]}
        cur.execute("select matter_id, count(*) from agenda_items where matter_id = any(%s) group by 1", (list(left),))
        counts = dict(cur.fetchall())
        taken = __import__("collections").Counter(e["from"] for e in report["heading_entries"])
        report["would_empty"] = sorted(m for m in left if counts.get(m, 0) <= taken[m])
        log(f"  [tidy] {len(report['would_empty'])} topic(s) would be left with nothing")
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
