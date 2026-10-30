"""Plain-language highlights for a meeting, for residents.

``meetings.summary`` is written during ingest for people who follow council
closely: exact bylaw stages, bylaw numbers, who opposed. This stage rewrites
the meeting's outcomes for everyone else, from the summary plus the decided
motions and agenda items, into ``meetings.meta.highlights``::

    {"bullets": ["...", "..."],
     "links": [[{"text": "2609 Sooke Road", "agenda_item_id": 123}], []],
     "description": "May 19, 2026: ...", "version": "2"}

``bullets`` are 2–4 one-sentence outcomes, most significant first (plain strings,
so readers of version 1 keep working). ``links`` is aligned with ``bullets``:
``links[i]`` lists phrases of ``bullets[i]`` (exact substrings, first occurrence,
in reading order, non-overlapping, at most 3) and the agenda item of the same
meeting each is about; the web turns them into ``#item-{id}`` anchors.
``description`` is one sentence of at most 155 characters for SEO and share cards.
The summary is never touched (ingest rewrites it; it stays the source).

``meta`` is shared with other writers (posters, calendar, …), so only the
``highlights`` key is replaced, with a compare-and-swap on ``updated_at``.
Bump ``HIGHLIGHTS_VERSION`` after a prompt change and run
``main.py --stage meeting-highlights --stale``.
"""
from __future__ import annotations

import json
import re
from datetime import date
from typing import Any

from pydantic import BaseModel
from supabase import Client

from pipeline import ai

HIGHLIGHTS_VERSION = "2"
DESCRIPTION_MAX = 155
# Meetings that never happened (or haven't yet) get no highlights.
SKIP_STATUSES = ("Planned", "Cancelled")

