"""Names of residents and guest presenters on the transcript, from their own introductions.

Speaker naming (``speaker_identity``) can only name people in the registry: council and the staff the
minutes list. Most unnamed speech is everyone else: residents at public participation and hearings
("Bernadette Armstrong, 2813 Rodney Road"), delegations and invited presenters ("a presentation on
community safety with James Bridge. Welcome."). They say who they are on the recording.

A name must be said on the recording (an answer to "state your name for the record", "my name is ...", or the
chair introducing a guest). It is shown with the best spelling available (``participation_names.resolve_public_name``:
the people registry, the meeting's minutes speaker list, a name the agenda item's own title gives, or an earlier
published name), or with one close official spelling, or as transcribed: people state their name for the
record on a public recording. Only real ambiguity (several close spellings) waits for an admin in
``public_speaker_names`` (/admin/names); decided rows are never overwritten.

The name goes on that speaker's lines from the introduction until someone else takes the floor for good,
within the same agenda item, so a diarization label that merges several residents is never named as one.
Pure detection here; ``speaker_names`` writes the rows and records them for exact reverts.
"""
from __future__ import annotations

import re

from .participation_names import NAME, name_key, resolve_public_name

ASKS_NAME = re.compile(
    r"(?i)(?:state|give|provide|say)\s+(?:us\s+)?(?:your\s+)?(?:full\s+)?name|name\s+and\s+(?:your\s+)?address|"
    r"your\s+name\s+(?:and\s+\w+\s+)?for\s+the\s+record|need\s+your\s+name|unmute\s+yourself")
# Case matters in the name itself (speech-to-text capitalises names), so only the lead-in words ignore case.
OPENER = r"(?:(?i:hi|hello|yes|yeah|yep|yup|okay|ok|sure|good\s+(?:evening|afternoon|morning)|thank\s+you|thanks)[,.!\s]+(?:(?i:mayor|council|everyone|madam\s+chair)[,.!\s]+)*)*"
LEAD = r"(?:(?i:um|uh|so|well)[,\s]+)*(?:(?i:my\s+name\s+is|my\s+name's|it's|it\s+is|this\s+is|i'm|i\s+am)\s+)?"
# "Bernadette Armstrong, 2813 Rodney Road" / "It's Lori Plunk, ..." / "My name is Jay Scott"
ANSWER = re.compile(rf"^\W*{OPENER}{LEAD}(?P<name>{NAME})\b")
MY_NAME = re.compile(rf"\b(?i:my\s+name\s+is)\s+(?P<name>{NAME})\b")
# The chair hands the floor to a named guest: "... with James Bridge. Welcome." / "Welcome, Ken Caruska."
GUEST_CALL = re.compile(rf"(?i:\bwith|\bfrom|\bwelcome,?|\bover\s+to|\binvite)\s+(?P<name>{NAME})[\s.,!]*(?i:welcome|go\s+ahead|the\s+floor\s+is\s+yours|please)?[\s.,!]*$")
NOT_A_NAME = re.compile(r"(?i)^(?:mayor|council|councillor|madam|chair|langford|city|thank|good|the|and|item|your|hi|hello)\b|\b(?:worship|there|number)$")


FILLER = re.compile(r"^(?i:(?:um|uh|er|ah|oh|so|well|yeah|yes|okay|ok)\s+)+")
# Ordinary words speech-to-text capitalises at the start of a sentence, never a first name.
COMMON_FIRST = {"here", "there", "this", "that", "just", "also", "now", "then", "can", "could", "would", "will",
                "please", "sorry", "not", "all", "any", "some", "one", "two", "item", "next", "last", "first"}


def _name(m: re.Match | None) -> str | None:
    if not m:
        return None
    name = FILLER.sub("", re.sub(r"\s+", " ", m.group("name")).strip(" .,"))
    if name.split() and name.split()[0].casefold() in COMMON_FIRST:
        return None
    if NOT_A_NAME.search(name) or len(name.split()) < 2:
        return None
    return name


def introductions(turns, items: list[dict]) -> list[dict]:
    """[{label, turn index, spoken, introduction, item}] for every turn that names its own speaker."""
    def item_at(t):
        best = None
        for it in items:
            a, b = it.get("discussion_start_time"), it.get("discussion_end_time")
            if a is not None and b is not None and a <= t < b and (best is None or a > best["discussion_start_time"]):
                best = it
        return best

    out = []
    for i, turn in enumerate(turns):
        if not turn.text or not turn.label:
            continue
        prev = turns[i - 1] if i else None
        spoken, source = None, None
        head = " ".join(turn.text.split()[:30])
        if prev and prev.label != turn.label and ASKS_NAME.search(prev.text[-200:]):
            spoken, source = _name(ANSWER.search(head)), head
        if not spoken:
            spoken, source = _name(MY_NAME.search(head)), head
        if not spoken and prev and prev.label != turn.label and len(turn.text.split()) >= 40:
            # A guest introduced by the chair, who then speaks at length.
            spoken, source = _name(GUEST_CALL.search(prev.text[-160:])), prev.text[-160:]
        item = item_at(turn.start) if spoken else None
        if spoken and item:
            out.append({"label": turn.label, "turn": i, "spoken": spoken, "introduction": source, "item": item})
    return out


def title_names(items: list[dict]) -> list[dict]:
    """People an agenda item's own title names ("Presentation - James Bridge, Community Safety"), as minutes-style
    entries: the agenda is an official spelling for invited presenters and delegations."""
    out, seen = [], set()
    for it in items:
        for m in re.finditer(NAME, it.get("title") or ""):
            name = re.sub(r"\s+", " ", m.group(0)).strip()
            if NOT_A_NAME.search(name) or len(name.split()) < 2 or name_key(name) in seen:
                continue
            seen.add(name_key(name))
            out.append({"name": name, "affiliation": "", "said": it.get("title") or "", "section": -1, "order": len(out)})
    return out


