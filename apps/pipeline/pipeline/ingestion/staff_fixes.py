"""Page fixes staff asked for, run by the quick worker (job ``fix_page``).

The site's fix agent (apps/web/app/services/page-fix.server.ts) carries out almost every fix itself, in its own
request: moves to a named topic, merges, the summary rewrite and its checks (see docs/page-review-fixes.md). It queues
this job only to re-file an item the way ingest files one (no listed topic fits), which needs the ingest matcher.
``run_fix_page`` re-files those items, rewrites the summaries of the topics they left and joined, and finishes the
page with the site's report and its own. It still handles every step below, so older queued jobs run as before.

A moved item carries a lock, ``agenda_items.meta.staff_matter`` ({"matter_id", "by", "at", "reason"}), which the
ingester and the history step respect: re-processing a meeting never files it back.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from pipeline.ingestion.manual_edits import keep_text_edits


def staff_matter(meta: dict | None) -> dict | None:
    """The lock on an item moved by staff, or None. ``matter_id`` may be None (taken off every topic)."""
    lock = (meta or {}).get("staff_matter")
    return lock if isinstance(lock, dict) and "matter_id" in lock else None


def locked_matter_id(meta: dict | None, proposed: int | None) -> int | None:
    """The topic an item belongs to on re-processing: the staff lock wins over the pipeline's own choice."""
    lock = staff_matter(meta)
    return lock["matter_id"] if lock else proposed


def move_item(supabase, item_id: int, to_matter_id: int | None, *, by: str | None, reason: str) -> dict:
    """File one agenda item under another topic (or none) and lock it there. Returns {from, to, meeting_id}."""
    item = supabase.table("agenda_items").select("id, matter_id, meeting_id, meta").eq("id", item_id).single().execute().data
    if to_matter_id is not None:
        target = supabase.table("matters").select("id, merged_into").eq("id", to_matter_id).single().execute().data
        to_matter_id = target.get("merged_into") or to_matter_id
    meta = {**(item.get("meta") or {}), "staff_matter": {
        "matter_id": to_matter_id, "by": by, "at": datetime.now(timezone.utc).isoformat(), "reason": reason[:300],
        "from": item.get("matter_id"),
    }}
    supabase.table("agenda_items").update({"matter_id": to_matter_id, "meta": meta}).eq("id", item_id).execute()
    # The item's addresses go with it, so the old topic's map and property pages drop them now (the properties
    # stage would also catch up, on its next run).
    supabase.table("property_links").update({"matter_id": to_matter_id}).eq("agenda_item_id", item_id).execute()
    return {"from": item.get("matter_id"), "to": to_matter_id, "meeting_id": item["meeting_id"]}


def refile_targets(supabase, item_ids: list[int]) -> dict[int, int | None]:
    """Where ingest would file these items if they weren't on their current topics (never those topics): an existing
    topic for their permit, bylaw or address, a new one, or none for a heading. Filed together, earliest first, so the
    steps of one application land on one topic: the first founds it and the later ones join it."""
    from pipeline.ingestion.topic_regroup import refile

    if not item_ids:
        return {}
    rows = supabase.table("agenda_items").select("id, matter_id").in_("id", item_ids).execute().data or []
    # An approved move overrides an earlier staff placement: that placement is what's being corrected.
    entries = [{"item": r["id"], "from": r.get("matter_id"), "override_lock": True} for r in rows]
    results = refile(supabase, entries, dry_run=False, log=lambda *_: None)
    return {int(r["item"]): (int(r["to"]) if isinstance(r.get("to"), int) else None) for r in results}


def refile_target(supabase, item_id: int) -> int | None:
    """``refile_targets`` for one item."""
    return refile_targets(supabase, [item_id]).get(item_id)


# Shared with the site's fix agent (apps/web/app/services/topic-summaries.server.ts), which does these steps itself.
_FIELDS = json.loads((Path(__file__).resolve().parents[4] / "shared" / "prompts" / "topic-summaries.json").read_text())["fields"]


