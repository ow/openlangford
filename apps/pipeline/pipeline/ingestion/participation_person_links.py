"""Link named public speakers and letter writers to their ``people`` record, deterministically.

A speaker in ``agenda_items.meta.participation.speakers``, or the author of a
letter in ``agenda_items.meta.written_participation`` (``documents[].letters``,
or a legacy flat ``letters`` list), gets a ``person_id`` only when every check
passes:

1. the name, after dropping a trailing "(Street Name)" qualifier, is a full
   name: at least two capitalized words, none of them an initial ("N. Joel"
   never links) and none a label or organization word ("Neighbourhood
   resident", "Westhills Land Corporation" are people rows too);
2. exactly one ``people`` row has that name, compared case-insensitively;
3. that person is not a councillor, mayor or staff member (``is_councillor``,
   a Council or Staff membership, an official role, or a documented
   government-staff role at any meeting).

Anything else removes a stale ``person_id``, so re-running is idempotent. No
model calls: this is a cheap backfill over existing summaries and runs after
the participation and written-submission stages so a redraft gets its links
back. The web app only links a speaker or letter writer through this id; the
``who`` string is never an identity.
"""
from __future__ import annotations

import re
from typing import Any

# Bump when the linking rule changes; stamped in agenda_items.meta.participation_links_version.
# "2": letter authors in meta.written_participation are linked too.
LINKS_VERSION = "2"
STAMP = "participation_links_version"

QUALIFIER = re.compile(r"\s*\([^()]*\)\s*$")
INITIAL = re.compile(r"^[A-Za-z]\.?$|^(?:[A-Za-z]\.){2,}$")
# Words that make a "name" a label or an organization, not a person.
NOT_A_PERSON = {
    "resident", "residents", "owner", "owners", "business", "member", "members", "public", "neighbour", "neighbours",
    "neighbourhood", "neighbor", "neighborhood", "representative", "applicant", "agent", "speaker", "delegation",
    "corporation", "corp", "inc", "ltd", "limited", "llp", "company", "co", "group", "association", "society",
    "developers", "development", "developments", "homes", "properties", "holdings", "land", "council", "committee",
    "city", "district", "school", "church", "club", "foundation", "chamber", "commerce", "network", "alliance",
    "coalition", "partnership", "consulting", "architects", "engineering", "construction", "realty", "services",
    "avenue", "road", "street", "drive", "highway", "way", "place", "crescent", "terrace", "lane", "langford",
    "staff", "mayor", "councillor", "unknown", "anonymous", "redacted", "withheld",
}
OFFICIAL_ROLE = re.compile(
    r"\b(?:mayor|councill?or|director|manager|clerk|cao|chief|officer|planner|engineer|administrator|"
    r"superintendent|staff|coordinator|deputy|assistant|police|rcmp)\b",
    re.I,
)


def name_key(name: str) -> str:
    return " ".join((name or "").split()).casefold()


def full_name(who: str) -> str | None:
    """The speaker's name without a trailing "(Street)" qualifier, or None unless it is a full name."""
    name = " ".join(QUALIFIER.sub("", who or "").split())
    words = name.split(" ") if name else []
    if len(words) < 2 or any(INITIAL.match(w) for w in words):
        return None
    if not all(re.match(r"[^\W\d_]", w) and w[0].isupper() for w in words):
        return None
    if any(re.sub(r"[^\w]", "", w).casefold() in NOT_A_PERSON for w in words):
        return None
    return name


def official_ids(people: list[dict], memberships: list[dict], staff_roles: list[dict] = ()) -> set[int]:
    """People who are (or were) council or staff: never linked as public participants."""
    ids = {p["id"] for p in people if p.get("is_councillor")}
    for m in memberships:
        org = m.get("organizations") or m.get("organization") or {}
        classification = (org.get("classification") or "").strip().lower()
        if classification in {"council", "staff"} or OFFICIAL_ROLE.search(m.get("role") or ""):
            ids.add(m["person_id"])
    for role in staff_roles:
        if role.get("classification") == "government_staff" and role.get("person_id") is not None:
            ids.add(role["person_id"])
    return ids


def build_registry(people: list[dict], excluded: set[int]) -> dict[str, int | None]:
    """name key -> person id, or None when the name is ambiguous or belongs to an official."""
    by_name: dict[str, set[int]] = {}
    for p in people:
        by_name.setdefault(name_key(p["name"]), set()).add(p["id"])
    registry: dict[str, int | None] = {}
    for key, ids in by_name.items():
        registry[key] = next(iter(ids)) if len(ids) == 1 and not ids & excluded else None
    return registry


