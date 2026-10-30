#!/usr/bin/env python3
"""Sync Langford pre-2021 agenda/minutes PDFs from langford.ca.

The current eSCRIBE source starts in 2021. Langford keeps older council
agenda/minutes links on a WordPress page whose old URLs point at a retired
staging host. This script parses the desktop table, rewrites retired links to
the current langford.ca host, downloads PDFs into the normal archive tree, and
optionally queues ingest jobs by archive path.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote, urljoin, urlparse
from urllib.request import Request, urlopen

PIPELINE_DIR = Path(__file__).resolve().parents[1]
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))


PAGE_URL = "https://langford.ca/city-hall/agendas-and-minutes/"
OLD_HOST = "cityoflangford.eclipsedev.tk"
CURRENT_HOST = "langford.ca"
USER_AGENT = "ViewRoyal.ai archive sync (+https://viewroyal.ai)"


@dataclass
class LegacyDocument:
    title: str
    original_url: str
    url: str
    section: str
    category: str
    filename: str


@dataclass
class LegacyMeeting:
    date: str
    year: int
    title: str
    meeting_type: str
    archive_path: str
    source_id: str
    documents: list[LegacyDocument] = field(default_factory=list)


def fetch_text(url: str, timeout: int = 60) -> str:
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def fetch_bytes(url: str, timeout: int = 180) -> bytes:
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=timeout) as response:
        return response.read()


def clean_text(value: str) -> str:
    value = re.sub(r"<[^>]+>", " ", value)
    value = html.unescape(value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def normalize_url(url: str) -> str:
    url = html.unescape(url.strip())
    url = url.rstrip('"')
    url = urljoin(PAGE_URL, url)
    parsed = urlparse(url)
    if parsed.netloc == OLD_HOST:
        parsed = parsed._replace(scheme="https", netloc=CURRENT_HOST)
    return parsed.geturl()


def safe_filename(value: str) -> str:
    value = unquote(value)
    value = value.replace("/", "-").replace("\\", "-")
    value = re.sub(r"[\x00-\x1f:]+", "-", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value or "document.pdf"


def category_for(section: str, title: str, url: str) -> str:
    text = f"{section} {title} {url}".lower()
    if "minute" in text or "signed" in text:
        return "Minutes"
    if "agenda" in text or "notice" in text:
        return "Agenda"
    return "Other Documents"


def infer_meeting_type(text: str) -> str:
    lowered = text.lower()
    if "public hearing" in lowered:
        return "Public Hearing"
    if "special" in lowered:
        return "Special Council"
    return "Regular Council"


def parse_date(year: int, value: str) -> str:
    cleaned = clean_text(value)
    for fmt in ("%B %d %Y", "%b %d %Y"):
        try:
            return datetime.strptime(f"{cleaned} {year}", fmt).date().isoformat()
        except ValueError:
            continue
    raise ValueError(f"Could not parse meeting date: year={year} value={value!r}")


def parse_links(cell_html: str, section: str) -> list[LegacyDocument]:
    docs: list[LegacyDocument] = []
    for href, body in re.findall(
        r"<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>",
        cell_html,
        flags=re.IGNORECASE | re.DOTALL,
    ):
        if ".pdf" not in href.lower():
            continue
        original_url = html.unescape(href.strip())
        url = normalize_url(original_url)
        title = clean_text(body) or Path(urlparse(url).path).name
        filename = safe_filename(Path(urlparse(url).path).name)
        docs.append(
            LegacyDocument(
                title=title,
                original_url=original_url,
                url=url,
                section=section,
                category=category_for(section, title, url),
                filename=filename,
            )
        )
    return docs


def parse_meetings(page_html: str, archive_root: Path) -> list[LegacyMeeting]:
    desktop_html = page_html.split('<div class="table-cards-top', 1)[0]
    rows = re.findall(
        r'(<div class="table-row alignfull (?:odd|even)" year="(\d{4})".*?)(?=<div class="clear"></div>)',
        desktop_html,
        flags=re.IGNORECASE | re.DOTALL,
    )

    meetings: list[LegacyMeeting] = []
    seen_docs: set[tuple[str, str]] = set()
    for row_html, year_raw in rows:
        year = int(year_raw)
        cells = re.findall(
            r'<div class="table-cell[^"]*">\s*<p class="black">(.*?)</p>\s*</div>',
            row_html,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if len(cells) < 4:
            continue

        date = parse_date(year, cells[1])
        date_text = datetime.fromisoformat(date).strftime("%B %-d")
        docs = parse_links(cells[2], "Agendas") + parse_links(cells[3], "Minutes")
        if not docs:
            continue

        meeting_type = infer_meeting_type(" ".join(doc.title for doc in docs))
        folder_type = meeting_type
        folder_name = f"{date} {folder_type} [legacy]"
        rel_path = Path("archive") / "langford" / "Council" / str(year) / date[5:7] / folder_name
        meeting = LegacyMeeting(
            date=date,
            year=year,
            title=f"{date_text} {folder_type}",
            meeting_type=meeting_type,
            archive_path=str(rel_path),
            source_id=f"legacy:{date}:{meeting_type.lower().replace(' ', '-')}",
        )

        for doc in docs:
            key = (date, doc.url)
            if key in seen_docs:
                continue
            seen_docs.add(key)
            meeting.documents.append(doc)

        meetings.append(meeting)

    return meetings


def write_manifest(meetings: Iterable[LegacyMeeting], manifest_path: Path) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("w", encoding="utf-8") as handle:
        for meeting in meetings:
            record = {
                "date": meeting.date,
                "title": meeting.title,
                "meeting_type": meeting.meeting_type,
                "source_id": meeting.source_id,
                "archive_path": meeting.archive_path,
                "documents": [doc.__dict__ for doc in meeting.documents],
            }
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def write_queue_sql(
    meetings: Iterable[LegacyMeeting],
    sql_path: Path,
    municipality_id: int,
    requested_by: str,
) -> None:
    sql_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "-- Queue Langford legacy meeting ingest jobs.",
        "-- Generated by apps/pipeline/scripts/sync_langford_legacy_meetings.py",
        "INSERT INTO pipeline_jobs (municipality_id, job_type, args, priority, requested_by)",
        "VALUES",
    ]
    values = []
    for meeting in meetings:
        args = json.dumps({
            "archive_path": meeting.archive_path,
            "force": True,
            "skip_diarization": True,
        })
        values.append(
            "  "
            + ", ".join(
                [
                    f"({municipality_id}",
                    sql_literal("ingest_meeting"),
                    sql_literal(args) + "::jsonb",
                    "-10",
                    sql_literal(requested_by) + ")",
                ]
            )
        )
    lines.append(",\n".join(values) + ";")
    sql_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def download_documents(meetings: Iterable[LegacyMeeting], project_root: Path, delay: float) -> dict:
    stats = {"downloaded": 0, "skipped": 0, "failed": 0}
    for meeting in meetings:
        meeting_root = project_root / meeting.archive_path
        for doc in meeting.documents:
            target_dir = meeting_root / doc.category
            target_dir.mkdir(parents=True, exist_ok=True)
            target_path = target_dir / doc.filename
            if target_path.exists() and target_path.stat().st_size > 0:
                stats["skipped"] += 1
                continue

            try:
                data = fetch_bytes(doc.url)
                target_path.write_bytes(data)
                target_path.with_suffix(target_path.suffix + ".url").write_text(
                    doc.url,
                    encoding="utf-8",
                )
                stats["downloaded"] += 1
                print(f"[+] {meeting.date} {doc.category}: {doc.filename}")
                if delay:
                    time.sleep(delay)
            except Exception as exc:
                stats["failed"] += 1
                print(f"[!] {meeting.date} {doc.url}: {exc}", file=sys.stderr)
    return stats


def load_dotenv(env_path: Path) -> None:
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def queue_jobs(meetings: Iterable[LegacyMeeting], municipality_id: int, requested_by: str) -> int:
    from pipeline import config

    active_paths = get_active_job_paths(config, municipality_id)
    rows = [
        {
            "municipality_id": municipality_id,
            "job_type": "ingest_meeting",
            "args": {
                "archive_path": meeting.archive_path,
                "force": True,
                "skip_diarization": True,
            },
            "priority": -10,
            "requested_by": requested_by,
        }
        for meeting in meetings
        if meeting.archive_path not in active_paths
    ]
    if not rows:
        return 0
    return insert_jobs(config, rows)


def get_active_job_paths(config, municipality_id: int) -> set[str]:
    supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
    if config.SUPABASE_URL and supabase_key:
        try:
            from supabase import create_client

            supabase = create_client(config.SUPABASE_URL, supabase_key)
            existing = (
                supabase.table("pipeline_jobs")
                .select("args")
                .eq("municipality_id", municipality_id)
                .in_("status", ["queued", "running"])
                .execute()
                .data
                or []
            )
            return {
                row.get("args", {}).get("archive_path")
                for row in existing
                if isinstance(row.get("args"), dict)
            }
        except Exception as exc:
            print(f"[i] Supabase REST unavailable, trying DATABASE_URL: {exc}", file=sys.stderr)

    return get_active_job_paths_via_database(config, municipality_id)


def get_active_job_paths_via_database(config, municipality_id: int) -> set[str]:
    if not config.DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required when Supabase REST is unavailable")

    import psycopg2

    with psycopg2.connect(config.DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT args->>'archive_path'
                FROM pipeline_jobs
                WHERE municipality_id = %s
                  AND status IN ('queued', 'running')
                  AND args ? 'archive_path'
                """,
                (municipality_id,),
            )
            return {row[0] for row in cur.fetchall() if row[0]}