class _DirectEdit(BaseModel):
    summary: str = Field(description=_FIELDS["direct_summary"])
    status_line: str = Field(description=_FIELDS["direct_status_line"])


def direct_edit(supabase, matter_id: int, notes: list[str]) -> bool:
    """Last step when the summary writer won't follow an approved instruction: edit the current summary and status
    line directly, using only the instruction and the record's words it quotes. Kept as meta.staff_text, which later
    rewrites keep until the topic gains a step of its own (then the writer takes over again). True when saved."""
    from pipeline import ai

    m = supabase.table("matters").select("plain_english_summary, meta").eq("id", matter_id).single().execute().data
    meta = m.get("meta") or {}
    try:
        edit = ai.json("Apply these approved instructions to a topic page on a site that follows a city council. Change only "
                       "what they ask; keep everything else, and use only facts the instructions or their quoted records "
                       f"give.\n\nInstructions:\n" + "\n".join(f"- {n}" for n in notes)
                       + f"\n\nCurrent summary: {m.get('plain_english_summary') or ''}\nCurrent where it stands: {meta.get('status_line') or ''}",
                       stage="review", schema=_DirectEdit)
    except Exception as exc:
        print(f"  [fix_page] direct edit failed: {exc}")
        return False
    owned = [r["id"] for r in supabase.table("agenda_items").select("id").eq("matter_id", matter_id).execute().data or []]
    staff_text = {"summary": edit.summary.strip(), "status_line": edit.status_line.strip(), "items": sorted(owned),
                  "notes": notes, "at": datetime.now(timezone.utc).isoformat()}
    supabase.table("matters").update(keep_text_edits(supabase, matter_id, {"plain_english_summary": staff_text["summary"] or m.get("plain_english_summary"),
                                      "meta": {**meta, "status_line": staff_text["status_line"] or meta.get("status_line"),
                                               "staff_text": staff_text}})).eq("id", matter_id).execute()
    return True


class _NoteCheck(BaseModel):
    followed: bool = Field(description=_FIELDS["note_followed"])
    missing: str = Field(description=_FIELDS["note_missing"])


def check_summary_notes(supabase, notes: list[dict]) -> list[dict]:
    """The approved summary instructions the rewritten summary doesn't follow, each with the topic the page now shows
    and what is still missing."""
    from pipeline import ai

    unfollowed = []
    for entry in notes:
        matter = supabase.table("matters").select("plain_english_summary, meta, merged_into").eq("id", int(entry["matter_id"])).single().execute().data
        matter_id = int(entry["matter_id"])
        canonical = matter.get("merged_into")
        if canonical:
            matter_id = int(canonical)  # merged away during this fix: the page now shows the topic it was merged into
            matter = supabase.table("matters").select("plain_english_summary, meta").eq("id", int(canonical)).single().execute().data
        text = f"Summary: {matter.get('plain_english_summary') or ''}\nWhere it stands: {(matter.get('meta') or {}).get('status_line') or ''}"
        try:
            verdict = ai.json(f"An editor asked for this change to a topic page's summary on a site that follows a city "
                              f"council:\n\n{entry['note']}\n\nThe page now reads:\n{text}\n\nThe page's dates (when it was "
                              f"discussed) and its timeline are drawn from its records and shown separately, so judge only "
                              f"what the summary and status should say. Judge substance, not wording: it follows the "
                              f"instruction when the facts it asks for are there (in the summary or the status) and "
                              f"nothing it says to drop is left; asides such as \"noting that…\" are optional. "
                              f"Does it follow the instruction?",
                              stage="review", schema=_NoteCheck)
        except Exception as exc:  # can't check: say so rather than claim it
            print(f"  [fix_page] summary check failed: {exc}")
            unfollowed.append({"note": entry["note"], "matter_id": matter_id, "missing": ""})
            continue
        if not verdict.followed:
            unfollowed.append({"note": entry["note"], "matter_id": matter_id, "missing": verdict.missing})
    return unfollowed


