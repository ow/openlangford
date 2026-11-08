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
from functools import partial
from pathlib import Path
from typing import Iterable, Literal

from datetime import datetime, timezone

from pydantic import BaseModel, Field
from supabase import Client

from pipeline import ai
from pipeline.ai import glossary
from pipeline.ingestion.manual_edits import keep_text_edits
from pipeline.ingestion.record_sources import item_transcripts
from pipeline.postgrest import in_chunks, paginate

# The writer's prompts, topics and version are shared with the site's fix agent, which rewrites a topic's summary
# straight after a staff fix (apps/web/app/services/topic-summaries.server.ts): change them in that file.
# Bump "version" when the prompt/schema changes so `main.py --stage matter-summaries --stale` re-runs matters
# summarized by an older version (stamped in meta.summary_version).
SHARED = json.loads((Path(__file__).resolve().parents[4] / "shared" / "prompts" / "topic-summaries.json").read_text())
SUMMARY_VERSION = SHARED["version"]
TOPICS = SHARED["topics"]
STATUSES = SHARED["statuses"]
SYSTEM = SHARED["system"] + "\n\n" + glossary.prompt_block(SHARED["glossary"]["register"], only=glossary.ids(SHARED["glossary"]["groups"]))

Topic = Literal[tuple(TOPICS)]  # type: ignore[valid-type]
Status = Literal[tuple(STATUSES)]  # type: ignore[valid-type]


class TimelineHeadline(BaseModel):
    item: int = Field(description=SHARED["fields"]["timeline_item"])
    headline: str = Field(description=SHARED["fields"]["timeline_headline"])


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


KEY_SECTION = re.compile(r"purpose|executive summary|proposal|comment|recommendation|summary|background|discussion|financial", re.I)


# Every row of build(chunk) for the ids in chunks (long id lists overflow a request URL), all pages: each build is
# ordered, so a chunk with more than 1000 rows is read page by page.
_in_chunks = partial(in_chunks, paged=True)

LOAD_CHUNK = 32  # matters whose records are loaded at once (then packed into requests by size)


