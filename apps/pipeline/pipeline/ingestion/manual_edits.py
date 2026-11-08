"""Fields staff edited by hand (the web review bar's edit panel, and the fix agent on a meeting page).

``matters.meta.manual`` lists them: ``{field: {by, at, auto}, items: [...]}`` for the fields ``title``
(``meta.display_title``), ``summary`` (``plain_english_summary``), ``status_line`` (``meta.status_line``) and
``image`` (``meta.images.lead``). A writer never replaces an edited field: it keeps the person's value and stores
its own new version as ``auto``, which "Reset to automatic" on the page puts back. See
apps/web/app/services/topic-edit.server.ts.

The same convention protects a meeting page's text the fix agent edited (apps/web/app/services/meeting-fix.server.ts):
``agenda_items.meta.manual.summary`` for an item's ``plain_english_summary``, and ``meetings.meta.manual.highlights``
for ``meta.highlights`` (bullets, links and description together). Writers go through ``keep_manual_text`` and
``keep_manual_highlights`` so a re-ingest or a highlights run keeps the person's text and stores its own as ``auto``.
"""

from __future__ import annotations

from supabase import Client


def _fresh(supabase: Client, matter_id: int) -> dict:
    """The stored row now: the edit may have been saved while this run was working."""
    return (supabase.table("matters").select("plain_english_summary, meta").eq("id", matter_id).single().execute().data) or {}


def keep_text_edits(supabase: Client, matter_id: int, update: dict) -> dict:
    """An update to a topic's title, summary or status line, with any hand-edited field kept as the person left it."""
    row = _fresh(supabase, matter_id)
    stored = row.get("meta") or {}
    manual = stored.get("manual") or {}
    if not any(f in manual for f in ("title", "summary", "status_line")):
        return update
    out = dict(update)
    meta = dict(out.get("meta") or stored)
    manual = dict(manual)
    for field, key in (("title", "display_title"), ("status_line", "status_line")):
        if field in manual and key in meta:
            manual[field] = {**manual[field], "auto": meta.get(key)}
            meta[key] = stored.get(key)
    if "summary" in manual and "plain_english_summary" in out:
        manual["summary"] = {**manual["summary"], "auto": out["plain_english_summary"]}
        out["plain_english_summary"] = row.get("plain_english_summary")
    meta["manual"] = manual
    out["meta"] = meta
    return out


def keep_image_edit(supabase: Client, matter_id: int, meta: dict) -> dict:
    """New ``meta`` from the picture picker, with a hand-picked feature photo kept (the layout plan still updates)."""
    stored = (_fresh(supabase, matter_id).get("meta") or {})
    manual = stored.get("manual") or {}
    if "image" not in manual:
        return meta
    out = dict(meta)
    images = dict(out.get("images") or {})
    picked = images.pop("lead", None)
    chosen = (stored.get("images") or {}).get("lead")
    if chosen:
        images["lead"] = chosen
    if images:
        out["images"] = images
    else:
        out.pop("images", None)
    out["manual"] = {**manual, "image": {**manual["image"], "auto": picked}}
    return out


def keep_manual_text(stored_meta: dict | None, update: dict, fields: dict[str, str]) -> dict:
    """``update`` for a row whose ``meta.manual`` may lock some of its text columns: ``fields`` maps each manual
    field name to its column ("summary" -> "plain_english_summary"). A locked column is left out of the update and
    the writer's value kept as ``manual.<field>.auto``; ``update["meta"]`` (or the stored meta) carries the lock on.
    A column the update doesn't set is untouched. Pure: safe on any row."""
    manual = dict((stored_meta or {}).get("manual") or {})
    locked = {field: column for field, column in fields.items() if field in manual and column in update}
    if not locked:
        return update
    out = dict(update)
    for field, column in locked.items():
        manual[field] = {**manual[field], "auto": out.pop(column)}
    meta = dict(out.get("meta") or stored_meta or {})
    meta["manual"] = manual
    out["meta"] = meta
    return out


def keep_manual_highlights(meta: dict, highlights: dict | None) -> dict:
    """A meeting's new ``meta`` after the highlights stage, when a person edited the highlights by hand
    (``meta.manual.highlights``): theirs stay, the stage's go to ``manual.highlights.auto``. Pure."""
    manual = dict(meta.get("manual") or {})
    if "highlights" not in manual:
        out = dict(meta)
        if highlights is None:
            out.pop("highlights", None)
        else:
            out["highlights"] = highlights
        return out
    return {**meta, "manual": {**manual, "highlights": {**manual["highlights"], "auto": highlights}}}