def run_fix_page(supabase, args: dict[str, Any]) -> dict[str, Any]:
    """Carry out the moves the site's fix agent planned, refresh the topics they touched, and finish the page."""
    from pipeline.ingestion.matter_lifecycle import refresh_meeting_matter_lifecycles
    from pipeline.ingestion.matter_summaries import refresh_matter_summaries

    path = args["path"]
    by = args.get("requested_by")
    role = args.get("role") or "moderator"
    done: list[str] = list(args.get("done") or [])
    left: list[str] = list(args.get("left") or [])
    touched: set[int] = {int(m) for m in args.get("refresh") or []}
    meetings: set[int] = set()
    fixed_keys: set[str] = set()
    merged = 0

    moves = []
    for move in args.get("moves") or []:
        to = move.get("to_matter_id")
        if to is not None:
            current = supabase.table("agenda_items").select("matter_id").eq("id", int(move["item_id"])).single().execute().data.get("matter_id")
            if int(to) == current:  # "move" onto the topic it's already on: re-file it instead
                move = {**move, "to_matter_id": None, "refile": True}
        moves.append(move)
    # Every item to re-file goes in one batch, so the steps of one application land on one topic together.
    refiling = [int(m["item_id"]) for m in moves if m.get("refile") and m.get("to_matter_id") is None]
    origins = {r["id"]: r.get("matter_id") for r in (supabase.table("agenda_items").select("id, matter_id").in_("id", refiling)
                                                     .execute().data or [])} if refiling else {}
    try:
        refiled = refile_targets(supabase, refiling)
    except Exception as exc:
        refiled = {}
        left.extend(f"{m.get('reason') or 'Re-filing an item'} (it didn't work: {exc})" for m in moves if int(m["item_id"]) in refiling)
        moves = [m for m in moves if int(m["item_id"]) not in refiling]
    touched.update(m for m in origins.values() if m)

    for move in moves:
        item_id, to = int(move["item_id"]), move.get("to_matter_id")
        try:
            if item_id in refiling:
                to = refiled.get(item_id)
            result = move_item(supabase, item_id, int(to) if to is not None else None, by=by, reason=move.get("reason") or "")
            touched.update(m for m in (result["from"], result["to"]) if m)
            meetings.add(result["meeting_id"])
            fixed_keys.add(f"agenda-{item_id}")
            done.append(move.get("reason") or f"Moved item {item_id}.")
            supabase.table("staff_actions").insert({
                "user_id": by, "role": role, "path": path, "action": "agent:move_item",
                "detail": {"agenda_item_id": str(item_id), "from": str(result["from"]), "to": str(result["to"]),
                           "reason": (move.get("reason") or "")[:400]},
            }).execute()
        except Exception as exc:  # one failed move doesn't stop the rest
            left.append(f"{move.get('reason') or f'Moving item {item_id}'} (it didn't work: {exc})")

    from pipeline.ingestion.matter_resolver import merge_flat

    for merge in args.get("merges") or []:
        a, b = int(merge["matter_id"]), int(merge["with_matter_id"])
        try:
            # Flattened, so no topic is left pointing at another alias.
            result = merge_flat(supabase, [a, b], canonical=a, reason="staff")  # the page being fixed keeps its address
            applied = [result] if result["aliases"] else []
            if applied:
                touched.add(applied[0]["canonical"])
                # The flag that asked for it is done: its own key (from the site), or the merged topics' Related cards.
                fixed_keys.update(k for k in (merge.get("key"), f"related-{a}", f"related-{b}") if k)
                merged += 1
                done.append(merge.get("reason") or f"Merged topic {b} into this one.")
                supabase.table("staff_actions").insert({
                    "user_id": by, "role": role, "path": path, "action": "agent:merge_topic",
                    "detail": {"canonical": str(applied[0]["canonical"]), "aliases": ",".join(map(str, applied[0]["aliases"])),
                               "reason": (merge.get("reason") or "")[:400]},
                }).execute()
        except Exception as exc:
            left.append(f"{merge.get('reason') or 'Merging a duplicate topic'} (it didn't work: {exc})")

    for meeting_id in meetings:
        try:
            refresh_meeting_matter_lifecycles(supabase, meeting_id)
        except Exception as exc:
            print(f"  [fix_page] lifecycle refresh for meeting {meeting_id} failed: {exc}")
    summaries = {}
    if touched:
        summaries = refresh_matter_summaries(supabase, sorted(touched))
        if summaries:
            done.append(f"Rewrote the summary of {len(summaries)} {'topic' if len(summaries) == 1 else 'topics'} whose timeline changed.")

    unfollowed = check_summary_notes(supabase, args.get("summary_notes") or [])
    if unfollowed:  # one more rewrite, told exactly what the last one missed
        retry = sorted({u["matter_id"] for u in unfollowed})
        for matter_id in retry:
            meta = supabase.table("matters").select("meta").eq("id", matter_id).single().execute().data.get("meta") or {}
            asks = [f"The last rewrite missed this: {u['missing']}" for u in unfollowed if u["matter_id"] == matter_id and u["missing"]]
            if asks:
                supabase.table("matters").update({"meta": {**meta, "editor_notes": [*(meta.get("editor_notes") or []), *asks]}}).eq("id", matter_id).execute()
        refresh_matter_summaries(supabase, retry)
        unfollowed = check_summary_notes(supabase, [{"matter_id": u["matter_id"], "note": u["note"]} for u in unfollowed])
    if unfollowed:  # the writer still won't: the agent edits the text itself, checked the same way
        for matter_id in sorted({u["matter_id"] for u in unfollowed}):
            if direct_edit(supabase, matter_id, [u["note"] for u in unfollowed if u["matter_id"] == matter_id]):
                done.append("Edited the summary directly, since the summary writer didn't follow the instruction.")
        unfollowed = check_summary_notes(supabase, [{"matter_id": u["matter_id"], "note": u["note"]} for u in unfollowed])
    for u in unfollowed:
        note = u["note"]
        left.append(f"The summary was rewritten but doesn't yet say what was asked: \"{note[:300]}\""
                    + (f" Still missing: {u['missing']}" if u["missing"] else ""))
        done[:] = [d for d in done if note.split(" The record says:")[0][:80] not in d]

    row = supabase.table("page_reviews").select("ai_flags").eq("path", path).maybe_single().execute()
    flags = ((row.data if row else None) or {}).get("ai_flags") or []
    flags = [{**f, "fixed": True} if f.get("key") in fixed_keys else f for f in flags]
    if unfollowed:  # a whole-page problem isn't fixed until its summary instruction is followed
        flags = [{**f, "fixed": False} if not f.get("key") and f.get("verdict") == "agree" else f for f in flags]
    waiting: list[str] = list(args.get("waiting") or [])
    note = "\n\n".join(p for p in [
        "Changed:\n" + "\n".join(f"• {d}" for d in done) if done else "Changed nothing.",
        "Needs a record that isn't on this page:\n" + "\n".join(f"• {d}" for d in waiting) if waiting else "",
        "Needs a person:\n" + "\n".join(f"• {d}" for d in left) if left else "",
    ] if p)
    supabase.table("page_reviews").update({
        "status": "fixed" if done or (waiting and not left) else "needs_work", "agent_note": note,
        "agent_at": datetime.now(timezone.utc).isoformat(), "ai_flags": flags,
    }).eq("path", path).execute()
    return {"moved": len([k for k in fixed_keys if k.startswith("agenda-")]), "merged": merged,
            "summaries": len(summaries), "left": len(left)}


def describe(args: dict) -> str:
    return json.dumps({k: args.get(k) for k in ("path", "moves", "refresh")})[:500]
