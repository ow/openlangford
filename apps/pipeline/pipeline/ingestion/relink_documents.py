"""Link extracted documents to agenda items where the extractor's guess failed.

The extractor matched the model's item-number guess ("6.1a") against agenda
numbering and almost always missed, so ~99% of extracted reports had no
agenda item and were invisible to matters, summaries and search context.
For each unlinked document, the Decisions API picks which of its meeting's
agenda items it belongs to (or none).
"""
from __future__ import annotations

from collections import defaultdict

from supabase import Client

from pipeline import ai

MIN_PROBABILITY = 0.75
PROCEDURAL = ("call to order", "adjourn", "approval of the agenda", "territorial acknowledgement",
              "meeting conduct", "in camera", "closed meeting")


def _paginate(build, page: int = 1000) -> list[dict]:
    rows, start = [], 0
    while True:
        chunk = build().range(start, start + page - 1).execute().data or []
        rows.extend(chunk)
        if len(chunk) < page:
            return rows
        start += page


def _write_link(supabase: Client, extracted_id: int, item_id: int, attempts: int = 3) -> bool:
    """Set the item on a document and its sections. Section updates touch the vector index, so retry on timeouts."""
    import time

    for attempt in range(attempts):
        try:
            supabase.table("document_sections").update({"agenda_item_id": item_id}).eq("extracted_document_id", extracted_id).execute()
            supabase.table("extracted_documents").update({"agenda_item_id": item_id}).eq("id", extracted_id).execute()
            return True
        except Exception as exc:
            if attempt == attempts - 1:
                print(f"  [Relink] doc {extracted_id}: {exc}")
                return False
            time.sleep(2 * (attempt + 1))
    return False


def unlinked_documents(supabase: Client, meeting_ids: list[int] | None = None) -> list[dict]:
    """Extracted documents with no agenda item, optionally only those of the given meetings."""
    select = "id, document_id, title, document_type, summary, documents(meeting_id)"
    if meeting_ids is None:
        return _paginate(
            lambda: supabase.table("extracted_documents").select(select).is_("agenda_item_id", "null").order("id")
        )
    ids = sorted({int(i) for i in meeting_ids})
    doc_ids: list[int] = []
    for start in range(0, len(ids), 50):
        rows = supabase.table("documents").select("id").in_("meeting_id", ids[start : start + 50]).execute().data or []
        doc_ids.extend(r["id"] for r in rows)
    docs: list[dict] = []
    for start in range(0, len(doc_ids), 100):
        chunk = doc_ids[start : start + 100]
        docs.extend(
            supabase.table("extracted_documents").select(select).in_("document_id", chunk)
            .is_("agenda_item_id", "null").order("id").execute().data or []
        )
    return docs


def relink(supabase: Client, *, dry_run: bool = False, limit: int | None = None,
           meeting_ids: list[int] | None = None) -> dict:
    """Link unlinked extracted documents to agenda items (all, or only the given meetings')."""
    docs = unlinked_documents(supabase, meeting_ids)
    if limit:
        docs = docs[:limit]
    meeting_ids = sorted({(d.get("documents") or {}).get("meeting_id") for d in docs} - {None})
    items_by_meeting: dict[int, list[dict]] = defaultdict(list)
    for start in range(0, len(meeting_ids), 50):
        for it in (
            supabase.table("agenda_items")
            .select("id, meeting_id, item_order, title, plain_english_summary")
            .in_("meeting_id", meeting_ids[start : start + 50])
            .execute()
            .data
            or []
        ):
            if not any(p in (it.get("title") or "").lower() for p in PROCEDURAL):
                items_by_meeting[it["meeting_id"]].append(it)

    jobs, job_docs = [], []
    for d in docs:
        items = items_by_meeting.get((d.get("documents") or {}).get("meeting_id")) or []
        if not items:
            continue
        question = ai.choice(
            "item",
            "A document was attached to a council meeting agenda. Which agenda item does it belong to? "
            "Choose 'none' if it is the agenda itself, minutes of this meeting, or fits no item.",
            [(f"i{it['id']}", f"{it.get('item_order') or ''} {it.get('title') or ''} — {it.get('plain_english_summary') or ''}".strip())
             for it in items]
            + [("none", "Not about any single agenda item.")],
        )
        jobs.append((f"DOCUMENT: {d['title']} ({d.get('document_type')})\n{d.get('summary') or ''}", [question]))
        job_docs.append(d)

    linked = skipped = failed = 0
    for start in range(0, len(jobs), 200):
        for d, res in zip(job_docs[start : start + 200], ai.decide_many(jobs[start : start + 200])):
            if isinstance(res, Exception):
                failed += 1
                continue
            ans = res.get("item")
            if ans is None or ans.type != "choice" or ans.choice == "none":
                skipped += 1
                continue
            prob = {p.value: p.probability for p in ans.probabilities}.get(ans.choice, 0)
            if prob < MIN_PROBABILITY:
                skipped += 1
                continue
            item_id = int(ans.choice[1:])
            if not dry_run and not _write_link(supabase, d["id"], item_id):
                failed += 1
                continue
            linked += 1
        print(f"  [Relink] {min(start + 200, len(jobs))}/{len(jobs)} — linked {linked}, skipped {skipped}, failed {failed}")
    return {"documents": len(docs), "judged": len(jobs), "linked": linked, "skipped": skipped, "failed": failed}
