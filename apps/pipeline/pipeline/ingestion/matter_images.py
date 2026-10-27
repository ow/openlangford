"""Pick a lead picture (and a layout plan) for a matter from its staff reports.

The extractor already stores every image in report PDFs (document_images, R2),
but its descriptions are unreliable ("Renderings of Proposed Design" can be a
generic planning sketch). Each candidate is judged visually with the Decisions
API: what kind of picture it is, and whether it's sideways.

Lead preference: a rendering of what would be built, else a photo of the site
today, else an aerial or map showing where it is, else the site plan. The site plan is also kept
separately as the "layout" image for the application step.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import httpx
from supabase import Client

from pipeline import ai

# Bump when judging/selection changes; stamped in matters.meta.images_version.
IMAGES_VERSION = "1"

IMAGE_BASE = "https://pub-62dc9711e31a49c39b0544c981bf613e.r2.dev/viewroyal-document-images"
MIN_W, MIN_H, MIN_BYTES = 400, 250, 20_000
MAX_CANDIDATES = 24

# Lead preference, best first. Captions on the web say "What's proposed", "The site today", etc.
LEAD_ORDER = ["rendering", "site_photo", "location", "site_plan"]
KIND_QUESTION = {
    "type": "choice",
    "name": "kind",
    "instructions": "This image comes from a city staff report about the matter described. What kind of picture is it?",
    "choices": [
        {"value": "useless", "description": "Logo, signature, table, form, chart, mostly text, or blank."},
        {"value": "generic", "description": "Generic diagram, policy or zoning map not specific to this site."},
        {"value": "location", "description": "Aerial photo or map that clearly shows where this specific site is."},
        {"value": "site_plan", "description": "Site plan, subdivision or lot layout for this proposal."},
        {"value": "rendering", "description": "Rendering, elevation or streetscape drawing of what would be built."},
        {"value": "site_photo", "description": "Photograph of the site or building as it is now."},
    ],
}
SIDEWAYS_QUESTION = {
    "type": "predicate",
    "name": "sideways",
    "instructions": "Is this image rotated sideways or upside down, so its text and drawing don't read upright?",
}


def _candidate_images(supabase: Client, matter_id: int) -> list[dict]:
    matter = supabase.table("matters").select("id, meta").eq("id", matter_id).single().execute().data
    ids = [matter_id] + list((matter.get("meta") or {}).get("merged_matter_ids") or [])
    items = supabase.table("agenda_items").select("id, meeting_id").in_("matter_id", ids).execute().data or []
    if not items:
        return []
    meeting_of = {i["id"]: i["meeting_id"] for i in items}
    docs = (
        supabase.table("extracted_documents")
        .select("id, document_id, agenda_item_id, title")
        .in_("agenda_item_id", list(meeting_of))
        .execute()
        .data
        or []
    )
    if not docs:
        return []
    doc_of = {d["id"]: d for d in docs}
    images = (
        supabase.table("document_images")
        .select("id, extracted_document_id, r2_key, page, width, height, file_size")
        .in_("extracted_document_id", list(doc_of))
        .execute()
        .data
        or []
    )
    seen: set[tuple] = set()
    out = []
    for img in sorted(images, key=lambda i: -(i.get("file_size") or 0)):
        if (img.get("width") or 0) < MIN_W or (img.get("height") or 0) < MIN_H or (img.get("file_size") or 0) < MIN_BYTES:
            continue
        key = (img.get("width"), img.get("height"), img.get("file_size"))  # same picture repeated across packages
        if key in seen:
            continue
        seen.add(key)
        doc = doc_of[img["extracted_document_id"]]
        out.append(
            {
                **img,
                "agenda_item_id": doc["agenda_item_id"],
                "document_id": doc["document_id"],
                "meeting_id": meeting_of.get(doc["agenda_item_id"]),
                "report_title": doc.get("title"),
            }
        )
    return out[:MAX_CANDIDATES]


def _judge(img: dict, context: str) -> dict | None:
    try:
        data = httpx.get(f"{IMAGE_BASE}/{img['r2_key']}", timeout=httpx.Timeout(connect=10, read=30, write=30, pool=10)).content
        answers = ai.decide(
            context,
            [KIND_QUESTION, SIDEWAYS_QUESTION],
            images=[{"data": data, "mime_type": "image/webp"}],
        )
    except Exception as exc:
        print(f"  [Images] {img['r2_key']}: {exc}")
        return None
    kind = answers.get("kind")
    sideways = answers.get("sideways")
    if kind is None or kind.type != "choice":
        return None
    return {
        **img,
        "kind": kind.choice,
        "confidence": {p.value: p.probability for p in kind.probabilities}.get(kind.choice, 0),
        "sideways": (getattr(sideways, "probability", 0) or 0) >= 0.5,
    }


def pick_matter_images(supabase: Client, matter_id: int, *, dry_run: bool = False) -> dict:
    matter = supabase.table("matters").select("id, title, meta, plain_english_summary").eq("id", matter_id).single().execute().data
    meta = matter.get("meta") or {}
    context = f"Matter: {meta.get('display_title') or matter['title']}. {matter.get('plain_english_summary') or ''}"
    candidates = _candidate_images(supabase, matter_id)
    if not candidates:
        # Stamp it so --stale doesn't keep revisiting matters with nothing to judge.
        if not dry_run and meta.get("images_version") != IMAGES_VERSION:
            stamped = dict(meta)
            stamped["images_version"] = IMAGES_VERSION
            supabase.table("matters").update({"meta": stamped}).eq("id", matter_id).execute()
        return {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        judged = [j for j in pool.map(lambda c: _judge(c, context), candidates) if j and not j["sideways"]]

    def best(kind: str) -> dict | None:
        pool_ = [j for j in judged if j["kind"] == kind and j["confidence"] >= 0.6]
        return max(pool_, key=lambda j: (j["confidence"], j["width"] * j["height"]), default=None)

    site_plan = best("site_plan")
    lead = next((b for b in (best(k) for k in LEAD_ORDER) if b), None)
    keep = lambda j: j and {k: j[k] for k in ("r2_key", "kind", "width", "height", "page", "agenda_item_id", "document_id", "meeting_id", "report_title")}
    images = {"lead": keep(lead)} if lead else {}
    if site_plan and site_plan is not lead:
        images["layout"] = keep(site_plan)
    if not dry_run:
        new_meta = dict(meta)
        new_meta["images_version"] = IMAGES_VERSION
        if images:
            new_meta["images"] = images
        else:
            new_meta.pop("images", None)
        supabase.table("matters").update({"meta": new_meta}).eq("id", matter_id).execute()
    return images
