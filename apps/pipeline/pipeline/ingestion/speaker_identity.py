"""Evidence-based speaker naming for diarized transcripts.

Diarization gives anonymous labels (Speaker_1..N). This module names a label
only when the recording itself, the minutes, or a voice heard in other meetings
says who it is. Pure functions, no I/O; ``speaker_names`` runs it as a stage.

Evidence per label (deterministic, no model calls), with its measured
agreement against legacy names on 149 older meetings (October 2026):

- ``called`` (0.81): the previous turn ends by giving this label the floor
  ("... Councillor Wagner?"). Names in the closing words only; thanks and
  possessives don't count; ASR misspellings match after a title.
- ``chair`` (0.95): the label opens the meeting / calls the question, or is
  thanked as "Mayor"/"Chair"; the person is the meeting's chair.
- ``moved`` (0.91) / ``seconded`` (0.78): a first-person "I'll move that ..."
  read from a recorded motion (or recorded near its time) names the minutes'
  mover; the next "I'll second" names the minutes' seconder. Minutes and audio
  disagree on the seconder often enough that it carries half weight.
- ``introduced`` (0.86): "My name is Melissa Miles" near the start of a turn.
- ``voice``: the label's voice centroid matches one person's exemplars from at
  least ``VOICE_MIN_MEETINGS`` other meetings, clear of everyone else.

The minutes roster (attendance) is supporting evidence, not a filter: people it
lists need less evidence than people it doesn't. "Thank you, Councillor X" at
the start of the next turn was measured at 0.27 and is not used.

``decide`` names a label when its evidence clearly points to one person and holds
it when sources disagree (including a text name whose voice is far from that
person's known voice). Decisions and their evidence are stored by the stage.
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from difflib import SequenceMatcher

IDENTITY_VERSION = "1"
ATTRIBUTION_SOURCE = "SPEAKER_EVIDENCE"
# Rows the stage may name. Anything else (manual, verified, legacy-named) is left alone.
UNNAMED_SOURCES = ("UNIDENTIFIED_DIARIZATION", "CACHED_TRANSCRIPT_BACKFILL", "AI_DIARIZATION")

# Text evidence thresholds.
MIN_SCORE = 2.0  # weighted events for the winning person
MIN_SHARE = 0.75  # winner's share of all weighted events for the label
# Voice thresholds (CAM++ 192-d centroids, cosine).
VOICE_MIN_MEETINGS = 3
VOICE_MIN_SIMILARITY = 0.80
VOICE_MIN_MARGIN = 0.08
FINGERPRINT_MIN_SECONDS = 60.0  # a label must speak this long to seed a fingerprint or be voice-checked
# A text-named label whose voice is this far from the person's evidenced voice is held
# (same-person exemplars sit at p1 0.78 / p50 0.98 against their own mean).
VOICE_CONTRADICTS_BELOW = 0.75
# Fingerprint growth guards: an exemplar joins a person's fingerprint only when it is
# close to their evidenced voice and clearly closer to it than to anyone else's.
DRIFT_MIN_SIMILARITY = 0.85  # other people's voices: p99 0.86, same person: p5 0.90
DRIFT_MIN_LEAD = 0.05
DRIFT_MIN_EXEMPLARS = 3  # below this the person has no stable mean to drift from
VOICE_EXEMPLAR_MIN_SIMILARITY = 0.85  # a voice-only naming must be this strong to add an exemplar
VOICE_EXEMPLAR_MIN_MARGIN = 0.10

TITLE = (
    r"(?:deputy\s+mayor|acting\s+mayor|vice[\s-]chair|councill?or|counsell?or|council(?:man|woman)?|counsel|"
    r"mayor|chair(?:person|man|woman)?|director|manager|chief|mr|mrs|ms|miss|dr|madam|commissioner|trustee)\.?"
)
WORD = r"[A-Za-z][A-Za-z'\-]+"
WEIGHTS = {"called": 1.0, "introduced": 2.0, "chair": 1.0, "moved": 1.0, "seconded": 0.5, "voice": 3.0}


# ── names ────────────────────────────────────────────────────────────────


def _norm(s: str) -> str:
    return re.sub(r"[^a-z]", "", (s or "").casefold())


@dataclass
class Candidate:
    id: int
    name: str
    first: str | None  # full first name when the registry has one ("Mary"), else None ("M.")
    initial: str | None
    surname: str
    on_roster: bool = True  # listed as attending in the minutes


def candidates_from_people(people: list[dict], on_roster: bool = True) -> list[Candidate]:
    out = []
    for p in people:
        parts = (p.get("name") or "").replace(",", " ").split()
        if len(parts) < 2:
            continue
        surname = _norm(parts[-1])
        first = _norm(parts[0])
        if len(surname) < 3:
            continue
        out.append(Candidate(int(p["id"]), p["name"], first if len(first) >= 3 else None, first[:1] or None,
                             surname, on_roster))
    return out


class _Tier:
    def __init__(self, candidates: list[Candidate]):
        self.candidates = candidates
        surnames = Counter(c.surname for c in candidates)
        firsts = Counter(c.first for c in candidates if c.first)
        self.by_surname = {c.surname: c for c in candidates if surnames[c.surname] == 1}
        self.by_first = {c.first: c for c in candidates if c.first and firsts[c.first] == 1}
        self.ambiguous = {k for k, n in surnames.items() if n > 1}

    def exact(self, words: list[str], allow_first: bool) -> Candidate | None | bool:
        """Candidate, None (no match) or False (ambiguous surname: stop looking)."""
        if len(words) >= 2 and words[1] in self.ambiguous:
            # "Mary Wagner" vs two Wagners: settle by first name/initial or give up.
            hits = [c for c in self.candidates if c.surname == words[1] and
                    (c.first == words[0] or (not c.first and c.initial == words[0][:1]))]
            return hits[0] if len(hits) == 1 else False
        for w in words[:2]:
            if w in self.by_surname:
                return self.by_surname[w]
            if w in self.ambiguous:
                return False
        # A bare first name ("Leah?") only when it is the whole name spoken.
        if allow_first and len(words) == 1 and words[0] in self.by_first:
            return self.by_first[words[0]]
        return None

    def fuzzy(self, words: list[str]) -> Candidate | None:
        scores = []
        for c in self.by_surname.values():
            r = max((SequenceMatcher(None, w, c.surname).ratio() for w in words[:2] if len(w) >= 4), default=0.0)
            scores.append((r, c.id, c))
        scores.sort(reverse=True)
        if scores and scores[0][0] >= 0.66 and (len(scores) == 1 or scores[0][0] - scores[1][0] >= 0.12):
            return scores[0][2]
        return None


class NameIndex:
    """Resolve a spoken name to exactly one candidate, or None.

    The minutes roster is searched first (exact, then fuzzy after a title, since
    ASR mangles surnames: "Counter Gary" for Councillor Guiry). Other known
    people (``extras``) only match exactly and only when no roster name does.
    """

    def __init__(self, roster: list[Candidate], extras: list[Candidate] | None = None):
        roster_ids = {c.id for c in roster}
        extras = [c for c in (extras or []) if c.id not in roster_ids]
        self.candidates = roster + extras
        self.roster = _Tier(roster)
        self.extras = _Tier(extras)

        self.shadowed: set[str] = set()

    def shadow_namesakes(self, text: str) -> set[str]:
        """Surnames that someone else in the recording also carries.

        "App user Shelley King, please unmute" means a bare "Ms. King" later may
        not be committee member Nadine King. A first name or initial before a
        candidate's surname that disagrees with theirs shadows that surname: from
        then on only a call that includes the right first name resolves to them.
        """
        by_surname = defaultdict(list)
        for c in self.candidates:
            by_surname[c.surname].append(c)
        for m in re.finditer(rf"\b([A-Z][a-z]+|[A-Z]\.?)\s+({WORD})\b", text):
            surname = _norm(m.group(2))
            if surname not in by_surname:
                continue
            given = _norm(m.group(1))
            if not given or given in NOT_GIVEN or re.fullmatch(TITLE, m.group(1).rstrip("."), re.I):
                continue
            if any(c.first == given or (len(given) == 1 and c.initial == given)
                   or (c.first and len(given) >= 3 and SequenceMatcher(None, given, c.first).ratio() >= 0.8)
                   or (not c.first and c.initial == given[:1]) for c in by_surname[surname]):
                continue
            self.shadowed.add(surname)
        return self.shadowed

    def resolve(self, tokens: list[str], titled: bool) -> Candidate | None:
        words = [w for w in (_norm(t) for t in tokens) if w]
        if not words:
            return None
        hit = self.roster.exact(words, allow_first=True)
        if hit is False:
            return None
        if not hit and titled:
            hit = self.roster.fuzzy(words)
        if not hit:
            hit = self.extras.exact(words, allow_first=False) or None
        if hit and hit.surname in self.shadowed:
            given = words[0] if len(words) >= 2 else None
            if not (given and (given == hit.first or (not hit.first and given[:1] == hit.initial))):
                return None
        return hit


# ── turns ────────────────────────────────────────────────────────────────


@dataclass
class Turn:
    label: str
    start: float
    end: float
    text: str
    segment_ids: list[int] = field(default_factory=list)


def is_diarized_label(label: str | None) -> bool:
    return bool(re.fullmatch(r"(?i)speaker[_ ]?\d+", label or ""))


def build_turns(segments: list[dict]) -> list[Turn]:
    """Merge consecutive segments of one label into turns (segments ordered by start)."""
    turns: list[Turn] = []
    for s in segments:
        label = s.get("speaker_name") or ""
        text = " ".join((s.get("text_content") or "").split())
        if turns and turns[-1].label == label:
            t = turns[-1]
            t.text = f"{t.text} {text}".strip()
            t.end = max(t.end, s.get("end_time") or t.end)
            t.segment_ids.append(s["id"])
        else:
            turns.append(Turn(label, s.get("start_time") or 0.0, s.get("end_time") or 0.0, text, [s["id"]]))
    return turns


def _words(text: str) -> list[str]:
    return re.findall(r"[A-Za-z][A-Za-z'\-]*|\d+|[?.!,]", text)


CALL_RE = re.compile(rf"(?:\b(?P<title>{TITLE})\s+)?(?P<n1>{WORD})(?:\s+(?P<n2>{WORD}))?", re.I)
NOT_GIVEN = {
    "thank", "thanks", "okay", "ok", "yes", "yeah", "hi", "hello", "sorry", "good", "great", "dear", "and", "but",
    "so", "go", "ahead", "the", "member", "members", "committee", "sergeant", "inspector", "staff", "constable",
    "corporal", "superintendent", "sir", "user", "with", "from", "to", "for", "of", "in", "on", "by", "is", "as",
    "app", "please", "now", "next", "also", "well", "right", "all", "uh", "um", "i", "a", "that", "this", "it",
}
STOP = {
    "the", "and", "a", "to", "of", "for", "you", "your", "i", "we", "it", "is", "that", "this", "on", "in",
    "go", "ahead", "please", "yes", "no", "okay", "ok", "all", "right", "thank", "thanks", "very", "much",
    "anyone", "else", "council", "mayor", "chair", "staff", "so", "um", "uh", "item", "next", "motion",
}


def _name_mentions(text: str, index: NameIndex):
    """Yield (char_start, char_end, candidate, titled) for each resolvable name mention."""
    for m in CALL_RE.finditer(text):
        n1, n2, title = m.group("n1"), m.group("n2"), m.group("title")
        if not title and (n1.casefold() in STOP or not n1[0].isupper()):
            continue
        if title and re.fullmatch(r"(?i)council|counsel|mayor|chair", title.rstrip(".")) and n1.casefold() in STOP:
            continue
        # Only a capitalised second word can be part of the name ("Mary Wagner", not "Mary, can").
        tokens = [n1] + ([n2] if n2 and n2[0].isupper() and n2.casefold() not in STOP else [])
        cand = index.resolve(tokens, bool(title))
        if cand:
            yield m.start(), m.end(), cand, bool(title), m.group(0)


def floor_call(text: str, index: NameIndex) -> tuple[Candidate, str] | None:
    """The person a turn hands the floor to: the last name mentioned in its closing words.

    A name that is being thanked ("Thank you, Councillor Harder.") or possessive
    ("Councillor Harder's point") is not a call.
    """
    tail_start = 0
    words = list(re.finditer(r"\S+", text))
    if len(words) > 14:
        tail_start = words[-14].start()
    last = None
    for start, end, cand, titled, quote in _name_mentions(text, index):
        if start < tail_start:
            continue
        before = text[max(0, start - 30):start].casefold()
        after = text[end:end + 2]
        if (re.search(r"thank(?:s| you)[\s,]*(?:very much[\s,]*)?(?:to\s+)?$", before) or after.startswith("'")
                or re.search(r"['’]s\b", quote)):
            last = None
            continue
        # Words after the name: a call ends the turn ("..., go ahead"), not a narration.
        trailing = len(re.findall(r"\S+", text[end:]))
        if trailing > 10:
            continue
        last = (cand, quote)
    return last


INTRO_RE = re.compile(
    rf"\b(?:my\s+name\s+is|my\s+name's|i\s+am|i'm|this\s+is)\s+(?:(?P<title>{TITLE})\s+)?(?P<n1>{WORD})(?:\s+(?P<n2>{WORD}))?",
    re.I,
)


def self_introduction(text: str, index: NameIndex) -> tuple[Candidate, str] | None:
    """"My name is Marie Watmough" near the start of a turn: the surname must match
    (exactly, or >= 0.8 similar for ASR spelling), and a spoken first name must
    agree with the registry's first name or initial."""
    head = " ".join(text.split()[:40])
    for m in INTRO_RE.finditer(head):
        n1, n2 = m.group("n1"), m.group("n2")
        if not n1[0].isupper():
            continue
        words = [_norm(n1)] + ([_norm(n2)] if n2 and n2[0].isupper() else [])
        surname = words[-1]
        given = words[0] if len(words) == 2 else None
        if not given and not m.group("title"):
            continue  # "I'm Wagner" without a first name or title is too thin
        best = []
        for c in index.candidates:
            r = 1.0 if surname == c.surname else SequenceMatcher(None, surname, c.surname).ratio()
            if r < 0.8:
                continue
            if given and not (c.first == given or (not c.first and c.initial == given[:1])
                              or (c.first and SequenceMatcher(None, given, c.first).ratio() >= 0.8)):
                continue
            best.append((r, c.on_roster, c))
        best.sort(key=lambda x: (-x[0], not x[1]))
        if not best or (len(best) > 1 and best[0][:2] == best[1][:2]):
            continue
        return best[0][2], m.group(0)
    return None


