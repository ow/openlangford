"""Short, punchy headlines for council decisions.

Motion summaries stay as full sentences that say what a decision does. The
home page leads with decisions, so each non-procedural motion also gets a
newspaper-style headline in ``motions.meta.headline``, stamped with
``meta.headline_version``. Bump ``HEADLINE_VERSION`` after a prompt change and
run ``main.py --stage motion-headlines --stale``.
"""
from __future__ import annotations

import json

from pydantic import BaseModel
from supabase import Client

from pipeline import ai
from pipeline.ai import glossary
from pipeline.ingestion.record_sources import RECORD_RULE

HEADLINE_VERSION = "3"  # 3: glossary block (resident register); 2: Terra, record vs notes

SYSTEM = """You write headlines for council decisions in a small Canadian city, for residents skimming a front page.
Each headline is 3 to 8 words, sentence case, no trailing period.
Lead with what changes for residents (the thing, place or amount), not with a verb like "Adopted" or "Approved".
Say what it means in practice, in everyday words ("garbage", not "solid waste"; "developers", not "development charges").
Prefer concrete nouns: the street, the facility, the dollar amount, who is affected.
Avoid ending on a filler verb like "adopted" or "approved" when a more specific one fits.
Write like a newspaper: "Garbage pickup capped at $280", "Developers to pay toward new parks", "Clinic cleared for Happy Valley Road".
When the motion failed, say so: "Bid to extend patio hours rejected".
When it is a bylaw step short of adoption, say so in the site's words: "Walfred Road rezoning one step from final approval".
No bylaw or permit numbers, policy codes, quotation marks, "Council" as the subject, or the city name.
Never invent details that are not in the inputs.
""" + RECORD_RULE + """ Here the record is each motion's wording, its result and its agenda item title; the decision
summary is a note."""


SYSTEM = SYSTEM + "\n\n" + glossary.prompt_block("resident", only=glossary.ids(["bylaws", "land"], plus=["carried", "defeated", "tabled", "referred", "rescinded", "withdrawn", "closed-meeting", "notice-of-motion"]))

class MotionHeadline(BaseModel):
    id: int
    headline: str


class MotionHeadlines(BaseModel):
    motions: list[MotionHeadline]


def _prompt(rows: list[dict]) -> str:
    items = [
        {
            "id": r["id"],
            "agenda_item": r.get("agenda_title") or "",
            "record": {"motion_text": r.get("text_content") or "", "result": r.get("result") or ""},
            "notes": {"decision_summary": r.get("plain_english_summary") or ""},
        }
        for r in rows
    ]
    return (
        "Write a headline for each decision below: one entry in `motions` per decision, same ids.\n\n"
        + json.dumps(items, ensure_ascii=False)
    )


def _clean(result: MotionHeadlines) -> dict[int, str]:
    out: dict[int, str] = {}
    for item in result.motions:
        headline = item.headline.strip().strip('"').strip().rstrip(".").strip()
        if headline:
            out[item.id] = headline
    return out


def headline_meeting_motions(supabase: Client, meeting_id: int, *, dry_run: bool = False) -> dict[int, str]:
    """Write headlines for a meeting's non-procedural motions. Returns {motion_id: headline}."""
    motions = (
        supabase.table("motions")
        .select("id, text_content, result, plain_english_summary, agenda_item_id, disposition, meta")
        .eq("meeting_id", meeting_id)
        .neq("disposition", "Procedural")
        .not_.is_("result", "null")
        .order("id")
        .execute()
        .data
    ) or []
    motions = [m for m in motions if m.get("plain_english_summary") or m.get("text_content")]
    if not motions:
        return {}

    item_ids = sorted({m["agenda_item_id"] for m in motions if m.get("agenda_item_id")})
    titles: dict[int, str] = {}
    if item_ids:
        for row in supabase.table("agenda_items").select("id, title").in_("id", item_ids).execute().data or []:
            titles[row["id"]] = row["title"]
    rows = [{**m, "agenda_title": titles.get(m.get("agenda_item_id"))} for m in motions]

    result = ai.json(_prompt(rows), stage="writing", schema=MotionHeadlines, system=SYSTEM)
    by_id = {m["id"]: m for m in motions}
    headlines = {mid: h for mid, h in _clean(result).items() if mid in by_id}
    if not dry_run:
        for mid, headline in headlines.items():
            meta = {**(by_id[mid].get("meta") or {}), "headline": headline, "headline_version": HEADLINE_VERSION}
            supabase.table("motions").update({"meta": meta}).eq("id", mid).eq("meeting_id", meeting_id).execute()
    return headlines