def _load_context(supabase: Client, matter_ids: list[int]) -> list[dict]:
    """Each matter's whole history and its accepted mentions, with every record in full: motion wording, report text,
    the video transcript of each discussed item. Nothing is cut to fit; ``refresh_matter_summaries`` packs matters into
    requests by size instead (pipeline.ai.budget)."""
    matters = _in_chunks(lambda ids: supabase.table("matters").select("id, municipality_id, title, identifier, category, status, meta")
                         .in_("id", ids).order("id"), matter_ids)
    # A merge moves every item and mention onto the canonical (merge_matters), so a matter's own rows are its history.
    matter_ids = [m["id"] for m in matters]
    items = _in_chunks(lambda ids: supabase.table("agenda_items")
                       .select("id, matter_id, meeting_id, title, description, plain_english_summary, debate_summary, "
                               "discussion_start_time, discussion_end_time, meetings(meeting_date, type)")
                       .in_("matter_id", ids).order("id"), matter_ids)
    links = _in_chunks(lambda ids: supabase.table("matter_links").select("id,matter_id,agenda_item_id,quote").in_("matter_id", ids)
                       .eq("kind", "mention").eq("hidden", False).order("id"), matter_ids)
    mention_ids = sorted({link["agenda_item_id"] for link in links if link.get("agenda_item_id")})
    mention_items = _in_chunks(lambda ids: supabase.table("agenda_items")
                               .select("id,matter_id,title,plain_english_summary,meetings!inner(meeting_date,municipality_id)")
                               .in_("id", ids).order("id"), mention_ids) if mention_ids else []
    mentions_by_matter = {}
    matter_by_id = {m["id"]: m for m in matters}
    item_by_id = {item["id"]: item for item in mention_items}
    owned = {(item["matter_id"], item["id"]) for item in items}
    for link in links:
        mid = link["matter_id"]
        item = item_by_id.get(link.get("agenda_item_id"))
        if not item or mid not in matter_by_id or (mid, item["id"]) in owned:
            continue
        meeting = item.get("meetings") or {}
        if meeting.get("municipality_id") != matter_by_id[mid]["municipality_id"]:
            continue
        # The quote is the line of that item's record that names this matter: often the only place a budget
        # amount, a recommendation or a question about it is written down.
        mentions_by_matter.setdefault(mid, []).append({
            "item": item["id"], "date": meeting.get("meeting_date"), "agenda_item": item["title"],
            "notes": {"summary": item.get("plain_english_summary") or "",
                      **({"names_this_matter": link["quote"].strip()} if isinstance(link.get("quote"), str) and link["quote"].strip() else {})},
            "source": "accepted mention",
        })
    item_ids = [i["id"] for i in items]
    motions = _in_chunks(lambda ids: supabase.table("motions").select("id, agenda_item_id, plain_english_summary, text_content, result")
                         .in_("agenda_item_id", ids).order("id"), item_ids) if item_ids else []
    docs = _in_chunks(lambda ids: supabase.table("extracted_documents").select("id, agenda_item_id, title, document_type, summary, key_facts")
                      .in_("agenda_item_id", ids).order("id"), item_ids) if item_ids else []
    # The substance of a staff report lives in its sections; the extracted summary and key facts are notes (often
    # vague, sometimes wrong), so the report's own text goes in as record, whole, its key sections first.
    sections = _in_chunks(lambda ids: supabase.table("document_sections")
                          .select("id, agenda_item_id, section_title, section_text, section_order")
                          .in_("agenda_item_id", ids).order("agenda_item_id").order("section_order").order("id"), item_ids) if item_ids else []
    excerpts_by_item: dict[int, list[str]] = {}
    for sec in sorted(sections, key=lambda x: not KEY_SECTION.search((x.get("section_title") or ""))):
        text = re.sub(r"\s+", " ", re.sub(r"[#|*]", " ", sec.get("section_text") or "")).strip()
        if text:
            excerpts_by_item.setdefault(sec["agenda_item_id"], []).append(
                f"{sec['section_title']}: {text}" if sec.get("section_title") else text)
    docs_by_item: dict[int, list[dict]] = {}
    # Staff reports first; drawings, schedules and forms add little.
    rank = lambda d: 0 if "report" in (d.get("document_type") or "").lower() or "report" in (d.get("title") or "").lower() else 1
    for d in sorted(docs, key=rank):
        docs_by_item.setdefault(d["agenda_item_id"], []).append(d)
    motions_by_item: dict[int, list[dict]] = {}
    for m in motions:
        motions_by_item.setdefault(m["agenda_item_id"], []).append(m)

    # The video is the original for what was said: every item discussed on video brings its transcript as record, so a
    # fact from its debate summary (a note) can be confirmed.
    transcripts = item_transcripts(supabase, [i for i in items if i.get("discussion_start_time") is not None])

    same_site = _same_site(supabase, matter_ids)
    out = []
    for matter in matters:
        history = []
        for item in items:
            if item["matter_id"] != matter["id"]:
                continue
            meeting = item.get("meetings") or {}
            mine = motions_by_item.get(item["id"], [])
            history.append(
                {
                    "item": item["id"],
                    "date": meeting.get("meeting_date"),
                    "meeting": meeting.get("type"),
                    "agenda_item": item.get("title"),
                    # The City's own text (see record_sources.RECORD_RULE).
                    "record": {k: v for k, v in {
                        "motions": [{"text": m.get("text_content") or "", "result": m.get("result")} for m in mine],
                        "report_text": excerpts_by_item.get(item["id"], []),
                        "video_transcript": transcripts.get(item["id"]),
                    }.items() if v},
                    # What a model wrote about it earlier: for orientation, never the source of a fact.
                    "notes": {k: v for k, v in {
                        "summary": item.get("plain_english_summary") or "",
                        "description": item.get("description") or "",
                        "video_summary": item.get("debate_summary") or "",
                        "motion_summaries": [m["plain_english_summary"] for m in mine if m.get("plain_english_summary")],
                        "reports": [{"title": d.get("title"), "summary": d.get("summary") or "", "key_facts": d.get("key_facts") or []}
                                    for d in docs_by_item.get(item["id"], [])],
                    }.items() if v},
                }
            )
        history.sort(key=lambda h: h["date"] or "")
        out.append(
            {
                "id": matter["id"],
                "title": matter["title"],
                "identifier": matter.get("identifier"),
                "history": history,
                "mentions": sorted(mentions_by_matter.get(matter["id"], []), key=lambda row: row["date"] or ""),
                **({"same_site": same_site[matter["id"]]} if same_site.get(matter["id"]) else {}),
                **({"editor_notes": notes} if (notes := [n for n in ((matter.get("meta") or {}).get("editor_notes") or [])
                                                          if isinstance(n, str) and n.strip()]) else {}),
                "_has_mentions": bool(mentions_by_matter.get(matter["id"])),
                "_owned_item_ids": {item["item"] for item in history},
                "_meta": matter.get("meta") or {},
            }
        )
    return out


