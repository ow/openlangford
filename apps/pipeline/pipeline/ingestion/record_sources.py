"""What a model may take facts from: the record, not what another model wrote about it.

The site stores a lot of model-written text: agenda item and motion summaries, video (debate) summaries, meeting
summaries, a report's extracted summary and key facts. They are compressed and lossy, and sometimes wrong, so a
writer or a checker that reads them as the record repeats their mistakes (2026-11-03: a meeting's highlights copied
a count from its summary, and the check accepted it because the summary was among the "records"). Writers and checkers
still read them, to find their way, but under a separate ``notes`` label and with ``RECORD_RULE``: every fact must be
in the record itself. Where the video is the only original (a meeting without minutes, an item discussed but not
minuted), its transcript is given as record.
"""
from __future__ import annotations

from typing import Iterable

from supabase import Client

RECORD_RULE = """Inputs come in two kinds. "record" is the City's own text: motion wording and results, minutes, report
text, and transcripts of the meeting video (whose speaker names are a machine's guess). "notes" are summaries a model
wrote earlier from the record: helpful for finding your way, but compressed and sometimes wrong. Every figure, count,
amount, name, date, place, step and outcome you state must be in a record; something only the notes say is unconfirmed,
so leave it out."""

CHECK_RULE = """The inputs come in two kinds. "record" is the City's own text (motion wording and results, minutes,
report text, video transcripts); "notes" are summaries a model wrote earlier, which may be wrong. A statement is
supported only by a record. A statement only the notes back is not_in_record (say "only in a model-written summary"),
and so is one where a note and the record disagree and the text follows the note."""

TRANSCRIPT_CAP = 6000  # characters per agenda item; long discussions keep their end, where the motion and vote are


def _segments(supabase: Client, meeting_id: int, start: float | None = None, end: float | None = None) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        query = supabase.table("transcript_segments").select("start_time, speaker_name, text_content").eq("meeting_id", meeting_id)
        if start is not None:
            query = query.gte("start_time", start)
        if end is not None:
            query = query.lt("start_time", end)
        chunk = query.order("start_time").range(offset, offset + 999).execute().data or []
        rows.extend(chunk)
        if len(chunk) < 1000:
            return rows
        offset += 1000


def _text(segments: list[dict], cap: int) -> str:
    text = "\n".join(f"{s.get('speaker_name') or 'Speaker'}: {s.get('text_content') or ''}" for s in segments)
    return text if len(text) <= cap else "…" + text[-cap:]


def item_transcripts(supabase: Client, items: Iterable[dict], cap: int = TRANSCRIPT_CAP) -> dict[int, str]:
    """The video transcript of each item's discussion ({item id: text}), for items with a discussion window."""
    out: dict[int, str] = {}
    for item in items:
        start = item.get("discussion_start_time")
        if start is None or not item.get("meeting_id"):
            continue
        end = item.get("discussion_end_time")
        text = _text(_segments(supabase, item["meeting_id"], float(start), float(end) if end is not None else float(start) + 1800), cap)
        if text.strip():
            out[item["id"]] = text
    return out


def meeting_transcript(supabase: Client, meeting_id: int, cap: int = 60000) -> str:
    """The whole meeting's video transcript, capped (the start: a meeting's business is in agenda order)."""
    text = _text(_segments(supabase, meeting_id), 10**9)
    return text[:cap] + ("…" if len(text) > cap else "")