def span(turns, start: int, label: str, item: dict) -> list[int]:
    """Turn indexes the introduced person holds: their label's turns from the introduction until the item ends or
    the same label introduces someone new (answers another name request, or says "my name is")."""
    end_time = item.get("discussion_end_time") or float("inf")
    held = [start]
    for j in range(start + 1, len(turns)):
        t = turns[j]
        if t.start >= end_time:
            break
        if t.label != label:
            continue
        if MY_NAME.search(" ".join(t.text.split()[:30])) or ASKS_NAME.search(turns[j - 1].text[-200:]):
            break  # this label is someone new now
        held.append(j)
    return held


def is_official(spoken: str, officials: list) -> bool:
    """A roster person (council, staff) by surname as heard and a compatible first name or initial: those are
    speaker_identity's to name, with their registry identity."""
    from .speaker_identity import _norm, name_similarity

    words = spoken.split()
    first, surname = _norm(words[0]), _norm(words[-1])
    for c in officials:
        if name_similarity(surname, c.surname) >= 0.8 and (not first or (c.first and c.first[:3] == first[:3]) or c.initial == first[:1]):
            return True
    return False


def resolve(intros: list[dict], *, people, statement_names, minutes, published, decisions, officials: list) -> list[dict]:
    """Each introduction with its decision: {..., record: {status, basis, display, key, transcribed, conflict}}.
    ``officials``: speaker_identity Candidates (the meeting's roster and councillors), left to speaker_identity."""
    out = []
    for intro in intros:
        if is_official(intro["spoken"], officials):
            continue
        record = resolve_public_name(intro["spoken"], intro["introduction"], people=people, statement_names=statement_names,
                                     minutes=minutes, published=published, decisions=decisions.get(intro["item"]["id"], {}))
        if not record:
            continue
        # A registry spelling must be the same name, not a neighbour ("James Bridge" is not "James Ridge").
        if record["basis"] == "registry" and record.get("display") and not _same_name(intro["spoken"], record["display"]):
            record = {**record, "status": "review", "basis": "introduction", "display": None,
                      "conflict": {"near": [{"name": record["display"], "source": "registry"}], "reason": "near_miss"}}
        pool = [p["name"] for p in people] + list(published) + [m["name"] for m in minutes]
        out.append({**intro, "record": _settle(record, intro["spoken"], pool)})
    return out


def _settle(record: dict, spoken: str, pool: list[str] = ()) -> dict:
    """A name said for the record on a public recording is shown. Review is only for real ambiguity: one close
    official spelling takes over ("Gintow" -> minutes' "Gintaut"); several close ones, or a decided row, stay as they are."""
    if record["basis"] == "admin" or (record["status"] == "published" and record["basis"] != "introduction"):
        return record
    if not all(w[:1].isupper() for w in spoken.split()):
        # Speech-to-text capitalises names it is sure of; a lowercase "ron coutrey" is a guess.
        return {**record, "status": "review", "display": None, "conflict": {**record.get("conflict", {}), "reason": "uncertain_transcription"}}
    near = [n for n in (record.get("conflict") or {}).get("near") or [] if _same_name(spoken, n["name"])]
    # Several spellings of one surname ("Jacqueline Gintaut", "J. Gintaut") are one person: keep the fullest.
    if near and len({n["name"].split()[-1].casefold() for n in near}) == 1:
        best = max(near, key=lambda n: len(n["name"]))
        return {**record, "status": "published", "basis": "minutes" if best.get("source") == "minutes" else "known",
                "display": best["name"], "conflict": {**record.get("conflict", {}), "settled": "one_close_spelling"}}
    if not near:
        # Speech-to-text respells repeat speakers ("Gintow", "Gintel" for Gintaut): one known person with the same
        # first name and a like-sounding surname gives the spelling.
        known = {n for n in pool if n and _same_name(spoken, n, loose=True)}
        # A full first name that agrees ("Jacqueline") outranks a bare initial ("J. Gowing").
        full = {n for n in known if n.split()[0].rstrip(".").casefold() == spoken.split()[0].casefold()}
        known = full or known
        # "Lori Plomp" and "L. Plomp" are one person: same surname, keep the fullest spelling.
        if known and len({n.split()[-1].casefold() for n in known}) == 1:
            return {**record, "status": "published", "basis": "known", "display": max(known, key=len),
                    "conflict": {**record.get("conflict", {}), "settled": "one_known_spelling"}}
        return {**record, "status": "published", "basis": "introduction", "display": record["transcribed"],
                "conflict": {**record.get("conflict", {}), "settled": "stated_for_the_record"}}
    return record


def _same_name(spoken: str, registry: str, loose: bool = False) -> bool:
    """Registry "B. Armstrong" / "Jacqueline Gintaut" agree with spoken "Bernadette Armstrong" / "Jacqueline Gintow"
    only when the surname is the same as heard (sound-alike) and the first name or initial agrees."""
    from .speaker_identity import _norm, name_similarity

    a, b = spoken.replace(".", ". ").split(), registry.replace(".", ". ").split()
    if len(a) < 2 or len(b) < 2:
        return False
    first_a, first_b = _norm(a[0]), _norm(b[0])
    first_ok = first_a[:1] == first_b[:1] and (len(first_b) == 1 or len(first_a) == 1 or first_a[:3] == first_b[:3])
    sa, sb = _norm(a[-1]), _norm(b[-1])
    return first_ok and sa[:1] == sb[:1] and name_similarity(sa, sb) >= (0.55 if loose else 0.7)