def insert_jobs(config, rows: list[dict]) -> int:
    supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
    if config.SUPABASE_URL and supabase_key:
        try:
            from supabase import create_client

            supabase = create_client(config.SUPABASE_URL, supabase_key)
            result = supabase.table("pipeline_jobs").insert(rows).execute()
            return len(result.data or rows)
        except Exception as exc:
            print(f"[i] Supabase REST insert unavailable, trying DATABASE_URL: {exc}", file=sys.stderr)

    if not config.DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required when Supabase REST is unavailable")

    import psycopg2
    from psycopg2.extras import Json, execute_values

    from pipeline import db

    values = [
        (
            row["municipality_id"],
            row["job_type"],
            Json(row["args"]),
            row["priority"],
            row["requested_by"],
        )
        for row in rows
    ]
    db.run_write(
        lambda cur: execute_values(
            cur,
            """
            INSERT INTO pipeline_jobs
                (municipality_id, job_type, args, priority, requested_by)
            VALUES %s
            """,
            values,
        ),
        opener=lambda: psycopg2.connect(config.DATABASE_URL),
    )
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--page-url", default=PAGE_URL)
    parser.add_argument("--project-root", default=".")
    parser.add_argument("--archive-root", default="archive/langford")
    parser.add_argument("--manifest", default="data/langford/legacy-meetings-manifest.jsonl")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--queue", action="store_true")
    parser.add_argument("--queue-sql", default="data/langford/legacy-ingest-jobs.sql")
    parser.add_argument("--municipality-id", type=int, default=1)
    parser.add_argument("--requested-by", default="legacy-sync")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--delay", type=float, default=0.05)
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    page_html = fetch_text(args.page_url)
    meetings = parse_meetings(page_html, project_root / args.archive_root)
    if args.limit:
        meetings = meetings[: args.limit]

    manifest_path = project_root / args.manifest
    write_manifest(meetings, manifest_path)

    doc_count = sum(len(meeting.documents) for meeting in meetings)
    print(f"manifest={manifest_path}")
    print(f"meetings={len(meetings)} documents={doc_count}")
    if meetings:
        print(f"date_range={meetings[-1].date}..{meetings[0].date}")

    if args.download:
        stats = download_documents(meetings, project_root, args.delay)
        print(f"downloaded={stats['downloaded']} skipped={stats['skipped']} failed={stats['failed']}")

    queue_sql_path = project_root / args.queue_sql
    write_queue_sql(meetings, queue_sql_path, args.municipality_id, args.requested_by)
    print(f"queue_sql={queue_sql_path}")

    if args.queue:
        load_dotenv(project_root / ".env")
        queued = queue_jobs(meetings, args.municipality_id, args.requested_by)
        print(f"queued={queued}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
