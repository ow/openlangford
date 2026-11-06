"""Assign agenda_items.discussion_start_time / discussion_end_time from transcripts.

Older meetings were refined before their transcripts existed, so the AI refiner
never produced item timestamps for them. This step fills the gaps afterwards,
using cheap, explainable signals first:

1. ``transcript_segments.agenda_item_id`` links (when present).
2. Motion ``time_offset_seconds`` (optional; a point inside the item).
3. The chair announcing items in the transcript ("item 6.1", "moving on to
   number five", "public participation", "bylaw number 2144") and the mover
   reading a motion that matches the minutes' motion text.

Candidates are combined with a monotonic dynamic program (agenda items happen
in agenda order), so a stray mention ("I'm speaking to item 11.2" during public
comment) cannot pull an item out of sequence. Items that keep existing times act
as fixed anchors and are never overwritten. Each item's end is the next timed
item's start. An optional AI pass (one small function, ``_ai_choose``) only
fills items left without an anchor between two anchored neighbours.

Provenance goes to ``agenda_items.meta.alignment`` =
``{method, confidence, aligned_at, score}``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

from pipeline.postgrest import paginate
from pipeline.utils import natural_sort_key

# ---------------------------------------------------------------------------
# Text normalisation
# ---------------------------------------------------------------------------

_UNITS = {
    "zero": 0, "oh": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
    "eighteen": 18, "nineteen": 19,
}
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50}
_ORDINALS = {
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7,
    "eighth": 8, "ninth": 9, "tenth": 10, "eleventh": 11, "twelfth": 12,
}
_NUM_WORD = "|".join(sorted([*_UNITS, *_TENS], key=len, reverse=True))


def _words_to_number(match: re.Match) -> str:
    words = re.split(r"[\s-]+", match.group(0).strip())
    # A run of single digit words ("two one seven zero") is a digit string.
    if len(words) > 1 and all(w in _UNITS and _UNITS[w] < 10 for w in words):
        return "".join(str(_UNITS[w]) for w in words)
    out: list[str] = []
    acc: int | None = None
    for w in words:
        if w in _TENS:
            if acc is not None:
                out.append(str(acc))
            acc = _TENS[w]
        elif w in _UNITS:
            if acc is not None and acc % 10 == 0 and acc >= 20 and _UNITS[w] < 10:
                acc += _UNITS[w]
            else:
                if acc is not None:
                    out.append(str(acc))
                acc = _UNITS[w]
    if acc is not None:
        out.append(str(acc))
    return " ".join(out)


def normalize(text: str) -> str:
    """Lowercase, spell numbers as digits, and join spoken decimals ("ten point one" -> "10.1")."""
    t = (text or "").lower().replace("’", "'")
    t = re.sub(rf"\b(?:{_NUM_WORD})(?:[\s-]+(?:{_NUM_WORD}))*\b", _words_to_number, t)
    t = re.sub(r"\b(\d+)\s+point\s+(\d+)\b", r"\1.\2", t)
    t = re.sub(r"\b(\d+)\s+point\s+(\d+)\b", r"\1.\2", t)  # 8 point 1 point 1
    t = re.sub(r"\b(\d+(?:\.\d+)+)\s+point\s+(\d+)\b", r"\1.\2", t)
    t = re.sub(r"(\d)\s*\.\s+(\d)", r"\1.\2", t)
    t = re.sub(r"[^a-z0-9.'\s-]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _order_parts(item_order: str | None) -> list[str]:
    return re.findall(r"\d+", item_order or "")


# ---------------------------------------------------------------------------
# Patterns per agenda item
# ---------------------------------------------------------------------------

CUE = re.compile(
    r"(moving on|move on|moving to|next (?:item|up|we have|is|on)?|we(?: are|'re| will| ll)? (?:now )?(?:on|onto|on to|moving|going|turn|go)|"
    r"now (?:on )?to|on to|onto|brings us to|we have|turning to|turn to|go to|proceed (?:to|with)|first (?:up|one|item)|"
    r"call (?:the|this) meeting|item number|on our (?:docket|agenda))\b"
)
PUBLIC_SPEAKER = re.compile(
    r"\b(speaking (?:to|on|about)|my name is|i live|i'm a resident|resident of|langford resident|"
    r"comment on|i'm here (?:to|on|tonight)|i want to (?:speak|talk|comment)|regarding item)\b"
)
STOP = {
    "the", "and", "for", "with", "from", "that", "this", "report", "dated", "council", "meeting",
    "recommendation", "attachment", "attached", "background", "langford", "city", "amendment",
    "bylaw", "bylaws", "application", "item", "items", "adoption", "reading", "readings", "minutes",
    "resolutions", "resolution", "committee", "update", "program", "road", "street", "avenue", "drive",
    "of", "to", "no", "nos", "a", "an", "in", "on", "at", "by", "re", "policy", "first", "second", "third",
}

# Standard agenda headings -> spoken phrases (normalized text).
HEADINGS: list[tuple[re.Pattern, re.Pattern]] = [
    (re.compile(r"call to order"), re.compile(r"call (?:the |this )?(?:\w+ )?(?:meeting )?to order|welcome (?:everyone )?to|good (?:evening|afternoon|morning)")),
    (re.compile(r"territorial acknowledg"), re.compile(r"territor|traditional (?:territor|land)|acknowledg(?:e|ement) (?:that|the)|lekwungen|songhees|esquimalt nation")),
    (re.compile(r"conduct rules|rules of conduct"), re.compile(r"conduct rules|rules of conduct|meeting conduct|moderator for")),
    (re.compile(r"approval of (?:the )?agenda|adoption of (?:the )?agenda"), re.compile(r"approv\w* (?:of )?(?:the )?agenda|adopt\w* (?:of )?(?:the )?agenda|agenda (?:as|be) (?:presented|amended)")),
    (re.compile(r"public participation|question period|public input"), re.compile(r"public participation|public input|question period")),
    (re.compile(r"public hearing"), re.compile(r"public hearing")),
    (re.compile(r"delegation"), re.compile(r"delegation")),
    (re.compile(r"presentation"), re.compile(r"presentation")),
    (re.compile(r"removed from the consent"), re.compile(r"removed from (?:the )?consent|items? removed")),
    (re.compile(r"^(?!.*removed).*consent agenda"), re.compile(r"consent agenda")),
    (re.compile(r"adoption of (?:the )?minutes|approval of (?:the )?minutes|^minutes"), re.compile(r"adopt\w* (?:of )?(?:the )?minutes|approv\w* (?:of )?(?:the )?minutes")),
    (re.compile(r"committee resolutions|committee recommendations"), re.compile(r"committee (?:resolution|recommendation)")),
    (re.compile(r"notices? of (?:intent|motion)"), re.compile(r"notices? of (?:intent|motion)")),
    (re.compile(r"^reports?$|staff reports|^reports? "), re.compile(r"\breports?\b")),
    (re.compile(r"^bylaws?$"), re.compile(r"\bbylaws\b")),
    (re.compile(r"new business"), re.compile(r"new business")),
    (re.compile(r"unfinished business|old business"), re.compile(r"(?:unfinished|old) business")),
    (re.compile(r"correspondence"), re.compile(r"correspondence")),
    (re.compile(r"in[ -]camera|closed meeting"), re.compile(r"in[ -]?camera|closed (?:portion|meeting|session)")),
    (re.compile(r"rise and report"), re.compile(r"rise and report")),
    (re.compile(r"adjourn|termination"), re.compile(r"adjourn|terminat")),
]


@dataclass
class ItemPatterns:
    order: list[tuple[re.Pattern, float]] = field(default_factory=list)
    phrases: list[tuple[re.Pattern, float]] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)


def item_patterns(item_order: str | None, title: str | None) -> ItemPatterns:
    pats = ItemPatterns()
    parts = _order_parts(item_order)
    if parts:
        num = r"\s*\.\s*".join(parts)
        tail = r"(?!\.\d)(?!\d{1,2}\b)"  # don't let 13.1 match 13.10; tolerate "8.1.2960" (glued address)
        if len(parts) > 1:
            pats.order.append((re.compile(rf"(?<![\d.]){num}{tail}"), 2.5))
        else:
            n = parts[0]
            pats.order.append((re.compile(rf"\b(?:item|section|items) (?:number |no )?{n}\b(?!\.\d)"), 2.5))
            pats.order.append((re.compile(rf"\b(?:on to|onto|moving on|move on|next|we have|now|go to|going to) (?:to )?(?:item |section )?number {n}\b(?!\.\d)"), 2.0))
            pats.order.append((re.compile(rf"\b(?:on to|onto|to|next|we have|now) (?:number |item )?{n}\b(?!\.\d)(?! (?:minutes|seconds|years|days|weeks|percent|people|units|storeys))"), 0.75))
    t = normalize(title or "")
    t = re.sub(r"\(.*?\)", " ", t) if "(" in (title or "") else t
    heading_hit = False
    for title_re, spoken in HEADINGS:
        if title_re.search(t):
            pats.phrases.append((spoken, 2.0))
            heading_hit = True
    raw = (title or "").lower()
    for b in re.findall(r"bylaw(?:s)?\s*(?:no\.?|nos\.?|number)?\s*(\d{3,4})", raw):
        pats.phrases.append((re.compile(rf"bylaw (?:no |number )?{b}\b"), 2.5))
        pats.phrases.append((re.compile(rf"(?<![\d.]){b}\b"), 1.0))
    for code in re.findall(r"\b([a-z]{2,4}\d{2}-\d{3,4})\b", raw):
        digits = re.sub(r"\D", "", code)
        pats.phrases.append((re.compile(rf"{code[:3]}\w*\s*{digits[:2]}\D{{0,3}}{digits[2:]}"), 2.0))
    for addr_no, street in re.findall(r"\b(\d{3,5})(?:[-/]\d+)?\s+([a-z]{4,})", raw):
        pats.phrases.append((re.compile(rf"\b{addr_no}\b"), 1.0))
        pats.keywords.append(street[:5])
    if not heading_hit:
        words = [w for w in re.findall(r"[a-z]{4,}", t) if w not in STOP]
        pats.keywords.extend(dict.fromkeys(w[:6] for w in words))
    return pats


# ---------------------------------------------------------------------------
# Candidate scoring
# ---------------------------------------------------------------------------


@dataclass
class Candidate:
    time: float
    score: float
    method: str
    seg_index: int = -1


def _point_in_segment(seg: dict, pos: int, text_len: int) -> float:
    start, end = float(seg["start_time"]), float(seg.get("end_time") or seg["start_time"])
    if text_len <= 0 or end <= start:
        return start
    return start + (end - start) * min(1.0, pos / text_len)


def segment_candidates(item: dict, segments: list[dict], norm_texts: list[str] | None = None) -> list[Candidate]:
    """Score every transcript segment as a possible start of ``item``."""
    pats = item_patterns(item.get("item_order"), item.get("title"))
    texts = norm_texts if norm_texts is not None else [normalize(s.get("text_content") or "") for s in segments]
    out: list[Candidate] = []
    is_adjourn = bool(re.search(r"adjourn|terminat", (item.get("title") or "").lower()))
    first_idx = 0
    if is_adjourn and segments:
        # Adjournment lives at the end; ignore "adjourn" mentions earlier on.
        t0, t1 = float(segments[0]["start_time"]), float(segments[-1]["start_time"])
        cutoff = t0 + 0.75 * (t1 - t0)
        first_idx = next((k for k, sg in enumerate(segments) if float(sg["start_time"]) >= cutoff), 0)
    for idx, text in enumerate(texts):
        if not text or idx < first_idx:
            continue
        if is_adjourn:
            m = re.search(r"adjourn|terminat", text)
            if m:
                out.append(Candidate(_point_in_segment(segments[idx], m.start(), len(text)), 3.0, "title_match", idx))
            continue
        best: tuple[float, int, str] | None = None
        hits = 0.0
        for rx, w in pats.order:
            m = rx.search(text)
            if m:
                hits += w
                if best is None or w > best[0]:
                    best = (w, m.start(), "announcement")
        for rx, w in pats.phrases:
            m = rx.search(text)
            if m:
                hits += w * (0.6 if hits else 1.0)
                if best is None:
                    best = (w, m.start(), "title_match")
                elif m.start() < best[1]:
                    best = (max(w, best[0]), m.start(), best[2])
        if pats.keywords:
            found = [k for k in pats.keywords if re.search(rf"\b{re.escape(k)}", text)]
            frac = len(found) / len(pats.keywords)
            if len(pats.keywords) >= 2 and frac >= 0.5 or len(pats.keywords) == 1 and found and hits:
                kw = 1.5 * frac
                hits += kw
                if best is None:
                    m = re.search(rf"\b{re.escape(found[0])}", text)
                    best = (kw, m.start() if m else 0, "title_match")
        if best is None:
            continue
        score = hits
        pos = best[1]
        window = text[max(0, pos - 50): pos]
        cue = CUE.search(window)
        if cue:
            score += 1.0
            pos = max(0, pos - 50) + cue.start()
        turn_len = segments[idx].get("_turn_len", len(text))
        if turn_len < 160:
            score += 0.5  # short chair line ("next on our docket is public participation")
        elif segments[idx].get("_turn_pos", 0) + pos > 300:
            score -= 0.5  # buried in a long speech
        if PUBLIC_SPEAKER.search(text):
            score -= 1.5
        after = text[best[1]: best[1] + 60]
        if re.search(r"\bclos(?:e|ed|ing)\b|\bthat concludes\b|^\S+ (?:passes|passed|carried|carries)\b", after):
            score -= 1.0
        out.append(Candidate(_point_in_segment(segments[idx], pos, len(text)), score, best[2], idx))
    return out


def motion_text_candidates(motions: list[dict], segments: list[dict], norm_texts: list[str]) -> list[tuple[dict, Candidate]]:
    """A mover reading the minutes' motion text marks a point inside the item."""
    out: list[tuple[dict, Candidate]] = []
    for mo in motions:
        words = [w for w in re.findall(r"[a-z0-9]{3,}", normalize(mo.get("text_content") or ""))
                 if w not in STOP and w not in {"move", "moved", "council", "that", "adopt", "give"}][:14]
        words = list(dict.fromkeys(words))
        if len(words) < 3:
            continue
        best: tuple[float, int] | None = None
        for idx, text in enumerate(norm_texts):
            if "move" not in text and "moved" not in text:
                continue
            got = sum(1 for w in words if re.search(rf"\b{re.escape(w)}", text))
            frac = got / len(words)
            if frac >= 0.5 and (best is None or frac > best[0]):
                best = (frac, idx)
        if best:
            out.append((mo, Candidate(float(segments[best[1]]["start_time"]), 1.0 + best[0], "motion_text", best[1])))
    return out


