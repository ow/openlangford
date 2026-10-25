"""Turn public participation / delegation segments into readable bullets.

Those agenda items only had a one-line summary ("many speakers on the
Transportation Master Plan"). The transcript for the item's time window holds
what each person actually said; this writes one bullet per speaker to
``agenda_items.meta.participation``:

    {"overview": str, "speakers": [{"who": str, "position": str, "point": str, "topic": str}]}

Privacy: a name is shown only when the speaker introduced it on the recording,
and then only with an earned spelling (people registry, the meeting's minutes,
an earlier published name, or a first-time introduction). Near misses wait for
admin review in ``public_speaker_names``. Unnamed people use a resident label
and a verified street, never a house number, phone or email.
"""
from __future__ import annotations

import re

from supabase import Client

from .participation_names import VERSION as NAMES_VERSION, match_unnamed_to_minutes, name_key, parse_minutes_speakers
from .participation_validation import load_name_evidence, load_streets

PARTICIPATION_TITLE = re.compile(r"public participation|delegations?|public input|question period|public hearing", re.I)
# Bump when the prompt/schema changes; stamped in agenda_items.meta.participation_version.
PARTICIPATION_VERSION = "3"


def _all(query_builder) -> list[dict]:
    rows = []
    while True:
        page = query_builder().range(len(rows), len(rows) + 999).execute().data or []
        rows.extend(page)
        if len(page) < 1000:
            return rows


def load_public_name_context(supabase: Client, item: dict) -> dict:
    """Minutes speaker lists for the meeting, published names, and admin decisions for this item."""
    docs = [d for d in supabase.table("documents").select("id,category").eq("meeting_id", item["meeting_id"]).execute().data or []
            if (d.get("category") or "").lower().startswith("minutes")]
    sections = []
    if docs:
        sections = _all(lambda: supabase.table("document_sections").select("id,section_title,section_text")
                        .in_("document_id", [d["id"] for d in docs]).order("id"))
    names = _all(lambda: supabase.table("public_speaker_names")
                 .select("agenda_item_id,name_key,display_name,status,decided_at").order("id"))
    return {
        "minutes": parse_minutes_speakers(sections),
        "published": sorted({r["display_name"] for r in names
                             if r["status"] == "published" and r["display_name"] and r["agenda_item_id"] != item["id"]}),
        "decisions": {r["name_key"]: {"status": r["status"], "display_name": r["display_name"]}
                      for r in names if r["agenda_item_id"] == item["id"] and r["decided_at"]},
    }


def _minutes_decider():
    from pipeline import ai

    def decide(context: str, entries: list[dict]):
        question = ai.choice(
            "entry",
            "Council minutes list each public speaker with a one-line summary of what they said. Which entry is "
            "this same person making this same contribution? Match on substance (position, topic, specific points), "
            "not just a shared subject. Choose none unless it clearly matches.",
            [(f"e{i}", f"{e['name']} ({e['affiliation']}): {e['said']}"[:400]) for i, e in enumerate(entries)]
            + [("none", "None of these entries.")],
        )
        answer = ai.decide(context, [question]).get("entry")
        if answer is None or answer.type != "choice" or answer.choice == "none":
            return None, 0.0
        probability = {p.value: p.probability for p in answer.probabilities}.get(answer.choice, 0.0)
        return int(answer.choice[1:]), probability

    return decide


