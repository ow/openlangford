"""Local-context document extraction.

Uses text/layout packages produced locally from PDFs as the primary AI context.
Provider PDF reads remain fallback behavior in ``pdf_extractor``.
"""

from __future__ import annotations

import logging

from pipeline import ai
from pipeline.ingestion.pdf_extractor import (
    CONTENT_WITH_IMAGES_PROMPT,
    DocumentBoundaries,
    _dedup_overlapping_boundaries,
    boundaries_from_result,
)
from pipeline.ingestion.local_pdf_package import (
    PdfPackage,
    package_for_prompt,
    pages_fitting,
    range_text,
)

logger = logging.getLogger(__name__)


LOCAL_BOUNDARY_PROMPT = """You are analyzing locally extracted text from a municipal council agenda/minutes PDF.

The text is grouped by page and may include quality flags such as good_text, sparse_text,
image_dominant, table_like, or scanned_or_ocr_needed. Image IDs indicate visual assets
extracted locally from that page.

Identify every distinct document in this PDF and return one entry in `documents` for each:

{{
  "title": "Document title/heading as it appears",
  "page_start": 1,
  "page_end": 5,
  "type": "staff_report",
  "agenda_item": "6.1a",
  "summary": "1-2 sentence summary of what this document is about",
  "key_facts": ["dollar amounts", "addresses", "dates", "decisions"]
}}

Rules:
- type must be one of agenda, minutes, staff_report, delegation, correspondence, appendix, bylaw, presentation, form, other.
- agenda_item is the agenda item number this document relates to, or null.
- Page ranges must be precise and must not overlap.
- Prefer granular child documents over one parent that spans many attachments.
- If the PDF is a standalone agenda, minutes, or cover page, return one boundary covering the whole PDF.
- Use quality flags to avoid over-trusting weak OCR-like pages, but still return best-effort ranges.

LOCAL PDF PACKAGE:
{package_text}
"""


LOCAL_CONTENT_PROMPT = """Convert locally extracted PDF text into clean, structured Markdown for this document.

Document title: {title}
Page range: {page_start}-{page_end}

Instructions:
- Use ## for main headings and ### for sub-headings.
- Preserve staff recommendations verbatim when present.
- Preserve dollar amounts, dates, addresses, bylaw numbers, names, and motion text exactly.
- Render table-like text as readable markdown where possible.
- Skip repeated headers, footers, page numbers, and watermarks when obvious.
- Where an image is referenced by the page package, insert [Image N: brief description] if the surrounding text makes its purpose clear.
- Do not invent facts that are not present in the local text.
- Return ONLY Markdown, no commentary.

LOCAL PAGE TEXT:
{page_text}

LOCAL PAGE/IMAGE CONTEXT:
{package_text}
"""


WINDOW_NOTE = """This PDF has {page_count} pages; you are shown pages {page_start}-{page_end} of it. Return only
documents that start within these pages. If a document clearly runs past page {page_end}, give its true page_end
when the text shows it; otherwise end it at page {page_end}.

"""


