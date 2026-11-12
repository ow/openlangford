"""Rewrite motion plain-English summaries so they say what a decision does.

Existing summaries often just restate the identifier ("Council adopted Bylaw
No. 2284."). This uses data already in the database (motion text, agenda item
title and summary) to write one resident-friendly sentence per motion; the
identifier stays visible in the UI via the agenda item title.

Not called by the pipeline today; kept as a maintenance tool.
"""
from __future__ import annotations

import json

from pydantic import BaseModel
from supabase import Client

from pipeline import ai
from pipeline.ai import glossary
from pipeline.ingestion.manual_edits import keep_manual_text
from pipeline.ingestion.record_sources import RECORD_RULE

SYSTEM = """You rewrite council motion summaries for residents of a small Canadian city.
Each summary is ONE sentence, at most 15 words, saying what the decision does in everyday terms.
Start with the outcome verb (Approved, Adopted, Rejected, Allowed, Raised, Directed staff to, Gave first reading to, Deferred...).
No bylaw/permit numbers, policy codes, formal bylaw titles, quotation marks, or "Council" as the subject.
Include the street/place or dollar amount when it is the point. Keep the exact bylaw stage (first/second/third reading, adoption).
For procedural motions (agenda, minutes, adjournment, closed session) write a short plain phrase like "Approved the agenda."
Never invent details that are not in the inputs.
""" + RECORD_RULE + """ Here the record is each motion's wording, its result and its agenda item title; the agenda
item summary and the current summary are notes."""


SYSTEM = SYSTEM + "\n\n" + glossary.prompt_block("record", only=glossary.ids(["decisions", "bylaws"], plus=["closed-meeting", "consent-agenda", "committee-of-the-whole", "development-variance-permit", "temporary-use-permit", "notice-of-intent"]))

class MotionSummary(BaseModel):
    id: int
    summary: str


class MotionSummaries(BaseModel):
    motions: list[MotionSummary]


def _prompt(rows: list[dict]) -> str:
    items = [
        {
            "id": r["id"],
            "agenda_item": r.get("agenda_title") or "",
            "record": {"motion_text": r.get("text_content") or "", "result": r.get("result") or ""},
            "notes": {"agenda_item_summary": r.get("agenda_summary") or "", "current_summary": r.get("plain_english_summary") or ""},
        }
        for r in rows
    ]
    return (
        "Rewrite the summary for each motion below: one entry in `motions` per motion, same ids.\n\n"
        + json.dumps(items, ensure_ascii=False)
    )


def _clean(result: MotionSummaries) -> dict[int, str]:
    out: dict[int, str] = {}
    for item in result.motions:
        summary = item.summary.strip().strip('"').strip()
        if summary:
            out[item.id] = summary
    return out


def regenerate_meeting_motion_summaries(supabase: Client, meeting_id: int, *, dry_run: bool = False) -> dict[int, str]:
    motions = (
        supabase.table("motions")
        .select("id, text_content, result, plain_english_summary, agenda_item_id, meta")
        .eq("meeting_id", meeting_id)
        .order("id")
        .execute()
        .data
    ) or []
    if not motions:
        return {}
    item_ids = sorted({m["agenda_item_id"] for m in motions if m.get("agenda_item_id")})
    items = {}
    if item_ids:
        for row in (
            supabase.table("agenda_items")
            .select("id, title, plain_english_summary")
            .in_("id", item_ids)
            .execute()
            .data
            or []
        ):
            items[row["id"]] = row
    rows = [
        {
            **m,
            "agenda_title": items.get(m.get("agenda_item_id"), {}).get("title"),
            "agenda_summary": items.get(m.get("agenda_item_id"), {}).get("plain_english_summary"),
        }
        for m in motions
        if (m.get("text_content") or m.get("plain_english_summary"))
    ]
    if not rows:
        return {}
    summaries = _clean(ai.json(_prompt(rows), stage="writing", schema=MotionSummaries, system=SYSTEM))
    valid = {mid: s for mid, s in summaries.items() if any(r["id"] == mid for r in rows)}
    if not dry_run:
        stored = {m["id"]: m.get("meta") for m in motions}
        for mid, summary in valid.items():
            # A line staff (or the fix agent) set by hand is kept; this run's goes to meta.manual.summary.auto.
            update = keep_manual_text(stored.get(mid), {"plain_english_summary": summary}, {"summary": "plain_english_summary"})
            supabase.table("motions").update(update).eq("id", mid).eq("meeting_id", meeting_id).execute()
    return valid
