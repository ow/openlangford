"""Page fixes staff asked for, run by the quick worker (job ``fix_page``).

Marking a topic page "needs work" in the site's review bar starts the fix agent on the site
(apps/web/app/services/page-fix.server.ts). It removes wrong links itself, then queues this job for what needs the
pipeline: moving an agenda item filed under the wrong topic, and rewriting the summaries of the topics whose
timelines changed. When this finishes, the page is "fixed" for staff to confirm.

A moved item carries a lock, ``agenda_items.meta.staff_matter`` ({"matter_id", "by", "at", "reason"}), which the
ingester and the history step respect: re-processing a meeting never files it back.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any


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
    return {"from": item.get("matter_id"), "to": to_matter_id, "meeting_id": item["meeting_id"]}


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

    row = supabase.table("page_reviews").select("ai_flags").eq("path", path).maybe_single().execute()
    flags = ((row.data if row else None) or {}).get("ai_flags") or []
    flags = [{**f, "fixed": True} if f.get("key") in fixed_keys else f for f in flags]
    note = "\n\n".join(p for p in [
        "Changed:\n" + "\n".join(f"• {d}" for d in done) if done else "Changed nothing.",
        "Needs a person:\n" + "\n".join(f"• {d}" for d in left) if left else "",
    ] if p)
    supabase.table("page_reviews").update({
        "status": "fixed" if done else "needs_work", "agent_note": note,
        "agent_at": datetime.now(timezone.utc).isoformat(), "ai_flags": flags,
    }).eq("path", path).execute()
    return {"moved": len(fixed_keys), "summaries": len(summaries), "left": len(left)}


def describe(args: dict) -> str:
    return json.dumps({k: args.get(k) for k in ("path", "moves", "refresh")})[:500]