def attach_minutes_names(result: dict, names: dict, segments: list[dict], excluded: set[str], decide=None) -> None:
    """After review: name resident-labelled speakers the minutes clearly list."""
    if not names["minutes"]:
        return
    speakers = result["speakers"]
    taken = [s["who"].split(" (")[0] for s in speakers if not s["who"].startswith("A resident")]
    picks = match_unnamed_to_minutes(speakers, names["minutes"], taken_names=taken,
                                     decide=decide or _minutes_decider(), excluded_names=excluded)
    starts = {s["id"]: s["start_time"] for s in segments}
    proofs = result["validation"]["speaker_proofs"]
    for index, (entry, probability) in picks.items():
        key = name_key(entry["name"])
        decision = names["decisions"].get(key)
        if decision and decision["status"] != "published":
            continue
        shown = (decision or {}).get("display_name") or entry["name"]
        suffix = re.search(r"\s*\([^()]*\)\s*$", speakers[index]["who"])
        speakers[index]["who"] = shown + (suffix[0] if suffix else "")
        speakers[index]["name_ref"] = key
        ids = proofs[index]["source_segment_ids"] if index < len(proofs) else []
        result["validation"]["name_records"].append({
            "key": key, "transcribed": entry["name"], "display": shown, "status": "published",
            "basis": "admin" if decision else "minutes",
            "conflict": {"minutes": entry, "matched_by": "minutes_summary", "probability": round(probability, 3)},
            "source_segment_ids": ids, "start_time": min((starts[i] for i in ids if i in starts), default=None),
        })


def record_public_names(supabase: Client, item: dict, records: list[dict]) -> None:
    """Upsert this item's undecided name rows; drop undecided rows the new summary no longer has."""
    existing = supabase.table("public_speaker_names").select("id,name_key,decided_at").eq("agenda_item_id", item["id"]).execute().data or []
    decided = {r["name_key"] for r in existing if r["decided_at"]}
    rows = [{
        "meeting_id": item["meeting_id"], "agenda_item_id": item["id"], "name_key": r["key"],
        "transcribed_name": r["transcribed"], "display_name": r["display"], "status": r["status"], "basis": r["basis"],
        "conflict": r["conflict"], "source_segment_ids": r["source_segment_ids"], "start_time": r["start_time"],
    } for r in records if r["key"] not in decided]
    if rows:
        supabase.table("public_speaker_names").upsert(rows, on_conflict="agenda_item_id,name_key").execute()
    keep = {r["key"] for r in records}
    stale = [r["id"] for r in existing if not r["decided_at"] and r["name_key"] not in keep]
    if stale:
        supabase.table("public_speaker_names").delete().in_("id", stale).execute()


