"""A one-sentence summary for agenda items that have a decision but no summary.

The AI refine step writes ``agenda_items.plain_english_summary`` when a meeting is ingested. Items filed afterwards
(the history catch-up reads old minutes, and some items arrive with only a motion) have decisions but no summary, so a
topic's timeline falls back to a glossary line like "Final approval." This stage writes the missing summary from the
item's own record: its title, its decisions, and the other decisions on the same topic (also record). The topic's
model-written summary and the other items' summaries are notes, never a source of facts
(``record_sources.RECORD_RULE``).

It only fills an empty summary, so nothing the refiner or a person wrote is touched, and stamps what it wrote with
``meta.item_summary_version``. Bump ``ITEM_SUMMARY_VERSION`` after a prompt change and run
``main.py --stage item-summaries --stale`` to rewrite only the summaries this stage wrote.
"""
from __future__ import annotations

import json

from pydantic import BaseModel
from supabase import Client

from pipeline import ai
from pipeline.ai import glossary
from pipeline.ingestion.record_sources import RECORD_RULE

ITEM_SUMMARY_VERSION = "1"
BATCH_SIZE = 20
MAX_SUMMARY_CHARS = 300
OTHER_DECISIONS = 8  # nearest decisions on the same topic given as context

SYSTEM = """You write the one-line summary under an agenda item's title on a council transparency site for residents.
Each summary is ONE sentence, at most 30 words, saying what Council did at this item in everyday words.
Start with the outcome ("Adopted…", "Gave first, second and third readings to…", "Cancelled…", "Turned down…"), then
what it was about: the thing, the place or the amount, when the record says it.
Where another decision on the same topic explains this one (the old bylaw it replaces, the reading before it), say so
briefly in plain words.
No bylaw or permit numbers, file numbers, quotation marks, or "Council" as the subject.
When the record gives nothing beyond a bare procedural step, say just that step; never pad it.
Never invent details that are not in the record.
""" + RECORD_RULE + """ Here the record is the item's title, its decisions (wording and result), and the other decisions
on the same topic (wording, result, date). The topic's summary and the other items' summaries are notes: they say what
to look for, never what is true."""

SYSTEM = SYSTEM + "\n\n" + glossary.prompt_block("resident", only=glossary.ids(["bylaws", "land"], plus=["carried", "defeated", "tabled", "referred", "rescinded", "withdrawn", "closed-meeting", "notice-of-motion"]))


class ItemSummary(BaseModel):
    id: int
    summary: str


class ItemSummaries(BaseModel):
    items: list[ItemSummary]


def decided(motion: dict) -> bool:
    """A decision worth summarising: it has an outcome and isn't housekeeping (agenda, minutes, adjournment)."""
    return bool(motion.get("result")) and motion.get("disposition") != "Procedural"


def is_container(item: dict) -> bool:
    """The history catch-up's catch-all for decisions it couldn't file under an item: not an agenda item to summarise."""
    return item.get("item_order") == "official-recorded-motions" or (item.get("title") or "").lower().startswith("official recorded motions")


def written_here(item: dict) -> bool:
    """A summary this stage wrote (it carries the stage's stamp), as opposed to the refiner's or a person's."""
    return bool((item.get("meta") or {}).get("item_summary_version"))


def needs_summary(item: dict, motions: list[dict]) -> bool:
    """Items to write: no summary of their own, or one this stage wrote under an older version; never a person's edit
    and never the refiner's text. Each needs at least one decision."""
    meta = item.get("meta") or {}
    if meta.get("manual") or is_container(item):
        return False
    has_text = bool((item.get("plain_english_summary") or "").strip())
    if has_text and not (written_here(item) and meta.get("item_summary_version") != ITEM_SUMMARY_VERSION):
        return False
    return any(decided(m) for m in motions)


def _prompt(rows: list[dict]) -> str:
    items = [
        {
            "id": r["id"],
            "record": {
                "item_title": r.get("title") or "",
                "meeting": r.get("meeting") or "",
                "decisions": [{"wording": m.get("text_content") or "", "result": m.get("result") or ""} for m in r.get("motions") or []],
                "other_decisions_on_this_topic": r.get("others") or [],
            },
            "notes": {"topic": r.get("topic_title") or "", "topic_summary": r.get("topic_summary") or ""},
        }
        for r in rows
    ]
    return (
        "Write the summary for each agenda item below: one entry in `items` per item, same ids.\n\n"
        + json.dumps(items, ensure_ascii=False)
    )


def _clean(result: ItemSummaries) -> dict[int, str]:
    out: dict[int, str] = {}
    for item in result.items:
        text = " ".join(item.summary.split()).strip().strip('"').strip()
        if 15 <= len(text) <= MAX_SUMMARY_CHARS:
            out[item.id] = text if text.endswith((".", "!", "?")) else text + "."
    return out