CHAIR_ACT_RE = re.compile(
    r"\b(?:call(?:ing)?\s+(?:this|the|today's|tonight's)?\s*(?:\w+\s+)?meeting\s+to\s+order|"
    r"(?:this|the)\s+meeting\s+is\s+(?:now\s+)?(?:adjourned|called\s+to\s+order)|"
    r"(?:i'll|i\s+will|we'll)\s+call\s+the\s+question|all\s+those\s+in\s+favou?r)",
    re.I,
)
CHAIR_THANKS_RE = re.compile(
    r"^\W*(?:thank\s+you|thanks)[\s,]*(?:(?:mr|madam|madame)\.?\s+)?(?:mayor|chair|your\s+worship)\b", re.I
)


MOVE_RE = re.compile(
    r"(?:\bi(?:'ll|\s+will|'d\s+like\s+to|\s+would\s+like\s+to)?\s+(?:\w+\s+){0,2}?move\b(?!\s+on\b|\s+forward\b|\s+to\s+item)|"
    r"\bso\s+moved\b|^\W*(?:uh\W+|um\W+)?moved\b)",
    re.I,
)
SECOND_RE = re.compile(r"(?:\bi(?:'ll|\s+will|'d)?\s+second\b|^\W*(?:uh\W+|um\W+)?(?:i\s+)?second(?:ed)?\b(?!\s+(?:reading|item|time|one|point|question)))", re.I)
_CONTENT = re.compile(r"[a-z]{4,}")
_FILLER = {"that", "council", "move", "with", "this", "which", "would", "like", "will", "from", "have", "their", "there"}


