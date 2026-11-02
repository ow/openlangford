"""Page fixes staff asked for, run by the quick worker (job ``fix_page``).

Marking a topic page "needs work" in the site's review bar starts the fix agent on the site
(apps/web/app/services/page-fix.server.ts). It removes wrong links itself, then queues this job for what needs the
pipeline: moving an agenda item filed under the wrong topic (or, when no listed topic fits, re-filing it the way
ingest files an item, never back onto the topic it left), and rewriting the summaries of the topics whose timelines
changed, then checking that each summary instruction staff approved was actually followed. When this finishes, the
page is "fixed" for staff to confirm.

A moved item carries a lock, ``agenda_items.meta.staff_matter`` ({"matter_id", "by", "at", "reason"}), which the
ingester and the history step respect: re-processing a meeting never files it back.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field


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
        target = supabase.table("matters").select("id, meta").eq("id", to_matter_id).single().execute().data
        canonical = (target.get("meta") or {}).get("canonical_matter_id")
        to_matter_id = int(canonical) if canonical else to_matter_id
    meta = {**(item.get("meta") or {}), "staff_matter": {
        "matter_id": to_matter_id, "by": by, "at": datetime.now(timezone.utc).isoformat(), "reason": reason[:300],
        "from": item.get("matter_id"),
    }}
    supabase.table("agenda_items").update({"matter_id": to_matter_id, "meta": meta}).eq("id", item_id).execute()
    # The item's addresses go with it, so the old topic's map and property pages drop them now (the properties
    # stage would also catch up, on its next run).
    supabase.table("property_links").update({"matter_id": to_matter_id}).eq("agenda_item_id", item_id).execute()
    return {"from": item.get("matter_id"), "to": to_matter_id, "meeting_id": item["meeting_id"]}


def refile_target(supabase, item_id: int) -> int | None:
    """Where ingest would file this item if it weren't on its current topic (never that topic): an existing topic
    for its permit, bylaw or address, a new one, or none for a heading."""
    from pipeline.ingestion.topic_regroup import refile

    item = supabase.table("agenda_items").select("matter_id").eq("id", item_id).single().execute().data
    results = refile(supabase, [{"item": item_id, "from": item.get("matter_id")}], dry_run=False, log=lambda *_: None)
    target = results[0].get("to") if results else None
    return int(target) if isinstance(target, int) else None


class _NoteCheck(BaseModel):
    followed: bool = Field(description="True when the summary or status says what the instruction asks (or leaves out what it says to leave out).")


def check_summary_notes(supabase, notes: list[dict]) -> list[str]:
    """The approved summary instructions the rewritten summary doesn't follow."""
    from pipeline import ai

    unfollowed = []
    for entry in notes:
        matter = supabase.table("matters").select("plain_english_summary, meta").eq("id", int(entry["matter_id"])).single().execute().data
        canonical = (matter.get("meta") or {}).get("canonical_matter_id")
        if canonical:  # merged away during this fix: the page now shows the topic it was merged into
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
            unfollowed.append(entry["note"])
            continue
        if not verdict.followed:
            unfollowed.append(entry["note"])
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

    for move in args.get("moves") or []:
        item_id, to = int(move["item_id"]), move.get("to_matter_id")
        try:
            if move.get("refile") and to is None:
                origin = supabase.table("agenda_items").select("matter_id").eq("id", item_id).single().execute().data.get("matter_id")
                to = refile_target(supabase, item_id)
                touched.update(m for m in (origin,) if m)
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

    from pipeline.ingestion.matter_resolver import apply_merges

    for merge in args.get("merges") or []:
        a, b = int(merge["matter_id"]), int(merge["with_matter_id"])
        try:
            applied = apply_merges(supabase, [[a, b]], reason="staff")
            if applied:
                touched.add(applied[0]["canonical"])
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
    for note in unfollowed:
        left.append(f"The summary was rewritten but doesn't yet say what was asked: \"{note[:300]}\"")
        done[:] = [d for d in done if note.split(" The record says:")[0][:80] not in d]

    row = supabase.table("page_reviews").select("ai_flags").eq("path", path).maybe_single().execute()
    flags = ((row.data if row else None) or {}).get("ai_flags") or []
    flags = [{**f, "fixed": True} if f.get("key") in fixed_keys else f for f in flags]
    if unfollowed:  # a whole-page problem isn't fixed until its summary instruction is followed
        flags = [{**f, "fixed": False} if not f.get("key") and f.get("verdict") == "agree" else f for f in flags]
    waiting: list[str] = list(args.get("waiting") or [])
    note = "\n\n".join(p for p in [
        "Changed:\n" + "\n".join(f"• {d}" for d in done) if done else "Changed nothing.",
        "Waiting on records (being recovered; the fix can be redone then):\n" + "\n".join(f"• {d}" for d in waiting) if waiting else "",
        "Needs a person:\n" + "\n".join(f"• {d}" for d in left) if left else "",
    ] if p)
    supabase.table("page_reviews").update({
        "status": "fixed" if done or (waiting and not left) else "needs_work", "agent_note": note,
        "agent_at": datetime.now(timezone.utc).isoformat(), "ai_flags": flags,
    }).eq("path", path).execute()
    return {"moved": len(fixed_keys), "summaries": len(summaries), "left": len(left)}


def describe(args: dict) -> str:
    return json.dumps({k: args.get(k) for k in ("path", "moves", "refresh")})[:500]
