"""Pipeline ops worker.

This is intentionally small for the first admin-console iteration: it claims one
queued job at a time and runs safe, bounded pipeline operations.
"""

from __future__ import annotations

import argparse
import contextlib
import os
import ssl
import socket
import sys
import threading
import time
import traceback
from datetime import datetime, timezone

from supabase import create_client

from pipeline import config
from pipeline.email_outbox import EmailEnqueuePersistenceError, DELIVERY_WINDOW, record_email_enqueue
from pipeline.ops import record_job_event
from pipeline.orchestrator import Archiver, load_municipality_by_id


R2_ENV_KEYS = ("R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT_URL")


def get_supabase():
    supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
    if not config.SUPABASE_URL or not supabase_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY/SUPABASE_KEY are required")
    return create_client(config.SUPABASE_URL, supabase_key)


def has_env(name: str) -> bool:
    return bool(os.environ.get(name))


def preflight(supabase, municipality) -> dict:
    from pipeline.paths import get_municipality_archive_root

    checks = {
        "supabase_url": bool(config.SUPABASE_URL),
        "supabase_write_key": bool(config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY),
        "database_url": bool(config.DATABASE_URL),
        "openai_api_key": bool(config.OPENAI_API_KEY),
        "request_ca_bundle": bool(os.environ.get("REQUESTS_CA_BUNDLE")),
        "default_verify_paths": ssl.get_default_verify_paths()._asdict(),
        "archive_root": get_municipality_archive_root(municipality.slug),
        "r2_images": all(has_env(key) for key in R2_ENV_KEYS),
        "diarization_device": config.DIARIZATION_DEVICE,
    }

    source_count = (
        supabase.table("source_meetings")
        .select("*", count="exact", head=True)
        .eq("municipality_id", municipality.id)
        .execute()
        .count
        or 0
    )
    meeting_count = (
        supabase.table("meetings")
        .select("*", count="exact", head=True)
        .eq("municipality_id", municipality.id)
        .execute()
        .count
        or 0
    )
    checks["source_meetings"] = source_count
    checks["ingested_meetings"] = meeting_count

    required = (
        checks["supabase_url"]
        and checks["supabase_write_key"]
        and checks["database_url"]
        and checks["openai_api_key"]
    )
    checks["ok_for_discovery"] = checks["supabase_url"] and checks["supabase_write_key"]
    checks["ok_for_extraction"] = required
    checks["warnings"] = []
    if not checks["r2_images"]:
        checks["warnings"].append("R2 image upload env is incomplete; document images will be skipped.")
    if not checks["request_ca_bundle"]:
        checks["warnings"].append("REQUESTS_CA_BUNDLE is not set; eSCRIBE TLS may fail on local Python.")
    return checks


def claim_job(supabase, worker_id: str, job_types: list[str] | None = None):
    params = {"worker_id": worker_id, "job_types": job_types}
    result = supabase.rpc("claim_next_pipeline_job", params).execute()
    jobs = result.data or []
    return jobs[0] if jobs else None


def finish_job(supabase, job_id: int, status: str, result=None, error: str | None = None, recovery_args=None):
    payload = {
        "status": status,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "locked_by": None,
        "locked_at": None,
        "last_error": error,
        "result": result or {},
    }
    if recovery_args is not None:
        payload['args'] = recovery_args
    supabase.table("pipeline_jobs").update(payload).eq("id", job_id).execute()