def _overlap(utterance: str, motion: str) -> float:
    words = [w for w in _CONTENT.findall(utterance.casefold()) if w not in _FILLER]
    if len(words) < 5:
        return 0.0
    target = set(_CONTENT.findall(motion.casefold()))
    return sum(w in target for w in words) / len(words)


def motion_evidence(turns: list[Turn], motions: list[dict], index: NameIndex) -> list[tuple[str, str, Candidate, Turn, str]]:
    """(label, kind, candidate, turn, quote) for spoken moves/seconds matched to a recorded motion.

    A first-person "I'll move that ..." turn is matched to the motion whose text it
    reads (unique best word overlap >= 0.6) or, failing that, to the motions whose
    recorded time is within 90 s, which must all share one recorded mover. The
    first "I'll second" from another label within 90 s gets that motion's seconder.
    """
    by_id = {c.id: c for c in index.candidates}
    out = []
    for i, turn in enumerate(turns):
        m = MOVE_RE.search(turn.text[:400])
        if not m:
            continue
        said = turn.text[m.end():m.end() + 400]
        scored = sorted(((_overlap(said, mo.get("text_content") or ""), mo) for mo in motions), key=lambda x: -x[0])
        chosen = None
        if scored and scored[0][0] >= 0.6 and (len(scored) == 1 or scored[0][0] - scored[1][0] >= 0.15
                                                 or scored[0][1].get("mover_id") == scored[1][1].get("mover_id")):
            chosen = scored[0][1]
        else:
            near = [mo for mo in motions if mo.get("time") is not None and abs(mo["time"] - turn.start) <= 90]
            movers = {mo.get("mover_id") for mo in near}
            if near and len(movers) == 1:
                chosen = near[0]
        if not chosen:
            continue
        mover = by_id.get(chosen.get("mover_id"))
        if mover:
            out.append((turn.label, "moved", mover, turn, turn.text[m.start():m.start() + 120]))
        seconder = by_id.get(chosen.get("seconder_id"))
        if not seconder:
            continue
        for nxt in turns[i + 1:i + 6]:
            if nxt.start - turn.end > 90:
                break
            if nxt.label != turn.label and SECOND_RE.search(nxt.text[:80]) and len(nxt.text.split()) <= 25:
                out.append((nxt.label, "seconded", seconder, nxt, nxt.text[:80]))
                break
    return out


