"""Roll each matter's agenda items and motions up into resident-facing context.

Matters are created during ingestion with only a title and identifier, so the
matter page had nothing to say about what the matter is or where it stands.
This writes, per matter:

- ``plain_english_summary``: 1-2 sentences on what the matter is about.
- ``meta.status_line``: where it stands now, with the latest step and date.
- ``meta.display_title``: a short human title (the raw ``title`` is kept as-is
  because the matcher uses it to link future agenda items).
- ``category``: a topic, replacing the catch-all "General".
- ``status``: derived from the latest decision when it is clear.
"""
from __future__ import annotations

import json
import re
from typing import Iterable, Literal

from pydantic import BaseModel, Field
from supabase import Client

from pipeline import ai

# Bump when the prompt/schema changes so `main.py --stage matter-summaries --stale`
# re-runs matters summarized by an older version (stamped in meta.summary_version).
SUMMARY_VERSION = "2"

TOPICS = [
    "Development",
    "Housing",
    "Transportation",
    "Environment",
    "Parks & Recreation",
    "Finance",
    "Public Safety",
    "Utilities & Infrastructure",
    "Community",
    "Administration",
]
STATUSES = ["Active", "Adopted", "Approved", "Defeated", "Withdrawn", "Completed"]

SYSTEM = f"""You explain city council matters to residents of a small Canadian city.
For each matter you get its raw title and its history (agenda items, motions, and staff reports or
attached documents with their key facts, oldest first). The reports are the best source for what the
matter actually is; use them.
Return for each matter:
- "display_title": a short, plain title (max 8 words) naming the thing itself, e.g. "Solid waste collection bylaw", "854 Latoria Road rezoning". No reading stages, no "(Background report attached)", no years unless essential. Keep a street address when the matter is about a property.
- "summary": 2-3 sentences, max 60 words, saying what the matter actually is and why it matters to residents. Be concrete and lead with the substance: for a development, what would be built (use, units, storeys, tenure) and where; for a bylaw or program, what changes for residents, what it costs them, and why the city is doing it. No bylaw numbers, no "Council" as the opening word, no jargon. Do not mention readings, approval or status here; that belongs in status_line.
- "status_line": max 18 words on where it stands now: the latest step and its date (e.g. "Third reading given Sep 28, 2026; final adoption still to come."). Use the dates provided.
- "timeline": for each history entry, {{"item": <its item id>, "headline": "<max 12 words>"}} — a plain-English headline for that step that says what happened, e.g. "Staff propose city-run curbside garbage and organics pickup" or "Third reading for 120-unit rental building". No agenda numbering, no "(Background report attached)".
- "category": exactly one of {", ".join(TOPICS)}.
- "status": exactly one of {", ".join(STATUSES)}. Adopted = bylaw finally adopted; Approved = non-bylaw item approved; Defeated/Withdrawn when the latest decision says so; Completed = received for information or finished with nothing pending; otherwise Active.
"mentions" are separately linked context, not decisions on this matter. They may describe
public comments or earlier presentations: retain their source dates, attribute them, and do not
use them to infer adoption, approval, a vote, or a change in legal status. Only "history" entries
are owned proceedings and may receive timeline headlines. A date mentioned inside a report is
not necessarily the date of its containing council meeting; never silently substitute one for the other.
Never invent facts that are not in the inputs. If the history is too thin to say what it is about, base the summary on the title alone and keep it short."""

Topic = Literal[tuple(TOPICS)]  # type: ignore[valid-type]
Status = Literal[tuple(STATUSES)]  # type: ignore[valid-type]


class TimelineHeadline(BaseModel):
    item: int = Field(description="The history entry's item id")
    headline: str = Field(description="Max 12 words: what happened at this step")


class MatterSummary(BaseModel):
    id: int
    display_title: str
    summary: str
    status_line: str
    timeline: list[TimelineHeadline]
    category: Topic
    status: Status


class MatterSummaries(BaseModel):
    matters: list[MatterSummary]


MAX_HISTORY = 12
KEY_SECTION = re.compile(r"purpose|executive summary|proposal|commentary|recommendation|summary|background", re.I)


def _paginate(query_fn, page: int = 1000) -> list[dict]:
    rows: list[dict] = []
    start = 0
    while True:
        chunk = query_fn().range(start, start + page - 1).execute().data or []
        rows.extend(chunk)
        if len(chunk) < page:
            return rows
        start += page