# Rules quoted from docs/writing-style.md (the repo-wide guide for public text) are marked "Style rule N".
SYSTEM = """You explain what happened at a council or committee meeting in Langford, BC, to a resident on a phone who has never read a council agenda.
They want to know what happened and whether it affects them. Assume no knowledge of council procedure, bylaw numbers or city jargon.

You get the meeting's existing insider summary, its recorded decisions (motions with results and votes) and, for context only, what was on the agenda.
Write:
1. `bullets`: 2 to 4 bullets (1 only if the meeting had a single piece of real business). Each bullet is ONE sentence of at most 20 words, about one idea.
   Keep the headline of a decision and drop long lists of details: "Passed new developer charges to pay for future parks." and
   "Updated several zoning rules, including daycares and electric-vehicle charging." rather than one long bullet carrying both.
   Never repeat a stock phrase across bullets ("one step from final approval", "asked staff to", "no one spoke"). When several items reached the same stage,
   group them in one bullet: "Moved the 2026 budget and tax rates, City Centre parking rules (passed 6–1) and stronger noise rules one step from final approval."
   A grouped bullet names at most 3 items: drop the minor ones. Keep normal grammar with articles ("the 2026 budget", not "budget"). Otherwise vary the wording.
2. `description`: one sentence that sums up the whole meeting for a search result or share card.
Each bullet has `text` (the sentence) and `links`: 0 to 3 short noun phrases copied character for character from that bullet's text
(a place, facility, project or topic, e.g. "2609 Sooke Road", "Jacklin Road", "the 2026–2030 budget"), each with the `agenda_item_id` of the agenda item
(from `agenda_items_for_context_only` or a decision's `agenda_item_id`) that the phrase is about. Link only where the item clearly matches; no links is fine.
Never link a whole sentence or a verb, and link each agenda item only once across all bullets (its first mention).
When `decisions` is empty, the existing summary is the record: its past-tense outcomes ("Recommended…", "Approved…", "Gave first reading…",
"Heard a presentation…") are outcomes to write up, the same as recorded decisions.
Only if nothing happened beyond scheduling and housekeeping (the summary says what "will" be or was "scheduled", or only approves the agenda,
minutes and adjournment), return an empty `bullets` list and an empty `description`;
never write a bullet saying nothing was decided or recorded.

Style rules (from the site's writing guide):
- Style rule 1, "Say what happened, not what was on the agenda." "Council approved 47 homes on Latoria Road", not "Consider bringing Bylaw 2278 forward".
  A decision belongs in a bullet only if a motion result or the summary records it. An agenda item with no recorded outcome is not a decision: leave it out.
- Style rule 2, "Most important first. Lead with the outcome and who it affects. Dates, counts, sources and caveats go last, if at all."
  Rank: budget and property taxes, housing and big developments, rezoning of named places, services, fees and fines, parks and roads.
  Procedural business (agenda, minutes, going in camera, adjournment, receiving reports) comes last or not at all. Combine closely related decisions (a budget and its tax rates) into one bullet.
- Style rule 3, "Everyday words. Write "garbage" not "solid waste", "passed" not "adopted", "rules" not "regulations". If a term can't be avoided, explain it in a few words the first time."
- Style rule 4, "Explain process instead of naming it. "Moved the 2026 budget one step from final approval", not "gave first, second and third reading". "Made final", not "adopted at fourth reading"."
  - third reading (with or without first and second) -> "moved ... one step from final approval"; first or second reading only -> "gave early approval to".
  - adopted / final reading -> "passed" or "made final" (not "approved", which hides that it is final). Never write "adopted", "reading" or "readings".
    Don't add caveats like "a later vote is still needed": "one step from final approval" already says it.
  - directed staff to bring a bylaw or rezoning forward for readings -> "asked city staff to bring ... back for a council vote". It is a step forward, not an approval.
  - directed staff to prepare / draft / investigate -> "asked city staff to ...". Never write "directed".
  - received for information / heard a presentation -> "heard from ..." (only if it matters to residents).
  - a committee (not Council) only recommends: "recommended that Council ...", or what it asked staff to do; never that it approved or passed something.
  - a closed (in-camera) session -> "met privately to discuss ..." with the topic only if it is given.
- Style rule 5, "No internal codes. No bylaw, file, permit or policy numbers (Z15-0004, POL-0031-FIN, LGA s.146(2)(b)) in running text."
  Also no jargon or abbreviations: "an exception to the building rules" rather than DVP or variance permit, "the community plan" rather than OCP, "temporary permit" rather than TUP;
  explain a covenant in a few words ("a legal promise to keep homes affordable") or leave it out.
- Style rule 6, "No database words. Never "matters", "records", "agenda items", "segments" or "attribution" in public copy."
- Style rule 7, "Counts in plain terms, last." A vote tally goes at the end of its bullet, e.g. "(passed 6–1)".
  A tally belongs to one decision: when a bullet combines several, say which one was split ("the $800,000 cut passed 4–3"); never attach it to the whole bullet.
  Parallel, near-identical outcomes always merge into one bullet, never one each: three public hearings that closed with no speakers become
  "Held public hearings on business-park zoning for West Shore Parkway and Langshire Road and a community plan update; no one spoke."
- Style rule 8, "Short sentences, active voice. One idea per sentence. About 20 words at most. Council (or the person) is the subject: "Council rejected…", not "It was resolved that…"."
  The bullets appear under the meeting's name, so Council (or the committee) is the understood subject: start each bullet with the past-tense verb,
  as in the guide's example "Moved to drop minimum parking requirements for new City Centre buildings, one step from final approval (passed 6–1)".
  Other examples: "Capped garbage collection fees at $280 a year.", "Made final the zoning for a health clinic on Happy Valley Road.", "Met privately to discuss a land purchase."
- Style rule 9, "Concrete. Name the street, the facility, the dollar amount, the number of homes."
  Keep full street names ("Sooke Road", not "Sooke"); to save words, drop details, not street types.
  Every bullet names the specific place, facility or thing when the inputs give it: not "Made the dedication of land as park final"
  but "Made final the new park on Goldstream Avenue" (whatever the inputs say it is and where).
- Style rule 10, "Never invent. If the records don't say how something ended, leave it out." No numbers, places, names or outcomes that are not in the inputs,
  and no characterizations they don't support (don't say "renewed" an agreement the inputs only say was approved or entered into). The description follows this too.
- Style rule 11, "Never infer gender: no he/she unless the source states pronouns. Dissent only when it matters to the story, in plain words ("passed 6–1")." Do not name individual council members.
- Style rule 13, "Write so it stays true. Avoid "currently", "incoming until", "recently" in stored text; give the date instead." Also avoid "now", "is now", "can now": write what was decided.
- Style rule 14, "Canadian spelling", numerals for 10 and up and for all money and measurements.
- No quotation marks, no Markdown, no wrap-up bullet, no meeting title, date or type in the bullets.

Description:
- At most 135 characters. Starts with the body as subject: "Council ..." for council meetings, the committee's short name for committees ("The parks committee ...", "The accessibility committee ...", "The Board of Variance ...").
- The two or three most significant outcomes, e.g. "Council approved a new 911 dispatch deal and fines for noise and construction."
- Same style rules: no codes, jargon or database words."""


