import pytest

from pipeline.ingestion.local_pdf_package import (
    build_pdf_package,
    package_for_prompt,
    pages_fitting,
    range_text,
)
from pipeline.ingestion.local_context_extractor import package_needs_pdf_fallback
from pipeline.ingestion import local_context_extractor


pytest.importorskip("fitz")


def _write_pdf(path, pages):
    import fitz

    doc = fitz.open()
    for text in pages:
        page = doc.new_page()
        page.insert_text((72, 72), text, fontsize=11)
    doc.save(path)
    doc.close()


def test_build_pdf_package_extracts_page_text(tmp_path):
    pdf_path = tmp_path / "agenda.pdf"
    _write_pdf(
        pdf_path,
        [
            "Agenda Item 6.1 Staff Report\nRecommendation: That Council approve the permit. "
            "The report describes background, options, consultation, financial implications, "
            "and implementation next steps for the application.",
            "Appendix A\nThe property is 123 Example Road and the cost is $25,000. "
            "The attachment includes context, rationale, and supporting details.",
        ],
    )

    package = build_pdf_package(str(pdf_path))

    assert package.page_count == 2
    assert package.has_usable_text
    assert "Staff Report" in package.pages[0].text
    assert package.pages[0].quality.word_count > 0
    assert "123 Example Road" in range_text(package, 2, 2)


def test_package_for_prompt_includes_quality_and_pages(tmp_path):
    pdf_path = tmp_path / "minutes.pdf"
    _write_pdf(pdf_path, ["Minutes\nCouncil adopted Bylaw No. 1234."])

    package = build_pdf_package(str(pdf_path))
    prompt_text = package_for_prompt(package)

    assert "PDF: minutes.pdf" in prompt_text
    assert "--- PAGE 1" in prompt_text
    assert "quality=" in prompt_text
    assert "Bylaw No. 1234" in prompt_text


def test_package_needs_pdf_fallback_for_sparse_page(tmp_path):
    pdf_path = tmp_path / "blankish.pdf"
    _write_pdf(pdf_path, [""])

    package = build_pdf_package(str(pdf_path))

    assert package_needs_pdf_fallback(package, 1, 1) is True


def test_local_boundary_prompt_accepts_json_example_braces():
    prompt = local_context_extractor.LOCAL_BOUNDARY_PROMPT.format(
        package_text="--- PAGE 1 ---\nAgenda content"
    )

    assert '"title": "Document title/heading as it appears"' in prompt
    assert "--- PAGE 1 ---" in prompt


def _long_package(tmp_path, pages=12):
    pdf_path = tmp_path / "long-agenda.pdf"
    body = "Report text about the application, its background, options and recommendation. " * 6
    _write_pdf(pdf_path, [f"Page {i} heading\n{body}" for i in range(1, pages + 1)])
    return build_pdf_package(str(pdf_path))


def test_pages_fitting_counts_by_the_prompts_own_arithmetic(tmp_path):
    package = _long_package(tmp_path)
    end = pages_fitting(package, 1, max_page_chars=400, max_total_chars=1800)
    assert 1 <= end < package.page_count
    # package_for_prompt shows exactly those pages and omits the rest.
    shown = package_for_prompt(package, page_start=1, page_end=package.page_count, max_page_chars=400, max_total_chars=1800)
    assert f"--- PAGE {end} " in shown and f"--- PAGE {end + 1} " not in shown
    assert pages_fitting(package, 1, max_page_chars=400, max_total_chars=10) == 1  # never less than the first page


def test_boundary_detection_walks_a_long_package_in_windows(tmp_path, monkeypatch):
    """A text-dense package that doesn't fit one prompt is covered to its last page, in several model calls, with
    a document cut at a window's edge seen again whole."""
    import re

    from pipeline.ingestion.pdf_extractor import DocumentBoundaries

    package = _long_package(tmp_path, pages=12)
    calls: list[tuple[int, int]] = []

    def fake_json(prompt, *, stage, schema):
        pages = [int(m) for m in re.findall(r"--- PAGE (\d+) ", prompt)]
        lo, hi = min(pages), max(pages)
        calls.append((lo, hi))
        # Two-page documents from the window's first page; the last one may run to the window's edge.
        docs = []
        p = lo
        while p <= hi:
            q = min(p + 1, hi)
            docs.append({"title": f"Doc {p}-{q}", "page_start": p, "page_end": q, "type": "staff_report",
                         "agenda_item": None, "summary": "s", "key_facts": []})
            p = q + 1
        return DocumentBoundaries.model_validate({"documents": docs})

    monkeypatch.setattr(local_context_extractor.ai, "json", fake_json)
    found = local_context_extractor.detect_boundaries_from_package(package, max_page_chars=400, max_total_chars=1800)

    assert len(calls) > 1
    assert max(b["page_end"] for b in found) == package.page_count
    starts = [b["page_start"] for b in found]
    assert starts == sorted(starts) and len(starts) == len(set(starts))
    for a, b in zip(found, found[1:]):
        assert b["page_start"] > a["page_end"]  # no overlaps across windows
