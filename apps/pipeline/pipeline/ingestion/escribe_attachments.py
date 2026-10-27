"""Download and extract per-item attachments (staff reports, bylaws) from eSCRIBE.

eSCRIBE agendas are HTML pages; each agenda item lists its attachments as
``filestream.ashx?DocumentId=N`` links. The scraper only kept the agenda page,
so the reports that explain what an item *is* never reached the pipeline.

The agenda HTML ties every attachment to its item, so linking is exact: we
match the eSCRIBE item title to our agenda_items row and pass that id to the
extractor instead of letting it guess.

PDF downloads sit behind Cloudflare's browser check, which headless browsers
fail; a real (headed, off-screen) Chrome session passes it, and attachments are
fetched from inside that page.
"""
from __future__ import annotations

import base64
import difflib
import hashlib
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from bs4 import BeautifulSoup

ATTACHMENTS_DIR = "Attachments"
MANIFEST = "manifest.json"
EXTRACT_WORKERS = 6
SKIP_EXTRACT = re.compile(r"\b(redline|consolidat)", re.I)


@dataclass
class Attachment:
    doc_id: str
    filename: str
    item_title: str
    escribe_item: str


def parse_agenda_attachments(html: str) -> list[Attachment]:
    """Attachments per agenda item from an eSCRIBE agenda page."""
    soup = BeautifulSoup(html, "html.parser")
    out: list[Attachment] = []
    seen: set[str] = set()
    for a in soup.select('a[href*="filestream.ashx?DocumentId="]'):
        item = a.find_parent(class_="AgendaItem")
        if item is None:
            continue  # the page repeats every attachment in an unscoped list; skip those copies
        match = re.search(r"DocumentId=(\d+)", a.get("href", ""))
        filename = a.get_text(" ", strip=True)
        if not match or not filename.lower().endswith(".pdf") or match.group(1) in seen:
            continue
        seen.add(match.group(1))
        item_class = next((c for c in item.get("class", []) if re.fullmatch(r"AgendaItem\d+", c)), "")
        header = soup.select_one(f"#AgendaItem{item_class}TitleHeader") if item_class else None
        title_el = (header or item).select_one(".AgendaItemTitle a, .AgendaItemTitle")
        out.append(
            Attachment(
                doc_id=match.group(1),
                filename=filename,
                item_title=(title_el.get_text(" ", strip=True) if title_el else "").strip(),
                escribe_item=item_class,
            )
        )
    return out


def _norm_title(t: str | None) -> str:
    t = (t or "").lower()
    t = re.sub(r"^\s*[\d.]+[a-z]?[.)]?\s+", "", t)
    t = re.sub(r"\((?:background )?report attached\)|\(approx[^)]*\)", "", t)
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def match_agenda_items(attachments: list[Attachment], agenda_items: list[dict]) -> dict[str, int]:
    """Map attachment doc_id -> agenda_items.id by item title."""
    by_title: dict[str, list[dict]] = {}
    for row in agenda_items:
        by_title.setdefault(_norm_title(row.get("title")), []).append(row)
    out: dict[str, int] = {}
    for att in attachments:
        key = _norm_title(att.item_title)
        rows = by_title.get(key)
        if not rows and key:
            best, score = None, 0.0
            for title, candidates in by_title.items():
                s = difflib.SequenceMatcher(None, key, title).ratio()
                if s > score:
                    best, score = candidates, s
            rows = best if score >= 0.85 else None
        if rows and len(rows) == 1:
            out[att.doc_id] = rows[0]["id"]
    unmatched = [a for a in attachments if a.doc_id not in out]
    if unmatched and agenda_items:
        out.update(_decide_items(unmatched, agenda_items))
    return out


