"""Decide how a self-introduced public speaker is named.

The transcript is only evidence that someone said a name; the spelling still
has to be earned. In order:

1. an admin decision for this item and name wins;
2. a confident people-registry spelling (``display_name``);
3. the meeting minutes list the speaker (same surname, compatible first name);
4. the name exactly matches one already published elsewhere;
5. a near miss against the minutes, the registry or a published name is held
   for admin review (shown as "A resident" meanwhile);
6. otherwise it is a first-time name and is published as introduced.

A name is only considered when its words appear literally in the speaker's
own introduction, so a model cannot invent or "correct" one.
"""
from __future__ import annotations

import re

from .participation_validation import display_name, folded, name_score, one_edit

VERSION = "public-speaker-names-v1"

SECTION_TITLE = re.compile(r"public (?:participation|hearing|input)|delegations?|question period", re.I)
NAME = r"(?:(?:[A-Z]\.\s*){1,2}|[A-Z][a-z'’\-]+\s+)(?:[A-Z][a-z]?['’]?)?[A-Z][A-Za-z'’\-]+"
MINUTES_LINE = re.compile(r"^\s*(?:[-*•]\s*)?(?P<name>" + NAME + r")\s*,\s*(?P<rest>\S.*)$", re.M)
NOT_PEOPLE = {"mayor", "councillor", "council", "staff", "director", "manager", "resident", "speaker", "city"}
OFFICIAL_ROLE = re.compile(r"\b(?:mayor|councillor|director|manager|planner|engineer|chief|clerk|staff|city of)\b", re.I)
MINUTES_MATCH_MIN = 0.85


def name_key(name: str) -> str:
    return " ".join(folded(name))


def parse_minutes_speakers(sections: list[dict]) -> list[dict]:
    """Public speakers listed in minutes ("J. Harris, Langford Resident - re: Item 11.2 - ...")."""
    found, seen = [], set()
    for section in sections:
        if not SECTION_TITLE.search(f"{section.get('section_title') or ''} {(section.get('section_text') or '')[:200]}"):
            continue
        for match in MINUTES_LINE.finditer(section.get("section_text") or ""):
            name = re.sub(r"\s+", " ", match["name"]).strip()
            words = folded(name)
            if len(words) < 2 or NOT_PEOPLE.intersection(words):
                continue
            key = name_key(name)
            if key in seen:
                continue
            seen.add(key)
            affiliation, _, said = match["rest"].partition(" - ")
            if OFFICIAL_ROLE.search(affiliation):
                continue
            found.append({"name": name, "affiliation": affiliation.strip(" ,-")[:120], "said": said.strip()[:400]})
    return found


def _first_compatible(a: str, b: str) -> bool:
    """'T' / 'Tara' / 'Tara' agree; 'Tara' / 'Tanya' do not."""
    if len(a) == 1 or len(b) == 1:
        return a[0] == b[0]
    return a == b or (min(len(a), len(b)) >= 4 and one_edit(a, b))


def _surname_relation(spoken: list[str], listed: list[str]) -> str | None:
    if len(spoken) < 2 or len(listed) < 2:
        return None
    same_surname = spoken[-1] == listed[-1]
    close_surname = not same_surname and min(len(spoken[-1]), len(listed[-1])) >= 4 and one_edit(spoken[-1], listed[-1])
    first_ok = _first_compatible(spoken[0], listed[0])
    if same_surname and first_ok:
        return "match"
    if (close_surname and first_ok) or (same_surname and spoken[0][0] == listed[0][0]):
        return "near"
    return None


def _merge_spelling(spoken: str, listed: str) -> str:
    """Use the minutes' surname spelling; keep a full first name from the recording when minutes give an initial."""
    listed_words, spoken_words = listed.split(), spoken.split()
    first = listed_words[0]
    if re.fullmatch(r"(?:[A-Z]\.\s*)+", first) and len(spoken_words) >= 2:
        first = spoken_words[0]
    return " ".join([first, *listed_words[1:]])


def _literal_in(name: str, text: str) -> bool:
    words, source = folded(name), folded(text)
    width = len(words)
    return width >= 2 and any(source[i:i + width] == words for i in range(len(source) - width + 1))


def _titled(name: str) -> str:
    return " ".join(w if any(c.isupper() for c in w) else w.capitalize() for w in name.split())


def resolve_public_name(spoken: str, introduction: str, *, people, statement_names, minutes, published, decisions=None):
    """Return {status, basis, display, key, transcribed, conflict} or None when no usable name was introduced."""
    spoken = re.sub(r"\s+", " ", spoken or "").strip()
    if not spoken or not _literal_in(spoken, introduction):
        return None
    key = name_key(spoken)
    record = {"key": key, "transcribed": _titled(spoken), "conflict": {}}
    words = folded(spoken)

    decision = (decisions or {}).get(key)
    if decision:
        return {**record, "status": decision["status"], "basis": "admin", "display": decision.get("display_name")}

    registry = display_name(spoken, people, statement_names)
    if registry:
        return {**record, "status": "published", "basis": "registry", "display": registry}

    near = []
    for entry in minutes:
        relation = _surname_relation(words, folded(entry["name"]))
        if relation == "match":
            return {**record, "status": "published", "basis": "minutes", "display": _merge_spelling(record["transcribed"], entry["name"]),
                    "conflict": {"minutes": entry}}
        if relation == "near":
            near.append({"name": entry["name"], "source": "minutes", "affiliation": entry.get("affiliation")})

    for name in published:
        if name_key(name) == key:
            return {**record, "status": "published", "basis": "known", "display": name}
    for name in [*published, *(p["name"] for p in people)]:
        if name_score(spoken, name) or _surname_relation(words, folded(name)):
            near.append({"name": name, "source": "known"})

    if near:
        return {**record, "status": "review", "basis": "introduction", "display": None, "conflict": {"near": near[:5]}}
    return {**record, "status": "published", "basis": "introduction", "display": record["transcribed"]}


def match_unnamed_to_minutes(speakers, minutes, *, taken_names, decide, excluded_names=()):
    """Pair resident-labelled speakers with minutes entries by what they said.

    ``decide(context, choices)`` returns ``(choice_index_or_None, probability)``.
    Only confident, one-to-one pairings survive; an entry chosen twice is
    dropped for both, and entries already named elsewhere are not offered.
    """
    taken = [folded(n) for n in taken_names]
    entries = [m for m in minutes
               if not any(_surname_relation(t, folded(m["name"])) == "match" for t in taken)
               and not any(name_score(m["name"], official) for official in excluded_names)]
    if not entries:
        return {}
    picks = {}
    for index, speaker in enumerate(speakers):
        if not speaker["who"].startswith("A resident") or speaker.get("name_ref"):
            continue
        context = (f"Public speaker (summarised from the recording): position {speaker['position']}; "
                   f"topic: {speaker['topic']}; point: {speaker['point']}; label: {speaker['who']}")
        choice, probability = decide(context, entries)
        if choice is not None and 0 <= choice < len(entries) and probability >= MINUTES_MATCH_MIN:
            picks[index] = (entries[choice], probability)
    counts = {}
    for entry, _ in picks.values():
        counts[name_key(entry["name"])] = counts.get(name_key(entry["name"]), 0) + 1
    return {i: pick for i, pick in picks.items() if counts[name_key(pick[0]["name"])] == 1}
