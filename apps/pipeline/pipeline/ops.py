"""Operational bookkeeping for pipeline discovery and worker jobs.

source_meetings.status lifecycle
================================
Written by the scrapers/orchestrator (discovery, document sync), the job
worker (worker.py) and the one-off scheduling of future meetings. The admin
page (/admin/pipeline) maps these to plain-language labels
(apps/web/app/lib/pipeline-status.ts); keep the two in sync.

  status               written by                         meaning
  -------------------  ---------------------------------  ------------------------------------------
  discovered           upsert_source_meetings (scrape)    Listed by the source; documents not fetched yet
  documents_downloaded orchestrator._sync_documents,      Agenda/minutes files are in the local archive
                       worker sync_documents/sync_media
  media_downloaded     worker sync_media                  Audio downloaded too
  diarized             worker diarize_meeting             Transcribed/diarized, ingest may follow
  ingested             mark_source_meeting_ingested       TERMINAL SUCCESS: a public meeting row exists
                       (worker + orchestrator)            and has agenda items / minutes / transcript
  extracted            legacy (worker, pre-helper)        Same as ingested; backfilled to ingested
  scheduled            calendar sync (future meetings)    Future meeting known, nothing to ingest yet
  cancelled            source_document_status             Source lists only a cancellation notice
  postponed            source_document_status             Source lists only a postponement notice
  (job failures are not stored here; they surface via pipeline_jobs.status)

Rules: upsert_source_meetings never regresses ingested/extracted rows, and
mark_source_meeting_ingested never touches cancelled/postponed rows.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from supabase import Client

from pipeline.scrapers.base import MunicipalityConfig, ScrapedMeeting


def source_document_status(meeting: ScrapedMeeting, default: str) -> str:
    """Distinguish cancelled/postponed listings from meetings awaiting ingestion."""
    if any(
        (doc.category or "").lower() in {"agenda", "minutes"}
        for doc in meeting.documents
    ):
        return default
    titles = " ".join(doc.title.lower() for doc in meeting.documents)
    if "postpon" in titles:
        return "postponed"
    if "cancel" in titles:
        return "cancelled"
    return default


def meeting_source_record(
    municipality: MunicipalityConfig,
    source_type: str,
    meeting: ScrapedMeeting,
    archive_path: str | None = None,
    status: str = "discovered",
) -> dict[str, Any]:
    source_id = meeting.source_id or f"{meeting.date.isoformat()}:{meeting.title}"
    raw = dict(meeting.meta or {})
    raw.setdefault("documents", [doc.__dict__ for doc in meeting.documents])

    return {
        "municipality_id": municipality.id,
        "source_type": source_type,
        "source_id": source_id,
        "meeting_date": meeting.date.isoformat(),
        "title": meeting.title,
        "meeting_type": meeting.meeting_type,
        "source_url": meeting.agenda_url or meeting.minutes_url or meeting.video_url,
        "video_url": meeting.video_url,
        "archive_path": archive_path,
        "raw": raw,
        "status": source_document_status(meeting, status),
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }


def upsert_source_meetings(
    supabase: Client,
    municipality: MunicipalityConfig,
    source_type: str,
    records: list[dict[str, Any]],
) -> int:
    if not records:
        return 0

    archive_paths = sorted(
        {
            record["archive_path"]
            for record in records
            if record.get("archive_path")
        }
    )
    if archive_paths:
        # Archive paths are long and PostgREST puts this filter in the URL.
        # Bound each lookup to avoid gateway rejection of large inventories.
        meetings = []
        for start in range(0, len(archive_paths), 20):
            meetings.extend(
                supabase.table("meetings")
                .select("id, archive_path")
                .eq("municipality_id", municipality.id)
                .in_("archive_path", archive_paths[start : start + 20])
                .execute()
                .data
                or []
            )
        meetings_by_path = {meeting["archive_path"]: meeting["id"] for meeting in meetings}
        for record in records:
            meeting_id = meetings_by_path.get(record.get("archive_path"))
            if meeting_id:
                record["ingested_meeting_id"] = meeting_id

    # Discovery and document sync are repeatable. Do not regress a completed
    # source to "discovered" merely because it appeared in the next scrape.
    for start in range(0, len(records), 100):
        batch = records[start : start + 100]
        existing = (
            supabase.table("source_meetings")
            .select("source_id,status,ingested_meeting_id")
            .eq("municipality_id", municipality.id)
            .eq("source_type", source_type)
            .in_("source_id", [record["source_id"] for record in batch])
            .execute()
            .data
            or []
        )
        existing_by_id = {row["source_id"]: row for row in existing}
        for record in batch:
            prior = existing_by_id.get(record["source_id"])
            if not prior:
                continue
            if prior.get("ingested_meeting_id") and not record.get("ingested_meeting_id"):
                record["ingested_meeting_id"] = prior["ingested_meeting_id"]
            if (
                prior["status"] in {"ingested", "extracted"}
                and record["status"] in {"discovered", "documents_downloaded"}
            ):
                record["status"] = prior["status"]

    result = (
        supabase.table("source_meetings")
        .upsert(records, on_conflict="municipality_id,source_type,source_id")
        .execute()
    )
    return len(result.data or records)


def record_job_event(
    supabase: Client,
    job_id: int,
    message: str,
    level: str = "info",
    data: dict[str, Any] | None = None,
) -> None:
    supabase.table("pipeline_run_events").insert(
        {
            "job_id": job_id,
            "level": level,
            "message": message,
            "data": data or {},
        }
    ).execute()


# Statuses the ingest helper must never overwrite: the source itself says
# the meeting did not happen as listed.
_NOT_HELD_STATUSES = {"cancelled", "postponed"}


def mark_source_meeting_ingested(
    supabase: Client,
    meeting_id: int,
    source_meeting_id: int | None = None,
) -> bool:
    """Mark the source_meetings row for a public meeting as 'ingested'.

    The single place that records a successful ingest, used by both the job
    worker and the CLI/orchestrator path. Links ingested_meeting_id too.
    Only acts if the meeting actually has content (agenda items, minutes or
    a transcript), so a bare scheduled placeholder stays as it is. Returns
    True if a source row now says 'ingested'.
    """
    meeting_rows = (
        supabase.table("meetings")
        .select("id, municipality_id, archive_path, has_minutes, has_transcript")
        .eq("id", meeting_id)
        .execute()
        .data
        or []
    )
    if not meeting_rows:
        return False
    meeting = meeting_rows[0]

    has_content = bool(meeting.get("has_minutes") or meeting.get("has_transcript"))
    if not has_content:
        items = (
            supabase.table("agenda_items")
            .select("id", count="exact")
            .eq("meeting_id", meeting_id)
            .limit(1)
            .execute()
        )
        has_content = bool(items.count)
    if not has_content:
        return False

    def find(**filters):
        query = supabase.table("source_meetings").select("id, status, ingested_meeting_id")
        for column, value in filters.items():
            query = query.eq(column, value)
        return query.execute().data or []

    if source_meeting_id:
        sources = find(id=source_meeting_id)
    else:
        sources = find(ingested_meeting_id=meeting_id)
        if not sources and meeting.get("archive_path"):
            sources = find(
                municipality_id=meeting["municipality_id"],
                archive_path=meeting["archive_path"],
            )

    marked = False
    for source in sources:
        if source["status"] in _NOT_HELD_STATUSES:
            continue
        if source["status"] != "ingested" or source.get("ingested_meeting_id") != meeting_id:
            supabase.table("source_meetings").update(
                {"status": "ingested", "ingested_meeting_id": meeting_id}
            ).eq("id", source["id"]).execute()
        marked = True
    return marked