def _decide_items(attachments: list[Attachment], agenda_items: list[dict]) -> dict[str, int]:
    """Titles differ between eSCRIBE and our minutes-derived items; let the Decisions API pick."""
    from pipeline import ai

    choices = [(f"i{r['id']}", (r.get("title") or "")[:200]) for r in agenda_items[:60]] + [("none", "None of these.")]
    jobs = [
        (
            f"eSCRIBE agenda item: {a.item_title}\nAttachment file: {a.filename}",
            [ai.choice("item", "Which agenda item of this meeting is this attachment for?", choices)],
        )
        for a in attachments
    ]
    out: dict[str, int] = {}
    for a, res in zip(attachments, ai.decide_many(jobs)):
        if isinstance(res, Exception):
            continue
        ans = res.get("item")
        if ans is None or ans.type != "choice" or ans.choice == "none":
            continue
        if {p.value: p.probability for p in ans.probabilities}.get(ans.choice, 0) >= 0.75:
            out[a.doc_id] = int(ans.choice[1:])
    return out


class AttachmentFetcher:
    """A real Chrome session on the eSCRIBE site, reused across meetings."""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self._pw = None
        self._browser = None
        self._page = None

    def __enter__(self):
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(
            channel="chrome", headless=False, args=["--window-position=-2400,0", "--window-size=800,600"]
        )
        self._page = self._browser.new_page()
        return self

    def __exit__(self, *exc):
        if self._browser:
            self._browser.close()
        if self._pw:
            self._pw.stop()

    def open_meeting(self, agenda_url: str):
        self._page.goto(agenda_url, wait_until="networkidle", timeout=60000)

    def fetch_pdf(self, doc_id: str) -> bytes:
        result = self._page.evaluate(
            """async (id) => {
                const r = await fetch(`/filestream.ashx?DocumentId=${id}`, { credentials: "include" });
                const buf = new Uint8Array(await r.arrayBuffer());
                let s = ""; const step = 0x8000;
                for (let i = 0; i < buf.length; i += step) s += String.fromCharCode(...buf.subarray(i, i + step));
                return { status: r.status, type: r.headers.get("content-type") || "", b64: btoa(s) };
            }""",
            doc_id,
        )
        if result["status"] != 200 or "pdf" not in result["type"]:
            raise ValueError(f"DocumentId={doc_id}: HTTP {result['status']} {result['type']}")
        return base64.b64decode(result["b64"])


def download_meeting_attachments(fetcher: AttachmentFetcher, meeting_folder: str, agenda_url: str) -> list[dict]:
    """Download any missing attachments for one meeting. Returns manifest rows."""
    html_path = os.path.join(meeting_folder, "Agenda", "Agenda.html")
    if not os.path.isfile(html_path):
        return []
    with open(html_path, encoding="utf-8") as handle:
        attachments = parse_agenda_attachments(handle.read())
    if not attachments:
        return []

    out_dir = os.path.join(meeting_folder, ATTACHMENTS_DIR)
    os.makedirs(out_dir, exist_ok=True)
    manifest_path = os.path.join(out_dir, MANIFEST)
    manifest = {}
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as handle:
            manifest = {row["doc_id"]: row for row in json.load(handle)}

    opened = False
    for att in attachments:
        safe = re.sub(r"[^\w.\- ]+", "_", att.filename)[:150]
        path = os.path.join(out_dir, f"{att.doc_id} - {safe}")
        if att.doc_id in manifest and os.path.exists(path):
            continue
        if not opened:
            fetcher.open_meeting(agenda_url)
            opened = True
        try:
            data = fetcher.fetch_pdf(att.doc_id)
        except Exception as exc:
            print(f"  [!] attachment {att.doc_id} ({att.filename}): {exc}")
            continue
        with open(f"{path}.part", "wb") as handle:
            handle.write(data)
        os.replace(f"{path}.part", path)
        manifest[att.doc_id] = {
            "doc_id": att.doc_id,
            "filename": att.filename,
            "path": os.path.basename(path),
            "item_title": att.item_title,
            "escribe_item": att.escribe_item,
            "sha256": hashlib.sha256(data).hexdigest(),
            "url": f"{fetcher.base_url}/filestream.ashx?DocumentId={att.doc_id}",
        }
        print(f"  [+] Attachment: {att.filename}")
        time.sleep(0.5)

    rows = list(manifest.values())
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(rows, handle, indent=1)
    return rows