# ---------------------------------------------------------------------------
# Monotonic assignment
# ---------------------------------------------------------------------------

FIXED_SCORE = 1000.0
MIN_SCORE = 2.0  # validated: 2.5/3.0 lose coverage without improving accuracy


def assign_monotonic(candidates: list[list[Candidate]], *, min_score: float = MIN_SCORE) -> list[Candidate | None]:
    """Pick at most one candidate per item so chosen times never decrease with item order.

    Maximises total score (weighted longest-chain DP). ``candidates[i]`` lists options for
    item i; options below ``min_score`` are ignored. Ties prefer earlier times.
    """
    flat: list[tuple[int, Candidate]] = [
        (i, c) for i, cs in enumerate(candidates) for c in cs if c.score >= min_score
    ]
    if not flat:
        return [None] * len(candidates)
    # Process in item order; within an item, by time.
    flat.sort(key=lambda x: (x[0], x[1].time))
    n = len(flat)
    best = [0.0] * n
    prev = [-1] * n
    for k, (i, c) in enumerate(flat):
        value = c.score - 1e-7 * c.time
        best[k], prev[k] = value, -1
        for j in range(k):
            pi, pc = flat[j]
            if pi < i and pc.time <= c.time and best[j] + value > best[k]:
                best[k], prev[k] = best[j] + value, j
    k = max(range(n), key=lambda x: best[x])
    chosen: list[Candidate | None] = [None] * len(candidates)
    while k != -1:
        chosen[flat[k][0]] = flat[k][1]
        k = prev[k]
    return chosen