# ── evidence ─────────────────────────────────────────────────────────────


def text_evidence(turns: list[Turn], index: NameIndex, chair: Candidate | None,
                  motions: list[dict] | None = None) -> dict[str, list[dict]]:
    """label -> evidence events {kind, person_id, at, quote}."""
    ev: dict[str, list[dict]] = defaultdict(list)

    def add(label, kind, cand, turn, quote):
        if is_diarized_label(label):
            ev[label].append({"kind": kind, "person_id": cand.id, "at": round(turn.start, 1), "quote": quote[:160]})

    for i, turn in enumerate(turns):
        if not turn.text:
            continue
        prev = turns[i - 1] if i else None
        if prev and prev.label != turn.label and len(turn.text.split()) >= 4:
            call = floor_call(prev.text, index)
            if call:
                add(turn.label, "called", call[0], turn, call[1])
        intro = self_introduction(turn.text, index)
        if intro:
            add(turn.label, "introduced", intro[0], turn, intro[1])
        if chair:
            act = CHAIR_ACT_RE.search(turn.text)
            if act:
                add(turn.label, "chair", chair, turn, act.group(0))
            if prev and prev.label != turn.label and CHAIR_THANKS_RE.search(turn.text) and len(prev.text.split()) >= 2:
                add(prev.label, "chair", chair, prev, turn.text[:60])
    for label, kind, cand, turn, quote in motion_evidence(turns, motions or [], index):
        add(label, kind, cand, turn, quote)
    return ev