def ingest_meeting_attachments(supabase, meeting: dict, meeting_folder: str, *, municipality_id: int = 1, extract: bool = True) -> dict:
    """Register downloaded attachments as documents and extract them, linked to their agenda item."""
    from pipeline.ingestion.document_extractor import extract_and_store_documents

    manifest_path = os.path.join(meeting_folder, ATTACHMENTS_DIR, MANIFEST)
    if not os.path.exists(manifest_path):
        return {"documents": 0, "extracted": 0, "linked": 0}
    with open(manifest_path, encoding="utf-8") as handle:
        rows = json.load(handle)

    items = (
        supabase.table("agenda_items").select("id, title").eq("meeting_id", meeting["id"]).execute().data or []
    )
    links = match_agenda_items(
        [Attachment(r["doc_id"], r["filename"], r["item_title"], r.get("escribe_item", "")) for r in rows], items
    )
    stats = {"documents": 0, "extracted": 0, "linked": len(links)}
    to_extract: list[tuple[str, int, str]] = []
    for row in rows:
        file_path = os.path.join(meeting_folder, ATTACHMENTS_DIR, row["path"])
        if not os.path.exists(file_path):
            continue
        existing = (
            supabase.table("documents").select("id, file_hash").eq("source_url", row["url"]).limit(1).execute().data
        )
        if existing and existing[0].get("file_hash") == row["sha256"]:
            doc_id = existing[0]["id"]
            already = (
                supabase.table("extracted_documents").select("id", count="exact").eq("document_id", doc_id).limit(1).execute().count
            )
            if already:
                item_id = links.get(row["doc_id"])
                if item_id:  # fill in links for documents extracted before a match was found
                    supabase.table("extracted_documents").update({"agenda_item_id": item_id}).eq("document_id", doc_id).is_("agenda_item_id", "null").execute()
                    supabase.table("document_sections").update({"agenda_item_id": item_id}).eq("document_id", doc_id).is_("agenda_item_id", "null").execute()
                continue
        else:
            record = {
                "meeting_id": meeting["id"],
                "title": re.sub(r"\.pdf$", "", row["filename"], flags=re.I),
                "category": "Attachment",
                "source_url": row["url"],
                "file_path": os.path.relpath(file_path, meeting_folder),
                "file_hash": row["sha256"],
                "municipality_id": municipality_id,
            }
            if existing:
                supabase.table("documents").update(record).eq("id", existing[0]["id"]).execute()
                doc_id = existing[0]["id"]
            else:
                doc_id = supabase.table("documents").insert(record).execute().data[0]["id"]
            stats["documents"] += 1
        if extract and not SKIP_EXTRACT.search(row["filename"]):
            # redlines/consolidations repeat the bylaw text at length and add nothing to summaries
            to_extract.append((file_path, doc_id, row["doc_id"]))

    local = threading.local()

    def thread_client():
        # The sync supabase client isn't thread-safe; give each extraction thread its own.
        if not hasattr(local, "client"):
            from pipeline import config as pipeline_config
            from pipeline.supabase_client import create_client

            local.client = create_client(
                pipeline_config.SUPABASE_URL, pipeline_config.SUPABASE_SECRET_KEY or pipeline_config.SUPABASE_KEY
            )
        return local.client

    def run(job: tuple[str, int, str]) -> bool:
        file_path, doc_id, escribe_doc = job
        try:
            extract_and_store_documents(
                file_path, doc_id, meeting["id"], thread_client(), municipality_id=municipality_id,
                agenda_item_id=links.get(escribe_doc),
            )
            return True
        except Exception as exc:
            print(f"  [!] extraction failed for {os.path.basename(file_path)}: {exc}")
            return False

    with ThreadPoolExecutor(max_workers=EXTRACT_WORKERS) as pool:
        stats["extracted"] = sum(pool.map(run, to_extract))
    return stats