class Link(BaseModel):
    text: str
    agenda_item_id: int


class Bullet(BaseModel):
    text: str
    links: list[Link]


class Highlights(BaseModel):
    bullets: list[Bullet]
    description: str


def _texts(result: Highlights) -> list[str]:
    return [_clean_line(b.text) for b in result.bullets]


# ── inputs ───────────────────────────────────────────────────────────────


def _trim(text: Any, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _tally(votes: list[dict]) -> dict | None:
    if not votes:
        return None
    counts: dict[str, int] = {}
    for v in votes:
        key = (v.get("vote") or "").strip().lower() or "unknown"
        counts[key] = counts.get(key, 0) + 1
    yes, no = counts.get("yes", 0), counts.get("no", 0)
    if not yes and not no:
        return None
    return {"for": yes, "against": no}


def build_inputs(meeting: dict, motions: list[dict], votes_by_motion: dict[int, list[dict]],
                 agenda_items: list[dict]) -> dict:
    """The JSON the model sees: meeting facts, decided motions (most informative first), agenda items."""
    titles = {a["id"]: a.get("title") or "" for a in agenda_items}
    decisions = []
    procedural = 0
    for m in motions:
        if not m.get("result"):
            continue
        if (m.get("disposition") or "") == "Procedural":
            procedural += 1
            # Keep the procedural one-liners only for meetings that had nothing else (e.g. closed sessions).
            if any((x.get("disposition") or "") != "Procedural" and x.get("result") for x in motions):
                continue
        entry = {
            "agenda_item_id": m.get("agenda_item_id") if m.get("agenda_item_id") in titles else None,
            "agenda_item": _trim(titles.get(m.get("agenda_item_id")), 160),
            "decision": _trim(m.get("plain_english_summary"), 400),
            "headline": (m.get("meta") or {}).get("headline") or "",
            "result": m.get("result"),
        }
        if not entry["decision"]:
            entry["motion_text"] = _trim(m.get("text_content"), 600)
        tally = _tally(votes_by_motion.get(m["id"], []))
        if tally and tally["against"]:
            entry["vote"] = f"{tally['for']}–{tally['against']}"
        decisions.append({k: v for k, v in entry.items() if v})
    # Every titled item (with its id, for links); summaries only where they add something.
    items = [
        {k: v for k, v in {"id": a["id"], "title": _trim(a.get("title"), 160),
                           "summary": _trim(a.get("plain_english_summary"), 300)}.items() if v}
        for a in agenda_items
        if a.get("title")
    ]
    return {
        "meeting": {
            "title": meeting.get("title"),
            "type": meeting.get("type"),
            "date": meeting.get("meeting_date"),
            "has_minutes": meeting.get("has_minutes"),
        },
        "existing_summary": meeting.get("summary") or "",
        "decisions": decisions,
        "agenda_items_for_context_only": items[:60],
    }


def build_prompt(inputs: dict) -> str:
    return (
        "Write the plain-language highlights for this meeting. The `decisions` are the recorded outcomes; "
        "`agenda_items_for_context_only` explain what items were about but are NOT outcomes on their own.\n\n"
        + json.dumps(inputs, ensure_ascii=False, default=str)
    )


# ── output ───────────────────────────────────────────────────────────────


def format_date(value: Any) -> str:
    d = value if isinstance(value, date) else date.fromisoformat(str(value)[:10])
    return f"{d.strftime('%B')} {d.day}, {d.year}"


def _clean_line(text: str) -> str:
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text or "")
    text = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s+", "", text)
    text = re.sub(r"\s+", " ", text).strip().strip('"“”').strip()
    if text and text[-1] not in ".!?":
        text += "."
    return text


def _shorten(text: str, limit: int) -> str:
    """Cut at a clause or word boundary so the sentence still ends cleanly."""
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    for sep in ("; ", ", and ", ", "):
        i = cut.rfind(sep)
        if i > limit * 0.6:
            return cut[:i].rstrip(" ,;") + "."
    return cut[: cut.rfind(" ")].rstrip(" ,;") + "."