def detect_boundaries_from_package(
    package: PdfPackage,
    *,
    max_page_chars: int = 1600,
    max_total_chars: int = 70000,
) -> list[dict]:
    """Detect document boundaries from local text/page context.

    One prompt holds about `max_total_chars` of page text, which a text-dense 600-page agenda package exceeds by
    page 50 or so; the model then only ever saw the first window and the rest of the package stayed unsectioned
    (2026-11-07: 23 packages cut off around page 60). So the package is walked in windows: each prompt shows the
    pages that fit, the next window starts after the last complete document (a document the model ended at the
    window's edge is looked at again whole), until the last page is covered.
    """
    if not package.has_usable_text:
        logger.info("Local package has insufficient text for boundary detection")
        return []

    n = package.page_count
    found_all: list[dict] = []
    start = 1
    windows = 0
    while start <= n:
        end = pages_fitting(package, start, max_page_chars=max_page_chars, max_total_chars=max_total_chars)
        windows += 1
        package_text = package_for_prompt(
            package, page_start=start, page_end=end, max_page_chars=max_page_chars, max_total_chars=max_total_chars,
        )
        if windows > 1 or end < n:
            package_text = WINDOW_NOTE.format(page_count=n, page_start=start, page_end=end) + package_text
        prompt = LOCAL_BOUNDARY_PROMPT.format(package_text=package_text)
        try:
            result = ai.json(prompt, stage="document", schema=DocumentBoundaries)
        except ai.AIError as exc:
            if not found_all:
                logger.warning("Local boundary detection failed (falling back to PDF read): %s", exc)
                return []
            logger.warning("Local boundary detection stopped at page %d of %d: %s", start - 1, n, exc)
            break
        found = sorted(
            (b for b in boundaries_from_result(result) if start <= b["page_start"] <= end),
            key=lambda b: b["page_start"],
        )
        for b in found:
            b["page_end"] = min(b["page_end"], n)
        if end >= n:
            found_all.extend(found)
            break
        # A document the model ended at the window's edge may continue past it: see it whole in the next window.
        if found and found[-1]["page_end"] >= end and found[-1]["page_start"] > start:
            next_start = found[-1]["page_start"]
            found = found[:-1]
        else:
            next_start = max((b["page_end"] for b in found), default=end) + 1
        found_all.extend(found)
        if next_start <= start:
            next_start = end + 1
        start = next_start
    if windows > 1:
        logger.info("Boundary detection took %d windows for %d pages of %s", windows, n, package.file_name)
    return _dedup_overlapping_boundaries(found_all)


def extract_content_from_package(
    package: PdfPackage,
    page_start: int,
    page_end: int,
    doc_title: str = "",
    images: list[dict] | None = None,
) -> str:
    """Extract Markdown content from local page text and image context."""
    pages = package.pages_in_range(page_start, page_end)
    page_text = range_text(package, page_start, page_end)
    if not page_text:
        logger.info(
            "Local package has no page text for content pages %d-%d",
            page_start,
            page_end,
        )
        return ""

    # Very large documents are better inserted as local markdown than sent as a
    # giant prompt that recreates the old context-window problem.
    if len(page_text) > 90000:
        logger.info(
            "Local page text for '%s' is %d chars; using direct local markdown",
            doc_title[:50] if doc_title else "untitled",
            len(page_text),
        )
        return _local_markdown_fallback(doc_title, page_text, images)

    package_text = package_for_prompt(
        package,
        page_start=page_start,
        page_end=page_end,
        max_page_chars=2200,
        max_total_chars=50000,
    )
    if images:
        image_instruction = CONTENT_WITH_IMAGES_PROMPT.format(
            page_start=page_start,
            page_end=page_end,
            n_images=len(images),
        )
        package_text = f"{package_text}\n\nIMAGE INSTRUCTIONS:\n{image_instruction}"

    prompt = LOCAL_CONTENT_PROMPT.format(
        title=doc_title or "Untitled document",
        page_start=page_start,
        page_end=page_end,
        page_text=page_text,
        package_text=package_text,
    )
    try:
        text = ai.text(prompt, stage="document")
    except ai.AIError as exc:
        logger.warning("Local content extraction failed for '%s': %s", doc_title, exc)
        return _local_markdown_fallback(doc_title, page_text, images)

    return (text or "").strip() or _local_markdown_fallback(doc_title, page_text, images)


def package_needs_pdf_fallback(
    package: PdfPackage,
    page_start: int,
    page_end: int,
) -> bool:
    """Return True when local text quality is weak for a page range."""
    pages = package.pages_in_range(page_start, page_end)
    if not pages:
        return True
    words = sum(page.quality.word_count for page in pages)
    if words < 20:
        return True
    weak_pages = [
        page
        for page in pages
        if page.quality.label in {"scanned_or_ocr_needed", "empty"}
    ]
    return bool(weak_pages) and len(weak_pages) >= max(1, len(pages) // 2)


def _local_markdown_fallback(
    doc_title: str,
    page_text: str,
    images: list[dict] | None,
) -> str:
    heading = doc_title.strip() or "Document Content"
    image_note = ""
    if images:
        image_note = "\n\n" + "\n".join(
            f"[Image {idx}: extracted visual asset on page {img.get('page', '?')}]"
            for idx, img in enumerate(images, 1)
        )
    return f"## {heading}\n\n{page_text.strip()}{image_note}".strip()