def _others(item: dict, siblings: list[dict], motions_by_item: dict[int, list[dict]], dates: dict[int, str]) -> list[dict]:
    """The other decisions on the item's topic, nearest in time first: record context for what this step did."""
    own_date = dates.get(item["id"]) or ""
    rows = []
    for s in siblings:
        if s["id"] == item["id"]:
            continue
        for m in motions_by_item.get(s["id"], []):
            if decided(m):
                rows.append({"date": dates.get(s["id"]) or "", "wording": m.get("text_content") or "", "result": m.get("result") or "",
                             "same_meeting": s.get("meeting_id") == item.get("meeting_id")})
    rows.sort(key=lambda r: (abs(_days(r["date"]) - _days(own_date)), r["date"]))
    return rows[:OTHER_DECISIONS]


def _days(date: str) -> int:
    try:
        y, m, d = (int(x) for x in date[:10].split("-"))
        return y * 372 + m * 31 + d
    except ValueError:
        return 0


def summarize_meeting_items(supabase: Client, meeting_id: int, *, dry_run: bool = False) -> dict[int, str]:
    """Write the missing summaries for one meeting's items. Returns {item_id: summary}."""
    items = (
        supabase.table("agenda_items").select("id, title, item_order, matter_id, meeting_id, plain_english_summary, meta")
        .eq("meeting_id", meeting_id).order("id").execute().data
    ) or []
    items = [i for i in items if not (i.get("meta") or {}).get("manual") and not is_container(i)
             and (not (i.get("plain_english_summary") or "").strip() or (written_here(i) and i["meta"].get("item_summary_version") != ITEM_SUMMARY_VERSION))]
    if not items:
        return {}
    motions = (
        supabase.table("motions").select("agenda_item_id, text_content, result, disposition")
        .in_("agenda_item_id", [i["id"] for i in items]).not_.is_("result", "null").order("id").execute().data
    ) or []
    by_item: dict[int, list[dict]] = {}
    for m in motions:
        by_item.setdefault(m["agenda_item_id"], []).append(m)
    items = [i for i in items if needs_summary(i, by_item.get(i["id"], []))]
    if not items:
        return {}

    meeting = (supabase.table("meetings").select("title, meeting_date").eq("id", meeting_id).execute().data or [{}])[0]
    matter_ids = sorted({i["matter_id"] for i in items if i.get("matter_id")})
    matters: dict[int, dict] = {}
    siblings: dict[int, list[dict]] = {}
    sibling_motions: dict[int, list[dict]] = {}
    dates: dict[int, str] = {i["id"]: meeting.get("meeting_date") or "" for i in items}
    if matter_ids:
        for row in supabase.table("matters").select("id, title, plain_english_summary").in_("id", matter_ids).execute().data or []:
            matters[row["id"]] = row
        rows = (
            supabase.table("agenda_items").select("id, matter_id, meeting_id, meetings!inner(meeting_date)").in_("matter_id", matter_ids).order("id").execute().data
        ) or []
        for r in rows:
            siblings.setdefault(r["matter_id"], []).append(r)
            mt = r.get("meetings")
            dates[r["id"]] = (mt[0] if isinstance(mt, list) else mt or {}).get("meeting_date") or ""
        sibling_ids = [r["id"] for r in rows]
        for start in range(0, len(sibling_ids), 200):
            for m in (supabase.table("motions").select("agenda_item_id, text_content, result, disposition")
                      .in_("agenda_item_id", sibling_ids[start:start + 200]).not_.is_("result", "null").order("id").execute().data or []):
                sibling_motions.setdefault(m["agenda_item_id"], []).append(m)

    prompts = []
    for i in items:
        topic = matters.get(i.get("matter_id") or 0) or {}
        prompts.append({
            "id": i["id"], "title": i.get("title"), "meeting": f"{meeting.get('title') or 'Meeting'}, {meeting.get('meeting_date') or ''}".strip(", "),
            "motions": [m for m in by_item.get(i["id"], []) if decided(m)],
            "others": _others(i, siblings.get(i.get("matter_id") or 0, []), sibling_motions, dates),
            "topic_title": topic.get("title"), "topic_summary": topic.get("plain_english_summary"),
        })

    written: dict[int, str] = {}
    for start in range(0, len(prompts), BATCH_SIZE):
        result = ai.json(_prompt(prompts[start:start + BATCH_SIZE]), stage="writing", schema=ItemSummaries, system=SYSTEM)
        written.update({k: v for k, v in _clean(result).items() if k in {i["id"] for i in items}})
    if not dry_run:
        by_id = {i["id"]: i for i in items}
        for item_id, summary in written.items():
            meta = {**(by_id[item_id].get("meta") or {}), "item_summary_version": ITEM_SUMMARY_VERSION}
            # Only over what was there when read (nothing, or this stage's older text): a refine or a person's text that
            # landed meanwhile stays.
            before = by_id[item_id].get("plain_english_summary")
            query = supabase.table("agenda_items").update({"plain_english_summary": summary, "meta": meta}).eq("id", item_id).eq("meeting_id", meeting_id)
            (query.eq("plain_english_summary", before) if before else query.is_("plain_english_summary", "null")).execute()
    return written