def _unit(vec) -> list[float] | None:
    try:
        v = [float(x) for x in vec]
    except (TypeError, ValueError):
        return None
    if len(v) != 192 or not all(math.isfinite(x) for x in v):
        return None
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v] if n else None


def _dot(a, b) -> float:
    return sum(x * y for x, y in zip(a, b))


def voice_match(centroid, fingerprints: list[dict], exclude_meeting: int | None = None) -> dict | None:
    """Match a label centroid against per-meeting fingerprints of known people.

    The best person needs ``VOICE_MIN_MEETINGS`` distinct meetings at or above
    ``VOICE_MIN_SIMILARITY`` (scored by its k-th best meeting) and must beat every
    other person's best meeting by ``VOICE_MIN_MARGIN``.
    """
    v = _unit(centroid)
    if v is None:
        return None
    per_person: dict[int, dict[int, float]] = defaultdict(dict)
    for fp in fingerprints:
        if exclude_meeting is not None and fp.get("source_meeting_id") == exclude_meeting:
            continue
        u = fp.get("_unit") or _unit(fp.get("embedding"))
        if u is None:
            continue
        fp["_unit"] = u
        sim = _dot(v, u)
        meeting = fp.get("source_meeting_id")
        best = per_person[fp["person_id"]].get(meeting, -1.0)
        per_person[fp["person_id"]][meeting] = max(best, sim)
    scored = []
    for pid, meetings in per_person.items():
        sims = sorted(meetings.values(), reverse=True)
        kth = sims[VOICE_MIN_MEETINGS - 1] if len(sims) >= VOICE_MIN_MEETINGS else -1.0
        scored.append((kth, sims[0], pid))
    if not scored:
        return None
    scored.sort(reverse=True)
    kth, top, pid = scored[0]
    rival = max((s[1] for s in scored[1:]), default=0.0)
    if kth < VOICE_MIN_SIMILARITY or kth - rival < VOICE_MIN_MARGIN:
        return None
    return {"person_id": pid, "similarity": round(kth, 4), "margin": round(kth - rival, 4)}


