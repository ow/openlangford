"""The City's annual reports, page by page, from the Goldstream Public Record archive (Glyphdex).

Annual reports belong to no meeting, so they live in ``public_reports`` (one row per year) and
``public_report_pages`` (the text of each page). The matter-links stage then finds the pages
that name a matter (``matter_report_mentions``) and the matter page shows them on its timeline,
for example the 2015 report's "The North Langford Recreation Centre was acquired and renovated".

Originals go to ``archive/<municipality>/Reports/Annual/<year>/`` with the usual ``.url`` sidecar
pointing at Glyphdex's archived copy, which is also the report's ``source_url``.

    uv run python -m pipeline.ingestion.annual_reports --dry-run
    uv run python -m pipeline.ingestion.annual_reports            # download, read and store every report
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time

import requests

from pipeline.ingestion.glyphdex_import import API, ARCHIVE_URL, USER_AGENT, _safe_filename, _sha256

TITLE = re.compile(r"^Annual Report (?P<year>\d{4})$", re.I)
MIN_PAGE_CHARS = 40  # cover photos and dividers have no text worth storing


def annual_reports(docs: list[dict]) -> list[dict]:
    """Glyphdex annual report PDFs, oldest first: [{"year", "id", "title"}]."""
    out = {}
    for doc in docs:
        m = TITLE.match((doc.get("title") or "").strip())
        if doc.get("doc_type") == "year_end_report" and doc.get("source_kind") == "pdf" and m:
            out.setdefault(int(m["year"]), {"year": int(m["year"]), "id": doc["id"], "title": f"Annual Report {m['year']}"})
    return [out[y] for y in sorted(out)]


def page_texts(pdf_path: str) -> list[tuple[int, str]]:
    """(page number from 1, text) for every page with text, whitespace tidied."""
    import fitz

    from pipeline.parser import _clean_extracted_text

    fitz.TOOLS.mupdf_display_errors(False)
    pages = []
    with fitz.open(pdf_path) as doc:
        for i, page in enumerate(doc, 1):
            text = re.sub(r"[ \t]+", " ", _clean_extracted_text(page.get_text()))
            text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
            if len(text) >= MIN_PAGE_CHARS:
                pages.append((i, text))
    return pages


def download(report: dict, archive_root: str, session=None) -> str:
    """The report's original PDF in the archive (kept when its SHA-256 still matches Glyphdex's)."""
    session = session or requests.Session()
    detail = session.get(f"{API}/documents/{report['id']}", headers={"User-Agent": USER_AGENT}, timeout=30).json()
    info = detail["document"]
    original = next(a for a in detail["artifacts"] if a["kind"] == "original")
    folder = os.path.join(archive_root, "Reports", "Annual", str(report["year"]))
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, _safe_filename(info.get("original_filename") or f"{report['title']}.pdf"))
    if not (os.path.exists(path) and _sha256(path) == info["sha256"]):
        response = session.get(f"https://gspr.emc2.build{original['url']}", headers={"User-Agent": USER_AGENT}, timeout=300)
        response.raise_for_status()
        if hashlib.sha256(response.content).hexdigest() != info["sha256"]:
            raise RuntimeError(f"checksum mismatch for {report['id']}")
        with open(path, "wb") as handle:
            handle.write(response.content)
    with open(path + ".url", "w", encoding="utf-8") as handle:
        handle.write(ARCHIVE_URL.format(id=report["id"]))
    return path


def store(conn, municipality_id: int, report: dict, path: str, pages: list[tuple[int, str]]) -> int:
    """Upsert the report row and replace its pages. Returns the report id."""
    import fitz

    with fitz.open(path) as doc:
        page_count = len(doc)
    cur = conn.cursor() if hasattr(conn, "cursor") else conn
    cur.execute(
        """insert into public_reports (municipality_id, kind, year, title, source_url, file_hash, page_count, meta)
           values (%s, 'annual_report', %s, %s, %s, %s, %s, %s)
           on conflict (municipality_id, kind, year) do update set title = excluded.title, source_url = excluded.source_url,
             file_hash = excluded.file_hash, page_count = excluded.page_count, meta = excluded.meta
           returning id""",
        (municipality_id, report["year"], report["title"], ARCHIVE_URL.format(id=report["id"]), _sha256(path), page_count,
         json.dumps({"source": "glyphdex", "glyphdex_id": report["id"], "pages_with_text": len(pages)})),
    )
    report_id = cur.fetchone()[0]
    cur.execute("delete from public_report_pages where report_id = %s", (report_id,))
    for page, text in pages:
        cur.execute("insert into public_report_pages (report_id, page, content) values (%s, %s, %s)", (report_id, page, text))
    return report_id


def main(argv=None):
    from pipeline.db import run_write
    from pipeline.ingestion.glyphdex_import import list_documents
    from pipeline.paths import get_municipality_archive_root

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--year", type=int, action="append", help="Only this year (repeatable)")
    parser.add_argument("--dry-run", action="store_true", help="Download and read, but store nothing")
    parser.add_argument("--docs-json", help=argparse.SUPPRESS)  # a cached Glyphdex document list
    args = parser.parse_args(argv)

    docs = json.load(open(args.docs_json)) if args.docs_json else list_documents(pause=1.5)
    reports = [r for r in annual_reports(docs) if not args.year or r["year"] in args.year]
    archive_root = get_municipality_archive_root("langford")
    session = requests.Session()
    for report in reports:
        path = download(report, archive_root, session)
        pages = page_texts(path)
        line = f"  {report['year']}: {len(pages)} page(s) with text -> {os.path.relpath(path, archive_root)}"
        if not args.dry_run:
            report_id = run_write(lambda cur: store(cur, 1, report, path, pages))
            line += f" (report id {report_id})"
        print(line, flush=True)
        time.sleep(2)


if __name__ == "__main__":
    main()
