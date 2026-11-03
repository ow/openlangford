from __future__ import annotations

import json
import os

from supabase import Client

from pipeline import config
from typing import Literal

from pydantic import BaseModel

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
  A committee only recommends: start its bullets with "Recommended" ("Recommended rezoning 1029 Marwood Avenue for three
  lots"), never "Approved recommending".
- Write for residents, not insiders. Say what the decision does in everyday terms, then at most one short identifier in parentheses at the end, e.g. "Adopted new fees developers pay toward community amenities (Bylaw 2275)." or "Allowed reduced setbacks for the RCMP building expansion on Atkins Ave; Guiry opposed."
- Leave out amendment numbers, policy codes (e.g. POL-0185-FIN), formal bylaw titles, quotation marks and ALL-CAPS labels like "(ADOPTION)". Spell out acronyms (say "development variance permit", not "DVP").
- Name the street or neighbourhood when relevant and include dollar amounts.
- Name the exact bylaw stage (first/second/third reading or adoption); never blur it into "final readings" or "approved".
- If any council member voted against or the vote was split, say who in the bullet (e.g. "Guiry opposed"), but only when
  the minutes name them or the chair names them in the transcript. Arguing against a motion isn't voting against it, and
  transcript speaker names are a machine's guess: when a vote against is heard but not named, say "one member opposed".
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


class _Problem(BaseModel):
    statement: str
    problem: str


class _Dissent(BaseModel):
    name: str
    named_in: Literal["minutes", "chair_on_video", "nowhere"]
    quote: str


class _Check(BaseModel):
    problems: list[_Problem]
    dissents: list[_Dissent]


def check_summary(summary: str, agenda_text: str, minutes_text: str, transcript_text: str) -> list[str]:
    """Problems of fact in a meeting summary, judged by the reviewer model against the meeting's own records."""
    prompt = f"""You check a short public summary of a Langford council or committee meeting against the meeting's records:
its minutes, agenda and video transcript (whose speaker names are a machine's guess). List every statement the records
contradict or don't contain: a figure, name, place, outcome or bylaw stage that differs or appears nowhere, and anyone
named as voting against or opposed unless the minutes name them or the chair names them in the transcript (arguing
against a motion is not voting against it). Wording and simplification are fine; judge facts only. Return no problems
when it is right.
Separately, under "dissents", list every person the summary names as voting against or opposed, with where the records
name them doing so: "minutes" (the minutes record them as opposed), "chair_on_video" (the chair names them in the
transcript, e.g. "opposed, Councillor X"), or "nowhere" (you'd have to infer it, e.g. from who argued against). Quote
the words that name them; empty when nowhere.

SUMMARY:
{summary}

MINUTES:
{minutes_text}

AGENDA:
{agenda_text}

TRANSCRIPT:
{transcript_text}"""
    if ai.budget.size(prompt) > ai.INPUT_BUDGET_CHARS:
        raise ai.TooLarge(f"{ai.budget.size(prompt):,} characters to check")
    checked = ai.json(prompt, stage="review", schema=_Check)
    return [f"{p.statement}: {p.problem}" for p in checked.problems] + [
        f"{d.name} is named as opposed, but no record names them voting against (say \"one member opposed\" or leave it out)"
        for d in checked.dissents if d.named_in == "nowhere" or not d.quote.strip()]


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
    summary = ai.text(prompt, stage="writing", system=SUMMARY_SYSTEM)
    if not summary or len(summary.strip()) < 20:
        raise RuntimeError("summary generation returned an empty response")
    # Checked against the minutes, agenda and transcript; rewritten once if anything is unsupported, keeping whichever
    # version has fewer problems (2026-11-03: a dissent attributed to whoever argued against, named nowhere).
    problems = check_summary(summary, agenda_text or "", minutes_text or "", transcript_text or "")
    if problems:
        revised = ai.text(prompt + "\n\nYour previous summary:\n" + summary + "\n\nA check against the minutes, agenda and "
                          "transcript found these problems. Fix each one from the records' own words, or leave the "
                          "statement out, and return the whole summary again:\n- " + "\n- ".join(problems),
                          stage="writing", system=SUMMARY_SYSTEM)
        if revised and len(revised.strip()) >= 20:
            left = check_summary(revised, agenda_text or "", minutes_text or "", transcript_text or "")
            if len(left) < len(problems):
                summary, problems = revised, left
    if problems:
        print(f"  [Summary] meeting {meeting_id}: kept with problems: {'; '.join(problems)}")

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