def decide(events: list[dict], voice: dict | None, roster: set[int], ignore: frozenset = frozenset()) -> dict | None:
    """Name a label when its evidence clearly points to one person.

    Minutes roster membership is supporting evidence, not a filter: a person the
    minutes list needs ``MIN_SCORE``; anyone else needs one more point and two
    independent kinds of evidence (or a self-introduction plus anything else).
    Voice disagreeing with the text evidence holds the label.
    """
    score: Counter = Counter()
    kinds: dict[int, Counter] = defaultdict(Counter)
    for e in events:
        if e["kind"] in ignore:
            continue
        score[e["person_id"]] += WEIGHTS[e["kind"]]
        kinds[e["person_id"]][e["kind"]] += 1
    if voice and "voice" not in ignore:
        score[voice["person_id"]] += WEIGHTS["voice"]
        kinds[voice["person_id"]]["voice"] += 1
    if not score:
        return None
    (pid, top), *_ = score.most_common()
    total = sum(score.values())
    if voice and "voice" not in ignore and voice["person_id"] != pid:
        return None
    if top / total < MIN_SHARE:
        return None
    k = kinds[pid]
    on_roster = pid in roster
    if on_roster:
        if top < MIN_SCORE:
            return None
        # One kind of text evidence alone must repeat (two calls, two thanks...).
        if len(k) == 1 and not (k.get("introduced") or k.get("voice")) and sum(k.values()) < 2:
            return None
        # Opening the meeting / calling votes is also what a clerk or acting chair does.
        if set(k) == {"chair"} and k["chair"] < 3:
            return None
    else:
        if top < MIN_SCORE + 1 or len(k) < 2:
            return None
    return {"person_id": pid, "score": top, "share": round(top / total, 3), "kinds": dict(k),
            "on_roster": on_roster}


