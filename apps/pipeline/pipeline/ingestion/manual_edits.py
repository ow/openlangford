"""Topic fields staff edited by hand (the web review bar's edit panel).

``matters.meta.manual`` lists them: ``{field: {by, at, auto}, items: [...]}`` for the fields ``title``
(``meta.display_title``), ``summary`` (``plain_english_summary``), ``status_line`` (``meta.status_line``) and
``image`` (``meta.images.lead``). A writer never replaces an edited field: it keeps the person's value and stores
its own new version as ``auto``, which "Reset to automatic" on the page puts back. See
apps/web/app/services/topic-edit.server.ts.
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
