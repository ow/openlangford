"""Ingest Langford bylaws: PDF -> bylaws row + bylaw_chunks, then link matters.

Upserts by (municipality_id, bylaw_number). Nothing is written without
``--write``; without it the record and the matter-link plan are printed.

    # one bylaw, dry run (downloads the PDF and calls the AI, writes nothing)
    uv run python -m pipeline.ingestion.langford_bylaws --bylaw 1819 --link
    # write it
    uv run python -m pipeline.ingestion.langford_bylaws --bylaw 1819 --link --write

    # bulk: plan every directory + media-library bylaw (downloads, no AI, no writes)
    uv run python -m pipeline.ingestion.langford_bylaws --all --no-ai --plan-md ../../research/bylaws-plan.md
    # ingest them (resumable: unchanged PDFs are skipped unless --force; --only 300,2200 to narrow)
    uv run python -m pipeline.ingestion.langford_bylaws --all --write
    # link matters.bylaw_id for every bylaw (dry run writes a sample; --write sets it)
    uv run python -m pipeline.ingestion.langford_bylaws --link-all --links-md ../../research/bylaws-links-sample.md
    # or both via the stage registry
    uv run python main.py --stage bylaws --all [--source directory|media] [--force] [--dry-run]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from urllib.parse import unquote, urlparse

from pydantic import BaseModel, Field

from pipeline import ai, utils
from pipeline.bylaw_numbers import (
    STREET_WORDS,
    adoption_year_from_text,
    amendments_from_consolidation,
    normalize_number,
    number_from_text,
)
from pipeline.ingestion.bylaw_matter_links import mentions, plan_links
from pipeline.ingestion.bylaw_text import chunk_text, extract_text_from_pdf
from pipeline.paths import get_municipality_archive_root
from pipeline.scrapers.langford_bylaws import BylawSource, download, fetch_sources

MUNICIPALITY_SLUG = "langford"

STATUS_IN_FORCE = "In force"
STATUS_AMENDED = "Amended"  # in force, as amended (a consolidation lists amendments)
STATUS_REPEALED = "Repealed"

SYSTEM = (
    "You explain municipal bylaws to residents of Langford, BC in plain, concrete English. "
    "Only state what the bylaw text says. Keep numbers, fees, distances and deadlines exactly as written. "
    "No legal advice, no speculation, no filler."
)


class BylawSummary(BaseModel):
    summary: str = Field(
        description="2-3 sentences: what this bylaw does for residents, in plain English. "
        "Lead with the practical effect, not 'This bylaw...'."
    )
    key_rules: list[str] = Field(
        description="3-6 short items (under 20 words each): the specific rules, fees, fines, "
        "limits or deadlines a resident is most likely to run into. Quote figures exactly."
    )
    who_it_affects: str = Field(description="One short sentence naming who this bylaw applies to.")


# ── derivation ───────────────────────────────────────────────────────────


def display_title(title: str) -> str:
    """'Elections (Bylaw No. 1819) – Consolidated' -> 'Elections Bylaw'."""
    t = re.sub(r"\s*\((?:bylaw\s*)?no\.?\s*\d+[^)]*\)", "", title, flags=re.IGNORECASE)
    t = re.sub(r"\s*[–-]\s*consolidated\b.*$", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s*\bconsolidated\b.*$", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s*\bbylaw\s+no\.?\s*\d+(?:,\s*\d{4})?", " Bylaw", t, flags=re.IGNORECASE)
    t = " ".join(t.split()).strip(" –-,")
    if not re.search(r"\bbylaw\b", t, re.IGNORECASE):
        t = f"{t} Bylaw"
    return re.sub(r"\bBylaw\s+Bylaw\b", "Bylaw", t)


_ANNUAL = re.compile(r"\b(financial plan|tax rates?)\b", re.IGNORECASE)


def derive_status(src: BylawSource, text: str, amendments: list[dict]) -> str | None:
    """Only what the source supports; None when unsure.

    * On the City's directory of current bylaws -> in force (amended if the
      PDF is a consolidation listing amendments).
    * Annual financial-plan / tax-rate bylaws are listed historically, so the
      directory says nothing about whether they are "in force" -> None.
    * Media-library uploads (amendments, rezonings) -> None: an amending
      bylaw is spent once consolidated, and we can't tell from the upload.
    """
    head = (text or "")[:3000].lower()
    # "This bylaw is repealed on the later of ..." (a sunset clause) is not a repeal we can date.
    if re.search(r"this bylaw is (?:hereby )?repealed(?!\s+(?:on|upon|when|at|effective|if|the)\b)", head) or re.search(
        r"\brepealed\s+by\s+bylaw", head
    ):
        return STATUS_REPEALED
    if not src.listed_current or _ANNUAL.search(src.title):
        return None
    if amendments or src.consolidated:
        return STATUS_AMENDED
    return STATUS_IN_FORCE


SUMMARY_INPUT_CHARS = 60000

_TOC = re.compile(r"\b(?:table\s+of\s+contents|^\s*contents\s*$)", re.IGNORECASE | re.MULTILINE)
_KEY_SECTION = re.compile(
    r"^[ \t]*(?:(?:part|section|division)\s+[\dA-Z.]+\s*[–:.-]?\s*)?(?:\d+(?:\.\d+)*\.?\s+)?"
    r"(?:purpose|intent|interpretation|application|introduction|title|vision|scope)\b[^\n]{0,60}$",
    re.IGNORECASE | re.MULTILINE,
)
_HEADING = re.compile(
    r"^[ \t]*(?:(?:PART|Part|DIVISION|Division|SECTION|SCHEDULE|Schedule|APPENDIX|Appendix|CHAPTER)\s+[\dA-Z][\w.]*\b[^\n]{0,90}"
    r"|\d+(?:\.\d+)?\.?[ \t]+[A-Z][A-Za-z ,&/()'’-]{2,80}"
    r"|[A-Z][A-Z ,&/()'’-]{7,80})[ \t]*$",
    re.MULTILINE,
)
_ADDRESS_LINE = re.compile(rf"^\d{{2,5}}[A-Z]?\b.*\b(?i:{STREET_WORDS})\b")
_SIGNATURE_LINE = re.compile(
    r"\b(?:CORPORATE OFFICER|PRESIDING|MAYOR|CLERK|COUNCIL MEMBER|CITY OF LANGFORD)\b"
    r"|^(?:Schedule|SCHEDULE|Part|PART)\s+[\w.]+\s*[-–]\s*\d+$|…|\.{4,}"  # page footers, TOC leaders
)


def section_headings(text: str, limit: int = 30000) -> str:
    """Heading-like lines (parts, divisions, schedules, numbered sections,
    all-caps titles), in order, de-duplicated, up to ``limit`` chars. Street
    addresses (amendment lists) and signature blocks are dropped."""
    seen: set[str] = set()
    out: list[str] = []
    size = 0
    for m in _HEADING.finditer(text):
        line = " ".join(m.group(0).split())
        key = line.lower()
        if key in seen or len(line) < 8 or _ADDRESS_LINE.match(line) or _SIGNATURE_LINE.search(line):
            continue
        seen.add(key)
        size += len(line) + 1
        if size > limit:
            break
        out.append(line)
    return "\n".join(out)


def _is_prose(line: str) -> bool:
    """A body-text line, not a TOC entry: long, mostly lowercase words."""
    words = line.split()
    return len(line) > 75 and sum(w[:1].islower() for w in words) > len(words) / 2


def compact_toc(raw: str) -> str:
    """The table of contents from ``raw`` (which starts at it and runs into
    the body): dot leaders and page numbers dropped, one entry per line,
    ending where body prose starts (three prose lines in a row)."""
    t = re.sub(r"\s*(?:\.{3,}|…{2,})\s*[\w-]*", "\n", raw)
    out: list[str] = []
    prose_run = 0
    for l in (" ".join(l.split()) for l in t.splitlines()):
        if not l:
            continue
        prose_run = prose_run + 1 if _is_prose(l) else 0
        if prose_run >= 3:
            out = out[:-2]
            break
        if out and re.fullmatch(r"\d+(?:\.\d+)*[A-Z]?\.?", out[-1]):  # "1.01" then "Definitions" on the next line
            out[-1] = f"{out[-1]} {l}"
        else:
            out.append(l)
    return "\n".join(out)


def summary_input(text: str, limit: int = SUMMARY_INPUT_CHARS) -> tuple[str, bool]:
    """What the summary prompt sees. Short bylaws: the whole text. Long ones
    (zoning, OCP, subdivision and servicing, multi-utility): the opening, the
    table of contents, the purpose/interpretation/application sections and
    the section headings of the whole document, so the summary covers the
    whole bylaw instead of a truncated prefix. Returns (text, digested)."""
    if len(text) <= limit:
        return text, False
    parts = [f"OPENING:\n{text[:4000]}"]
    toc = _TOC.search(text, 0, len(text) // 3)
    toc_text = ""
    if toc:
        toc_text = compact_toc(text[toc.start():toc.start() + 40000])[:20000]
        parts.append(f"TABLE OF CONTENTS:\n{toc_text}")
    taken = 0
    toc_end = toc.start() + len(toc_text) if toc else -1
    for m in _KEY_SECTION.finditer(text):
        if toc and toc.start() <= m.start() < toc_end:
            continue  # a TOC entry, not the section itself
        parts.append(f"SECTION EXCERPT:\n{text[m.start():m.start() + 3000]}")
        taken += 1
        if taken >= 5:
            break
    used = sum(len(p) for p in parts)
    parts.append(f"SECTION HEADINGS (whole document):\n{section_headings(text, max(6000, limit - used - 1000))}")
    return "\n\n".join(parts)[:limit], True


def summarize(title: str, number: str | None, text: str, amendments: list[dict]) -> BylawSummary:
    amend = "; ".join(f"Bylaw {a['bylaw_number']} (adopted {a['adopted']})" for a in amendments) or "none listed"
    body, digested = summary_input(text)
    if digested:
        note = (
            f"This bylaw is long ({len(text):,} characters). You are given its opening, table of contents, "
            "purpose/interpretation sections and the headings of every section, not the full text. "
            "Summarize the scope of the WHOLE bylaw (what it regulates and how it is organised). Key rules must be "
            "general rules that apply across the bylaw (permits, compliance, enforcement, how its parts or zones "
            "work), not details of one zone, schedule or site; only quote figures that appear in the excerpts.\n\n"
        )
        label = "BYLAW EXCERPTS"
    else:
        note, label = "", "BYLAW TEXT"
    prompt = (
        f"Bylaw: {title}" + (f" (No. {number})" if number else "") + "\n"
        f"Amendments included in this version: {amend}\n\n"
        f"{note}Summarize this bylaw for residents.\n\n"
        f"{label}:\n{body}"
    )
    return ai.json(prompt, stage="extraction", schema=BylawSummary, system=SYSTEM)


_CITED = re.compile(r"\b(?:may|shall)\s+be\s+cited\s+(?:for\s+all\s+purposes\s+)?as\b\s*,?\s*(?:the\s+)?", re.IGNORECASE)
_SENTENCE_END = re.compile(r"(?<!\bNo)(?<!\bNos)\.(?:\s|$)")
_QUOTES = "\"“”'‘’"


def citation_span(text: str | None) -> str | None:
    """The text of the citation clause ("This Bylaw may be cited as 'Langford
    Zoning Bylaw, Amendment No. 700 (123 Main St), Bylaw No. 2135, 2023'")."""
    if not text:
        return None
    m = _CITED.search(text[:80000])
    if not m:
        return None
    s = " ".join(text[m.end():m.end() + 400].split())
    stop = re.search(r"\b(?:READ\s+A\s+FIRST|FIRST\s+READING|READ\s+A\s+1ST)\b", s, re.IGNORECASE)
    if stop:
        s = s[: stop.start()]
    if s[:1] in _QUOTES:
        s = s[1:]
        end = re.search(r"[\"”’]", s)
        if end:
            s = s[: end.start()]
        else:
            end = _SENTENCE_END.search(s)
            s = s[: end.start()] if end else s
    else:
        end = _SENTENCE_END.search(s)
        s = s[: end.start()] if end else s[:200]
    s = s.strip(" .,;:" + _QUOTES)
    return s if 5 <= len(s) <= 250 else None


def cited_title(text: str | None) -> str | None:
    return citation_span(text)


_OWN_NUMBER = re.compile(r"\bBy-?law\s+No\.?\s*(\d{1,4})\b", re.IGNORECASE)


def own_number_from_text(text: str | None) -> str | None:
    """The bylaw's own number: the last "Bylaw No. N" in its citation clause
    ("Ticket Information Bylaw No. 34, 1993 Amendment Bylaw No. 1907, 2020"
    -> 1907), else the first-page header ("BYLAW NO. 2022")."""
    span = citation_span(text)
    if span:
        nums = _OWN_NUMBER.findall(span)
        if nums:
            return normalize_number(nums[-1])
    return number_from_text(text)


def media_title(cited: str) -> str:
    """'Langford Zoning Bylaw, Amendment No. 700 (1 Main St), Bylaw No. 2135, 2023'
    -> 'Langford Zoning Bylaw, Amendment No. 700 (1 Main St)';
    'City of Langford Permissive Tax Exemption Bylaw No. 1718, 2017'
    -> 'City of Langford Permissive Tax Exemption Bylaw'."""
    tail = re.search(r"[,\s]*\bBylaw\s+No\.?\s*\d+\s*(?:,\s*(?:19|20)\d{2})?\s*$", cited, flags=re.IGNORECASE)
    t = cited
    if tail:
        head = cited[: tail.start()]
        # "..., Amendment No. 3, Bylaw No. 2125" -> drop it; "Noise Bylaw No. 2056" -> "Noise Bylaw"
        t = head if re.search(r"\b(?:bylaw|amendment)\b", head, re.IGNORECASE) else f"{head} Bylaw"
    t = re.sub(r",\s*(?:19|20)\d{2}\s*$", "", t)
    t = " ".join(t.split()).strip(" ,–-")
    if t.count("(") > t.count(")"):
        t += ")"
    letters = [c for c in t if c.isalpha()]
    if letters and sum(c.isupper() for c in letters) / len(letters) > 0.6:
        t = " ".join(w if any(ch.isdigit() for ch in w) else w.capitalize() for w in t.lower().split())
    return t or cited


def build_record(
    src: BylawSource, path: str, *, archive_root: str, municipality_id: int, use_ai: bool = True, text: str | None = None
) -> dict:
    text = text if text is not None else (extract_text_from_pdf(path) or "")
    if not text.strip():
        raise RuntimeError(f"No text layer in {path}")
    own = own_number_from_text(text)
    number = own if (own and (src.number_unconfirmed or not src.bylaw_number)) else src.bylaw_number
    amendments = amendments_from_consolidation(text)
    cited = cited_title(text)
    title = planned_title(src, text, number)
    cited_year = None
    if cited:
        y = re.search(r",\s*((?:19|20)\d{2})\s*$", cited)
        cited_year = int(y.group(1)) if y else None
    if own and number and own != number:
        # The PDF is an amending bylaw listed under its parent: use the parent's
        # year ("Fees and Charges Bylaw No. 113, 1995"), not the amendment's.
        y = re.search(rf"\bBylaw\s+No\.?\s*0*{number}\s*,\s*((?:19|20)\d{{2}})\b", text, re.IGNORECASE)
        cited_year = int(y.group(1)) if y else None
    listed_as_parent = bool(own and number and own != number)
    rel_path = os.path.join("archive", os.path.basename(archive_root.rstrip("/")), "Bylaws", os.path.basename(path))

    summary = summarize(title, number, text, amendments) if use_ai else None
    return {
        "municipality_id": municipality_id,
        "title": title,
        "bylaw_number": number,
        "year": src.year or cited_year or (None if listed_as_parent else adoption_year_from_text(text)),
        "category": src.category,
        "status": derive_status(src, text, amendments),
        "source_url": src.source_url,
        "file_path": rel_path,
        "full_text": text,
        "plain_english_summary": " ".join(summary.summary.split()) if summary else None,
        "meta": summary_meta(summary) if summary else {},
    }


SUMMARY_VERSION = "v2"


def summary_meta(s: BylawSummary) -> dict:
    """Structured parts of the summary, stored in bylaws.meta (migration 47-12)."""
    return {
        "key_rules": [" ".join(r.split()) for r in s.key_rules if r.strip()],
        "who_it_affects": " ".join(s.who_it_affects.split()) or None,
        "summary_version": SUMMARY_VERSION,
    }


def format_summary(s: BylawSummary) -> str:
    """Legacy packed format (before bylaws.meta existed); kept for tests and the
    one-off migration. New rows use summary_meta(). The first paragraph is the 2-3 sentence summary, which
    list rows and the matter card show; the web app's ``parseBylawSummary``
    reads the rest::

        <summary>

        Key rules:
        - <rule>

        Who it affects: <sentence>
    """
    parts = [" ".join(s.summary.split())]
    rules = [" ".join(r.split()) for r in s.key_rules if r.strip()]
    if rules:
        parts.append("Key rules:\n" + "\n".join(f"- {r}" for r in rules))
    if s.who_it_affects.strip():
        parts.append(f"Who it affects: {' '.join(s.who_it_affects.split())}")
    return "\n\n".join(parts)


# ── database ─────────────────────────────────────────────────────────────


def _client():
    from dotenv import load_dotenv
    from pipeline.supabase_client import create_client

    load_dotenv()
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SECRET_KEY")
    if not url or not key:
        sys.exit("SUPABASE_URL and SUPABASE_SECRET_KEY must be set")
    return create_client(url, key)


def municipality_id_for(sb, slug: str = MUNICIPALITY_SLUG) -> int:
    rows = sb.table("municipalities").select("id").eq("slug", slug).execute().data
    if not rows:
        sys.exit(f"No municipality with slug {slug!r}")
    return rows[0]["id"]


def upsert_bylaw(sb, record: dict) -> tuple[int, int]:
    """Insert or update by (municipality_id, bylaw_number); replace chunks.
    Returns (bylaw_id, chunk_count)."""
    text = record["full_text"]
    doc_context = f"{record['title']}\n{record.get('plain_english_summary') or ''}\n{text[:1000]}"
    row = dict(record, embedding=ai.embed([doc_context])[0])

    q = sb.table("bylaws").select("id").eq("municipality_id", record["municipality_id"])
    q = q.eq("bylaw_number", record["bylaw_number"]) if record["bylaw_number"] else q.eq("file_path", record["file_path"])
    existing = q.execute().data
    if existing:
        bylaw_id = existing[0]["id"]
        sb.table("bylaws").update(row).eq("id", bylaw_id).execute()
        sb.table("bylaw_chunks").delete().eq("bylaw_id", bylaw_id).execute()
    else:
        bylaw_id = sb.table("bylaws").insert(row).execute().data[0]["id"]

    chunks = [c for c in chunk_text(text) if c.strip()]
    embeddings = ai.embed(chunks) if chunks else []
    rows = [
        {"bylaw_id": bylaw_id, "chunk_index": i, "text_content": c, "embedding": e}
        for i, (c, e) in enumerate(zip(chunks, embeddings))
    ]
    for i in range(0, len(rows), 50):
        sb.table("bylaw_chunks").insert(rows[i : i + 50]).execute()
    return bylaw_id, len(rows)


def load_matters(sb, municipality_id: int) -> list[dict]:
    out, off = [], 0
    while True:
        batch = (
            sb.table("matters")
            .select("id, title, identifier, slug, meta, bylaw_id")
            .eq("municipality_id", municipality_id)
            .order("id")
            .range(off, off + 999)
            .execute()
            .data
        )
        out.extend(batch)
        if len(batch) < 1000:
            return out
        off += 1000


def link_matters(sb, *, municipality_id: int, bylaw_id: int | None, number: str, amendments: list[dict], write: bool):
    matters = load_matters(sb, municipality_id)
    with_rows = {
        normalize_number(r["bylaw_number"])
        for r in sb.table("bylaws").select("bylaw_number").eq("municipality_id", municipality_id).execute().data
        if r.get("bylaw_number")
    }
    links = plan_links(
        matters,
        bylaw_id=bylaw_id,
        bylaw_number=number,
        amendment_numbers=[a["bylaw_number"] for a in amendments],
        numbers_with_rows=with_rows,
    )
    linked_ids = {mid for l in links for mid in l.matched_matter_ids}
    print(f"\nMatter links for Bylaw {number} ({'WRITE' if write else 'dry run'}):")
    for l in links:
        aliases = [i for i in l.matched_matter_ids if i != l.matter_id]
        flag = f"  [skip: already linked to bylaw {l.current_bylaw_id}]" if l.conflict else ""
        print(f"  matter {l.matter_id:>5}  {l.via:<16} {l.title[:80]}"
              + (f"  (via aliases {aliases})" if aliases else "") + flag)
    misses = [m for m in matters if m["id"] not in linked_ids and mentions(m, number)]
    for m in misses:
        print(f"  not linked {m['id']:>5}  (mentions {number}, not its main bylaw) {m['title'][:80]}")
    targets = [l.matter_id for l in links if not l.conflict]
    if write and bylaw_id and targets:
        sb.table("matters").update({"bylaw_id": bylaw_id}).in_("id", targets).execute()
        print(f"  -> linked {len(targets)} matter(s): {targets}")
    return links


# ── bulk ingestion ───────────────────────────────────────────────────────

DOWNLOAD_DELAY = 0.5  # seconds between real downloads
MANIFEST_NAME = "manifest.json"
SCANNED_NOTE = "scanned PDF: text transcribed by AI at ingest"

TRANSCRIBE_PROMPT = (
    "This PDF is a scanned municipal bylaw with no text layer. Transcribe ALL of its text verbatim, page by page, "
    "in reading order: headings, section numbers, schedules and tables (tables as plain lines). Do not summarize, "
    "correct or omit anything; mark illegible words as [illegible]. Output only the transcription."
)


def transcribe_scanned(path: str) -> str:
    """Text for a scanned PDF (no OCR engine installed here): the document
    model reads the page images."""
    return ai.pdf(path, TRANSCRIBE_PROMPT, stage="document") or ""

_LOOKS_LIKE_BYLAW = re.compile(
    r"\b(?:enacts?\s+as\s+follows|(?:may|shall)\s+be\s+cited\s+as|a\s+bylaw\s+to\b)", re.IGNORECASE
)


def looks_like_bylaw(text: str | None) -> bool:
    """A bylaw has a header number and an enacting or citation clause; notices,
    reports, job postings and permit forms do not."""
    head = (text or "")[:20000]
    return bool(own_number_from_text(text)) and bool(_LOOKS_LIKE_BYLAW.search(head) or _CITED.search(head))


_ADOPTED_DATED = re.compile(r"\bADOPTED\b[^\n]{0,40}?\b\d{1,2}\s*(?:st|nd|rd|th|\W{1,3})?\s+day\b", re.IGNORECASE)


def is_adopted(text: str | None) -> bool:
    """The adoption line carries a day ("ADOPTED THIS 19TH DAY OF ..."); a
    draft's is blank ("ADOPTED on the day of , 2024")."""
    return bool(_ADOPTED_DATED.search(text or ""))


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def text_sha256(text: str | None) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


@dataclass
class Candidate:
    """One downloaded source PDF and what its text says."""

    src: BylawSource
    path: str | None = None
    text: str = ""
    own_number: str | None = None  # from the citation clause, else the header
    adopted: bool = False
    error: str | None = None


@dataclass
class PlanEntry:
    number: str
    title: str
    source: str  # "directory" | "media"
    status: str | None
    cand: Candidate
    note: str = ""
    action: str = "ingest"  # "ingest" | "unchanged"


@dataclass
class Skipped:
    title: str
    source: str
    url: str
    reason: str
    number: str | None = None


def planned_title(src: BylawSource, text: str, number: str | None) -> str:
    if src.source == "media":
        cited = cited_title(text)
        return media_title(cited) if cited else f"Bylaw No. {number}"
    return display_title(src.title)


def candidate_name(src: BylawSource) -> str:
    """Archive filename. Media uploads reuse basenames ("Bylaw-2135.pdf" in
    2023/08 and 2023/09), so theirs carry the upload month."""
    if src.source != "media":
        return src.filename
    m = re.search(r"/uploads/(\d{4})/(\d{2})/", src.source_url)
    base = os.path.basename(unquote(urlparse(src.source_url).path))
    month = f"{m.group(1)}-{m.group(2)} " if m else ""
    prefix = f"Bylaw {src.bylaw_number} - " if src.bylaw_number else ""
    return utils.sanitize_filename(f"{prefix}{month}{base}")


def prepare_candidates(sources: list[BylawSource], folder: str, *, delay: float = DOWNLOAD_DELAY) -> list[Candidate]:
    """Download (polite, cached) and read each source. Never raises."""
    out: list[Candidate] = []
    for i, src in enumerate(sources, 1):
        cand = Candidate(src=src)
        try:
            cand.path = download(src, folder, candidate_name(src), delay=delay)
            cand.text = extract_text_from_pdf(cand.path) or ""
            cand.own_number = own_number_from_text(cand.text)
            cand.adopted = is_adopted(cand.text)
        except Exception as e:  # one bad download never stops the run
            cand.error = f"{type(e).__name__}: {e}"
        print(
            f"  [{i}/{len(sources)}] {src.source:<9} {src.bylaw_number or '-':>5} -> own {cand.own_number or '-':>5}"
            f"  {len(cand.text):>8} chars  {src.title[:60]}" + (f"  [!] {cand.error}" if cand.error else "")
        )
        out.append(cand)
    return out


def _amends(text: str, number: str) -> bool:
    """The first page says this PDF amends Bylaw ``number`` ("A BYLAW TO AMEND
    ... FEES AND CHARGES BYLAW NO. 113")."""
    return bool(re.search(rf"\bamend[^.]{{0,160}}?\bBylaw\s+No\.?\s*0*{number}\b", text[:4000], re.IGNORECASE | re.DOTALL))


def _final_number(cand: Candidate) -> tuple[str | None, str]:
    """The number the row gets, plus a note when the listing and the PDF
    disagree. The PDF's own number (citation clause, else header) wins, except
    on the directory when the PDF amends the listed bylaw (the City links the
    latest amending bylaw as "the" Fees and Charges / Sign bylaw)."""
    src, own = cand.src, cand.own_number
    listed = src.bylaw_number
    if not listed:
        return own, ("number from the PDF" if own else "")
    if src.number_unconfirmed:  # a loose "Bylaw 2019" title read: the PDF must agree or replace it
        if own == listed:
            return own, ""
        return own, (f"title read {listed}, PDF is Bylaw {own}" if own else "")
    if own and own != listed:
        if src.source == "directory" and _amends(cand.text, listed):
            return listed, f"PDF is amending Bylaw {own}; listed as {listed}"
        return own, f"listed as {listed}, PDF is Bylaw {own}"
    return listed, ""


def select_bulk(
    directory: list[Candidate], media: list[Candidate], *, source: str = "all"
) -> tuple[list[PlanEntry], list[Skipped]]:
    """Pure: decide which PDF becomes each bylaw row.

    * Directory first: one row per number (the City's list of current
      bylaws); unnumbered entries take the PDF header number.
    * Media next, only for numbers the directory doesn't have: uploads must
      read as a bylaw (header number + enacting/citation clause); per number
      prefer an adopted copy, then a consolidation, then the newest upload.
    * ``source`` = "directory" | "media" | "all" limits what is returned
      (media still defers to directory numbers).
    """
    entries: list[PlanEntry] = []
    skipped: list[Skipped] = []
    taken: set[str] = set()

    def skip(c: Candidate, reason: str, number: str | None = None):
        skipped.append(Skipped(c.src.title, c.src.source, c.src.source_url, reason, number))

    directory_texts: dict[str, str] = {}
    for c in directory:
        if c.error:
            skip(c, f"download/read failed: {c.error}")
            continue
        if not c.text.strip():
            # Scanned: the directory number is trusted; text is transcribed at ingest.
            if c.src.bylaw_number and not c.src.number_unconfirmed and c.src.bylaw_number not in taken:
                taken.add(c.src.bylaw_number)
                if source in ("all", "directory"):
                    entries.append(PlanEntry(c.src.bylaw_number, display_title(c.src.title), "directory",
                                             derive_status(c.src, "", []), c, SCANNED_NOTE))
            else:
                skip(c, "no text layer (scanned PDF) and no listed number", c.src.bylaw_number)
            continue
        number, note = _final_number(c)
        if not number:
            skip(c, "no bylaw number in the title, filename or PDF header")
            continue
        if number in taken:
            skip(c, f"second directory entry for Bylaw {number}", number)
            continue
        taken.add(number)
        directory_texts[text_sha256(c.text)] = number
        if source in ("all", "directory"):
            status = derive_status(c.src, c.text, amendments_from_consolidation(c.text))
            entries.append(PlanEntry(number, planned_title(c.src, c.text, number), "directory", status, c, note))

    groups: dict[str, list[tuple[Candidate, str]]] = {}
    for c in media:
        if c.error:
            skip(c, f"download/read failed: {c.error}")
            continue
        if not c.text.strip():
            skip(c, "no text layer (scanned PDF)", c.src.bylaw_number)
            continue
        same = directory_texts.get(text_sha256(c.text))
        if same:
            skip(c, f"same document as directory Bylaw {same}", c.own_number)
            continue
        number, note = _final_number(c)
        if not number:
            skip(c, "no bylaw number in the PDF (not a bylaw, or a year read as a number)", c.src.bylaw_number)
            continue
        if not looks_like_bylaw(c.text):
            skip(c, "does not read as a bylaw (no enacting/citation clause)", number)
            continue
        if number in taken:
            skip(c, f"Bylaw {number} comes from the directory", number)
            continue
        groups.setdefault(number, []).append((c, note))

    for number, group in groups.items():
        group.sort(key=lambda cn: (cn[0].adopted, cn[0].src.consolidated, cn[0].src.uploaded or ""), reverse=True)
        best, note = group[0]
        for other, _ in group[1:]:
            skip(other, f"another upload of Bylaw {number} was preferred", number)
        if source in ("all", "media"):
            entries.append(
                PlanEntry(number, planned_title(best.src, best.text, number), "media",
                          derive_status(best.src, best.text, []), best, note)
            )
    entries.sort(key=lambda e: (e.source != "directory", int(e.number)))
    return entries, skipped


def load_manifest(folder: str) -> dict:
    path = os.path.join(folder, MANIFEST_NAME)
    if not os.path.exists(path):
        return {}
    with open(path) as fh:
        return json.load(fh)


def save_manifest(folder: str, manifest: dict) -> None:
    path = os.path.join(folder, MANIFEST_NAME)
    tmp = path + ".part"
    with open(tmp, "w") as fh:
        json.dump(manifest, fh, indent=1, sort_keys=True)
    os.replace(tmp, path)


def is_unchanged(
    entry: PlanEntry, *, manifest: dict, existing: dict, file_hash: str | None, stored_text_hash: str | None = None
) -> bool:
    """Resume rule: the row exists with a summary and was ingested from the
    same file (manifest sha256), or (no manifest entry) its stored full_text
    is exactly what this PDF yields."""
    row = existing.get(entry.number)
    if not row or not row.get("has_summary"):
        return False
    m = manifest.get(entry.number)
    if m:
        return bool(file_hash) and m.get("sha256") == file_hash and m.get("bylaw_id") == row["id"]
    return stored_text_hash is not None and stored_text_hash == text_sha256(entry.cand.text)


def existing_bylaws(sb, municipality_id: int) -> dict[str, dict]:
    rows = (
        sb.table("bylaws")
        .select("id, bylaw_number, plain_english_summary, source_url")
        .eq("municipality_id", municipality_id)
        .execute()
        .data
        or []
    )
    return {
        normalize_number(r["bylaw_number"]): {
            "id": r["id"],
            "has_summary": bool(r.get("plain_english_summary")),
            "source_url": r.get("source_url"),
        }
        for r in rows
        if r.get("bylaw_number")
    }


def plan_problems(entries: list[PlanEntry]) -> list[str]:
    counts: dict[str, int] = {}
    for e in entries:
        counts[e.number] = counts.get(e.number, 0) + 1
    problems = [f"duplicate number {n} ({k}x)" for n, k in counts.items() if k > 1]
    problems += [
        f"{e.number}: does not read as a bylaw" for e in entries if e.source == "media" and not looks_like_bylaw(e.cand.text)
    ]
    return problems


def write_plan_md(path: str, entries: list[PlanEntry], skipped: list[Skipped]) -> list[str]:
    """Write the planned list; returns sanity-check problems (empty = OK)."""
    problems = plan_problems(entries)
    by_source = {s: sum(1 for e in entries if e.source == s) for s in ("directory", "media")}
    lines = [
        "# Langford bylaws: bulk ingestion plan",
        "",
        f"{len(entries)} bylaws planned ({by_source['directory']} directory, {by_source['media']} media library); "
        f"{sum(1 for e in entries if e.action == 'unchanged')} already ingested and unchanged; "
        f"{len(skipped)} source PDFs skipped.",
        "",
        "Sanity checks: "
        + (
            "OK (no duplicate numbers; every media entry has a header number and an enacting/citation clause)"
            if not problems
            else "; ".join(problems)
        ),
        "",
        "| # | Bylaw | Title | Source | Status | Action | Chars | Note |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for i, e in enumerate(entries, 1):
        title = e.title.replace("|", "/")
        lines.append(
            f"| {i} | {e.number} | {title} | {e.source} | {e.status or ''} | {e.action} | {len(e.cand.text):,} | {e.note} |"
        )
    lines += ["", "## Skipped source PDFs", "", "| Bylaw | Source | Title | Reason |", "|---|---|---|---|"]
    for k in sorted(skipped, key=lambda k: (k.reason, k.number or "")):
        lines.append(f"| {k.number or ''} | {k.source} | {k.title.replace('|', '/')} | {k.reason} |")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    return problems


def _finalize_path(entry: PlanEntry, folder: str) -> str:
    """Rename the archived PDF when its filename prefix carries a different
    number than the one the PDF header settled on."""
    src = entry.cand.src
    path = entry.cand.path
    if src.bylaw_number == entry.number and not src.number_unconfirmed:
        return path
    src.bylaw_number = entry.number
    src.number_unconfirmed = False
    new = os.path.join(folder, candidate_name(src))
    if path != new:
        if os.path.exists(new):
            os.remove(path)
        else:
            os.replace(path, new)
    entry.cand.path = new
    return new


def run_bulk(
    sb,
    *,
    archive_root: str,
    source: str = "all",
    write: bool = False,
    force: bool = False,
    use_ai: bool = True,
    plan_md: str | None = None,
    only: list[str] | None = None,
    delay: float = DOWNLOAD_DELAY,
) -> dict:
    """Plan, then (with ``write``) ingest every planned bylaw. Idempotent and
    resumable: unchanged rows are skipped unless ``force``; each bylaw is
    isolated so one failure never stops the run."""
    from pipeline.scrapers.langford_bylaws import fetch_directory, fetch_media

    folder = os.path.join(archive_root, "Bylaws")
    muni = municipality_id_for(sb)
    print("[Bylaws] Fetching the directory and media library ...")
    directory_src = fetch_directory()
    media_src = fetch_media("bylaw") if source in ("all", "media") else []
    print(f"[Bylaws] {len(directory_src)} directory entries, {len(media_src)} media candidates")
    directory = prepare_candidates(directory_src, folder, delay=delay)
    media = prepare_candidates(media_src, folder, delay=delay)
    entries, skipped = select_bulk(directory, media, source=source)
    if only:
        wanted = {normalize_number(n) for n in only}
        entries = [e for e in entries if e.number in wanted]

    manifest = load_manifest(folder)
    existing = existing_bylaws(sb, muni)
    adopted_rows = False
    for e in entries:
        if force:
            continue
        row = existing.get(e.number)
        stored_hash = None
        if row and e.number not in manifest:
            data = sb.table("bylaws").select("full_text").eq("id", row["id"]).execute().data
            stored_hash = text_sha256(data[0].get("full_text")) if data else None
        fhash = file_sha256(e.cand.path)
        if is_unchanged(e, manifest=manifest, existing=existing, file_hash=fhash, stored_text_hash=stored_hash):
            e.action = "unchanged"
            if e.number not in manifest:  # adopt a row ingested before the manifest existed
                manifest[e.number] = {"sha256": fhash, "bylaw_id": row["id"], "source_url": e.cand.src.source_url}
                adopted_rows = True

    if plan_md:
        problems = write_plan_md(plan_md, entries, skipped)
        print(f"[Bylaws] Plan written to {plan_md}" + (f"  PROBLEMS: {problems}" if problems else " (sanity checks OK)"))
    todo = [e for e in entries if e.action == "ingest"]
    print(
        f"[Bylaws] {len(entries)} planned, {len(todo)} to ingest, {len(entries) - len(todo)} unchanged, "
        f"{len(skipped)} source PDFs skipped"
    )
    result = {"planned": len(entries), "to_ingest": len(todo), "skipped": len(skipped), "written": 0, "chunks": 0,
              "failed": []}
    if not write:
        return result

    if adopted_rows:
        save_manifest(folder, manifest)
    for i, e in enumerate(todo, 1):
        try:
            path = _finalize_path(e, folder)
            if not e.cand.text.strip():
                if not use_ai:
                    raise RuntimeError("scanned PDF needs AI transcription (--no-ai given)")
                e.cand.text = transcribe_scanned(path)
                if len(e.cand.text.strip()) < 200:
                    raise RuntimeError(f"transcription too short ({len(e.cand.text)} chars)")
            record = build_record(
                e.cand.src, path, archive_root=archive_root, municipality_id=muni, use_ai=use_ai, text=e.cand.text
            )
            record["bylaw_number"] = e.number
            record["title"] = e.title
            bylaw_id, n = upsert_bylaw(sb, record)
            manifest[e.number] = {
                "sha256": file_sha256(path),
                "bylaw_id": bylaw_id,
                "source_url": e.cand.src.source_url,
                "chunks": n,
                "file": os.path.basename(path),
            }
            save_manifest(folder, manifest)
            result["written"] += 1
            result["chunks"] += n
            print(f"  [{i}/{len(todo)}] Bylaw {e.number} -> bylaws.id={bylaw_id}, {n} chunks  {e.title[:60]}")
        except Exception as ex:  # isolate: log and keep going
            result["failed"].append((e.number, f"{type(ex).__name__}: {ex}"))
            print(f"  [{i}/{len(todo)}] [!] Bylaw {e.number} failed: {type(ex).__name__}: {ex}")
    print(f"[Bylaws] wrote {result['written']} bylaw(s), {result['chunks']} chunks; {len(result['failed'])} failed")
    return result



def load_bylaws_for_linking(sb, municipality_id: int) -> list[dict]:
    """Bylaw rows plus the amendment numbers their consolidations list."""
    ids = [
        r["id"]
        for r in sb.table("bylaws").select("id").eq("municipality_id", municipality_id).order("id").execute().data or []
    ]
    out: list[dict] = []
    for i in range(0, len(ids), 10):  # full_text is large: small pages
        rows = (
            sb.table("bylaws")
            .select("id, bylaw_number, title, year, status, slug, full_text")
            .in_("id", ids[i : i + 10])
            .execute()
            .data
            or []
        )
        for r in rows:
            r["amendments"] = [a["bylaw_number"] for a in amendments_from_consolidation(r.pop("full_text", None))]
            out.append(r)
    return out


def link_all(sb, *, municipality_id: int, write: bool, sample_md: str | None = None, sample_size: int = 25,
             seed: int = 1) -> dict:
    """Plan (and with ``write``, set) matters.bylaw_id for every matter.
    Never overwrites a different non-null bylaw_id: those are listed as conflicts."""
    import random

    from pipeline.ingestion.bylaw_matter_links import plan_all_links

    bylaws = load_bylaws_for_linking(sb, municipality_id)
    matters = load_matters(sb, municipality_id)
    links, ambiguous = plan_all_links(matters, bylaws)
    by_number = {normalize_number(b["bylaw_number"]): b for b in bylaws if b.get("bylaw_number")}
    new = [l for l in links if not l.conflict and not l.unchanged]
    unchanged = [l for l in links if l.unchanged]
    conflicts = [l for l in links if l.conflict]
    via_counts: dict[str, int] = {}
    for l in links:
        if not l.conflict:
            via_counts[l.via] = via_counts.get(l.via, 0) + 1
    per_bylaw: dict[str, int] = {}
    for l in links:
        if not l.conflict:
            per_bylaw[l.bylaw_number] = per_bylaw.get(l.bylaw_number, 0) + 1

    print(f"[Links] {len(matters)} matters, {len(bylaws)} bylaws: {len(new)} new links, {len(unchanged)} already set, "
          f"{len(conflicts)} conflicts, {len(ambiguous)} ambiguous; by rule {via_counts}")
    for l in conflicts:
        print(f"  [conflict] matter {l.matter_id} is linked to bylaws.id={l.current_bylaw_id}; plan says "
              f"{l.bylaw_number} (id {l.bylaw_id}) - {l.title[:80]}")

    if sample_md:
        rng = random.Random(seed)
        sample = rng.sample(links, min(sample_size, len(links)))
        sample.sort(key=lambda l: l.matter_id)
        lines = [
            "# Langford bylaws: matter-link plan",
            "",
            f"- Matters: {len(matters)}; bylaw rows: {len(bylaws)}",
            f"- Planned links: {len(links)} ({len(new)} new, {len(unchanged)} already set, {len(conflicts)} conflicts)",
            f"- By rule: " + ", ".join(f"{k} {v}" for k, v in sorted(via_counts.items(), key=lambda kv: _via_order(kv[0]))),
            f"- Ambiguous (aliases point at different bylaws, not linked): {len(ambiguous)}",
            "",
            "Rules: `own` = the matter's own bylaw (identifier, else title) has a row; `consolidated` = its own "
            "amendment bylaw has no row but is listed in a consolidation; `amends` = title says amend and names the "
            "parent by number; `amends-name` = title says amend and names exactly one current bylaw by name, "
            "enacted before the matter began.",
            "",
            "## Links per bylaw",
            "",
            "| Bylaw | Title | Matters |",
            "|---|---|---|",
        ]
        for n, k in sorted(per_bylaw.items(), key=lambda kv: -kv[1]):
            lines.append(f"| {n} | {(by_number.get(n) or {}).get('title', '')} | {k} |")
        lines += ["", f"## Random sample of {len(sample)} links (seed {seed})", "",
                  "| Matter | Identifier | Matter title | Bylaw | Bylaw title | Rule | Detail |", "|---|---|---|---|---|---|---|"]
        matter_by_id = {m["id"]: m for m in matters}
        for l in sample:
            m = matter_by_id[l.matter_id]
            lines.append(
                f"| {l.matter_id} | {(m.get('identifier') or '').replace('|', '/')} | {l.title[:110].replace('|', '/')} | "
                f"{l.bylaw_number} | {(by_number.get(l.bylaw_number) or {}).get('title', '')[:70]} | {l.via} | {l.detail} |"
            )
        lines += ["", "## Conflicts (existing different bylaw_id; not overwritten)", ""]
        lines += [f"- matter {l.matter_id} ({l.title[:90]}): has bylaws.id={l.current_bylaw_id}, plan {l.bylaw_number} "
                  f"(id {l.bylaw_id})" for l in conflicts] or ["None."]
        lines += ["", "## Ambiguous", ""]
        lines += [f"- matter {a['matter_id']} ({(a['title'] or '')[:90]}): {a['numbers']}" for a in ambiguous] or ["None."]
        os.makedirs(os.path.dirname(os.path.abspath(sample_md)), exist_ok=True)
        with open(sample_md, "w") as fh:
            fh.write("\n".join(lines) + "\n")
        print(f"[Links] Plan written to {sample_md}")

    written = 0
    if write and new:
        groups: dict[int, list[int]] = {}
        for l in new:
            groups.setdefault(l.bylaw_id, []).append(l.matter_id)
        for bylaw_id, mids in groups.items():
            for i in range(0, len(mids), 200):
                # Guard against a concurrent writer: only rows still unlinked.
                sb.table("matters").update({"bylaw_id": bylaw_id}).in_("id", mids[i : i + 200]).is_("bylaw_id", "null").execute()
            written += len(mids)
        print(f"[Links] linked {written} matter(s)")
    return {"links": len(links), "new": len(new), "written": written, "unchanged": len(unchanged),
            "conflicts": [(l.matter_id, l.current_bylaw_id, l.bylaw_id) for l in conflicts], "ambiguous": len(ambiguous),
            "by_rule": via_counts}


def _via_order(via: str) -> int:
    from pipeline.ingestion.bylaw_matter_links import VIA_RANK

    return VIA_RANK.get(via, 9)


# ── CLI ──────────────────────────────────────────────────────────────────


def default_archive_root() -> str:
    return os.environ.get("LANGFORD_ARCHIVE_ROOT") or get_municipality_archive_root(MUNICIPALITY_SLUG)


def main(argv: list[str] | None = None):
    p = argparse.ArgumentParser(description="Ingest Langford bylaws")
    p.add_argument("--bylaw", help="Only this bylaw number")
    p.add_argument("--all", action="store_true", help="Bulk: every bylaw on the directory and in the media library")
    p.add_argument("--source", choices=("all", "directory", "media"), default="all", help="With --all: which source")
    p.add_argument("--force", action="store_true", help="With --all: re-ingest rows whose PDF is unchanged")
    p.add_argument("--only", help="With --all: comma-separated bylaw numbers to (re)ingest")
    p.add_argument("--plan-md", help="With --all: write the planned list (number, title, source, status) here")
    p.add_argument("--links-md", help="With --link-all: write link counts and a random sample here")
    p.add_argument("--link-all", action="store_true", help="Plan (with --write, set) matters.bylaw_id for every bylaw")
    p.add_argument("--write", action="store_true", help="Write to the database (default: dry run)")
    p.add_argument("--link", action="store_true", help="Plan (and with --write, set) matters.bylaw_id")
    p.add_argument("--no-ai", action="store_true", help="Skip the AI summary (dry runs)")
    p.add_argument("--archive-dir", help="Municipality archive root (default: $LANGFORD_ARCHIVE_ROOT or <repo>/archive/langford)")
    args = p.parse_args(argv)

    archive_root = args.archive_dir or default_archive_root()
    if args.all or args.link_all:
        from pipeline.ai.usage import usage_context

        sb = _client()
        if args.write and not args.no_ai:
            from pipeline.ai.usage_sink import install_usage_logging

            install_usage_logging()
        with usage_context(job="bylaws"):
            _bulk_cli(sb, args, archive_root)
        return
    if not args.bylaw:
        sys.exit("Pass --bylaw <number>, --all (bulk) or --link-all.")
    _single_cli(args, archive_root)


def _bulk_cli(sb, args, archive_root: str) -> None:
    if args.all:
        run_bulk(sb, archive_root=archive_root, source=args.source, write=args.write, force=args.force,
                 use_ai=not args.no_ai, plan_md=args.plan_md,
                 only=[n.strip() for n in args.only.split(",")] if args.only else None)
    if args.link_all:
        link_all(sb, municipality_id=municipality_id_for(sb), write=args.write, sample_md=args.links_md)


def _single_cli(args, archive_root: str) -> None:
    sources = fetch_sources(args.bylaw)
    if not sources:
        sys.exit(f"No PDF found for Bylaw {args.bylaw} on the directory or in the media library")
    src = sources[0]
    print(f"Source: {src.title} <{src.source_url}> ({src.source})")
    path = download(src, os.path.join(archive_root, "Bylaws"))
    print(f"PDF: {path}")

    sb = _client()
    muni = municipality_id_for(sb)
    record = build_record(src, path, archive_root=archive_root, municipality_id=muni, use_ai=not args.no_ai)
    preview = {k: v for k, v in record.items() if k != "full_text"}
    preview["full_text_chars"] = len(record["full_text"])
    import json as _json

    print(_json.dumps(preview, indent=2, ensure_ascii=False))

    bylaw_id = None
    if args.write:
        bylaw_id, n_chunks = upsert_bylaw(sb, record)
        print(f"-> bylaws.id={bylaw_id}, {n_chunks} chunks")
    else:
        existing = (
            sb.table("bylaws").select("id").eq("municipality_id", muni).eq("bylaw_number", record["bylaw_number"]).execute().data
        )
        bylaw_id = existing[0]["id"] if existing else None

    if args.link and record["bylaw_number"]:
        link_matters(
            sb,
            municipality_id=muni,
            bylaw_id=bylaw_id,
            number=record["bylaw_number"],
            amendments=amendments_from_consolidation(record["full_text"]),
            write=args.write,
        )


if __name__ == "__main__":
    main()
