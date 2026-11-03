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

from datetime import datetime, timezone

from pydantic import BaseModel, Field
from supabase import Client

from pipeline import ai
from pipeline.ingestion.record_sources import CHECK_RULE, RECORD_RULE, item_transcripts

# Bump when the prompt/schema changes so `main.py --stage matter-summaries --stale`
# re-runs matters summarized by an older version (stamped in meta.summary_version).
SUMMARY_VERSION = "5"

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
For each matter you get its raw title and its history (agenda items, oldest first), each with its "record" (motion
wording and results, staff report text, the video transcript of its discussion) and its "notes".
""" + RECORD_RULE + f"""
The agenda title is record too: it says what the item was (a public hearing, a staff report, a bylaw's readings).
The report text is the best source for what the matter actually is; use it. Be specific wherever the record is:
the number of homes or lots, the amounts, the names, what exactly was approved. Text that stays vague when the record
gives the details is as unhelpful as text that gets them wrong.
Return for each matter:
- "display_title": a short, plain title (max 8 words) naming the thing itself, e.g. "Solid waste collection bylaw", "854 Latoria Road rezoning". No reading stages, no "(Background report attached)", no years unless essential. Keep a street address when the matter is about a property.
- "summary": 2-3 sentences, max 60 words, saying what the matter actually is and why it matters to residents. Be concrete and lead with the substance: for a development, what would be built (use, units, storeys, tenure) and where; for a bylaw or program, what changes for residents, what it costs them, and why the city is doing it. No bylaw numbers, no "Council" as the opening word, no jargon. Do not mention readings, approval or status here; that belongs in status_line.
- "status_line": max 18 words on where it stands now: the latest step and its date (e.g. "Third reading given Sep 28, 2026; final adoption still to come."). Use the dates provided.
  When "history" is empty and only "mentions" exist, say where it last came up, as discussion, not a decision
  (e.g. "Draft presented to Council Apr 7, 2026; BC Transit is updating the plan."). Never say that history,
  records or a latest step are missing or not provided: that describes this site's data, not the matter.
- "timeline": for each history entry, {{"item": <its item id>, "headline": "<max 12 words>"}} — a plain-English headline for that step that says what happened, e.g. "Staff propose city-run curbside garbage and organics pickup" or "Third reading for 120-unit rental building". No agenda numbering, no "(Background report attached)".
  Take what happened from the entry's motions and their result, not the agenda title: a title saying "second and third
  reading" with a motion giving first reading is a first reading; a motion directing staff to prepare a bylaw is not a
  reading. With no motion, say what the item did (a report presented, a hearing held), never that something was
  decided. Name what the step is about ("First reading for townhomes and suites on Latoria Road"), never only the procedure
  ("Bylaw listed for first reading").
- "category": exactly one of {", ".join(TOPICS)}.
- "status": exactly one of {", ".join(STATUSES)}. Adopted = bylaw finally adopted; Approved = non-bylaw item approved; Defeated/Withdrawn when the latest decision says so; Completed = received for information or finished with nothing pending; otherwise Active.
"mentions" are separately linked context, not decisions on this matter. They may describe
public comments or earlier presentations: retain their source dates, attribute them, and do not
use them to infer adoption, approval, a vote, or a change in legal status. Only "history" entries
are owned proceedings and may receive timeline headlines. A date mentioned inside a report is
not necessarily the date of its containing council meeting; never silently substitute one for the other.
"editor_notes", when present, are an editor's requests about this matter's text (from the site's page review):
follow them where the history and mentions support it, or where the note quotes the record ("The record says: …"; an
editor checked that quote against the council's documents, so it counts as an input), and leave out what they ask
for if neither says it.
Never invent facts that are not in the inputs. If the history is too thin to say what it is about, base the summary on the title alone and keep it short.
Figures and names are copied, never made: every amount, count, measurement, date and name comes exactly from the inputs,
whole ("$4,408,940.67", "1.5 spaces per unit", not "$67" or "5 spaces"), and from a record, not the notes. Don't round, total, convert or estimate one,
don't give a count (units, lots, homes) the inputs don't state, and don't expand a name or acronym the inputs don't spell out.
"fix_these", when present, lists problems a check found in your last text for this matter, with what the records say:
fix every one, using the records' own words and figures, or leave the statement out."""

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


KEY_SECTION = re.compile(r"purpose|executive summary|proposal|comment|recommendation|summary|background|discussion|financial", re.I)


def _paginate(query_fn, page: int = 1000) -> list[dict]:
    rows: list[dict] = []
    start = 0
    while True:
        chunk = query_fn().range(start, start + page - 1).execute().data or []
        rows.extend(chunk)
        if len(chunk) < page:
            return rows
        start += page


LOAD_CHUNK = 32  # matters whose records are loaded at once (then packed into requests by size)


def _in_chunks(build, ids: list[int], size: int = 200) -> list[dict]:
    """Every row of ``build(chunk)`` for the ids in chunks (long id lists overflow a request URL), all pages."""
    rows: list[dict] = []
    for start in range(0, len(ids), size):
        chunk = ids[start : start + size]
        rows.extend(_paginate(lambda: build(chunk)))
    return rows


def _load_context(supabase: Client, matter_ids: list[int]) -> list[dict]:
    """Each matter's whole history and its accepted mentions, with every record in full: motion wording, report text,
    the video transcript of each discussed item. Nothing is cut to fit; ``refresh_matter_summaries`` packs matters into
    requests by size instead (pipeline.ai.budget)."""
    matters = _in_chunks(lambda ids: supabase.table("matters").select("id, municipality_id, title, identifier, category, status, meta")
                         .in_("id", ids).order("id"), matter_ids)
    # Merged duplicates (aliases) keep their agenda items; read them as the canonical's history.
    owner = {m["id"]: m["id"] for m in matters}
    for m in matters:
        for alias_id in (m.get("meta") or {}).get("merged_matter_ids") or []:
            owner[int(alias_id)] = m["id"]
    items = _in_chunks(lambda ids: supabase.table("agenda_items")
                       .select("id, matter_id, meeting_id, title, description, plain_english_summary, debate_summary, "
                               "discussion_start_time, discussion_end_time, meetings(meeting_date, type)")
                       .in_("matter_id", ids).order("id"), list(owner))
    for item in items:
        item["matter_id"] = owner.get(item["matter_id"], item["matter_id"])
    links = _in_chunks(lambda ids: supabase.table("matter_links").select("id,matter_id,agenda_item_id").in_("matter_id", ids)
                       .eq("kind", "mention").eq("hidden", False).order("id"), list(owner))
    mention_ids = sorted({link["agenda_item_id"] for link in links if link.get("agenda_item_id")})
    mention_items = _in_chunks(lambda ids: supabase.table("agenda_items")
                               .select("id,matter_id,title,plain_english_summary,meetings!inner(meeting_date,municipality_id)")
                               .in_("id", ids).order("id"), mention_ids) if mention_ids else []
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
            "notes": {"summary": item.get("plain_english_summary") or ""}, "source": "accepted mention",
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
                **({"editor_notes": notes} if (notes := [n for n in ((matter.get("meta") or {}).get("editor_notes") or [])
                                                          if isinstance(n, str) and n.strip()]) else {}),
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
    result = ai.json(_prompt(batch), stage="writing", schema=MatterSummaries, system=SYSTEM)
    return {m.id: m.model_dump() for m in result.matters if m.summary.strip()}


class SummaryProblem(BaseModel):
    matter: int = Field(description="The matter's id")
    statement: str = Field(description="The words in the summary, status or a headline that are wrong, quoted")
    verdict: Literal["contradicted", "not_in_record"]
    record_says: str = Field(description="What the records say instead, quoted; empty when they say nothing about it")


class SummaryCheck(BaseModel):
    problems: list[SummaryProblem]


CHECK_PROMPT = """You check short texts written for residents about city council matters against the records they were
written from. """ + CHECK_RULE + """
For each matter below you get its inputs (as given to the writer) and the text: a summary, a
"where it stands" line, and a headline per timeline step (keyed by the history entry's item id). List every statement
the records contradict (a different amount, count, measurement, date, name, address, outcome or step) or don't contain
at all (an invented figure, count, name or detail). For a headline, compare it with that entry's motions and result:
a different reading or step than the motion records (first reading called "second and third", a direction to prepare
a bylaw called a reading, a decision where there was no motion) is contradicted, and a headline that names only the
procedure ("Bylaw listed for first reading") without what it's about is a problem too (verdict not_in_record, quote
it). Paraphrase and plain-language simplification are fine; judge facts, not style. A statement about what the
records don't say ("no decision is recorded") is fine when true. Missing detail is not a problem. Return no problems
when the text is right.

"""


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
                results[mid] = update
                if not dry_run:
                    supabase.table("matters").update(update).eq("id", mid).execute()
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
        query = supabase.table("matters").select("id").order("id").is_("meta->>canonical_matter_id", "null")
        if since:
            query = query.gte("last_seen", since)
        return query.is_("plain_english_summary", "null") if only_missing else query

    return [r["id"] for r in _paginate(q)]