def summarize_participation(supabase: Client, agenda_item_id: int, *, dry_run: bool = False) -> dict | None:
    """Generate only from complete, reviewed source windows; preserve concurrent edits."""
    from . import participation_evidence as evidence
    item = supabase.table("agenda_items").select("id,meeting_id,title,meta,discussion_start_time,discussion_end_time").eq("id", agenda_item_id).single().execute().data
    start, end = item.get("discussion_start_time"), item.get("discussion_end_time")
    if start is None or end is None or end <= start:
        return None
    segments = []
    while True:
        rows = (supabase.table("transcript_segments")
                .select("id,meeting_id,start_time,end_time,speaker_name,text_content")
                .eq("meeting_id", item["meeting_id"]).lt("start_time", end).gt("end_time", start)
                .order("start_time").order("id").range(len(segments), len(segments) + 999).execute().data or [])
        segments.extend(rows)
        if len(rows) < 1000 or len(segments) > 2000:
            break
    window = evidence.source_window(item, segments)
    chunk_plan = None
    if window.get("reason") == "source_window_requires_reviewed_chunking":
        chunk_plan = evidence.chunk_source_window(item, segments)
        if chunk_plan["status"] == "ready":
            window = chunk_plan["window"]
    if window["status"] != "ready":
        return None
    people, statements = load_name_evidence(supabase)
    streets = load_streets()
    meeting = supabase.table("meetings").select("meeting_date,meta").eq("id", item["meeting_id"]).single().execute().data
    dated = meeting["meeting_date"]
    memberships = []
    while True:
        rows = supabase.table("memberships").select("id,person_id,role,start_date,end_date").order("id").range(len(memberships), len(memberships) + 999).execute().data or []
        memberships.extend(rows)
        if len(rows) < 1000:
            break
    registry = {p["id"]: p["name"] for p in people}
    excluded = {registry[m["person_id"]] for m in memberships if m["person_id"] in registry and
                (not m.get("start_date") or m["start_date"] <= dated) and
                (not m.get("end_date") or m["end_date"] >= dated) and
                m.get("role", "").lower() in {"mayor", "councillor", "councilor", "staff"}}
    for role in ((meeting.get("meta") or {}).get("participant_roles") or {}).values():
        if role.get("classification") in {"government_staff", "committee_service"} and role.get("person_id") in registry:
            excluded.add(registry[role["person_id"]])
    names = load_public_name_context(supabase, item)
    # Published names and admin decisions change as other items are reviewed; they
    # are applied at write time and patched in place, so they don't force a rerun.
    fingerprint = evidence.digest({"title": item["title"], "window": window["fingerprint"], "people": people,
                                   "statements": statements, "streets": streets, "excluded": sorted(excluded),
                                   "minutes_speakers": names["minutes"], "version": evidence.VERSION,
                                   "names_version": NAMES_VERSION})
    oldmeta = item.get("meta") or {}
    old = oldmeta.get("participation") or {}
    if old.get("validation", {}).get("input_fingerprint") == fingerprint:
        return old
    if oldmeta.get("participation_review_hold", {}).get("input_fingerprint") == fingerprint:
        return None
    try:
        if chunk_plan:
            parts = []
            for chunk in chunk_plan["chunks"]:
                proposal = evidence.generate(item, chunk, excluded)
                candidate = evidence.prepare_candidate(proposal, window=chunk, people=people, statement_names=statements,
                                                       streets=streets, excluded_names=excluded, names=names)
                checked = evidence.review(item, chunk, candidate, excluded)
                if not evidence.review_passed(checked, candidate):
                    raise ValueError("independent_chunk_review_rejected: " + "; ".join(checked["issues"]))
                parts.append({"candidate": candidate, "review": checked})
            result = evidence.merge_reviewed_chunks(chunk_plan, parts)
            review = {"all_chunk_reviews_passed": True, "chunk_count": len(parts)}
        else:
            proposal = evidence.generate(item, window, excluded)
            result = evidence.prepare_candidate(proposal, window=window, people=people, statement_names=statements,
                                                streets=streets, excluded_names=excluded, names=names)
            review = evidence.review(item, window, result, excluded)
            if not evidence.review_passed(review, result):
                raise ValueError("independent_source_review_rejected: " + "; ".join(review["issues"]))
    except ValueError as error:
        if not dry_run:
            meta = dict(oldmeta)
            reason = str(error).split(":", 1)[0]
            if not re.fullmatch(r"[a-z_]+", reason):
                reason = "source_review_rejected"
            meta["participation_review_hold"] = {"version": evidence.VERSION, "input_fingerprint": fingerprint,
                                                  "reason": reason, "details_sha256": evidence.digest(str(error))}
            supabase.rpc("apply_public_participation_summary", {"p_item_id": agenda_item_id, "p_expected_item": item,
                         "p_expected_segments": segments, "p_after_meta": meta}).execute()
        return None
    result["validation"].setdefault("name_records", [])
    attach_minutes_names(result, names, segments, excluded)
    result["validation"]["input_fingerprint"] = fingerprint
    result["validation"]["independent_review"] = review
    if not dry_run:
        meta = dict(oldmeta)
        meta["participation"] = result
        meta["participation_version"] = PARTICIPATION_VERSION
        meta.pop("participation_review_hold", None)
        if not supabase.rpc("apply_public_participation_summary", {"p_item_id": agenda_item_id, "p_expected_item": item,
                            "p_expected_segments": segments, "p_after_meta": meta}).execute().data:
            return None
        record_public_names(supabase, item, result["validation"].get("name_records", []))
    return result