def build_windows(starts: list[float | None], meeting_end: float | None) -> list[tuple[float | None, float | None]]:
    """End of each timed item = start of the next timed item (last one runs to meeting_end)."""
    out: list[tuple[float | None, float | None]] = []
    for i, s in enumerate(starts):
        if s is None:
            out.append((None, None))
            continue
        # Non-overlapping: an item announced in the same breath as the next one
        # (a heading and its first sub-item) gets a zero-length window.
        nxt = next((t for t in starts[i + 1:] if t is not None and t >= s), None)
        end = nxt if nxt is not None else (meeting_end if meeting_end and meeting_end > s else None)
        out.append((s, end))
    return out


def confidence_for(c: Candidate) -> str:
    if c.method in ("segment_link", "existing"):
        return "high"
    if c.score >= 3.5:
        return "high"
    if c.score >= 2.5:
        return "medium"
    return "low"


# ---------------------------------------------------------------------------
# AI gap fill (kept behind one function so it is easy to re-point)
# ---------------------------------------------------------------------------


def _ai_choose(question: str, context: str, options: list[tuple[str, str]]) -> tuple[str, float] | None:
    """Ask the AI to pick one option. Returns (value, probability) or None if unavailable."""
    try:
        from pipeline.ai import decide
        from pipeline.ai.client import choice

        ans = decide(context, [choice("pick", question, options)])["pick"]
        value = getattr(ans, "choice", None) or getattr(ans, "value", None)
        prob = getattr(ans, "confidence", None) or getattr(ans, "probability", None) or 0.0
        return (str(value), float(prob)) if value is not None else None
    except Exception as exc:  # AI is optional; never fatal
        print(f"  [!] agenda alignment AI unavailable: {exc}")
        return None


