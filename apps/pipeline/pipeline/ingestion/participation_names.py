"""Decide how a self-introduced public speaker is named.

The transcript is only evidence that someone said a name; the spelling still
has to be earned. In order:

1. an admin decision for this item and name wins;
2. a confident people-registry spelling (``display_name``);
3. the meeting minutes list the speaker (same surname, compatible first name);
4. the name exactly matches one already published elsewhere;
5. a near miss against the minutes, the registry or a published name, or any
   name the meeting's minutes don't list, is held for admin review (shown as
   "A resident" meanwhile);
6. otherwise (no minutes speaker list to check) it is a first-time name and is
   published as introduced.

A name is only considered when its words appear literally in the speaker's
own introduction, so a model cannot invent or "correct" one.
"""
from __future__ import annotations

import re

from .participation_validation import display_name, folded, name_score, one_edit

VERSION = "public-speaker-names-v5"

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
    for section_index, section in enumerate(sections):
        if not SECTION_TITLE.search(f"{section.get('section_title') or ''} {(section.get('section_text') or '')[:200]}"):
            continue
        text = section.get("section_text") or ""
        matches = list(MINUTES_LINE.finditer(text))
        for position, match in enumerate(matches):
            name = re.sub(r"\s+", " ", match["name"]).strip()
            # An entry's summary may continue on the following lines, up to the next speaker.
            end = matches[position + 1].start() if position + 1 < len(matches) else len(text)
            body = re.split(r"\n\s*(?:#|\n)", text[match.start("rest"):end])[0]
            rest = re.sub(r"\s+", " ", body).strip()
            words = folded(name)
            if len(words) < 2 or NOT_PEOPLE.intersection(words):
                continue
            key = name_key(name)
            if key in seen:
                continue
            seen.add(key)
            affiliation, _, said = rest.partition(" - ")
            if OFFICIAL_ROLE.search(affiliation):
                continue
            # Keep the street, never the house or unit number.
            affiliation = re.sub(r"#?\b\d[\w/-]*\b|\b(?:unit|suite|apt\.?)\b|&", "", affiliation, flags=re.I)
            found.append({"name": name, "affiliation": re.sub(r"\s+", " ", affiliation).strip(" ,-")[:120],
                          "said": said.strip()[:400], "section": section_index, "order": len(found)})
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

    if not near and minutes:
        # The minutes list this meeting's speakers and none matches: likely a
        # mishearing. Offer listed names with the same first initial.
        near = [{"name": m["name"], "source": "minutes", "affiliation": m.get("affiliation")}
                for m in minutes if folded(m["name"])[0][0] == words[0][0]]
        reason = "not_in_minutes"
    else:
        reason = "near_miss"
    if near or minutes:
        return {**record, "status": "review", "basis": "introduction", "display": None,
                "conflict": {"near": near[:5], "reason": reason}}
    return {**record, "status": "published", "basis": "introduction", "display": record["transcribed"]}


MINUTES_MATCH_FEW = 0.75  # enough when order leaves at most three candidates


def _minutes_index(name: str, minutes: list[dict]) -> int | None:
    words = folded(name)
    hits = [m["order"] for m in minutes if _surname_relation(words, folded(m["name"])) == "match"]
    return hits[0] if len(hits) == 1 else None


def match_unnamed_to_minutes(speakers, minutes, *, taken_names, decide, excluded_names=()):
    """Pair resident-labelled speakers with minutes entries.

    Minutes list speakers in speaking order, so speakers already named act as
    anchors: an unnamed speaker can only be an entry listed between the
    entries of its named neighbours. Within that range ``decide(context,
    choices)`` -> ``(index_or_None, probability)`` picks by what was said.
    Picks must be confident, one-to-one, and keep minutes order.
    """
    taken = [folded(n) for n in taken_names]
    available = [m for m in minutes
                 if not any(_surname_relation(t, folded(m["name"])) == "match" for t in taken)
                 and not any(name_score(m["name"], official) for official in excluded_names)]
    if not available:
        return {}
    anchors = {}
    for index, speaker in enumerate(speakers):
        if not speaker["who"].startswith("A resident"):
            position = _minutes_index(speaker["who"].split(" (")[0], minutes)
            if position is not None:
                anchors[index] = position
    sections = {minutes[o]["section"] for o in anchors.values()}
    picks = {}
    for index, speaker in enumerate(speakers):
        if not speaker["who"].startswith("A resident") or speaker.get("name_ref"):
            continue
        before = [anchors[i] for i in anchors if i < index]
        after = [anchors[i] for i in anchors if i > index]
        low, high = (max(before) if before else -1), (min(after) if after else len(minutes))
        options = [m for m in available if low < m["order"] < high
                   and (len(sections) != 1 or m["section"] in sections)]
        slot_speakers = [i for i in range(len(speakers))
                         if (not before or i > max(b for b in anchors if anchors[b] == max(before)))
                         and (not after or i < min(a for a in anchors if anchors[a] == min(after)))
                         and speakers[i]["who"].startswith("A resident")]
        # With no summary to compare, order alone must be unambiguous: one entry, one speaker.
        if not (len(options) == 1 and len(slot_speakers) == 1):
            options = [m for m in options if m.get("said")]
        if not options:
            continue
        neighbours = []
        if before:
            neighbours.append(f"listed after {minutes[max(before)]['name']}")
        if after:
            neighbours.append(f"listed before {minutes[min(after)]['name']}")
        context = (f"Public speaker (summarised from the recording): position {speaker['position']}; "
                   f"topic: {speaker['topic']}; point: {speaker['point']}; label: {speaker['who']}. "
                   f"Minutes list speakers in speaking order; this speaker should be "
                   f"{' and '.join(neighbours) or 'somewhere in the list'}.")
        choice, probability = decide(context, options)
        needed = MINUTES_MATCH_FEW if len(options) <= 3 else MINUTES_MATCH_MIN
        if choice is not None and 0 <= choice < len(options) and probability >= needed:
            picks[index] = (options[choice], probability)
    counts = {}
    for entry, _ in picks.values():
        counts[entry["order"]] = counts.get(entry["order"], 0) + 1
    picks = {i: pick for i, pick in picks.items() if counts[pick[0]["order"]] == 1}
    # Drop any pair of picks that cross each other's minutes order.
    crossed = {i for i in picks for j in picks
               if i < j and picks[i][0]["order"] > picks[j][0]["order"]}
    crossed |= {j for i in picks for j in picks if i < j and picks[i][0]["order"] > picks[j][0]["order"]}
    return {i: pick for i, pick in picks.items() if i not in crossed}