def person_for(who: str, registry: dict[str, int | None]) -> int | None:
    name = full_name(who)
    return registry.get(name_key(name)) if name else None


def link_speakers(speakers: list[dict], registry: dict[str, int | None]) -> tuple[list[dict], bool]:
    """Speakers (or letters) with ``person_id`` set or removed per the rule, and whether anything changed."""
    out, changed = [], False
    for speaker in speakers:
        pid = person_for(speaker.get("who") or "", registry)
        if speaker.get("person_id") == pid and (pid is not None or "person_id" not in speaker):
            out.append(speaker)
            continue
        changed = True
        updated = {k: v for k, v in speaker.items() if k != "person_id"}
        if pid is not None:
            updated["person_id"] = pid
        out.append(updated)
    return out, changed


def letters_of(written: dict | None) -> list[dict]:
    """Every letter in a written_participation value, in either stored shape."""
    if not written:
        return []
    if "documents" in written:
        return [letter for doc in written.get("documents") or [] for letter in (doc or {}).get("letters") or []]
    return list(written.get("letters") or [])


def link_letters(written: dict, registry: dict[str, int | None]) -> tuple[dict, bool]:
    """``written_participation`` with each letter author linked per the rule, and whether anything changed."""
    if "documents" in written:
        documents, changed = [], False
        for doc in written.get("documents") or []:
            if not isinstance(doc, dict) or not doc.get("letters"):
                documents.append(doc)
                continue
            letters, doc_changed = link_speakers(doc["letters"], registry)
            changed |= doc_changed
            documents.append({**doc, "letters": letters} if doc_changed else doc)
        return ({**written, "documents": documents} if changed else written), changed
    letters, changed = link_speakers(written.get("letters") or [], registry)
    return ({**written, "letters": letters} if changed else written), changed


def _paginate(build, page: int = 1000) -> list[dict]:
    rows: list[dict] = []
    while True:
        chunk = build().range(len(rows), len(rows) + page - 1).execute().data or []
        rows.extend(chunk)
        if len(chunk) < page:
            return rows


def load_registry(supabase: Any) -> tuple[dict[str, int | None], set[int]]:
    people = _paginate(lambda: supabase.table("people").select("id,name,is_councillor").order("id"))
    memberships = _paginate(lambda: supabase.table("memberships")
                            .select("id,person_id,role,organizations(classification)").order("id"))
    roles = []
    for meeting in _paginate(lambda: supabase.table("meetings").select("id,roles:meta->participant_roles")
                             .not_.is_("meta->participant_roles", "null").order("id")):
        roles.extend(r for r in (meeting.get("roles") or {}).values() if isinstance(r, dict))
    excluded = official_ids(people, memberships, roles)
    return build_registry(people, excluded), excluded


def link_item(supabase: Any, item: dict, registry: dict[str, int | None], *, dry_run: bool = False,
              force: bool = False) -> dict:
    """Link one item's speakers and letter authors. ``item`` has id, meta, updated_at. Writes guarded by updated_at."""
    meta = item.get("meta") or {}
    new_meta = dict(meta)
    participation = meta.get("participation") or {}
    speakers, speakers_changed = link_speakers(participation.get("speakers") or [], registry)
    if participation.get("speakers"):
        new_meta["participation"] = {**participation, "speakers": speakers}
    written = meta.get("written_participation")
    letters_changed = False
    if isinstance(written, dict):
        new_meta["written_participation"], letters_changed = link_letters(written, registry)
    changed = speakers_changed or letters_changed
    linked = [s["person_id"] for s in speakers if s.get("person_id") is not None]
    letters_linked = [l["person_id"] for l in letters_of(new_meta.get("written_participation"))
                      if isinstance(l, dict) and l.get("person_id") is not None]
    stamped = meta.get(STAMP) == LINKS_VERSION
    result = {"id": item["id"], "changed": changed, "linked": linked, "letters_linked": letters_linked,
              "written": False, "would_write": force or changed or not stamped}
    if dry_run or not result["would_write"]:
        return result
    new_meta[STAMP] = LINKS_VERSION
    query = supabase.table("agenda_items").update({"meta": new_meta}).eq("id", item["id"])
    if item.get("updated_at"):
        query = query.eq("updated_at", item["updated_at"])
    result["written"] = bool(query.execute().data)
    result["conflict"] = not result["written"]
    return result
