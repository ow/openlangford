"""Local PDF packaging for document extraction.

Builds a compact, deterministic page package from a PDF using PyMuPDF. This is
the default context source for local-first extraction; provider PDF reads remain
available as fallback for weak local extraction.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class PageQuality:
    label: str
    text_chars: int
    word_count: int
    image_count: int
    largest_image_area_ratio: float
    flags: list[str] = field(default_factory=list)


@dataclass
class PdfPage:
    page_number: int
    width: float
    height: float
    text: str
    blocks: list[dict[str, Any]]
    image_refs: list[str]
    quality: PageQuality


@dataclass
class PdfImageRef:
    local_id: str
    page_number: int
    xref: int
    width: int
    height: int
    bbox: dict[str, float] | None
    format: str


@dataclass
class PdfPackage:
    pdf_path: str
    file_name: str
    file_size: int
    page_count: int
    pages: list[PdfPage]
    images: list[PdfImageRef]

    @property
    def has_usable_text(self) -> bool:
        return sum(page.quality.word_count for page in self.pages) >= 25

    def pages_in_range(self, page_start: int, page_end: int) -> list[PdfPage]:
        return [
            page
            for page in self.pages
            if page_start <= page.page_number <= page_end
        ]


def build_pdf_package(pdf_path: str) -> PdfPackage:
    """Build a local page/text/image package from a PDF."""
    try:
        import fitz
    except ImportError as exc:
        raise RuntimeError("PyMuPDF (fitz) is required for local PDF extraction") from exc

    doc = fitz.open(pdf_path)
    images: list[PdfImageRef] = []
    pages: list[PdfPage] = []
    image_counter = 1
    seen_page_xrefs: set[tuple[int, int]] = set()

    try:
        for page_index, page in enumerate(doc):
            page_number = page_index + 1
            rect = page.rect
            text_dict = page.get_text("dict")
            blocks = _extract_text_blocks(text_dict)
            text = _normalize_text(page.get_text("text") or "")

            image_refs: list[str] = []
            image_infos = page.get_images(full=True)
            largest_area_ratio = 0.0
            page_area = max(float(rect.width * rect.height), 1.0)

            for info in image_infos:
                xref = int(info[0])
                key = (page_number, xref)
                if key in seen_page_xrefs:
                    continue
                seen_page_xrefs.add(key)

                try:
                    extracted = doc.extract_image(xref)
                except Exception:
                    continue
                if not extracted:
                    continue

                width = int(extracted.get("width") or 0)
                height = int(extracted.get("height") or 0)
                area_ratio = (width * height) / page_area
                largest_area_ratio = max(largest_area_ratio, area_ratio)

                bbox = None
                try:
                    rects = page.get_image_rects(xref)
                    if rects:
                        r = rects[0]
                        bbox = {"x0": r.x0, "y0": r.y0, "x1": r.x1, "y1": r.y1}
                except Exception:
                    bbox = None

                local_id = f"image-{image_counter}"
                image_counter += 1
                image_refs.append(local_id)
                images.append(
                    PdfImageRef(
                        local_id=local_id,
                        page_number=page_number,
                        xref=xref,
                        width=width,
                        height=height,
                        bbox=bbox,
                        format=str(extracted.get("ext") or "png"),
                    )
                )

            quality = _score_page_quality(
                text=text,
                image_count=len(image_infos),
                largest_image_area_ratio=largest_area_ratio,
            )
            pages.append(
                PdfPage(
                    page_number=page_number,
                    width=float(rect.width),
                    height=float(rect.height),
                    text=text,
                    blocks=blocks,
                    image_refs=image_refs,
                    quality=quality,
                )
            )
    finally:
        doc.close()

    package = PdfPackage(
        pdf_path=pdf_path,
        file_name=os.path.basename(pdf_path),
        file_size=os.path.getsize(pdf_path),
        page_count=len(pages),
        pages=pages,
        images=images,
    )
    logger.info(
        "Built local PDF package for %s: %d pages, %d text words, %d images",
        package.file_name,
        package.page_count,
        sum(page.quality.word_count for page in pages),
        len(images),
    )
    return package


def package_for_prompt(
    package: PdfPackage,
    *,
    page_start: int | None = None,
    page_end: int | None = None,
    max_page_chars: int = 1800,
    max_total_chars: int = 70000,
) -> str:
    """Serialize a PDF package into compact text for an LLM prompt."""
    pages = package.pages
    if page_start is not None and page_end is not None:
        pages = package.pages_in_range(page_start, page_end)

    header = [
        f"PDF: {package.file_name}",
        f"Pages: {package.page_count}",
        f"Bytes: {package.file_size}",
    ]
    chunks = ["\n".join(header)]
    total = len(chunks[0])

    for page in pages:
        page_chunk = _page_chunk(page, max_page_chars)
        if total + len(page_chunk) > max_total_chars:
            chunks.append(
                f"\n--- OMITTED ---\nRemaining pages omitted from prompt after "
                f"{max_total_chars} characters. Use local page range fallback if needed."
            )
            break
        chunks.append(page_chunk)
        total += len(page_chunk)

    return "\n".join(chunks)


def _page_chunk(page: PdfPage, max_page_chars: int) -> str:
    """One page as the prompt shows it: a header with its quality and images, then its (middle-truncated) text."""
    quality = page.quality
    image_note = f" images={','.join(page.image_refs)}" if page.image_refs else " images=none"
    text = _truncate_middle(page.text, max_page_chars)
    return (
        f"\n--- PAGE {page.page_number} "
        f"[quality={quality.label}; flags={','.join(quality.flags) or 'none'};"
        f" words={quality.word_count};{image_note}] ---\n{text}"
    )


def pages_fitting(package: PdfPackage, page_start: int, *, max_page_chars: int = 1800, max_total_chars: int = 70000) -> int:
    """The last page number that fits in one prompt starting at `page_start` (at least `page_start` itself), by the
    same arithmetic package_for_prompt uses, so a caller can walk a long package in windows."""
    total = len("\n".join([f"PDF: {package.file_name}", f"Pages: {package.page_count}", f"Bytes: {package.file_size}"]))
    last = page_start
    for page in package.pages_in_range(page_start, package.page_count):
        size = len(_page_chunk(page, max_page_chars))
        if total + size > max_total_chars and page.page_number > page_start:
            break
        total += size
        last = page.page_number
    return last


def range_text(package: PdfPackage, page_start: int, page_end: int) -> str:
    """Return normalized text for a page range."""
    return "\n\n".join(
        f"## Page {page.page_number}\n\n{page.text}".strip()
        for page in package.pages_in_range(page_start, page_end)
        if page.text.strip()
    ).strip()


def _extract_text_blocks(text_dict: dict[str, Any]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for block in text_dict.get("blocks", []):
        if block.get("type") != 0:
            continue
        lines = []
        for line in block.get("lines", []):
            line_text = "".join(span.get("text", "") for span in line.get("spans", []))
            line_text = _normalize_text(line_text)
            if line_text:
                lines.append(line_text)
        if not lines:
            continue
        bbox = block.get("bbox") or []
        blocks.append(
            {
                "bbox": list(bbox) if bbox else None,
                "text": "\n".join(lines),
            }
        )
    return blocks


def _score_page_quality(
    *,
    text: str,
    image_count: int,
    largest_image_area_ratio: float,
) -> PageQuality:
    words = re.findall(r"\b\w+\b", text)
    text_chars = len(text)
    flags: list[str] = []

    if text_chars < 80:
        flags.append("sparse_text")
    if image_count and largest_image_area_ratio > 0.35:
        flags.append("image_dominant")
    if text_chars < 40 and image_count:
        flags.append("scanned_or_ocr_needed")
    if _looks_table_like(text):
        flags.append("table_like")
    if "\ufffd" in text or text.count("?") > max(10, len(words) * 0.1):
        flags.append("noisy_text")

    if "scanned_or_ocr_needed" in flags:
        label = "scanned_or_ocr_needed"
    elif "image_dominant" in flags and len(words) < 50:
        label = "image_dominant"
    elif len(words) >= 25 and "noisy_text" not in flags:
        label = "good_text"
    elif text_chars:
        label = "sparse_text"
    else:
        label = "empty"

    return PageQuality(
        label=label,
        text_chars=text_chars,
        word_count=len(words),
        image_count=image_count,
        largest_image_area_ratio=round(largest_image_area_ratio, 4),
        flags=flags,
    )


def _looks_table_like(text: str) -> bool:
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) < 4:
        return False
    dense_numeric = sum(1 for line in lines if len(re.findall(r"\d+", line)) >= 3)
    multi_gap = sum(1 for line in lines if re.search(r"\S\s{3,}\S", line))
    return dense_numeric >= 3 or multi_gap >= 4


def _normalize_text(text: str) -> str:
    text = text.replace("\x00", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text.strip()


def _truncate_middle(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    head = max_chars // 2
    tail = max_chars - head
    return (
        text[:head].rstrip()
        + "\n[...local text truncated...]\n"
        + text[-tail:].lstrip()
    )