def heartbeat_job(supabase, job_id: int):
    supabase.table("pipeline_jobs").update(
        {"locked_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", job_id).eq("status", "running").execute()


def start_heartbeat(supabase, job_id: int, interval: float):
    stop_event = threading.Event()

    def _beat():
        while not stop_event.wait(interval):
            try:
                heartbeat_job(supabase, job_id)
            except Exception as exc:
                print(f"[worker] heartbeat failed for job {job_id}: {exc}", file=sys.stderr)

    thread = threading.Thread(target=_beat, daemon=True)
    thread.start()
    return stop_event, thread


class EventStream:
    """File-like stream that mirrors terminal output into pipeline events."""

    def __init__(self, supabase, job_id: int, level: str, original):
        self.supabase = supabase
        self.job_id = job_id
        self.level = level
        self.original = original
        self._buffer = ""

    def write(self, text: str):
        self.original.write(text)
        self.original.flush()
        self._buffer += text
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            self._record(line)
        return len(text)

    def flush(self):
        self.original.flush()
        if self._buffer.strip():
            self._record(self._buffer)
            self._buffer = ""

    def _record(self, line: str):
        message = line.strip()
        if not message:
            return
        record_job_event(
            self.supabase,
            self.job_id,
            message[:1000],
            level=self.level,
            data={"stream": self.level},
        )


@contextlib.contextmanager
def capture_job_output(supabase, job_id: int):
    stdout = EventStream(supabase, job_id, "info", sys.stdout)
    stderr = EventStream(supabase, job_id, "warning", sys.stderr)
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            yield
        finally:
            stdout.flush()
            stderr.flush()


def _absolute_archive_path(archive_path: str) -> str:
    from pipeline.paths import BASE_DIR

    if os.path.isabs(archive_path):
        return archive_path
    return os.path.join(BASE_DIR, archive_path)


def _get_source_meeting(supabase, source_meeting_id: int) -> dict:
    result = (
        supabase.table("source_meetings")
        .select("*")
        .eq("id", source_meeting_id)
        .single()
        .execute()
    )
    if not result.data:
        raise ValueError(f"source_meeting_id not found: {source_meeting_id}")
    return result.data


def _resolve_archive_path(supabase, args: dict) -> tuple[str, int | None, int | None]:
    """Return (absolute archive path, meeting id, source meeting id)."""
    source_meeting_id = args.get("source_meeting_id")
    if source_meeting_id:
        source = _get_source_meeting(supabase, int(source_meeting_id))
        archive_path = source.get("archive_path")
        if not archive_path:
            raise ValueError(f"source_meeting_id {source_meeting_id} has no archive_path")
        return (
            _absolute_archive_path(archive_path),
            source.get("ingested_meeting_id"),
            source["id"],
        )

    meeting_id = args.get("meeting_id")
    if meeting_id:
        result = (
            supabase.table("meetings")
            .select("id, archive_path")
            .eq("id", int(meeting_id))
            .single()
            .execute()
        )
        if not result.data or not result.data.get("archive_path"):
            raise ValueError(f"meeting_id {meeting_id} not found or has no archive_path")
        return _absolute_archive_path(result.data["archive_path"]), result.data["id"], None

    archive_path = args.get("archive_path")
    if archive_path:
        return _absolute_archive_path(str(archive_path)), None, None

    raise ValueError("Job requires source_meeting_id, meeting_id, or archive_path")


def _source_meeting_video_data(source: dict, municipality) -> dict:
    raw = source.get("raw") or {}
    raw_meeting = raw.get("escribe_meeting") or {}
    return {
        "url": source.get("video_url"),
        "title": f"{source.get('meeting_date')} {raw_meeting.get('MeetingType') or source.get('title') or source.get('meeting_type')}",
        "uri": source.get("source_id"),
        "duration": 0,
        "client_id": (municipality.source_config.get("video_source") or {}).get("client_id"),
    }


def _archive_player_url(target_folder: str) -> str | None:
    player_url_path = os.path.join(target_folder, "Video", "player.url")
    if not os.path.exists(player_url_path):
        return None
    with open(player_url_path, "r", encoding="utf-8") as f:
        return f.read().strip() or None


def _archive_video_data(target_folder: str, municipality) -> dict | None:
    player_url = _archive_player_url(target_folder)
    if not player_url:
        return None
    return {
        "url": player_url,
        "title": os.path.basename(target_folder),
        "uri": None,
        "duration": 0,
        "client_id": (municipality.source_config.get("video_source") or {}).get("client_id"),
    }


def _ensure_source_documents(supabase, archiver: Archiver, source: dict, target_folder: str):
    from pipeline.scrapers.base import ScrapedDocument, ScrapedMeeting

    raw = source.get("raw") or {}
    docs = [
        ScrapedDocument(
            title=doc.get("title") or "Document",
            url=doc.get("url") or "",
            category=doc.get("category"),
            file_format=doc.get("file_format") or "pdf",
        )
        for doc in raw.get("documents", [])
        if doc.get("url")
    ]
    meeting = ScrapedMeeting(
        date=datetime.fromisoformat(source["meeting_date"]).date(),
        title=source.get("title") or source.get("meeting_type") or "Meeting",
        meeting_type=source.get("meeting_type"),
        organization_name=archiver.municipality.name,
        agenda_url=source.get("source_url"),
        video_url=source.get("video_url"),
        source_id=source.get("source_id"),
        documents=docs,
        meta=raw,
    )
    downloaded = archiver.scraper.download_documents(meeting, target_folder)
    # Downloads can fail individually. Do not advance a transcript-only meeting
    # to AI refinement when its advertised official decision sources are absent.
    expected_categories = {doc.category for doc in docs if doc.category in {"Agenda", "Minutes"}}
    present_categories = {
        os.path.basename(os.path.dirname(path))
        for path in (downloaded or [])
        if os.path.isfile(path) and os.path.getsize(path) > 0
    }
    missing_categories = expected_categories - present_categories
    if missing_categories:
        raise RuntimeError(
            f"Source {source['id']} official document download incomplete: "
            f"missing {', '.join(sorted(missing_categories))}; "
            "retry document sync before ingestion"
        )
    if downloaded:
        supabase.table("source_meetings").update({"status": "documents_downloaded"}).eq(
            "id", source["id"]
        ).execute()
    return downloaded


def _ensure_source_audio(archiver: Archiver, source: dict, target_folder: str):
    video_data = _source_meeting_video_data(source, archiver.municipality)
    if not video_data.get("url"):
        video_data = _archive_video_data(target_folder, archiver.municipality)

    if not video_data or not video_data.get("url"):
        print("  [i] Source meeting has no video URL; skipping media sync.")
        return None

    audio_dir = os.path.join(target_folder, "Audio")
    os.makedirs(audio_dir, exist_ok=True)
    existing_audio = [
        path
        for path in os.listdir(audio_dir)
        if path.lower().endswith((".mp3", ".m4a", ".wav"))
    ]
    if existing_audio:
        print("  [i] Audio already exists; skipping media sync.")
        return os.path.join(audio_dir, existing_audio[0])

    print("  [i] Syncing source media before diarization.")
    return archiver.video_client.download_video(
        video_data,
        audio_dir,
        include_video=False,
        download_audio=True,
    )


def _ensure_archive_audio(archiver: Archiver, target_folder: str):
    video_data = _archive_video_data(target_folder, archiver.municipality)
    if not video_data:
        print("  [i] No archived player URL found; skipping media sync.")
        return None

    audio_dir = os.path.join(target_folder, "Audio")
    os.makedirs(audio_dir, exist_ok=True)
    existing_audio = [
        path
        for path in os.listdir(audio_dir)
        if path.lower().endswith((".mp3", ".m4a", ".wav"))
    ]
    if existing_audio:
        print("  [i] Audio already exists; skipping media sync.")
        return os.path.join(audio_dir, existing_audio[0])

    print("  [i] Syncing archived player media before diarization.")
    return archiver.video_client.download_video(
        video_data,
        audio_dir,
        include_video=False,
        download_audio=True,
    )


def run_job(supabase, job: dict):
    job_id = job["id"]
    job_type = job["job_type"]
    args = job.get("args") or {}
    limit = args.get("limit")

    municipality = load_municipality_by_id(job["municipality_id"])
    skip_diarization = bool(args.get("skip_diarization", False))
    needs_diarizer = job_type in {"ingest_meeting", "diarize_meeting", "transcribe_meeting"} and not (
        job_type == "ingest_meeting" and (skip_diarization or args.get("identity_only"))
    )
    archiver = Archiver(
        municipality=municipality,
        initialize_diarizer=needs_diarizer,
    )

    record_job_event(
        supabase,
        job_id,
        f"Starting {job_type}",
        data={"municipality": municipality.slug, "args": args},
    )

    if job_type == "preflight":
        result = preflight(supabase, municipality)
        print(f"Preflight: discovery={result['ok_for_discovery']} extraction={result['ok_for_extraction']}")
        for warning in result["warnings"]:
            print(f"Warning: {warning}")
        return result

    if job_type == "discover_meetings":
        meetings = archiver.discover_source_meetings(limit=limit)
        return {"discovered": len(meetings)}

    if job_type == "sync_documents":
        archiver._sync_documents(limit=limit)
        return {"synced_documents_for": limit or "all discovered meetings"}

    if job_type == "sync_media":
        from pipeline.paths import BASE_DIR

        target_folder, _, source_meeting_id = _resolve_archive_path(supabase, args)
        if not source_meeting_id:
            raise ValueError("sync_media requires source_meeting_id")
        source = _get_source_meeting(supabase, source_meeting_id)
        print("  [Stage] Syncing source documents.")
        documents = _ensure_source_documents(supabase, archiver, source, target_folder)
        print("  [Stage] Syncing source media/audio only; skipping transcription and AI.")
        audio_path = _ensure_source_audio(archiver, source, target_folder)
        status = "media_downloaded" if audio_path else "documents_downloaded"
        supabase.table("source_meetings").update({"status": status}).eq(
            "id", source_meeting_id
        ).execute()
        return {
            "source_meeting_id": source_meeting_id,
            "archive_path": os.path.relpath(target_folder, BASE_DIR),
            "documents": len(documents or []),
            "audio_path": audio_path,
            "status": status,
        }

    if job_type == "ingest_meeting":
        target_folder, _, source_meeting_id = _resolve_archive_path(supabase, args)
        if args.get("identity_only"):
            # Identity-only continuations consume private cached evidence work.
            # They never refresh documents/media, re-refine, re-embed or announce
            # unrelated source stages as complete.
            result = archiver._ingest_meetings(target_folder=target_folder, identity_only=True)
            if not result or not result.get("identity_only"):
                raise RuntimeError("Identity-only work produced no acknowledged stage result")
            return result
        if args.get('email_enqueue_retry') is not None:
            from pipeline.paths import BASE_DIR
            # Validate the original canonical target and restore its original clock
            # BEFORE forced/noncached ingestion can attempt to record it again.
            canonical = (supabase.table('meetings').select('id').eq('municipality_id', municipality.id)
                         .eq('archive_path', os.path.relpath(target_folder, BASE_DIR)).execute()).data
            restore_email_enqueue_retry(supabase, job, canonical[0]['id'] if canonical else None)
        source = _get_source_meeting(supabase, source_meeting_id) if source_meeting_id else None
        downloaded_documents = []
        if source:
            print("  [Stage] Syncing source documents.")
            downloaded_documents = _ensure_source_documents(supabase, archiver, source, target_folder) or []
            print("  [Stage] Syncing source audio/transcript inputs.")
            _ensure_source_audio(archiver, source, target_folder)

        diarized = set()
        if skip_diarization:
            print("  [Stage] Diarization/transcription check skipped by job args.")
        else:
            print("  [Stage] Diarization/transcription check.")
            diarized = archiver._process_audio_files(
                limit=limit,
                output_dir=target_folder,
                rediarize=bool(args.get("rediarize", False)),
            )

        print("  [Stage] Ingesting meeting and running AI refinement if needed.")
        ingestion_result = archiver._ingest_meetings(
            target_folder=target_folder,
            force_update=bool(args.get("force", False)),
            diarized_folders=diarized,
            replace_transcript=bool(args.get("replace_transcript", False)),
        )
        from pipeline.paths import BASE_DIR

        rel_archive_path = os.path.relpath(target_folder, BASE_DIR)
        meeting_result = (
            supabase.table("meetings")
            .select("id, video_url, summary, has_agenda, has_minutes")
            .eq("municipality_id", municipality.id)
            .eq("archive_path", rel_archive_path)
            .execute()
        )
        ingested_meeting_id = (
            meeting_result.data[0]["id"] if meeting_result.data else None
        )
        # An old transcript-only public row is not proof of successful enrichment.
        # A legitimate cached skip must already contain the advertised sources
        # and summary. Planned agenda-only meetings do not require future minutes.
        expected_categories = {
            os.path.basename(os.path.dirname(path)) for path in downloaded_documents
            if os.path.basename(os.path.dirname(path)) in {"Agenda", "Minutes"}
        }
        row = meeting_result.data[0] if meeting_result.data else {}
        if not row.get("summary") or any(
            not row.get("has_agenda" if category == "Agenda" else "has_minutes")
            for category in expected_categories
        ):
            raise RuntimeError("Meeting enrichment incomplete: missing summary or advertised official sources")
        if source_meeting_id:
            update_payload = {"status": "ingested"} if ingested_meeting_id else {}
            if ingested_meeting_id:
                update_payload["ingested_meeting_id"] = ingested_meeting_id
                if source and source.get("video_url") and not meeting_result.data[0].get("video_url"):
                    supabase.table("meetings").update(
                        {"video_url": source["video_url"]}
                    ).eq("id", ingested_meeting_id).execute()
                    print("  [+] Attached source video URL to public meeting.")
            if update_payload:
                supabase.table("source_meetings").update(update_payload).eq(
                    "id", source_meeting_id
                ).execute()
            else:
                print(
                    "  [i] No public meeting row was created; leaving source status unchanged."
                )

        source_only_refresh = bool(ingestion_result and ingestion_result.get("source_only_refresh"))
        extraction_result = None
        if ingested_meeting_id and not source_only_refresh:
            print(f"  [Stage] Extracting agenda documents for meeting {ingested_meeting_id}.")
            extraction_result = archiver.extract_documents_for_meeting(
                int(ingested_meeting_id),
                force=bool(args.get("force_extract", False)),
            )
            if source_meeting_id and not extraction_result.get("incomplete_attachment_extraction"):
                supabase.table("source_meetings").update(
                    {"status": "extracted"}
                ).eq("id", source_meeting_id).execute()

        if not source_only_refresh:
            print("  [Stage] Generating embeddings for newly ingested content.")
            archiver._embed_new_content()
        if ingested_meeting_id and ingestion_result and not source_only_refresh:
            print("  [Stage] Refreshing councillor profiles (drafts for review).")
            archiver.refresh_profiles_after_meetings([int(ingested_meeting_id)])
        print("  [Stage] Full ingest complete.")
        return {
            "archive_path": rel_archive_path,
            "ingested_meeting_id": ingested_meeting_id,
            "diarized_folders": sorted(diarized),
            "extraction": extraction_result,
            "ingestion_skipped": ingestion_result is None,
            "source_only_refresh": source_only_refresh,
        }

    if job_type == "extract_documents":
        _, meeting_id, source_meeting_id = _resolve_archive_path(supabase, args)
        if not meeting_id:
            raise ValueError("extract_documents requires an ingested meeting")
        result = archiver.extract_documents_for_meeting(
            int(meeting_id),
            force=bool(args.get("force", False)),
        )
        if source_meeting_id and not result.get("incomplete_attachment_extraction"):
            supabase.table("source_meetings").update(
                {"status": "extracted"}
            ).eq("id", source_meeting_id).execute()
        return result

    if job_type == "embed_content":
        tables = args.get("tables") or ["document_sections"]
        if isinstance(tables, str):
            tables = [tables]
        archiver._embed_new_content(
            force=bool(args.get("force", False)),
            tables=tables,
        )
        return {"tables": tables, "force": bool(args.get("force", False))}

    if job_type == "regenerate_summary":
        _, meeting_id, source_meeting_id = _resolve_archive_path(supabase, args)
        if not meeting_id:
            raise ValueError("regenerate_summary requires an ingested meeting")
        from pipeline.ingestion.summary import regenerate_meeting_summary

        result = regenerate_meeting_summary(
            supabase,
            int(meeting_id),
            municipality_id=municipality.id,
        )
        if source_meeting_id:
            supabase.table("source_meetings").update({"status": "ingested"}).eq(
                "id", source_meeting_id
            ).execute()
        return result

    if job_type == "transcribe_meeting":
        target_folder, meeting_id, source_meeting_id = _resolve_archive_path(supabase, args)
        source = _get_source_meeting(supabase, source_meeting_id) if source_meeting_id else None
        if source:
            _ensure_source_audio(archiver, source, target_folder)
        else:
            _ensure_archive_audio(archiver, target_folder)
        diarized = archiver._process_audio_files(output_dir=target_folder)
        return {"meeting_id": meeting_id, "transcribed_folders": sorted(diarized)}

    if job_type == "diarize_meeting":
        target_folder, meeting_id, source_meeting_id = _resolve_archive_path(supabase, args)
        source = _get_source_meeting(supabase, source_meeting_id) if source_meeting_id else None
        if source:
            _ensure_source_documents(supabase, archiver, source, target_folder)
            _ensure_source_audio(archiver, source, target_folder)
        else:
            _ensure_archive_audio(archiver, target_folder)
        diarized = archiver._process_audio_files(
            limit=limit,
            output_dir=target_folder,
            rediarize=bool(args.get("rediarize", False)),
        )
        if diarized:
            archiver._ingest_meetings(
                target_folder=target_folder,
                force_update=bool(args.get("force", False)),
                diarized_folders=diarized,
                replace_transcript=bool(args.get("replace_transcript", False)),
            )
            archiver._embed_new_content(
                tables=[
                    "agenda_items",
                    "motions",
                    "matters",
                    "meetings",
                    "key_statements",
                ],
            )
        if source_meeting_id and diarized:
            supabase.table("source_meetings").update(
                {"status": "diarized"}
            ).eq("id", source_meeting_id).execute()
        return {
            "meeting_id": meeting_id,
            "diarized_folders": sorted(diarized),
        }

    raise ValueError(f"Unsupported job_type: {job_type}")


def restore_email_enqueue_retry(supabase, job, meeting_id):
    marker = (job.get('args') or {}).get('email_enqueue_retry')
    if marker is None:
        return
    if job.get('job_type') != 'ingest_meeting' or not isinstance(marker, dict):
        raise ValueError('Invalid email enqueue recovery job')
    original = marker.get('created_at')
    deadline = marker.get('expires_at')
    if (marker.get('version') != 1 or type(marker.get('meeting_id')) is not int
            or marker['meeting_id'] != meeting_id
            or type(original) not in (int, float) or type(deadline) not in (int, float)
            or deadline != original + DELIVERY_WINDOW or not original <= time.time() < deadline):
        raise ValueError('Invalid or expired email enqueue recovery receipt')
    result = supabase.table('meetings').select('id,municipality_id').eq('id', meeting_id).single().execute()
    if not result.data or result.data['municipality_id'] != job['municipality_id']:
        raise ValueError('Email enqueue recovery municipality mismatch')
    if not record_email_enqueue(meeting_id, created_at=original):
        raise RuntimeError('Scoped email key missing; recovery receipt retained in job args')


def work_once(
    worker_id: str,
    heartbeat_interval: float,
    job_types: list[str] | None = None,
) -> bool:
    supabase = get_supabase()
    job = claim_job(supabase, worker_id, job_types=job_types)
    if not job:
        print(f"[worker] no queued jobs for {worker_id}")
        return False

    job_id = job["id"]
    stop_heartbeat, heartbeat_thread = start_heartbeat(
        supabase, job_id, heartbeat_interval
    )
    try:
        from pipeline.ai.usage import usage_context

        with capture_job_output(supabase, job_id), usage_context(job=f"worker:{job.get('job_type')}"):
            result = run_job(supabase, job)
        record_job_event(supabase, job_id, "Job succeeded", data=result)
        finish_job(supabase, job_id, "succeeded", result=result)
        print(f"[worker] job {job_id} succeeded")
    except Exception as exc:
        error = str(exc)
        recovery_args = None
        if isinstance(exc, EmailEnqueuePersistenceError):
            previous = (job.get('args') or {}).get('email_enqueue_retry')
            # A forced ingest may fail its second record even after restoration.
            # Never replace that exact meeting's original clock with a new one.
            receipt = previous if (isinstance(previous, dict)
                and previous.get('meeting_id') == exc.receipt['meeting_id']) else exc.receipt
            recovery_args = {**(job.get('args') or {}), 'email_enqueue_retry': receipt}
        # Persist failure and scoped recovery evidence atomically before best-effort logs.
        finish_job(supabase, job_id, "failed", error=error, recovery_args=recovery_args)
        try:
            record_job_event(
                supabase, job_id, "Job failed", level="error",
                data={"error": error, "traceback": traceback.format_exc()},
            )
        except Exception:
            print('[worker] failure event unavailable; failed job receipt retained')
        print(f"[worker] job {job_id} failed: {error}")
    finally:
        stop_heartbeat.set()
        heartbeat_thread.join(timeout=1)
    return True


def main():
    parser = argparse.ArgumentParser(description="Pipeline ops queue worker")
    parser.add_argument("--once", action="store_true", help="Process one queued job then exit")
    parser.add_argument("--poll-interval", type=float, default=10.0)
    parser.add_argument("--heartbeat-interval", type=float, default=30.0)
    parser.add_argument("--worker-id", default=f"{socket.gethostname()}:{os.getpid()}")
    parser.add_argument(
        "--job-types",
        help="Comma-separated job types this worker may claim, e.g. sync_media or ingest_meeting,diarize_meeting",
    )
    args = parser.parse_args()
    job_types = (
        [item.strip() for item in args.job_types.split(",") if item.strip()]
        if args.job_types
        else None
    )

    from pipeline.ai.usage_sink import install_usage_logging

    usage_sink = install_usage_logging()
    scope = ",".join(job_types) if job_types else "all"
    print(f"[worker] started {args.worker_id} job_types={scope}")
    while True:
        # Poll explicit durable intents even while no ingestion job is queued.
        # The Edge/SQL gate defers matching until agenda embeddings exist.
        from pipeline.email_outbox import retry_email_enqueues
        retry_email_enqueues(limit=1)
        claimed = work_once(args.worker_id, args.heartbeat_interval, job_types=job_types)
        if usage_sink is not None:
            usage_sink.flush(timeout=5)
        if args.once:
            break
        if not claimed:
            time.sleep(args.poll_interval)


if __name__ == "__main__":
    main()
