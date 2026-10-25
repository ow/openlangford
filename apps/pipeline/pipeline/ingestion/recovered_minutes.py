"""Recover a meeting's minutes from a LATER meeting's agenda package.

Each Langford agenda package contains the previous meeting's minutes for
adoption. When a meeting has no minutes document of its own, this module finds
the embedded copy (strict heading + date match), cuts those pages into a
standalone PDF in the target meeting's ``Minutes/`` folder (with ``.url`` and
provenance sidecars), and registers it as a ``Minutes`` document.

Nothing here re-runs full ingestion: ``ingest_recovered_minutes`` adds one
documents row, runs the document extractor on that one file and sets
``meetings.has_minutes``. Re-deriving motions/attendance is a separate step.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re

MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sept": 9, "sep": 9,
    "october": 10, "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
}
_MONTH_ALT = "|".join(sorted(MONTHS, key=len, reverse=True))
DATE_RE = re.compile(
    rf"\b({_MONTH_ALT})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\s*,?\s*(\d{{4}})\b", re.IGNORECASE)

_NOT_COUNCIL = re.compile(
    r"committee|board|society|commission|parks and recreation|annual general|\bagm\b|\bwsp?rs\b",
    re.IGNORECASE)
_PARTIAL = re.compile(r"excerpt|extract|opening page|referencing|related to bylaw|page \d+ of \d+", re.IGNORECASE)


def extract_dates(text: str) -> list[dt.date]:
    """All valid 'Month D[th], YYYY' dates in the text, in order."""
    found = []
    for month, day, year in DATE_RE.findall(text or ""):
        try:
            found.append(dt.date(int(year), MONTHS[month.lower()], int(day)))
        except ValueError:
            continue
    return found


def _kind(text: str) -> str:
    lower = (text or "").lower()
    if "special" in lower:
        return "special"
    if "public hearing" in lower:
        return "public_hearing"
    return "regular"


def parse_heading(title: str, fallback_text: str = "") -> dict | None:
    """Describe a 'Minutes of the ... Council' heading, or None if it is not council minutes.

    Returns {kind, dates, partial, date_source}. ``dates`` come from the title; only when the title
    has none do we look at ``fallback_text`` (the first lines of the extracted document).
    """
    title = (title or "").strip()
    lower = title.lower()
    if "minutes" not in lower or _NOT_COUNCIL.search(title):
        return None
    if "council" not in lower and "public hearing" not in lower:
        return None
    dates = extract_dates(title)
    source = "title"
    if not dates and fallback_text:
        dates = extract_dates(fallback_text[:600])
        source = "text"
    return {"kind": _kind(title), "dates": dates, "partial": bool(_PARTIAL.search(title)),
            "date_source": source}


def target_kinds(meeting_type: str, meeting_title: str = "") -> set[str]:
    """Heading kinds acceptable for a target meeting (type and title can disagree, e.g. a 'Special Council'
    row titled 'Public Hearing')."""
    return {_kind(meeting_type)} | ({_kind(meeting_title)} if meeting_title else set())


def match_heading(heading: dict | None, target_date: dt.date, kinds: set[str]) -> str | None:
    """'high' (date equal and kind compatible), 'low' (date equal, kind differs), or None.

    The date must be the ONLY date in the heading and equal the target date; partial/excerpt headings never match.
    """
    if not heading or heading["partial"] or not heading["dates"]:
        return None
    if set(heading["dates"]) != {target_date}:
        return None
    return "high" if heading["kind"] in kinds else "low"


def choose_best(candidates: list[dict]) -> dict | None:
    """Prefer high confidence, then the earliest later meeting, then the longest page span."""
    if not candidates:
        return None
    return sorted(candidates, key=lambda c: (c["confidence"] != "high", c["source_meeting_date"],
                                             -(c["page_end"] - c["page_start"])))[0]


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_candidates(cur, meeting: dict) -> list[dict]:
    """Strict search of LATER meetings' agenda packages for this meeting's minutes (read-only).

    ``cur`` is a DB-API cursor; ``meeting`` has id, meeting_date (date), type, title.
    """
    cur.execute(
        """select e.id, e.title, e.page_start, e.page_end, d.id, d.title, d.file_path, d.source_url,
                  m.id, m.meeting_date, m.archive_path,
                  (select s.section_text from document_sections s where s.extracted_document_id = e.id
                   order by s.section_order limit 1)
           from extracted_documents e
           join documents d on d.id = e.document_id
           join meetings m on m.id = d.meeting_id
           where m.meeting_date > %s and m.id <> %s and d.file_path ilike 'Agenda/%%'
             and (e.document_type = 'minutes' or e.title ilike '%%minutes%%')
           order by m.meeting_date, e.page_start""",
        (meeting["meeting_date"], meeting["id"]))
    kinds = target_kinds(meeting.get("type") or "", meeting.get("title") or "")
    out = []
    for (ext_id, title, p0, p1, doc_id, doc_title, file_path, source_url, src_meeting, src_date,
         archive_path, first_text) in cur.fetchall():
        confidence = match_heading(parse_heading(title, first_text or ""), meeting["meeting_date"], kinds)
        if not confidence or not p0 or not p1:
            continue
        out.append({"extracted_document_id": ext_id, "heading": title, "page_start": p0, "page_end": p1,
                    "source_document_id": doc_id, "source_document_title": doc_title,
                    "source_file_path": file_path, "source_url": source_url,
                    "source_meeting_id": src_meeting, "source_meeting_date": src_date,
                    "source_archive_path": archive_path, "confidence": confidence})
    return out


def recovered_filename(source_pdf_name: str, page_start: int, page_end: int) -> str:
    stem = os.path.splitext(os.path.basename(source_pdf_name))[0]
    return f"recovered-from-{stem}-p{page_start}-{page_end}.pdf"


def extract_pages(src_pdf: str, page_start: int, page_end: int, dst_pdf: str) -> int:
    """Copy 1-based inclusive pages into a new PDF (PyMuPDF). Returns the page count written."""
    import fitz

    with fitz.open(src_pdf) as src:
        if page_start < 1 or page_end > len(src) or page_start > page_end:
            raise ValueError(f"pages {page_start}-{page_end} outside {src_pdf} ({len(src)} pages)")
        with fitz.open() as out:
            out.insert_pdf(src, from_page=page_start - 1, to_page=page_end - 1)
            os.makedirs(os.path.dirname(dst_pdf), exist_ok=True)
            out.save(dst_pdf, garbage=3, deflate=True)
            return len(out)


def recover_pdf(meeting_folder: str, candidate: dict, repo_root: str) -> dict:
    """Write the recovered PDF + .url + provenance JSON under ``<meeting_folder>/Minutes``."""
    source_folder = candidate["source_archive_path"]
    if not os.path.isabs(source_folder):
        source_folder = os.path.join(repo_root, source_folder)
    src_pdf = os.path.join(source_folder, candidate["source_file_path"])
    if not os.path.exists(src_pdf):
        raise FileNotFoundError(src_pdf)
    name = recovered_filename(src_pdf, candidate["page_start"], candidate["page_end"])
    dst = os.path.join(meeting_folder, "Minutes", name)
    pages = extract_pages(src_pdf, candidate["page_start"], candidate["page_end"], dst)
    if candidate.get("source_url"):
        with open(dst + ".url", "w", encoding="utf-8") as handle:
            handle.write(candidate["source_url"] + "\n")
    provenance = {
        "recovered_file": name,
        "sha256": sha256_file(dst),
        "pages_written": pages,
        "source_document_id": candidate["source_document_id"],
        "source_meeting_id": candidate["source_meeting_id"],
        "source_file": candidate["source_file_path"],
        "source_pdf_sha256": sha256_file(src_pdf),
        "source_url": candidate.get("source_url"),
        "source_pages": [candidate["page_start"], candidate["page_end"]],
        "heading": candidate["heading"],
        "confidence": candidate["confidence"],
        "recovered_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }
    with open(dst + ".provenance.json", "w", encoding="utf-8") as handle:
        json.dump(provenance, handle, indent=2, default=str)
    return {"path": dst, **provenance}


def ingest_recovered_minutes(supabase, meeting: dict, pdf_path: str, *, municipality_id: int = 1,
                             dry_run: bool = False, extract=None) -> dict:
    """Add the Minutes documents row for a recovered PDF, extract it, and set has_minutes. Idempotent."""
    import fitz

    from pipeline.ingestion.letter_privacy import scrub_emails

    folder = os.path.dirname(os.path.dirname(pdf_path))
    rel = os.path.relpath(pdf_path, folder)
    file_hash = sha256_file(pdf_path)
    stats = {"document_id": None, "created": False, "extracted": False}
    existing = (supabase.table("documents").select("id,file_hash").eq("meeting_id", meeting["id"])
                .eq("file_path", rel).limit(1).execute().data)
    if existing and existing[0].get("file_hash") == file_hash:
        doc_id = existing[0]["id"]
    else:
        if dry_run:
            stats["created"] = True
            return stats
        with fitz.open(pdf_path) as pdf:
            text = "\n".join(page.get_text() for page in pdf).strip()
            page_count = len(pdf)
        source_url = None
        if os.path.exists(pdf_path + ".url"):
            with open(pdf_path + ".url", encoding="utf-8") as handle:
                source_url = handle.read().strip() or None
        record = {"meeting_id": meeting["id"], "title": os.path.splitext(os.path.basename(pdf_path))[0],
                  "category": "Minutes", "source_url": source_url, "file_path": rel, "file_hash": file_hash,
                  "full_text": scrub_emails(text) if text else None, "page_count": page_count,
                  "municipality_id": municipality_id}
        doc_id = supabase.table("documents").upsert(record, on_conflict="meeting_id,file_path").execute().data[0]["id"]
        stats["created"] = True
    stats["document_id"] = doc_id
    if dry_run:
        return stats
    already = (supabase.table("extracted_documents").select("id", count="exact")
               .eq("document_id", doc_id).limit(1).execute().count)
    if not already:
        if extract is None:
            from pipeline.ingestion.document_extractor import extract_and_store_documents as extract
        extract(pdf_path, doc_id, meeting["id"], supabase, municipality_id)
        stats["extracted"] = True
    supabase.table("meetings").update({"has_minutes": True}).eq("id", meeting["id"]).execute()
    return stats