def ai_fill_gaps(items: list[dict], starts: list[float | None], segments: list[dict], *,
                 chooser: Callable[[str, str, list[tuple[str, str]]], tuple[str, float] | None] = _ai_choose,
                 max_calls: int = 6, max_options: int = 24, min_prob: float = 0.6) -> dict[int, Candidate]:
    """For items with no anchor between two anchored neighbours, ask which segment starts them."""
    filled: dict[int, Candidate] = {}
    calls = 0
    for i, s in enumerate(starts):
        if s is not None or calls >= max_calls:
            continue
        lo = next((starts[j] for j in range(i - 1, -1, -1) if starts[j] is not None), None)
        hi = next((starts[j] for j in range(i + 1, len(starts)) if starts[j] is not None), None)
        if lo is None or hi is None or hi - lo < 60:
            continue
        lo = max(lo, max((c.time for k, c in filled.items() if k < i), default=lo))
        window = [(k, seg) for k, seg in enumerate(segments) if lo < float(seg["start_time"]) < hi]
        if len(window) < 2:
            continue
        step = max(1, len(window) // max_options)
        window = window[::step][:max_options]
        options = [(str(k), f"[{int(float(seg['start_time']))}s] {(seg.get('text_content') or '')[:160]}") for k, seg in window]
        options.append(("none", "This item is not discussed in this stretch (skipped, withdrawn or handled elsewhere)."))
        it = items[i]
        calls += 1
        res = chooser(
            f"Which transcript line is where the chair begins agenda item {it.get('item_order') or ''} "
            f"\"{it.get('title')}\"? Pick 'none' if it is not in these lines.",
            f"Agenda item {it.get('item_order')}: {it.get('title')}\n{(it.get('plain_english_summary') or '')[:400]}",
            options,
        )
        if res and res[0] != "none" and res[1] >= min_prob and res[0].isdigit():
            k = int(res[0])
            filled[i] = Candidate(float(segments[k]["start_time"]), 2.0, "ai_gap_fill", k)
    return filled


# ---------------------------------------------------------------------------
# Meeting-level alignment (pure: works on plain dicts)
# ---------------------------------------------------------------------------


_SENTENCE_END = re.compile(r"(?<=[.?!])\s+(?=[A-Z0-9\"'(])")


def split_sentences(segments: list[dict]) -> list[dict]:
    """Split speaker turns into sentences with times interpolated by character offset.

    Recent transcripts store whole speaker turns (minutes long) as one segment; the chair's
    "we're on to public participation" is one sentence inside it.
    """
    out: list[dict] = []
    for seg in segments:
        text = (seg.get("text_content") or "").strip()
        start = float(seg["start_time"])
        end = float(seg.get("end_time") or start)
        if not text:
            continue
        bounds = [0] + [m.end() for m in _SENTENCE_END.finditer(text)] + [len(text)]
        n = len(text)
        for a, b in zip(bounds, bounds[1:]):
            piece = text[a:b].strip()
            if not piece:
                continue
            t0 = start + (end - start) * a / n if end > start else start
            t1 = start + (end - start) * b / n if end > start else start
            out.append({**seg, "start_time": round(t0, 2), "end_time": round(t1, 2), "text_content": piece,
                        "_turn_len": n, "_turn_pos": a})
    return out


def sort_items(items: list[dict]) -> list[dict]:
    return sorted(items, key=lambda it: (natural_sort_key((it.get("item_order") or "").strip(".) ")) or [10**9], it.get("id") or 0))


def align_items(items: list[dict], segments: list[dict], motions: list[dict] | None = None, *,
                use_motion_offsets: bool = True, use_ai: bool = False,
                chooser: Callable | None = None) -> list[dict]:
    """Return proposed updates [{id, start, end, method, confidence, score}] for items lacking times.

    ``items`` need id, item_order, title, discussion_start_time/_end_time. ``segments`` need
    start_time, end_time, text_content (agenda_item_id optional). ``motions`` need agenda_item_id,
    text_content and optionally time_offset_seconds.
    """
    if not segments or not items:
        return []
    segments = sorted(segments, key=lambda s: float(s["start_time"]))
    items = sort_items(items)
    meeting_end = max(float(s.get("end_time") or s["start_time"]) for s in segments)
    by_id = {it["id"]: i for i, it in enumerate(items)}
    raw_segments = segments
    segments = split_sentences(segments)
    norm = [normalize(s.get("text_content") or "") for s in segments]
    cands: list[list[Candidate]] = [[] for _ in items]

    linked: dict[int, float] = {}
    for s in raw_segments:
        aid = s.get("agenda_item_id")
        if aid in by_id:
            linked[aid] = min(linked.get(aid, float("inf")), float(s["start_time"]))

    motions = motions or []
    for i, it in enumerate(items):
        if it.get("discussion_start_time") is not None:
            cands[i] = [Candidate(float(it["discussion_start_time"]), FIXED_SCORE, "existing")]
            continue
        if it["id"] in linked:
            cands[i] = [Candidate(linked[it["id"]], 50.0, "segment_link")]
            continue
        cands[i] = segment_candidates(it, segments, norm)
        if use_motion_offsets:
            for mo in motions:
                if mo.get("agenda_item_id") == it["id"] and mo.get("time_offset_seconds") is not None:
                    cands[i].append(Candidate(float(mo["time_offset_seconds"]) - 15.0, 2.5, "motion_offset"))
    # Motion-text matches, attributed to their agenda item.
    for mo, c in motion_text_candidates(motions, segments, norm):
        i = by_id.get(mo.get("agenda_item_id"))
        if i is None:
            continue
        if items[i].get("discussion_start_time") is None and items[i]["id"] not in linked:
            cands[i].append(c)

    chosen = assign_monotonic(cands)
    starts = [c.time if c else None for c in chosen]

    if use_ai:
        filled = ai_fill_gaps(items, starts, segments, **({"chooser": chooser} if chooser else {}))
        for i, c in filled.items():
            lo = max((t for t in starts[:i] if t is not None), default=0.0)
            hi = min((t for t in starts[i + 1:] if t is not None), default=float("inf"))
            if lo <= c.time <= hi:
                chosen[i], starts[i] = c, c.time

    # Keep existing ends; computed end = next timed item's start.
    windows = build_windows(starts, meeting_end)
    updates = []
    for i, it in enumerate(items):
        c = chosen[i]
        if c is None or c.method == "existing" or it.get("discussion_start_time") is not None:
            continue
        start, end = windows[i]
        if start is None:
            continue
        updates.append({
            "id": it["id"], "item_order": it.get("item_order"), "title": it.get("title"),
            "start": round(start, 2), "end": round(end, 2) if end is not None else None,
            "method": c.method, "confidence": confidence_for(c), "score": round(c.score, 2),
        })
    return updates


# ---------------------------------------------------------------------------
# Database glue
# ---------------------------------------------------------------------------


def load_meeting(supabase, meeting_id: int) -> tuple[list[dict], list[dict], list[dict]]:
    items = supabase.table("agenda_items").select(
        "id, item_order, title, plain_english_summary, discussion_start_time, discussion_end_time, meta"
    ).eq("meeting_id", meeting_id).execute().data or []
    segments = paginate(lambda: supabase.table("transcript_segments").select(
        "start_time, end_time, text_content, speaker_name, agenda_item_id"
    ).eq("meeting_id", meeting_id).order("start_time"))
    motions = supabase.table("motions").select(
        "id, agenda_item_id, text_content, time_offset_seconds"
    ).eq("meeting_id", meeting_id).order("id").execute().data or []
    return items, segments, motions


def align_meeting(supabase, meeting_id: int, *, dry_run: bool = False, use_ai: bool = False,
                  verbose: bool = True) -> list[dict]:
    """Align one meeting and (unless dry_run) write times for items that have none."""
    items, segments, motions = load_meeting(supabase, meeting_id)
    if not segments:
        return []
    updates = align_items(items, segments, motions, use_ai=use_ai)
    current = {it["id"]: it for it in items}
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for u in updates:
        if verbose:
            print(f"  {u['item_order'] or '-':>8} {u['start']:>8.0f}-{(u['end'] or 0):>6.0f}s "
                  f"[{u['method']}/{u['confidence']}] {(u['title'] or '')[:60]}")
        if dry_run:
            continue
        old = current[u["id"]]
        meta = {**(old.get("meta") or {}), "alignment": {
            "method": u["method"], "confidence": u["confidence"], "score": u["score"], "aligned_at": now,
        }}
        payload: dict[str, Any] = {"discussion_start_time": u["start"], "meta": meta}
        if old.get("discussion_end_time") is None and u["end"] is not None:
            payload["discussion_end_time"] = u["end"]
        # Guard against races: only write while the start is still null.
        supabase.table("agenda_items").update(payload).eq("id", u["id"]).is_("discussion_start_time", "null").execute()
    return updates


def meetings_needing_alignment(supabase, *, since: str | None = None, meeting_ids: Iterable[int] | None = None) -> list[int]:
    q = supabase.table("meetings").select("id, meeting_date, has_transcript").eq("has_transcript", True)
    if meeting_ids is not None:
        ids = list(meeting_ids)
        if not ids:
            return []
        q = q.in_("id", ids)
    if since:
        q = q.gte("meeting_date", since)
    rows = q.order("meeting_date").execute().data or []
    out = []
    for m in rows:
        missing = supabase.table("agenda_items").select("id", count="exact").eq("meeting_id", m["id"]).is_(
            "discussion_start_time", "null").limit(1).execute()
        if missing.count:
            out.append(m["id"])
    return out


def align_meetings(supabase, meeting_ids: Iterable[int] | None = None, *, since: str | None = None,
                   dry_run: bool = False, use_ai: bool = False) -> dict[int, list[dict]]:
    results: dict[int, list[dict]] = {}
    for mid in meetings_needing_alignment(supabase, since=since, meeting_ids=meeting_ids):
        print(f"[Agenda alignment] meeting {mid}{' (dry run)' if dry_run else ''}")
        try:
            results[mid] = align_meeting(supabase, mid, dry_run=dry_run, use_ai=use_ai)
        except Exception as exc:
            print(f"  [!] meeting {mid}: {exc}")
    return results