def _load_context(supabase: Client, matter_ids: list[int]) -> list[dict]:
    matters = (
        supabase.table("matters")
        .select("id, municipality_id, title, identifier, category, status, meta")
        .in_("id", matter_ids)
        .execute()
        .data
        or []
    )
    # Merged duplicates (aliases) keep their agenda items; read them as the canonical's history.
    owner = {m["id"]: m["id"] for m in matters}
    for m in matters:
        for alias_id in (m.get("meta") or {}).get("merged_matter_ids") or []:
            owner[int(alias_id)] = m["id"]
    items = (
        supabase.table("agenda_items")
        .select("id, matter_id, title, plain_english_summary, debate_summary, meetings(meeting_date, type)")
        .in_("matter_id", list(owner))
        .execute()
        .data
        or []
    )
    for item in items:
        item["matter_id"] = owner.get(item["matter_id"], item["matter_id"])
    links = supabase.table("matter_links").select("matter_id,agenda_item_id").in_("matter_id", list(owner)) \
        .eq("kind", "mention").eq("hidden", False).execute().data or []
    mention_ids = sorted({link["agenda_item_id"] for link in links if link.get("agenda_item_id")})
    mention_items = (supabase.table("agenda_items")
                     .select("id,matter_id,title,plain_english_summary,meetings!inner(meeting_date,municipality_id)")
                     .in_("id", mention_ids).execute().data or []) if mention_ids else []
    mentions_by_matter = {}
    matter_by_id = {m["id"]: m for m in matters}
    item_by_id = {item["id"]: item for item in mention_items}
    owned = {(item["matter_id"], item["id"]) for item in items}
    for link in links:
        mid = owner.get(link["matter_id"])
        item = item_by_id.get(link.get("agenda_item_id"))
        if not item or (mid, item["id"]) in owned:
            continue
        meeting = item.get("meetings") or {}
        if meeting.get("municipality_id") != matter_by_id[mid]["municipality_id"]:
            continue
        mentions_by_matter.setdefault(mid, []).append({
            "item": item["id"], "date": meeting.get("meeting_date"), "agenda_item": item["title"],
            "summary": (item.get("plain_english_summary") or "")[:400], "source": "accepted mention",
        })
    item_ids = [i["id"] for i in items]
    motions = (
        supabase.table("motions")
        .select("agenda_item_id, plain_english_summary, text_content, result")
        .in_("agenda_item_id", item_ids)
        .execute()
        .data
        or []
    ) if item_ids else []
    docs = (
        supabase.table("extracted_documents")
        .select("agenda_item_id, title, document_type, summary, key_facts")
        .in_("agenda_item_id", item_ids)
        .execute()
        .data
        or []
    ) if item_ids else []
    # The substance of a staff report lives in a few sections; the extracted one-line summary
    # is often vague ("staff report and attachments for ..."), so pass those sections too.
    sections = (
        supabase.table("document_sections")
        .select("agenda_item_id, section_title, section_text, section_order")
        .in_("agenda_item_id", item_ids)
        .order("section_order")
        .execute()
        .data
        or []
    ) if item_ids else []
    excerpts_by_item: dict[int, list[str]] = {}
    for sec in sections:
        title = (sec.get("section_title") or "").lower()
        if not KEY_SECTION.search(title):
            continue
        bucket = excerpts_by_item.setdefault(sec["agenda_item_id"], [])
        if len(bucket) < 3:
            text = re.sub(r"\s+", " ", re.sub(r"[#|*]", " ", sec.get("section_text") or "")).strip()
            bucket.append(text[:700])
    docs_by_item: dict[int, list[dict]] = {}
    # Staff reports first; drawings, schedules and forms add little.
    rank = lambda d: 0 if "report" in (d.get("document_type") or "").lower() or "report" in (d.get("title") or "").lower() else 1
    for d in sorted(docs, key=rank):
        docs_by_item.setdefault(d["agenda_item_id"], []).append(d)
    motions_by_item: dict[int, list[dict]] = {}
    for m in motions:
        motions_by_item.setdefault(m["agenda_item_id"], []).append(m)

    out = []
    for matter in matters:
        history = []
        for item in items:
            if item["matter_id"] != matter["id"]:
                continue
            meeting = item.get("meetings") or {}
            history.append(
                {
                    "item": item["id"],
                    "date": meeting.get("meeting_date"),
                    "meeting": meeting.get("type"),
                    "agenda_item": item.get("title"),
                    "summary": (item.get("plain_english_summary") or "")[:400],
                    "debate": (item.get("debate_summary") or "")[:300] or None,
                    "motions": [
                        {
                            "decision": m.get("plain_english_summary") or (m.get("text_content") or "")[:300],
                            "result": m.get("result"),
                        }
                        for m in motions_by_item.get(item["id"], [])
                    ],
                    "report_excerpts": excerpts_by_item.get(item["id"], []),
                    "reports": [
                        {"title": d.get("title"), "summary": (d.get("summary") or "")[:500], "key_facts": (d.get("key_facts") or [])[:10]}
                        for d in docs_by_item.get(item["id"], [])[:3]
                    ],
                }
            )
        history.sort(key=lambda h: h["date"] or "")
        out.append(
            {
                "id": matter["id"],
                "title": matter["title"],
                "identifier": matter.get("identifier"),
                "history": history[-MAX_HISTORY:],
                "mentions": sorted(mentions_by_matter.get(matter["id"], []), key=lambda row: row["date"] or "")[-MAX_HISTORY:],
                "_has_mentions": bool(mentions_by_matter.get(matter["id"])),
                "_owned_item_ids": {item["item"] for item in history},
                "_meta": matter.get("meta") or {},
            }
        )
    return out


