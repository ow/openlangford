"""Votes where the meeting video and the minutes disagree.

Minutes often name only who opposed, and Langford's procedure bylaws count every other member present as voting in
favour, so a full ballot is reconstructed from them (``motions.meta.ballot_reconstruction``). Now and then the video
shows a member voting against a motion the minutes record without dissent: the debate summary (written from the
transcript) says "Szpak voted against". The reconstructed ballot is still the official record, so it stays; the
disagreement is stored beside it (``motions.meta.video_dissent``) and the meeting page shows both.

Candidates are motions with a reconstructed "Yes" for someone the item's debate summary names near "voted against" or
"opposed"; the reviewer model then reads the item's motions and transcript to confirm the dissent was on this motion
(not an amendment or an earlier motion on the same item).
"""
from __future__ import annotations

import json as _json
import re
from typing import Any

from pydantic import BaseModel

from pipeline import ai

DISSENT = re.compile(r"(?i)\b(voted against|voted no|voted in opposition|opposed|dissent(?:ed|ing)?)\b")
TRANSCRIPT_CAP = 12000


class _Check(BaseModel):
    dissented: bool
    named: bool
    quote: str
    reason: str


PROMPT = """A Langford council or committee meeting's minutes record this motion, and under the City's procedure bylaw
everyone present who isn't recorded as opposed counts as voting in favour. The summary of the meeting video says
{name} voted against. Did {name} vote against THIS motion (not an amendment to it, an earlier or later motion on the
same item, or a different item)? Answer from the transcript where you can.

- dissented: true if a vote against this motion is heard in the transcript and the summary says it was {name}'s, or
  the transcript names {name} voting against it. False if the transcript shows it carried with no one opposed, or the
  opposition was to an amendment or another motion.
- named: true only if the transcript itself says it was {name} (the chair naming them, or them saying so).
- quote: the transcript words of the vote (e.g. "All in favour, opposed, noted, carried"); empty if none.
- reason: one plain sentence.

MOTION ON RECORD: {motion}

ALL MOTIONS ON THIS ITEM:
{motions}

VIDEO SUMMARY OF THE DISCUSSION: {debate}

TRANSCRIPT OF THE DISCUSSION:
{transcript}"""


def _last(name: str) -> str:
    return re.sub(r"[^A-Za-z'-]", "", (name or "").split()[-1]) if name else ""


def candidates(cur, meeting_ids: list[int] | None = None) -> list[dict]:
    """Motions with a reconstructed "Yes" for someone the debate summary names in the same sentence as a dissent."""
    cur.execute("""select m.id, m.text_content, m.meta, a.id, a.debate_summary, a.meeting_id,
                          a.discussion_start_time, a.discussion_end_time
                   from motions m join agenda_items a on a.id = m.agenda_item_id
                   where m.meta ? 'ballot_reconstruction' and a.debate_summary ~* '(voted against|voted no|opposed|dissent)'
                     and (%(meetings)s::bigint[] is null or a.meeting_id = any(%(meetings)s))""", {"meetings": meeting_ids})
    out = []
    for mid, text, meta, item_id, debate, meeting_id, start, end in cur.fetchall():
        sentences = [s for s in re.split(r"(?<=[.;])\s+", debate or "") if DISSENT.search(s)]
        for v in (meta.get("ballot_reconstruction") or {}).get("votes") or []:
            last = _last(v.get("person_name"))
            if v.get("vote") != "Yes" or not str(v.get("evidence", "")).startswith("inferred_") or len(last) < 3:
                continue
            if any(re.search(rf"\b{re.escape(last)}\b", s) for s in sentences):
                out.append({"motion_id": mid, "motion": text, "item_id": item_id, "debate": debate, "meeting_id": meeting_id,
                            "start": start, "end": end, "person_id": v.get("person_id"), "name": v.get("person_name")})
    return out


def _context(cur, c: dict) -> tuple[str, str]:
    cur.execute("select text_content, result from motions where agenda_item_id = %s order by id", (c["item_id"],))
    motions = "\n".join(f"- {(t or '').strip()[:600]} ({r or 'no result'})" for t, r in cur.fetchall())
    if c["start"] is None:
        return motions, "(no transcript for this item)"
    cur.execute("""select coalesce(speaker_name, 'Speaker'), text_content from transcript_segments
                   where meeting_id = %s and start_time >= %s and start_time < %s order by start_time""",
                (c["meeting_id"], c["start"], c["end"] if c["end"] is not None else c["start"] + 1800))
    transcript = "\n".join(f"{who}: {text}" for who, text in cur.fetchall())
    return motions, (transcript[-TRANSCRIPT_CAP:] or "(no transcript for this item)")


def run(*, meeting_ids: list[int] | None = None, dry_run: bool = False) -> dict[str, Any]:
    """Confirm each candidate with the reviewer model and store confirmed ones on the motion; a motion whose earlier
    finding no longer holds has it removed."""
    from pipeline.db import connect, run_write

    conn = connect()
    conn.set_session(readonly=True)
    try:
        cur = conn.cursor()
        found = candidates(cur, meeting_ids)
        contexts = [_context(cur, c) for c in found]
        cur.execute("""select m.id from motions m join agenda_items a on a.id = m.agenda_item_id where m.meta ? 'video_dissent'
                       and (%(meetings)s::bigint[] is null or a.meeting_id = any(%(meetings)s))""", {"meetings": meeting_ids})
        stored = {mid for (mid,) in cur.fetchall()}
        conn.rollback()
    finally:
        conn.close()
    confirmed: dict[int, list[dict]] = {}
    checked = []
    for c, (motions, transcript) in zip(found, contexts):
        res = ai.json(PROMPT.format(name=c["name"], motion=(c["motion"] or "")[:2000], motions=motions, debate=c["debate"],
                                    transcript=transcript), stage="review", schema=_Check)
        checked.append({**{k: c[k] for k in ("motion_id", "item_id", "name")}, **res.model_dump()})
        if res.dissented:
            confirmed.setdefault(c["motion_id"], []).append(
                {"person_id": c["person_id"], "name": c["name"], "named_in_video": res.named, "quote": res.quote[:400],
                 "reason": res.reason})
    if not dry_run:
        def write(cur):
            for mid, dissents in confirmed.items():
                cur.execute("update motions set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('video_dissent', %s::jsonb) where id = %s",
                            (_json.dumps(dissents), mid))
            gone = sorted(stored - set(confirmed))
            if gone:
                cur.execute("update motions set meta = meta - 'video_dissent' where id = any(%s)", (gone,))
        run_write(write)
    print(f"  [Video dissent] {len(found)} candidate(s), {sum(map(len, confirmed.values()))} confirmed")
    return {"candidates": len(found), "confirmed": confirmed, "checked": checked}