MAX_BULLET_WORDS = 25
REVISION_PASSES = 2
_STOPWORDS = {"a", "an", "and", "the", "of", "to", "for", "in", "on", "at", "with", "by", "from", "its", "city"}


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9$%'’–-]+", text.lower())


def problems(bullets: list[str]) -> list[str]:
    """Deterministic checks the prompt asks for: bullets of at most ~20 words, no stock phrase repeated across bullets."""
    found = []
    for i, b in enumerate(bullets, 1):
        n = len(_words(b))
        if n > MAX_BULLET_WORDS:
            found.append(f"bullet {i} has {n} words; keep each bullet to 20 words or fewer")
    seen: dict[tuple, int] = {}
    reported: set[tuple] = set()
    for i, b in enumerate(bullets, 1):
        w = _words(b)
        grams = {tuple(w[k:k + 4]) for k in range(len(w) - 3)}
        for g in grams:
            if all(x in _STOPWORDS for x in g):
                continue
            if g in seen and seen[g] != i and g not in reported:
                reported.add(g)
                found.append(f'bullets {seen[g]} and {i} both say "{" ".join(g)}"; group those items in one bullet or vary the wording')
            seen.setdefault(g, i)
    return found


_NOTHING = re.compile(r"\bno (?:decisions?|outcomes?|business)\b|\b(?:not|were|was) recorded\b", re.I)


MAX_LINKS_PER_BULLET = 3
MAX_LINK_WORDS = 8


def valid_links(text: str, links: list[Link], item_ids: set[int], used: set[int] | None = None) -> tuple[list[dict], int]:
    """Links whose text is an exact substring of the bullet (first occurrence, non-overlapping, short) and whose
    agenda item belongs to the meeting. An item already linked (``used``, shared across a meeting's bullets) is
    skipped silently so one item isn't linked over and over. Returns (links in reading order, number dropped as invalid)."""
    used = used if used is not None else set()
    kept: list[tuple[int, int, dict]] = []
    dropped = 0
    for link in links:
        phrase = (link.text or "").strip()
        start = text.find(phrase) if phrase else -1
        end = start + len(phrase)
        if link.agenda_item_id in used:
            continue
        if (start < 0 or link.agenda_item_id not in item_ids or len(phrase.split()) > MAX_LINK_WORDS
                or len(phrase) >= len(text.rstrip(".!?")) or any(s < end and start < e for s, e, _ in kept)
                or len(kept) >= MAX_LINKS_PER_BULLET):
            dropped += 1
            continue
        used.add(link.agenda_item_id)
        kept.append((start, end, {"text": phrase, "agenda_item_id": link.agenda_item_id}))
    kept.sort(key=lambda k: k[0])
    return [k for _, _, k in kept], dropped


def clean(result: Highlights, meeting_date: Any, item_ids: set[int] | None = None) -> dict:
    """Stored shape: ``bullets`` (strings, unchanged for older readers), ``links`` aligned with them
    (``links[i]`` = [{text, agenda_item_id}] for ``bullets[i]``), ``description``, ``version``.
    ``links_dropped`` counts invalid model links (diagnostic)."""
    bullets: list[str] = []
    links: list[list[dict]] = []
    dropped = 0
    used: set[int] = set()
    for b in result.bullets:
        text = _clean_line(b.text)
        if not text or _NOTHING.search(text) or len(bullets) >= 4:
            continue
        kept, n = valid_links(text, b.links, item_ids or set(), used)
        bullets.append(text)
        links.append(kept)
        dropped += n
    prefix = f"{format_date(meeting_date)}: "
    sentence = _clean_line(result.description)
    description = prefix + _shorten(sentence, DESCRIPTION_MAX - len(prefix)) if sentence else ""
    return {"bullets": bullets, "links": links, "description": description, "version": HIGHLIGHTS_VERSION,
            "links_dropped": dropped}


# ── stage entry point ────────────────────────────────────────────────────