def _prompt(batch: list[dict]) -> str:
    payload = [{k: v for k, v in m.items() if not k.startswith("_")} for m in batch]
    return (
        "Write context for each matter below: one entry in `matters` per matter, same ids.\n\n"
        + json.dumps(payload, ensure_ascii=False, default=str)
    )


def _summarize(batch: list[dict]) -> dict[int, dict]:
    result = ai.json(_prompt(batch), stage="extraction", schema=MatterSummaries, system=SYSTEM)
    return {m.id: m.model_dump() for m in result.matters if m.summary.strip()}


def refresh_matter_summaries(
    supabase: Client,
    matter_ids: Iterable[int],
    *,
    batch_size: int = 8,
    dry_run: bool = False,
    context_only: bool = False,
) -> dict[int, dict]:
    """Describe accepted context; derive decisions only from owned proceedings.

    A post-link refresh updates descriptions without rerunning lifecycle changes.
    On a normal refresh, owned-only generation remains independent of mentions,
    so later owned approvals still update status even when older comments exist.
    """
    ids = sorted({int(i) for i in matter_ids})
    results: dict[int, dict] = {}
    for start in range(0, len(ids), batch_size):
        batch = _load_context(supabase, ids[start : start + batch_size])
        if not batch:
            continue
        try:
            decisions = {} if context_only else _summarize([{**matter, "mentions": []} for matter in batch])
            context = batch if context_only else [matter for matter in batch if matter["_has_mentions"]]
            descriptions = _summarize(context) if context else {}
        except Exception as exc:
            print(f"  [MatterSummaries] batch {ids[start]}…: {exc}")
            continue
        for matter in batch:
            fields = decisions.get(matter["id"])
            descriptive = descriptions.get(matter["id"]) or fields
            if not descriptive:
                continue
            meta = dict(matter["_meta"])
            meta["display_title"] = (descriptive.get("display_title") or "").strip() or None
            meta["summary_version"] = SUMMARY_VERSION
            # A recorded replacement (meta.superseded_by) is a later council decision about this
            # matter that its own history doesn't show, so the model can't re-derive its status.
            superseded = bool(meta.get("superseded_by"))
            if fields and matter["history"] and not superseded:
                meta["status_line"] = (fields.get("status_line") or "").strip() or None
                meta["timeline_headlines"] = {
                    str(t["item"]): t["headline"].strip()
                    for t in fields.get("timeline") or []
                    if isinstance(t, dict) and t.get("item") in matter["_owned_item_ids"] and (t.get("headline") or "").strip()
                }
            update = {"plain_english_summary": descriptive["summary"].strip(), "meta": meta}
            if descriptive.get("category") in TOPICS:
                update["category"] = descriptive["category"]
            if fields and matter["history"] and not superseded and fields.get("status") in STATUSES:
                update["status"] = fields["status"]
            results[matter["id"]] = update
            if not dry_run:
                supabase.table("matters").update(update).eq("id", matter["id"]).execute()
        print(f"  [MatterSummaries] {min(start + batch_size, len(ids))}/{len(ids)}")
    return results


def matters_for_meetings(supabase: Client, meeting_ids: list[int]) -> list[int]:
    rows = (
        supabase.table("agenda_items")
        .select("matter_id")
        .in_("meeting_id", meeting_ids)
        .not_.is_("matter_id", "null")
        .execute()
        .data
        or []
    )
    return sorted({r["matter_id"] for r in rows})


def all_matter_ids(supabase: Client, only_missing: bool = False, since: str | None = None) -> list[int]:
    def q():
        query = supabase.table("matters").select("id").order("id").is_("meta->>canonical_matter_id", "null")
        if since:
            query = query.gte("last_seen", since)
        return query.is_("plain_english_summary", "null") if only_missing else query

    return [r["id"] for r in _paginate(q)]