SAME_SITE_MAX_LOTS = 4  # a matter naming more lots is a list (tax exemptions, permit parking), not one site's application


def _same_site(supabase: Client, matter_ids: list[int]) -> dict[int, list[dict]]:
    """Other matters for the same land as each matter: sharing a lot (a public, numbered one), neither naming more than
    SAME_SITE_MAX_LOTS lots. The web's sameSiteTopics (app/services/properties.ts) shows the same set on the page."""
    own = _in_chunks(lambda ids: supabase.table("property_links").select("matter_id, property_id")
                     .in_("matter_id", ids).eq("hidden", False).order("id"), matter_ids)
    lots: dict[int, set[int]] = {}
    for link in own:
        lots.setdefault(link["matter_id"], set()).add(link["property_id"])
    lots = {m: p for m, p in lots.items() if len(p) <= SAME_SITE_MAX_LOTS}
    property_ids = sorted({p for ps in lots.values() for p in ps})
    if not property_ids:
        return {}
    public = {p["id"] for p in _in_chunks(lambda ids: supabase.table("properties").select("id").in_("id", ids)
                                          .eq("hidden", False).neq("civic_number", "").order("id"), property_ids)}
    sharing = _in_chunks(lambda ids: supabase.table("property_links").select("matter_id, property_id")
                         .in_("property_id", ids).eq("hidden", False).not_.is_("matter_id", "null").order("id"),
                         sorted(public))
    other_ids = sorted({l["matter_id"] for l in sharing} - set(lots))
    their = _in_chunks(lambda ids: supabase.table("property_links").select("matter_id, property_id")
                       .in_("matter_id", ids).eq("hidden", False).order("id"), other_ids) if other_ids else []
    for link in their:
        lots.setdefault(link["matter_id"], set()).add(link["property_id"])
    small = {m for m, ps in lots.items() if len(ps) <= SAME_SITE_MAX_LOTS}
    candidates = sorted({l["matter_id"] for l in sharing} & small)
    rows = {m["id"]: m for m in _in_chunks(lambda ids: supabase.table("matters").select("id, title, meta, first_seen, last_seen, merged_into")
                                           .in_("id", ids).order("id"), candidates)}
    out: dict[int, list[dict]] = {}
    for mid in matter_ids:
        mine = lots.get(mid, set()) & public
        if not mine or mid not in small:
            continue
        siblings = sorted({l["matter_id"] for l in sharing if l["property_id"] in mine and l["matter_id"] != mid})
        for sid in siblings:
            row = rows.get(sid)
            if not row or row.get("merged_into") or (row.get("meta") or {}).get("hidden"):
                continue
            out.setdefault(mid, []).append({"title": (row.get("meta") or {}).get("display_title") or row["title"],
                                            "dates": f"{row.get('first_seen')} to {row.get('last_seen')}"})
    return out


def _prompt(batch: list[dict]) -> str:
    payload = [{k: v for k, v in m.items() if not k.startswith("_")} for m in batch]
    return (
        SHARED["prompt_intro"]
        + json.dumps(payload, ensure_ascii=False, default=str)
    )


def _summarize(batch: list[dict]) -> dict[int, dict]:
    result = ai.json(_prompt(batch), stage="writing", schema=MatterSummaries, system=SYSTEM)
    return {m.id: m.model_dump() for m in result.matters if m.summary.strip()}


class SummaryProblem(BaseModel):
    matter: int = Field(description=SHARED["fields"]["problem_matter"])
    statement: str = Field(description=SHARED["fields"]["problem_statement"])
    verdict: Literal["contradicted", "not_in_record"]
    record_says: str = Field(description=SHARED["fields"]["problem_record_says"])


class SummaryCheck(BaseModel):
    problems: list[SummaryProblem]


CHECK_PROMPT = SHARED["check_prompt"]


