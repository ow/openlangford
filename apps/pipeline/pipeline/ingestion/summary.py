from __future__ import annotations

import json
import os

from supabase import Client

from pipeline import config
from pipeline import ai
from pipeline.ingestion.ingester import MeetingIngester
from pipeline.paths import BASE_DIR
from pipeline.ingestion.summary_format import normalize_meeting_summary


SUMMARY_SYSTEM = """You write concise municipal meeting summaries for residents.
Focus on what changed, what was decided, what was controversial, and what follow-up was directed.
Do not include attendance roll calls, procedural housekeeping, or filler conclusions."""


def _absolute_archive_path(archive_path: str) -> str:
    if os.path.isabs(archive_path):
        return archive_path
    return os.path.join(BASE_DIR, archive_path)


def build_summary_prompt(meeting: dict, agenda_text: str, minutes_text: str, transcript_text: str) -> str:
    return f"""
Regenerate ONLY the public-facing meeting summary.

Meeting:
- Title: {meeting.get("title") or "Meeting"}
- Date: {meeting.get("meeting_date") or "Unknown"}
- Type: {meeting.get("type") or meeting.get("meeting_type") or "Unknown"}

Output rules:
- Return 3-5 Markdown bullets ("- "), one decision or outcome per bullet. No heading, no intro or closing sentence, no JSON.
- Order bullets by how much they matter to residents (money, land use, housing, taxes, services first).
- Keep each bullet under 18 words. Start with the outcome verb ("Approved", "Rejected", "Gave first reading to", "Directed staff to", "Deferred").
- Write for residents, not insiders. Say what the decision does in everyday terms, then at most one short identifier in parentheses at the end, e.g. "Adopted new fees developers pay toward community amenities (Bylaw 2275)." or "Allowed reduced setbacks for the RCMP building expansion on Atkins Ave; Guiry opposed."
- Leave out amendment numbers, policy codes (e.g. POL-0185-FIN), formal bylaw titles, quotation marks and ALL-CAPS labels like "(ADOPTION)". Spell out acronyms (say "development variance permit", not "DVP").
- Name the street or neighbourhood when relevant and include dollar amounts.
- Name the exact bylaw stage (first/second/third reading or adoption); never blur it into "final readings" or "approved".
- If any council member voted against or the vote was split, say who in the bullet (e.g. "Guiry opposed").
- Do not repeat the meeting title, type or date — they are shown beside the summary.
- Skip attendance, chair names, call to order, agenda adoption, consent-agenda housekeeping, closed-session motions and adjournment unless that was the only business (then one bullet saying so).
- Never present an agenda proposal or discussion as a decision.

Official minutes are the source of truth for decisions and vote outcomes.
If minutes are unavailable, distinguish transcript-reported decisions from proposals. Never turn an agenda proposal into an approved outcome.

MINUTES:
{minutes_text}

AGENDA:
{agenda_text}

TRANSCRIPT:
{transcript_text}
""".strip()


def regenerate_meeting_summary(
    supabase: Client,
    meeting_id: int,
    *,
    municipality_id: int,
    update_refinement_file: bool = True,
    dry_run: bool = False,
) -> dict:
    meeting_res = (
        supabase.table("meetings")
        .select("id, title, type, meeting_date, archive_path")
        .eq("id", meeting_id)
        .eq("municipality_id", municipality_id)
        .single()
        .execute()
    )
    meeting = meeting_res.data
    if not meeting:
        raise ValueError(f"meeting_id not found: {meeting_id}")
    if not meeting.get("archive_path"):
        raise ValueError(f"meeting_id {meeting_id} has no archive_path")

    folder_path = _absolute_archive_path(meeting["archive_path"])
    if not os.path.isdir(folder_path):
        raise ValueError(f"archive path does not exist: {folder_path}")

    supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
    ingester = MeetingIngester(
        config.SUPABASE_URL,
        supabase_key,
        municipality_id=municipality_id,
    )
    agenda_text, minutes_text, transcript_text = ingester.get_raw_texts(folder_path)
    if len((minutes_text or "").strip()) < 100 and len((agenda_text or "").strip()) < 100:
        raise ValueError(f"meeting_id {meeting_id} has no usable agenda or minutes text")

    prompt = build_summary_prompt(meeting, agenda_text or "", minutes_text or "", transcript_text or "")
    if ai.budget.size(prompt) > ai.INPUT_BUDGET_CHARS:  # never cut the minutes or transcript to fit; say so instead
        raise ai.TooLarge(f"meeting {meeting_id}: {ai.budget.size(prompt):,} characters of minutes, agenda and transcript")
    summary = ai.text(prompt, stage="extraction", system=SUMMARY_SYSTEM)
    if not summary or len(summary.strip()) < 20:
        raise RuntimeError("summary generation returned an empty response")

    summary = normalize_meeting_summary(summary)
    if dry_run:
        return {
            "meeting_id": meeting_id,
            "archive_path": meeting["archive_path"],
            "summary": summary,
            "summary_chars": len(summary),
            "refinement_updated": False,
            "dry_run": True,
        }
    supabase.table("meetings").update({"summary": summary}).eq("id", meeting_id).eq("municipality_id", municipality_id).execute()

    refinement_updated = False
    if update_refinement_file:
        refinement_path = os.path.join(folder_path, "refinement.json")
        if os.path.exists(refinement_path):
            try:
                with open(refinement_path, "r", encoding="utf-8") as handle:
                    refinement = json.load(handle)
                refinement["summary"] = summary
                with open(refinement_path, "w", encoding="utf-8") as handle:
                    json.dump(refinement, handle, indent=2, ensure_ascii=False)
                    handle.write("\n")
                refinement_updated = True
            except Exception as exc:
                print(f"  [!] Failed to update refinement.json summary: {exc}")

    return {
        "meeting_id": meeting_id,
        "archive_path": meeting["archive_path"],
        "summary_chars": len(summary),
        "refinement_updated": refinement_updated,
    }