def chair_from_minutes(minutes: str, index: NameIndex) -> Candidate | None:
    """The person the minutes say called the meeting to order / chaired."""
    if not minutes:
        return None
    pats = [
        rf"(?:(?:{TITLE})\s+)?(?:[A-Z]\.\s*)?(?P<n>{WORD})\s+called\s+the\s+meeting\s+to\s+order",
        rf"(?P<n>{WORD}),?\s+(?:presiding|in\s+the\s+chair)",
        rf"\bChair(?:person)?[:,]?\s+(?:(?:{TITLE})\s+)?(?:[A-Z]\.\s*)?(?P<n>{WORD})",
    ]
    for pat in pats:
        found = {c.id: c for m in re.finditer(pat, minutes) if (c := index.resolve([m.group("n")], True))}
        if len(found) == 1:
            return next(iter(found.values()))
    return None


def identify_meeting(
    segments: list[dict],
    attendees: list[dict],
    *,
    known_people: list[dict] | None = None,
    ignore: frozenset = frozenset(),
    minutes: str = "",
    chair_person_id: int | None = None,
    centroids: dict | None = None,
    fingerprints: list[dict] | None = None,
    meeting_id: int | None = None,
    motions: list[dict] | None = None,
    person_means: dict | None = None,
) -> dict:
    """Return {"labels": {label: decision+evidence}, "chair": person_id|None}. Pure; no I/O."""
    cands = candidates_from_people(attendees)
    extras = candidates_from_people(known_people or [], on_roster=False)
    index = NameIndex(cands, extras)
    index.shadow_namesakes(" ".join(s.get("text_content") or "" for s in segments))
    chair = next((c for c in index.candidates if c.id == chair_person_id), None) or chair_from_minutes(minutes, index)
    turns = build_turns(segments)
    ev = text_evidence(turns, index, chair, motions)
    roster = {c.id for c in cands}
    names = {c.id: c.name for c in index.candidates}
    names.update({p["id"]: p["name"] for p in (known_people or []) + attendees})
    seconds: Counter = Counter()
    for t in turns:
        seconds[t.label] += max(0.0, t.end - t.start)
    keyed = {}
    for key, vec in (centroids or {}).items():
        k = label_number(key)
        if k is not None:
            keyed[k] = vec
    labels = {}
    for label in sorted({t.label for t in turns if is_diarized_label(t.label)}, key=lambda x: label_number(x) or 0):
        voice = None
        vec = keyed.get(label_number(label))
        if vec is not None and fingerprints:
            voice = voice_match(vec, fingerprints, exclude_meeting=meeting_id)
        decision = decide(ev.get(label, []), voice, roster, ignore)
        entry = {"seconds": round(seconds[label], 1), "evidence": ev.get(label, [])[:12], "voice": voice}
        if decision and vec is not None and person_means and seconds[label] >= FINGERPRINT_MIN_SECONDS:
            mean, u = person_means.get(decision["person_id"]), _unit(vec)
            if mean is not None and u is not None:
                own = _dot(u, mean)
                entry["voice_check"] = round(own, 4)
                if own < VOICE_CONTRADICTS_BELOW:
                    entry["held"] = "voice_contradicts_text"
                    decision = None
        if decision:
            entry.update(decision, name=names.get(decision["person_id"], str(decision["person_id"])))
        labels[label] = entry
    return {"labels": labels, "chair": chair.id if chair else None}


def label_number(label: str | None) -> int | None:
    m = re.fullmatch(r"(?i)speaker[_ ]?0*(\d+)", label or "")
    return int(m[1]) if m else None