def _check(batch: list[dict], updates: dict[int, dict]) -> dict[int, list[dict]]:
    """Problems per matter in the written text (summary and status line), judged against the matter's own inputs."""
    payload = []
    for m in batch:
        u = updates.get(m["id"])
        if not u:
            continue
        payload.append({"id": m["id"], "records": {k: v for k, v in m.items() if not k.startswith("_") and k != "fix_these"},
                        "text": {"summary": u["plain_english_summary"], "where_it_stands": (u["meta"] or {}).get("status_line"),
                                 # Lines staff approved stand as written, so only the writer's own are checked.
                                 "timeline_headlines": {k: v for k, v in ((u["meta"] or {}).get("timeline_headlines") or {}).items()
                                                        if k not in ((u["meta"] or {}).get("staff_headlines") or {})}}})
    if not payload:
        return {}
    result = ai.json(CHECK_PROMPT + json.dumps(payload, ensure_ascii=False, default=str), stage="review", schema=SummaryCheck)
    found: dict[int, list[dict]] = {}
    for p in result.problems:
        if p.matter in updates:
            found.setdefault(p.matter, []).append(p.model_dump(exclude={"matter"}))
    return found


def _generate(batch: list[dict], *, context_only: bool = False) -> dict[int, dict]:
    """The updates for a batch: decisions from owned proceedings, descriptions with linked context."""
    decisions = {} if context_only else _summarize([{**matter, "mentions": []} for matter in batch])
    context = batch if context_only else [matter for matter in batch if matter["_has_mentions"]]
    descriptions = _summarize(context) if context else {}
    out: dict[int, dict] = {}
    for matter in batch:
        fields = decisions.get(matter["id"])
        descriptive = descriptions.get(matter["id"]) or fields
        if not descriptive:
            continue
        meta = dict(matter["_meta"])
        meta["display_title"] = (descriptive.get("display_title") or "").strip() or None
        meta["summary_version"] = SUMMARY_VERSION
        # Lines staff approved through the page review bar (meta.staff_headlines) outlive every rewrite.
        staff_lines = {k: v for k, v in (meta.get("staff_headlines") or {}).items() if isinstance(v, str) and v.strip()}
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
        elif not matter["history"] and not superseded:
            # Nothing filed on it, only mentions: where it last came up, as discussion (the decision pass sees no
            # mentions, so its line would only say the history is empty). Without mentions either, no line at all;
            # before, the old line was simply kept, whatever it said.
            line = ((descriptions.get(matter["id"]) or {}).get("status_line") or "").strip() if matter["_has_mentions"] else ""
            meta["status_line"] = line or None
        if staff_lines:
            meta["timeline_headlines"] = {**(meta.get("timeline_headlines") or {}), **staff_lines}
        # Text the fix agent edited directly (an approved instruction the writer wouldn't follow) stands until the
        # topic gains a step of its own; then this rewrite takes over.
        staff_text = meta.get("staff_text") if isinstance(meta.get("staff_text"), dict) else None
        if staff_text and set(matter["_owned_item_ids"]) <= set(staff_text.get("items") or []):
            if staff_text.get("status_line"):
                meta["status_line"] = staff_text["status_line"]
            if staff_text.get("summary"):
                descriptive = {**descriptive, "summary": staff_text["summary"]}
        update = {"plain_english_summary": descriptive["summary"].strip(), "meta": meta}
        if descriptive.get("category") in TOPICS:
            update["category"] = descriptive["category"]
        if fields and matter["history"] and not superseded and fields.get("status") in STATUSES:
            update["status"] = fields["status"]
        out[matter["id"]] = update
    return out


def _checked(batch: list[dict], updates: dict[int, dict], *, context_only: bool = False) -> dict[int, dict]:
    """Check the written text against the records; a matter with problems is rewritten once, told what they were,
    and keeps whichever version has fewer. The outcome is stamped in meta.summary_check."""
    try:
        problems = _check(batch, updates)
    except Exception as exc:  # unchecked rather than unwritten
        print(f"  [MatterSummaries] check failed: {exc}")
        return updates
    retry = [{**m, "fix_these": problems[m["id"]]} for m in batch if problems.get(m["id"])]
    second: dict[int, dict] = {}
    second_problems: dict[int, list[dict]] = {}
    if retry:
        try:
            second = _generate(retry, context_only=context_only)
            second_problems = _check(retry, second)
        except Exception as exc:
            print(f"  [MatterSummaries] rewrite after check failed: {exc}")
    now = datetime.now(timezone.utc).isoformat()
    out = {}
    for mid, update in updates.items():
        first = problems.get(mid, [])
        if mid in second and len(second_problems.get(mid, [])) < len(first):
            update, left, rewritten = second[mid], second_problems.get(mid, []), True
        else:
            left, rewritten = first, False
        update["meta"]["summary_check"] = {"at": now, "problems": len(left), "first_problems": len(first),
                                           "rewritten": rewritten, **({"unresolved": left} if left else {})}
        out[mid] = update
    return out


