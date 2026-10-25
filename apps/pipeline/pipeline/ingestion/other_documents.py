"""Ingest residents' letters filed under a meeting's "Other Documents" folder.

CivicWeb published late submissions and addendum correspondence as separate
files next to the agenda ("Late Submission Bylaw No. 1965.pdf", "Addendum
Correspondence Z21-0013.pdf"). The ingester only reads Agenda/Minutes, so
these were never in the database. Dial-in instructions, notices and other
logistics in the same folder are left alone.
"""
from __future__ import annotations

import hashlib
import os
import re

OTHER_DIR = "Other Documents"
LETTERS = re.compile(r"correspond|submission|letter|petition|comment|feedback|input", re.I)
NOT_LETTERS = re.compile(r"dial[- ]?in|notice|cancell|postpone|occupancy|reopening|chambers|presentation|budget", re.I)


def letter_files(meeting_folder: str) -> list[str]:
    folder = os.path.join(meeting_folder, OTHER_DIR)
    if not os.path.isdir(folder):
        return []
    return sorted(
        os.path.join(folder, name) for name in os.listdir(folder)
        if name.lower().endswith(".pdf") and LETTERS.search(name) and not NOT_LETTERS.search(name)
    )


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(8192), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ingest_meeting_letters(supabase, meeting: dict, base_dir: str, *, municipality_id: int = 1,
                           dry_run: bool = False, extract=None) -> dict:
    """Create document rows for a meeting's letter files and extract them. Returns counts."""
    folder = meeting["archive_path"] if os.path.isabs(meeting["archive_path"]) else os.path.join(base_dir, meeting["archive_path"])
    files = letter_files(folder)
    stats = {"files": len(files), "new": 0, "extracted": 0}
    for path in files:
        rel = os.path.relpath(path, folder)
        file_hash = _sha256(path)
        existing = (supabase.table("documents").select("id,file_hash").eq("meeting_id", meeting["id"])
                    .eq("file_path", rel).limit(1).execute().data)
        if existing and existing[0].get("file_hash") == file_hash:
            already = (supabase.table("extracted_documents").select("id", count="exact")
                       .eq("document_id", existing[0]["id"]).limit(1).execute().count)
            if already:
                continue
            doc_id = existing[0]["id"]
        else:
            if dry_run:
                stats["new"] += 1
                continue
            source_url = None
            if os.path.exists(path + ".url"):
                with open(path + ".url", encoding="utf-8") as handle:
                    source_url = handle.read().strip() or None
            record = {"meeting_id": meeting["id"], "title": os.path.splitext(os.path.basename(path))[0],
                      "category": "Attachment", "source_url": source_url, "file_path": rel,
                      "file_hash": file_hash, "municipality_id": municipality_id}
            doc_id = supabase.table("documents").upsert(record, on_conflict="meeting_id,file_path").execute().data[0]["id"]
            stats["new"] += 1
        if dry_run:
            continue
        if extract is None:
            from pipeline.ingestion.document_extractor import extract_and_store_documents as extract
        try:
            extract(path, doc_id, meeting["id"], supabase, municipality_id)
            stats["extracted"] += 1
        except Exception as error:
            print(f"  [!] extraction failed for {rel}: {error}")
    return stats