def _load(supabase: Client, meeting_id: int) -> tuple[dict | None, list[dict], dict[int, list[dict]], list[dict]]:
    rows = (
        supabase.table("meetings")
        .select("id, title, type, status, meeting_date, has_minutes, summary")
        .eq("id", meeting_id)
        .execute()
        .data
    ) or []
    if not rows:
        return None, [], {}, []
    motions = (
        supabase.table("motions")
        .select("id, agenda_item_id, text_content, plain_english_summary, disposition, result, meta")
        .eq("meeting_id", meeting_id)
        .order("id")
        .execute()
        .data
    ) or []
    votes: dict[int, list[dict]] = {}
    ids = [m["id"] for m in motions if m.get("result") and (m.get("disposition") or "") != "Procedural"]
    for start in range(0, len(ids), 200):
        for v in supabase.table("votes").select("motion_id, vote").in_("motion_id", ids[start:start + 200]).execute().data or []:
            votes.setdefault(v["motion_id"], []).append(v)
    items = (
        supabase.table("agenda_items")
        .select("id, title, plain_english_summary, item_order")
        .eq("meeting_id", meeting_id)
        .order("id")
        .execute()
        .data
    ) or []
    return rows[0], motions, votes, items


def eligible(meeting: dict, motions: list[dict]) -> bool:
    if (meeting.get("status") or "") in SKIP_STATUSES:
        return False
    return bool((meeting.get("summary") or "").strip()) or any(m.get("result") for m in motions)


def generate(supabase: Client, meeting_id: int) -> dict | None:
    """Model output for one meeting (nothing written). None when the meeting has nothing to highlight."""
    meeting, motions, votes, items = _load(supabase, meeting_id)
    if not meeting or not eligible(meeting, motions):
        return None
    inputs = build_inputs(meeting, motions, votes, items)
    prompt = build_prompt(inputs)
    result = ai.json(prompt, stage="extraction", schema=Highlights, system=SYSTEM)
    issues = problems(_texts(result))
    for _ in range(REVISION_PASSES):  # revise with the specific problems; keep whichever draft has fewer
        if not issues:
            break
        revised = ai.json(
            prompt + "\n\nYour previous draft:\n" + result.model_dump_json()
            + "\n\nFix these problems and return the full highlights again:\n- " + "\n- ".join(issues),
            stage="extraction", schema=Highlights, system=SYSTEM,
        )
        remaining = problems(_texts(revised))
        # An empty revision has no problems but says nothing: keep the draft that does.
        if revised.bullets and len(remaining) <= len(issues):
            result, issues = revised, remaining
    if issues:
        print(f"  [Highlights] meeting {meeting_id}: kept with warnings: {'; '.join(issues)}")
    room = DESCRIPTION_MAX - len(format_date(meeting["meeting_date"])) - 2
    for _ in range(2):  # shortening passes before falling back to a clause cut
        if len(_clean_line(result.description)) <= room:
            break
        shorter = ai.text(
            f"Shorten this sentence to at most {room - 5} characters. Keep the subject and the most significant "
            f"outcomes, same plain words, no new facts. Reply with the sentence only.\n\n{result.description}",
            stage="extraction", system=SYSTEM,
        ).strip()
        result = Highlights(bullets=result.bullets, description=shorter or result.description)
    out = clean(result, meeting["meeting_date"], {a["id"] for a in items})
    return out if out["bullets"] else None


def write_highlights(supabase: Client, meeting_id: int, highlights: dict | None, *, attempts: int = 4) -> bool:
    """Replace only ``meta.highlights`` (None removes it), guarded by ``updated_at`` so concurrent meta writers are never lost."""
    for _ in range(attempts):
        rows = supabase.table("meetings").select("meta, updated_at").eq("id", meeting_id).execute().data or []
        if not rows:
            return False
        meta = dict(rows[0].get("meta") or {})
        if highlights is None:
            if "highlights" not in meta:
                return True
            meta.pop("highlights")
        else:
            meta["highlights"] = highlights
        query = supabase.table("meetings").update({"meta": meta}).eq("id", meeting_id)
        if rows[0].get("updated_at"):
            query = query.eq("updated_at", rows[0]["updated_at"])
        if query.execute().data:
            return True
    return False


def highlight_meeting(supabase: Client, meeting_id: int, *, dry_run: bool = False) -> dict | None:
    """Generate and store. Returns the generated highlights plus ``links_dropped`` (not stored)."""
    highlights = generate(supabase, meeting_id)
    stored = {k: v for k, v in highlights.items() if k != "links_dropped"} if highlights else None
    if highlights and highlights.get("links_dropped"):
        print(f"  [Highlights] meeting {meeting_id}: dropped {highlights['links_dropped']} invalid link(s)")
    if not dry_run:  # nothing to highlight clears an older entry so pages fall back to the summary
        if not write_highlights(supabase, meeting_id, stored):
            raise RuntimeError("meta changed underneath on every attempt; not written")
    return highlights