def refresh_matter_summaries(
    supabase: Client,
    matter_ids: Iterable[int],
    *,
    batch_size: int = 8,
    dry_run: bool = False,
    context_only: bool = False,
    check: bool = True,
) -> dict[int, dict]:
    """Describe accepted context; derive decisions only from owned proceedings.

    A post-link refresh updates descriptions without rerunning lifecycle changes.
    On a normal refresh, owned-only generation remains independent of mentions,
    so later owned approvals still update status even when older comments exist.
    With ``check``, each text is checked against its records and rewritten once if it gets facts wrong.
    """
    ids = sorted({int(i) for i in matter_ids})
    results: dict[int, dict] = {}
    done = 0
    for start in range(0, len(ids), LOAD_CHUNK):
        loaded = _load_context(supabase, ids[start : start + LOAD_CHUNK])
        # Requests are filled by size, never by cutting a matter's records: up to batch_size matters each, within the
        # input budget. A matter too large for a request on its own is reported and left as it was.
        fits = []
        for matter in loaded:
            if ai.budget.size(_prompt([matter])) > ai.INPUT_BUDGET_CHARS:
                print(f"  [MatterSummaries] matter {matter['id']}: TOO LARGE for one request "
                      f"({ai.budget.size(_prompt([matter])):,} characters of records); not rewritten")
            else:
                fits.append(matter)
        for batch in ai.pack(fits, measure=lambda m: ai.budget.size(_prompt([m])), max_count=batch_size):
            try:
                updates = _generate(batch, context_only=context_only)
            except Exception as exc:
                print(f"  [MatterSummaries] batch {batch[0]['id']}…: {exc}")
                continue
            if check and updates:
                updates = _checked(batch, updates, context_only=context_only)
            for mid, update in updates.items():
                if not dry_run:
                    update = keep_text_edits(supabase, mid, update)  # fields staff edited by hand stay theirs
                    supabase.table("matters").update(update).eq("id", mid).execute()
                results[mid] = update
        done += len(loaded)
        print(f"  [MatterSummaries] {done}/{len(ids)}", flush=True)
    return results


def check_existing(supabase: Client, matter_ids: Iterable[int], *, batch_size: int = 8, dry_run: bool = False) -> dict:
    """Check topics' current summaries against their records without rewriting them; the ones with problems are
    regenerated (checked again, see refresh_matter_summaries), the rest are stamped as checked."""
    ids = sorted({int(i) for i in matter_ids})
    failing, passed, problems = [], [], {}
    loaded_all = (m for start in range(0, len(ids), LOAD_CHUNK) for m in _load_context(supabase, ids[start : start + LOAD_CHUNK]))
    fits = [m for m in loaded_all if ai.budget.size(_prompt([m])) <= ai.INPUT_BUDGET_CHARS]
    for start, batch in enumerate(ai.pack(fits, measure=lambda m: ai.budget.size(_prompt([m])), max_count=batch_size)):
        current = {}
        for m in batch:
            row = supabase.table("matters").select("plain_english_summary, meta").eq("id", m["id"]).single().execute().data
            if row.get("plain_english_summary"):
                current[m["id"]] = {"plain_english_summary": row["plain_english_summary"], "meta": row.get("meta") or {}}
        try:
            found = _check(batch, current)
        except Exception as exc:
            print(f"  [MatterSummaries] check {batch[0]['id']}…: {exc}")
            continue
        for mid, cur in current.items():
            if found.get(mid):
                failing.append(mid)
                problems[mid] = found[mid]
            else:
                passed.append(mid)
                if not dry_run:
                    meta = {**cur["meta"], "summary_check": {"at": datetime.now(timezone.utc).isoformat(), "problems": 0,
                                                              "first_problems": 0, "rewritten": False}}
                    supabase.table("matters").update({"meta": meta}).eq("id", mid).execute()
        print(f"  [MatterSummaries] checked {len(failing) + len(passed)}/{len(ids)}: {len(failing)} with problems", flush=True)
    rewritten = {} if dry_run else refresh_matter_summaries(supabase, failing, batch_size=batch_size)
    return {"checked": len(failing) + len(passed), "failing": failing, "problems": problems, "rewritten": len(rewritten)}


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
        query = supabase.table("matters").select("id").order("id").is_("merged_into", "null")
        if since:
            query = query.gte("last_seen", since)
        return query.is_("plain_english_summary", "null") if only_missing else query

    return [r["id"] for r in paginate(q)]
