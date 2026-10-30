import glob
import json
import os
import threading
import time as _time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from pipeline.supabase_client import create_client
from tqdm import tqdm

from pipeline import config, parser, utils
from pipeline.ops import (
    mark_source_meeting_ingested,
    meeting_source_record,
    upsert_source_meetings,
)
from pipeline.paths import ARCHIVE_ROOT, BASE_DIR, get_municipality_archive_root
from pipeline.scrapers import get_scraper, MunicipalityConfig
from pipeline.scrapers.civicweb import CivicWebScraper
from pipeline.scrapers.escribe_bodies import escribe_body
from pipeline.source_identity import (
    DuplicateGuard,
    folder_source_ids,
    gap_fill_documents,
    is_foreign_folder,
    known_folder_ids,
    select_video,
)

from .local_diarizer import LocalDiarizer
from .video import get_video_client

# Progress file for resumable backfill
BACKFILL_PROGRESS_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "backfill_progress.json",
)

def load_municipality(slug: str) -> MunicipalityConfig:
    """Load municipality config from Supabase by slug."""
    supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
    if not config.SUPABASE_URL or not supabase_key:
        raise RuntimeError("SUPABASE_URL/KEY not set — cannot load municipality config")

    supabase = create_client(config.SUPABASE_URL, supabase_key)
    result = (
        supabase.table("municipalities")
        .select("*")
        .eq("slug", slug)
        .single()
        .execute()
    )

    if not result.data:
        raise ValueError(f"Municipality not found: {slug}")

    return MunicipalityConfig.from_db_row(result.data)


def load_municipality_by_id(municipality_id: int) -> MunicipalityConfig:
    """Load municipality config from Supabase by id."""
    supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
    if not config.SUPABASE_URL or not supabase_key:
        raise RuntimeError("SUPABASE_URL/KEY not set — cannot load municipality config")

    supabase = create_client(config.SUPABASE_URL, supabase_key)
    result = (
        supabase.table("municipalities")
        .select("*")
        .eq("id", municipality_id)
        .single()
        .execute()
    )

    if not result.data:
        raise ValueError(f"Municipality not found: {municipality_id}")

    return MunicipalityConfig.from_db_row(result.data)


class Archiver:
    def __init__(
        self,
        municipality: MunicipalityConfig | None = None,
        initialize_diarizer: bool = True,
    ):
        # Meetings ingested during this run; their councillors' profiles are
        # refreshed (as drafts) once embeddings are done.
        self._ingested_meeting_ids: list[int] = []
        if municipality is None:
            # Backward compat: default to View Royal with hardcoded defaults
            self.municipality = None
            self.archive_root = ARCHIVE_ROOT
            self.scraper = CivicWebScraper()
            self.video_client = get_video_client()
        else:
            self.municipality = municipality
            self.archive_root = get_municipality_archive_root(municipality.slug)
            self.scraper = get_scraper(municipality)
            self.video_client = get_video_client(municipality)

        self.ai_enabled = False
        self.diarizer = None

        if initialize_diarizer:
            # Setup local diarizer (senko + parakeet) with fingerprint matching
            try:
                supabase_client = None
                # voice_fingerprints is service-role only (not readable with the
                # publishable key), so speaker matching needs the secret key.
                fingerprint_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
                if config.SUPABASE_URL and fingerprint_key:
                    try:
                        supabase_client = create_client(
                            config.SUPABASE_URL, fingerprint_key
                        )
                    except Exception as e:
                        print(
                            f"[!] Failed to initialize Supabase for fingerprints: {e}"
                        )

                self.diarizer = LocalDiarizer(supabase_client=supabase_client)
                self.ai_enabled = True
            except Exception as e:
                print(f"[!] Failed to initialize LocalDiarizer: {e}")

    def discover_source_meetings(self, limit=None, dry_run=False):
        """Discover source meetings and record them in the ops inventory.

        With ``dry_run`` nothing is written: the plan (see ``plan_source_sync``) is
        computed from read-only lookups and returned on ``self.source_sync_plan``.
        """
        meetings = self.scraper.discover_meetings()
        if limit:
            meetings = meetings[:limit]

        self._pin_known_archive_paths(meetings)
        self.source_sync_plan = self.plan_source_sync(meetings)
        if not dry_run:
            self._record_source_meetings(meetings)
        return meetings

    def plan_source_sync(self, meetings):
        """Per discovered meeting: where its documents go, or why they must not be synced.

        action: 'linked'  — ID already linked to a meeting we hold; sync into that folder
                            (gap-fill only when the folder came from another source)
                'new'     — not held; a new folder (and later a new meeting) for it
                'blocked' — not linked, but we hold an unlinked meeting of the same body,
                            kind and date; record its eSCRIBE ID before syncing
        """
        source_type = self.municipality.source_config.get("type") if self.municipality else None
        plan = {}
        pinned = getattr(self, "_pinned_archive_paths", {})
        unpinned = [m for m in meetings if m.source_id not in pinned]
        guard = None
        if source_type == "escribe" and unpinned:
            supabase = self._get_admin_supabase()
            if supabase:
                guard = DuplicateGuard(supabase, self.municipality.id).load(
                    m.date.isoformat() for m in unpinned
                )
        for meeting in meetings:
            root = self._meeting_archive_root(meeting)
            entry = {"source_id": meeting.source_id, "date": meeting.date.isoformat(),
                     "title": meeting.title, "archive_root": root}
            if meeting.source_id in pinned:
                entry.update(action="linked", foreign_folder=is_foreign_folder(root, meeting.source_id))
            elif guard is not None and (conflicts := guard.conflicts(meeting)):
                entry.update(action="blocked", conflicts=[c["id"] for c in conflicts],
                             reason="unlinked meeting(s) of the same body and date already held")
            else:
                entry.update(action="new", folder_exists=os.path.isdir(root))
            plan[meeting.source_id] = entry
        return plan

    def download_source_documents(self, meeting, target_dir):
        """Download a source meeting's documents without duplicating another source's copies."""
        if is_foreign_folder(target_dir, meeting.source_id) and os.path.isdir(target_dir):
            meeting, existing = gap_fill_documents(meeting, target_dir)
            downloaded = self.scraper.download_documents(meeting, target_dir)
            return existing + [p for p in downloaded or [] if p not in existing]
        return self.scraper.download_documents(meeting, target_dir)

    def _pin_known_archive_paths(self, meetings):
        """Keep the archive folder (and DB archive_path) of already-ingested eSCRIBE
        meetings stable when the folder date is corrected upstream.

        Folder names embed the meeting date, and meetings.archive_path / documents /
        transcript metadata point at them. If the date derivation is ever fixed, a
        fresh scrape would otherwise re-download every affected meeting into a second,
        correctly-dated folder and repoint source_meetings away from the ingested one.
        """
        source_type = self.municipality.source_config.get("type") if self.municipality else None
        if source_type != "escribe" or not meetings:
            return
        supabase = self._get_admin_supabase()
        if not supabase:
            return
        ids = [m.source_id for m in meetings if m.source_id]
        pinned = {}
        for start in range(0, len(ids), 100):
            rows = (
                supabase.table("source_meetings")
                .select("source_id,archive_path,ingested_meeting_id")
                .eq("municipality_id", self.municipality.id)
                .eq("source_type", source_type)
                .in_("source_id", ids[start : start + 100])
                .execute()
                .data
                or []
            )
            for row in rows:
                if row.get("ingested_meeting_id") and row.get("archive_path"):
                    pinned[row["source_id"]] = row["archive_path"]
        self._pinned_archive_paths = {**getattr(self, "_pinned_archive_paths", {}), **pinned}

    def _known_folder_ids(self):
        """Archive folder -> eSCRIBE IDs recorded in source_meetings ({} when unavailable)."""
        if not self.municipality or self.municipality.source_config.get("type") != "escribe":
            return {}
        supabase = self._get_admin_supabase()
        if not supabase:
            return {}
        try:
            return known_folder_ids(supabase, self.municipality.id, BASE_DIR)
        except Exception as e:
            print(f"  [!] Could not load source IDs for archive folders: {e}")
            return {}

    def _get_admin_supabase(self):
        supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
        if not config.SUPABASE_URL or not supabase_key:
            return None
        return create_client(config.SUPABASE_URL, supabase_key)

    def _meeting_archive_root(self, meeting):
        meeting_type = meeting.meeting_type or utils.infer_meeting_type(meeting.title) or meeting.title
        source_type = (
            self.municipality.source_config.get("type")
            if self.municipality
            else None
        )

        if source_type == "escribe":
            pinned = getattr(self, "_pinned_archive_paths", {}).get(meeting.source_id)
            if pinned:
                return pinned if os.path.isabs(pinned) else os.path.join(BASE_DIR, pinned)
            raw = meeting.meta.get("escribe_meeting", {}) if meeting.meta else {}
            body = escribe_body(raw.get("MeetingType") or meeting.title)
            top_level = utils.normalize_top_level(meeting_type or meeting.title)
            if body:
                # Committees and boards: one folder tree and title per body, as the
                # imported history files them ("<body>" / "<body> – Special").
                top_level, meeting_type = body.name, body.title
            elif "committee of the whole" in (meeting_type or "").lower():
                top_level = "Committee of the Whole"
            elif "public hearing" in (meeting_type or "").lower():
                top_level = "Public Hearing"
            elif "advisory" in (meeting_type or "").lower():
                top_level = "Joint Advisory Committee"

            year = meeting.date.strftime("%Y")
            month = meeting.date.strftime("%m")
            meeting_time = (raw.get("MeetingTime") or raw.get("TimeShort") or "").strip()
            time_slug = ""
            if meeting_time:
                safe_time = (
                    meeting_time.lower()
                    .replace(" ", "")
                    .replace(":", "")
                    .replace(".", "")
                )
                time_slug = f" {safe_time}"
            source_suffix = meeting.source_id[:8] if meeting.source_id else ""
            meeting_folder = f"{meeting.date.isoformat()}{time_slug} {meeting_type}"
            if source_suffix:
                meeting_folder = f"{meeting_folder} [{source_suffix}]"
            return os.path.join(self.archive_root, top_level, year, month, meeting_folder)

        meta = {
            "date": meeting.date.isoformat(),
            "meeting_suffix": meeting_type or "Meeting",
            "category": "Agenda",
        }
        agenda_dir = utils.get_target_path(
            self.archive_root,
            utils.normalize_top_level(meeting_type or meeting.title),
            meta,
        )
        return os.path.dirname(agenda_dir)

    def _meeting_archive_path_for_db(self, meeting):
        archive_path = self._meeting_archive_root(meeting)
        try:
            return os.path.relpath(archive_path, BASE_DIR)
        except ValueError:
            return archive_path

    def _record_source_meetings(self, meetings, status="discovered"):
        if not self.municipality:
            return

        supabase = self._get_admin_supabase()
        if not supabase:
            print("  [ops] SUPABASE_URL/KEY not set; source meeting inventory skipped")
            return

        source_type = self.municipality.source_config.get("type", "unknown")
        plan = getattr(self, "source_sync_plan", None) or {}
        records = [
            meeting_source_record(
                self.municipality,
                source_type,
                meeting,
                # A blocked meeting gets no folder: a job for it could otherwise
                # ingest a duplicate of the meeting we already hold.
                archive_path=None
                if (plan.get(meeting.source_id) or {}).get("action") == "blocked"
                else self._meeting_archive_path_for_db(meeting),
                status=status,
            )
            for meeting in meetings
        ]
        count = upsert_source_meetings(
            supabase, self.municipality, source_type, records
        )
        print(f"  [ops] Recorded {count} source meeting(s)")

    def run(
        self,
        skip_docs=False,
        include_video=False,
        limit=None,
        download_audio=False,
        skip_diarization=False,
        rediarize=False,
        skip_ingest=False,
        skip_embed=False,
    ):
        label = self.municipality.name if self.municipality else "View Royal"
        print(f"=== {label} Archiver ===")
        print(f"Archive Root: {self.archive_root}")

        # Phase 1: Documents
        if not skip_docs and not rediarize:
            print("\n--- Phase 1: Documents ---")
            try:
                self._sync_documents(limit=limit)
            except KeyboardInterrupt:
                return
        else:
            print("\n--- Phase 1: Documents (SKIPPED) ---")

        # Phase 2: Video/audio download
        if not rediarize and (include_video or download_audio):
            video_map = self.video_client.get_video_map(limit=limit)
            if video_map:
                print("\n--- Phase 2: Matching & Downloading Video Content ---")
                self._download_video_content(
                    video_map, include_video, download_audio, limit, self.archive_root
                )
        elif not rediarize:
            print("\n--- Phase 2: Video/audio download (SKIPPED) ---")

        # Phase 3: Processing
        diarized_folders = set()
        if self.ai_enabled and not skip_diarization:
            label = "Re-diarizing" if rediarize else "Diarization"
            print(f"\n--- Phase 3: Processing Audio ({label}) ---")
            diarized_folders = self._process_audio_files(limit, self.archive_root, rediarize=rediarize)

        # Phase 4: Ingestion
        if not skip_ingest:
            print("\n--- Phase 4: Database Ingestion ---")
            self._ingest_meetings(diarized_folders=diarized_folders)
        else:
            print("\n--- Phase 4: Database Ingestion (SKIPPED) ---")

        # Phase 5: Embeddings
        if not skip_embed:
            print("\n--- Phase 5: Embedding Generation ---")
            self._embed_new_content()
            self.refresh_matters_after_meetings()
            self.refresh_profiles_after_meetings()
        else:
            print("\n--- Phase 5: Embedding Generation (SKIPPED) ---")

        print("\n[SUCCESS] Archiving Complete.")

    def run_update_check(self):
        """Check CivicWeb and Vimeo for new content without processing anything.

        Scrapes CivicWeb first (idempotent -- skips existing files), then runs
        the UpdateDetector to compare remote state against local archive and DB.

        Returns:
            ChangeReport with detected document and video changes.
        """
        from pipeline.update_detector import UpdateDetector

        supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
        supabase = None
        if config.SUPABASE_URL and supabase_key:
            supabase = create_client(config.SUPABASE_URL, supabase_key)

        # Scrape source first to pick up any new files (idempotent)
        print("  Scraping source for new files...")
        try:
            self._sync_documents()
        except Exception as e:
            print(f"  [!] Scrape error (continuing with detection): {e}")

        detector = UpdateDetector(
            archive_root=self.archive_root,
            scraper=self.scraper,
            vimeo_client=self.video_client,
            known_folder_ids=self._known_folder_ids(),
        )

        report = detector.detect_all_changes(supabase=supabase)

        print(f"\n=== Update Check Report ===")
        print(f"Checked at: {report.checked_at}")
        print()

        if report.meetings_new:
            print(f"New Meetings ({len(report.meetings_new)} folders not in DB):")
            for change in report.meetings_new:
                details_str = ", ".join(change.details) if change.details else "New folder"
                print(f"  {change.meeting_date} {change.meeting_type}: {details_str}")
        else:
            print("New Meetings: None")

        if report.meetings_with_new_docs:
            print(f"New Documents ({len(report.meetings_with_new_docs)} meetings):")
            for change in report.meetings_with_new_docs:
                details_str = ", ".join(change.details) if change.details else "New content"
                print(f"  {change.meeting_date} {change.meeting_type}: {details_str}")
        else:
            print("New Documents: None")

        if report.meetings_with_new_video:
            print(f"\nNew Video ({len(report.meetings_with_new_video)} meetings):")
            for change in report.meetings_with_new_video:
                details_str = ", ".join(change.details) if change.details else "Video available"
                print(f"  {change.meeting_date} {change.meeting_type}: {details_str}")
        else:
            print("\nNew Video: None")

        print(f"\nTotal: {report.total_changes} meetings with new content")

        return report

    def run_update_mode(self, download_audio=True, skip_diarization=False, skip_embed=False, test=False):
        """Scrape, detect changes, and selectively re-process only changed meetings.

        Runs the full update check first, then for each meeting with changes:
        - New documents: re-ingest that meeting folder
        - New video: download audio (if enabled), diarize (if not skipped), re-ingest

        Args:
            download_audio: Download audio for meetings with new video (default True).
            skip_diarization: Skip diarization/transcription phase.
            skip_embed: Skip embedding generation at the end.
            test: If True, prefix push notification title with [TEST].
        """
        report = self.run_update_check()

        if report.total_changes == 0:
            print("No new content detected.")
            return

        processed = 0

        # Ingest brand-new meeting folders (not yet in DB)
        for change in report.meetings_new:
            print(f"\n  [update] Ingesting new meeting: {change.meeting_date} {change.meeting_type}")
            try:
                self._ingest_meetings(target_folder=change.archive_path, force_update=False)
                processed += 1
            except Exception as e:
                print(f"  [!] Error processing {change.archive_path}: {e}")

        # Process meetings with new documents
        for change in report.meetings_with_new_docs:
            print(f"\n  [update] Re-ingesting documents: {change.meeting_date} {change.meeting_type}")
            try:
                self._ingest_meetings(target_folder=change.archive_path, force_update=True)
                processed += 1
            except Exception as e:
                print(f"  [!] Error processing {change.archive_path}: {e}")

        # Process meetings with new video
        for change in report.meetings_with_new_video:
            print(f"\n  [update] Processing new video: {change.meeting_date} {change.meeting_type}")
            try:
                # Download audio if enabled and video_data is available
                if download_audio and change.meta.get("video_data"):
                    videos = change.meta["video_data"]
                    audio_dir = os.path.join(change.archive_path, "Audio")
                    os.makedirs(audio_dir, exist_ok=True)
                    for video_data in videos:
                        print(f"    Downloading audio: {video_data.get('title', 'Unknown')}")
                        self.video_client.download_video(
                            video_data, audio_dir, include_video=False, download_audio=True
                        )

                # Diarize if not skipped
                diarized = set()
                if not skip_diarization and self.ai_enabled:
                    print(f"    Diarizing audio...")
                    diarized = self._process_audio_files(output_dir=change.archive_path)

                # Re-ingest
                self._ingest_meetings(target_folder=change.archive_path, force_update=True, diarized_folders=diarized)
                processed += 1
            except Exception as e:
                print(f"  [!] Error processing {change.archive_path}: {e}")

        # Embed all new content once at the end
        if not skip_embed:
            print("\n  [update] Embedding new content...")
            self._embed_new_content()
            self.refresh_matters_after_meetings()
            self.refresh_profiles_after_meetings()

        print(f"\nUpdate complete: {processed} meetings re-processed")

        # Send push notification to operator's phone
        from pipeline.notifier import send_update_notification
        send_update_notification(report, processed_count=processed, test=test)

    def _sync_documents(self, limit=None, dry_run=False):
        """Sync meeting documents from the configured source into archive layout.

        Returns the sync plan (source_id -> decision). With ``dry_run`` nothing is
        downloaded or written.
        """
        if hasattr(self.scraper, "scrape_recursive"):
            if dry_run:
                raise ValueError("Dry-run discovery is not supported for recursive scrapers")
            self.scraper.scrape_recursive()
            return {}

        meetings = self.discover_source_meetings(limit=limit, dry_run=dry_run)
        plan = self.source_sync_plan
        counts = {}
        for entry in plan.values():
            counts[entry["action"]] = counts.get(entry["action"], 0) + 1
        print(f"  [sync] plan: {counts}")
        for entry in plan.values():
            if entry["action"] == "blocked":
                print(f"  [!] Blocked {entry['date']} {entry['title']} ({entry['source_id']}): "
                      f"already hold meeting(s) {entry['conflicts']} without this eSCRIBE ID")
        if dry_run:
            return plan

        for meeting in meetings:
            if plan[meeting.source_id]["action"] == "blocked":
                continue
            meeting_root = self._meeting_archive_root(meeting)
            self.download_source_documents(meeting, meeting_root)
            self._record_source_meetings([meeting], status="documents_downloaded")
        return plan

    def _download_video_content(
        self,
        video_map,
        include_video,
        download_audio,
        limit=None,
        output_dir=None,
    ):
        output_dir = output_dir or self.archive_root
        matches = 0
        known = self._known_folder_ids()
        folders = []
        for root, dirs, files in os.walk(output_dir):
            date_key = utils.extract_date_from_string(os.path.basename(root))
            if date_key and date_key in video_map and ("Agenda" in dirs or "Minutes" in dirs or "Audio" in dirs or "Video" in dirs):
                folders.append((root, date_key, folder_source_ids(root, known)))
        for root, date_key, ids in folders:
            folder_name = os.path.basename(root)
            videos = video_map[date_key]
            # Match by the folder's own meeting ID; ID-less folders never take a
            # video another folder that day owns (see pipeline.source_identity).
            claimed = set().union(*(other for r, d, other in folders if d == date_key and r != root))
            video_data = select_video(root, videos, ids, claimed)

            if not video_data:
                continue

            # Determine subfolder
            if include_video:
                subfolder = "Video"
            else:
                subfolder = "Audio"

            target_dir = os.path.join(root, subfolder)

            if not os.path.exists(target_dir):
                os.makedirs(target_dir)

            parts = []
            if include_video:
                parts.append("Video")
            if download_audio:
                parts.append("Audio")

            msg = " + ".join(parts)
            print(
                f"[Match] {date_key}: Syncing {msg} from '{video_data['title']}' to '{folder_name}/{subfolder}'"
            )

            new_audio_path = self.video_client.download_video(
                video_data,
                target_dir,
                include_video=include_video,
                download_audio=download_audio,
            )

            matches += 1

    def _collect_audio_files(self, output_dir=None, rediarize=False):
        """Collect audio files that need processing."""
        output_dir = output_dir or self.archive_root
        audio_files = []
        for root, dirs, files in os.walk(output_dir):
            for file in files:
                if file.lower().endswith((".mp3", ".m4a", ".wav")):
                    audio_path = os.path.join(root, file)
                    json_path = os.path.splitext(audio_path)[0] + ".json"
                    if os.path.exists(json_path) and not rediarize:
                        continue
                    audio_files.append(audio_path)
        return audio_files

    def _process_audio_files(self, limit=None, output_dir=None, rediarize=False):
        output_dir = output_dir or self.archive_root
        audio_files = self._collect_audio_files(output_dir, rediarize)

        if limit:
            audio_files = audio_files[:limit]

        processed_folders = set()

        if not audio_files:
            print("  No audio files to process.")
            return processed_folders

        mode = "Re-diarize" if rediarize else "Process"
        print(f"  Found {len(audio_files)} audio file(s) to {mode.lower()}.\n")

        for i, audio_path in enumerate(audio_files, 1):
            root = os.path.dirname(audio_path)

            # Detect if we are in strict archive structure
            parent_dir = os.path.basename(root)
            grandparent_dir = os.path.basename(os.path.dirname(root))
            date_key = utils.extract_date_from_string(grandparent_dir)

            is_archive = date_key is not None and parent_dir == "Audio"

            json_path = os.path.splitext(audio_path)[0] + ".json"

            label = "Re-diarizing" if rediarize else "Processing"
            print(f"[{i}/{len(audio_files)}] {label} {os.path.basename(audio_path)}...")

            # Context extraction
            context_str = ""
            if is_archive:
                try:
                    meeting_root = os.path.dirname(root)

                    agenda_text = ""
                    cached_agenda = os.path.join(meeting_root, "agenda.md")
                    if os.path.exists(cached_agenda):
                        with open(cached_agenda, "r", encoding="utf-8") as f:
                            agenda_text = f.read()
                    else:
                        agenda_folder = os.path.join(meeting_root, "Agenda")
                        pdf_files = sorted(glob.glob(
                            os.path.join(glob.escape(agenda_folder), "*.pdf")
                        ))
                        if pdf_files:
                            all_texts = []
                            for pdf_file in pdf_files:
                                text = parser.get_pdf_text(pdf_file)
                                if text.strip():
                                    all_texts.append(text)
                            agenda_text = "\n\n---\n\n".join(all_texts)

                    minutes_text = ""
                    cached_minutes = os.path.join(meeting_root, "minutes.md")
                    if os.path.exists(cached_minutes):
                        with open(cached_minutes, "r", encoding="utf-8") as f:
                            minutes_text = f.read()
                    else:
                        minutes_folder = os.path.join(meeting_root, "Minutes")
                        pdf_files = sorted(glob.glob(
                            os.path.join(glob.escape(minutes_folder), "*.pdf")
                        ))
                        if pdf_files:
                            all_texts = []
                            for pdf_file in pdf_files:
                                text = parser.get_pdf_text(pdf_file)
                                if text.strip():
                                    all_texts.append(text)
                            minutes_text = "\n\n---\n\n".join(all_texts)

                    if agenda_text:
                        context_str += agenda_text
                    if minutes_text:
                        context_str += "\n" + minutes_text
                except Exception as e:
                    print(f"    [!] Failed to extract context: {e}")

            # If we are in "limit" mode (testing), limit audio processing to 5 minutes (300s)
            duration_limit = 300 if limit else None

            transcript_json = self.diarizer.diarize_audio(
                audio_path,
                context=context_str,
                limit_duration=duration_limit,
                rediarize=rediarize,
            )

            if transcript_json:
                # LocalDiarizer already saves the full result (segments +
                # centroids + samples) to the JSON file. Only write here
                # if the file wasn't created by the diarizer.
                if not os.path.exists(json_path):
                    with open(json_path, "w", encoding="utf-8") as f:
                        f.write(transcript_json)
                print(
                    f"    [+] Saved transcript to {os.path.basename(json_path)}"
                )
                # Track the meeting root folder (grandparent of Audio/)
                meeting_root = os.path.dirname(os.path.dirname(audio_path))
                processed_folders.add(meeting_root)

        return processed_folders

    def _ingest_meetings(self, diarized_folders=None, target_folder=None, force_update=False, replace_transcript=False, identity_only=False):
        from pipeline.ingestion.ingester import MeetingIngester
        from pipeline.ingestion.audit import find_meetings_needing_reingest
        from pipeline.email_outbox import EmailEnqueuePersistenceError

        supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
        if not config.SUPABASE_URL or not supabase_key:
            print("  [!] SUPABASE_URL/KEY not set, skipping ingestion.")
            return

        supabase = create_client(config.SUPABASE_URL, supabase_key)
        municipality_id = self.municipality.id if self.municipality else 1
        ingester = MeetingIngester(
            config.SUPABASE_URL, supabase_key,
            municipality_id=municipality_id,
        )
        if identity_only and not target_folder:
            raise ValueError("Identity-only continuation requires a single canonical meeting")
        if not config.OPENAI_API_KEY:
            print("  [WARNING] OPENAI_API_KEY is not set. AI refinement will fail and meetings will be partially ingested (no agenda items/motions). Set OPENAI_API_KEY to enable full processing.")
        diarized_folders = diarized_folders or set()

        # Single-folder targeted mode
        if target_folder:
            needs_refine = force_update
            try:
                result = ingester.process_meeting(
                    target_folder,
                    force_update=force_update,
                    force_refine=needs_refine,
                    replace_transcript=replace_transcript or target_folder in diarized_folders,
                    identity_only=identity_only,
                )
                if result is None and (force_update or replace_transcript or target_folder in diarized_folders):
                    raise RuntimeError("Targeted meeting refresh produced no completed ingestion result")
                if result and not identity_only and (result["meeting"].get("has_minutes") or result["meeting"].get("has_transcript")):
                    self._after_meeting_ingested(result["meeting_id"], source_only_refresh=result.get("source_only_refresh", False))
                return result
            except EmailEnqueuePersistenceError:
                raise
            except Exception as e:
                print(f"  [!] {target_folder}: {e}")
                raise

        # Detect meetings with updated files (disk vs DB)
        updated_meetings = find_meetings_needing_reingest(supabase)
        updated_paths = {m["archive_path"] for m in updated_meetings}

        if updated_meetings:
            print(f"  Detected {len(updated_meetings)} meeting(s) with new documents:")
            for m in updated_meetings:
                reasons = ", ".join(m["reasons"])
                print(f"    {m['meeting_date']} {m['meeting_type']}: {reasons}")

        if diarized_folders:
            print(f"  {len(diarized_folders)} meeting(s) freshly diarized.")

        # Walk archive and process
        for root, dirs, files in os.walk(self.archive_root):
            if "Agenda" not in dirs and "Audio" not in dirs:
                continue

            rel_path = root

            if force_update or root in diarized_folders or rel_path in updated_paths:
                needs_refine = force_update or rel_path in updated_paths
                try:
                    result = ingester.process_meeting(
                        root,
                        force_update=True,
                        force_refine=needs_refine,
                            replace_transcript=replace_transcript or root in diarized_folders,
                    )
                    if result and (result["meeting"].get("has_minutes") or result["meeting"].get("has_transcript")):
                        self._after_meeting_ingested(result["meeting_id"], source_only_refresh=result.get("source_only_refresh", False))
                except EmailEnqueuePersistenceError:
                    raise
                except Exception as e:
                    print(f"  [!] {root}: {e}")
            else:
                try:
                    result = ingester.process_meeting(root)
                    if result and (result["meeting"].get("has_minutes") or result["meeting"].get("has_transcript")):
                        self._after_meeting_ingested(result["meeting_id"], source_only_refresh=result.get("source_only_refresh", False))
                except EmailEnqueuePersistenceError:
                    raise
                except Exception as e:
                    print(f"  [!] {root}: {e}")

    def extract_documents_for_meeting(self, meeting_id: int, force=False):
        """Run document extraction for one already-ingested meeting."""
        from pipeline.ingestion.document_extractor import extract_and_store_documents

        supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
        if not config.SUPABASE_URL or not supabase_key:
            raise RuntimeError("SUPABASE_URL/KEY not set, skipping extraction.")

        supabase = create_client(config.SUPABASE_URL, supabase_key)
        municipality_id = self.municipality.id if self.municipality else 1

        meeting_result = (
            supabase.table("meetings")
            .select("id, archive_path, title, meeting_date")
            .eq("id", meeting_id)
            .single()
            .execute()
        )
        meeting = meeting_result.data
        if not meeting or not meeting.get("archive_path"):
            raise ValueError(f"Meeting {meeting_id} not found or has no archive_path")

        archive_path = meeting["archive_path"]
        meeting_folder = (
            archive_path
            if os.path.isabs(archive_path)
            else os.path.join(BASE_DIR, archive_path)
        )
        agenda_dir = os.path.join(meeting_folder, "Agenda")
        pdf_paths = sorted(glob.glob(os.path.join(glob.escape(agenda_dir), "*.pdf")))
        if not pdf_paths:
            from bs4 import BeautifulSoup

            html_path = os.path.join(agenda_dir, "Agenda.html")
            if os.path.isfile(html_path):
                with open(html_path, encoding="utf-8") as handle:
                    soup = BeautifulSoup(handle.read(), "html.parser")
                if soup.select_one("#AgendaHeaderTitle") and soup.select_one('[id^="AgendaItem"]'):
                    return {
                        "meeting_id": meeting_id,
                        "documents": 0,
                        "skipped": "html_only_agenda",
                        "incomplete_attachment_extraction": True,
                    }
            raise ValueError(f"No agenda PDFs found for meeting {meeting_id}: {agenda_dir}")

        stats = {
            "meeting_id": meeting_id,
            "documents": 0,
            "boundaries_found": 0,
            "documents_extracted": 0,
            "sections_created": 0,
            "images_extracted": 0,
        }

        for pdf_path in pdf_paths:
            pdf_filename = os.path.basename(pdf_path)
            rel_file_path = os.path.join("Agenda", pdf_filename)
            doc_id = self._find_or_create_document(
                supabase, meeting_id, pdf_filename, rel_file_path, municipality_id
            )
            if not doc_id:
                raise RuntimeError(f"Could not find or create document for {pdf_filename}")

            if not force:
                existing = (
                    supabase.table("extracted_documents")
                    .select("id", count="exact")
                    .eq("document_id", doc_id)
                    .execute()
                )
                if existing.count:
                    print(f"  [i] Skipping already extracted document: {pdf_filename}")
                    continue

            result_stats = extract_and_store_documents(
                pdf_path, doc_id, meeting_id, supabase, municipality_id
            )
            stats["documents"] += 1
            for key in (
                "boundaries_found",
                "documents_extracted",
                "sections_created",
                "images_extracted",
            ):
                stats[key] += result_stats.get(key, 0)

        print(
            "  Extracted meeting "
            f"{meeting_id}: {stats['documents_extracted']} documents, "
            f"{stats['sections_created']} sections"
        )
        return stats

    def _mark_source_ingested(self, meeting_id: int):
        """Record the successful ingest on source_meetings. Never fatal."""
        try:
            supabase = self._get_admin_supabase()
            if supabase is not None:
                mark_source_meeting_ingested(supabase, int(meeting_id))
        except Exception as e:
            print(f"  [ops] Could not mark source meeting ingested: {e}")

    def _after_meeting_ingested(self, meeting_id: int, *, source_only_refresh=False):
        self._mark_source_ingested(meeting_id)
        # Documentary repairs do not announce new content or buy new profiles.
        if source_only_refresh:
            return
        self._ingested_meeting_ids.append(int(meeting_id))
        self._trigger_alerts(meeting_id)

    def run_post_ingest_stages(
        self,
        meeting_ids: list[int] | None = None,
        *,
        include: list[str] | None = None,
        exclude: tuple[str, ...] = (),
    ):
        """Run the registry's post_ingest stages (pipeline/stages.py) in order for
        the given (default: just-ingested) meetings. Each stage is isolated and
        logged; none is fatal."""
        from pipeline import stages

        ids = sorted(set(meeting_ids if meeting_ids is not None else self._ingested_meeting_ids))
        selected = stages.post_ingest_stages(include, exclude)
        if not ids and all(s.scope != "global" for s in selected):
            return {}
        supabase = self._get_admin_supabase()
        if supabase is None:
            print("  [!] SUPABASE_URL/KEY not set, skipping post-ingest stages.")
            return {}
        if ids:
            print(f"  [Stages] Post-ingest for meetings {ids}: {', '.join(s.name for s in selected)}")
        ctx = stages.StageContext(supabase=supabase, meeting_ids=ids, archiver=self)
        return stages.run_post_ingest(ctx, include=include, exclude=exclude)

    def refresh_matters_after_meetings(self, meeting_ids: list[int] | None = None):
        """Post-ingest document/matter stages (attachments, relink, summaries, alignment,
        participation, images, links) for newly ingested meetings. Never fatal."""
        try:
            return self.run_post_ingest_stages(meeting_ids, exclude=("embeddings", "profile-refresh"))
        except Exception as e:
            print(f"  [!] Matter refresh failed: {e}")
            return {}

    def refresh_profiles_after_meetings(self, meeting_ids: list[int] | None = None):
        """Refresh councillor profile data after new meetings are ingested.

        For councillors who attended or spoke: recompute key votes (factual),
        regenerate policy stances, and write a new overview DRAFT for admin
        review (published profiles stay live until a draft is approved).
        Failures are logged and never stop the pipeline.
        """
        try:
            return self.run_post_ingest_stages(meeting_ids, include=["profile-refresh"])
        except Exception as e:
            print(f"  [!] Profile refresh skipped: {e}")
            return {}
        finally:
            self._ingested_meeting_ids = []

    def _trigger_alerts(self, meeting_id: int):
        """Persist enqueue intent before network I/O; matching happens after embedding."""
        from pipeline.email_outbox import record_email_enqueue
        record_email_enqueue(meeting_id)

    def _embed_new_content(self, force=False, tables=None):
        """The registry's `embeddings` stage: embed rows missing a vector."""
        from pipeline.ai.usage import usage_context
        from pipeline.stages import embed_tables

        with usage_context(job="embeddings"):
            embed_tables(force=force, tables=tables)
        from pipeline.email_outbox import retry_email_enqueues
        retry_email_enqueues()

    def generate_stances(self, person_id=None):
        """Generate AI stance summaries for councillors.

        Lazy-imports the stance generator so the AI client loads only when needed.

        Args:
            person_id: Optional person ID to generate stances for a single councillor.
                       If None, generates for all councillors (is_councillor=true).
        """
        from pipeline.profiling.stance_generator import generate_all_stances

        supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
        if not config.SUPABASE_URL or not supabase_key:
            print("  [!] SUPABASE_URL/KEY not set, skipping stance generation.")
            return

        supabase = create_client(config.SUPABASE_URL, supabase_key)
        generate_all_stances(supabase, person_id=person_id)

    def generate_highlights(self, person_id=None, force=False):
        """Generate AI overview + notable policy positions for councillors.

        Uses embedding-powered profile agent for thematic discovery
        and temporal diversity.

        Args:
            person_id: Optional person ID. If None, generates for all councillors.
            force: If True, regenerate even if profile is recent (<30 days old).
        """
        from pipeline.profiling.stance_generator import generate_councillor_highlights

        supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
        if not config.SUPABASE_URL or not supabase_key:
            print("  [!] SUPABASE_URL/KEY not set, skipping highlights generation.")
            return

        supabase = create_client(config.SUPABASE_URL, supabase_key)
        generate_councillor_highlights(supabase, person_id=person_id, force=force)

    def backfill_document_sections(self, force=False):
        """Backfill extracted documents and sections for all existing documents.

        Uses the document model for boundary detection + content extraction.
        Falls back to PyMuPDF chunker if AI extraction fails.

        Two-pass approach:
        Pass 1 (this method): Extract and create sections for all documents
        Pass 2 (called separately): _embed_new_content() generates embeddings

        Idempotent: skips documents that already have extracted_documents unless force=True.
        """
        import time as _time

        from pipeline.ingestion.document_extractor import extract_and_store_documents

        supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
        if not config.SUPABASE_URL or not supabase_key:
            print("  [!] SUPABASE_URL/KEY not set, skipping backfill.")
            return

        supabase = create_client(config.SUPABASE_URL, supabase_key)
        municipality_id = self.municipality.id if self.municipality else 1

        # If force, delete ALL existing extraction data to start fresh
        if force:
            print("  [!] Force mode: deleting all extracted_documents, document_images, and document_sections...")
            try:
                # document_images has CASCADE from extracted_documents, so deleting
                # extracted_documents handles images. document_sections with
                # extracted_document_id will have that FK set to NULL via CASCADE.
                # We also delete document_sections explicitly for a clean slate.
                supabase.table("document_sections").delete().eq(
                    "municipality_id", municipality_id
                ).execute()
                supabase.table("extracted_documents").delete().eq(
                    "municipality_id", municipality_id
                ).execute()
                print("  [+] Cleared existing extraction data")
            except Exception as e:
                print(f"  [!] Error clearing data: {e}")

        # Fetch all documents with file paths
        result = supabase.table("documents").select(
            "id, meeting_id, title, file_path"
        ).eq("municipality_id", municipality_id).execute()

        documents = result.data or []
        print(f"  Found {len(documents)} documents to process")

        if not documents:
            print("  [!] No documents found. Run pipeline ingestion first.")
            return

        processed = 0
        skipped = 0
        errors = 0

        for doc in documents:
            doc_id = doc["id"]
            meeting_id = doc["meeting_id"]
            title = doc["title"] or f"Document {doc_id}"
            file_path = doc.get("file_path")

            if not file_path:
                skipped += 1
                continue

            # Check idempotency on extracted_documents table (not document_sections)
            if not force:
                try:
                    existing = supabase.table("extracted_documents").select(
                        "id", count="exact"
                    ).eq("document_id", doc_id).execute()
                    if existing.count and existing.count > 0:
                        skipped += 1
                        continue
                except Exception:
                    pass  # Table might not exist; proceed

            # Resolve full PDF path
            meeting_result = supabase.table("meetings").select(
                "archive_path"
            ).eq("id", meeting_id).single().execute()

            if not meeting_result.data or not meeting_result.data.get("archive_path"):
                print(f"  [!] No archive_path for meeting {meeting_id}, skipping {title}")
                skipped += 1
                continue

            archive_path = meeting_result.data["archive_path"]
            if not os.path.isabs(archive_path):
                archive_path = os.path.join(BASE_DIR, archive_path)

            pdf_path = os.path.join(archive_path, file_path)
            if not os.path.exists(pdf_path):
                print(f"  [!] PDF not found: {pdf_path}, skipping {title}")
                skipped += 1
                continue

            # Extract using the AI pipeline (with automatic fallback)
            try:
                stats = extract_and_store_documents(
                    pdf_path, doc_id, meeting_id, supabase, municipality_id
                )
                processed += 1
                print(
                    f"  [+] {title}: {stats['boundaries_found']} boundaries, "
                    f"{stats['sections_created']} sections, {stats['images_extracted']} images"
                )
            except Exception as e:
                print(f"  [!] Error extracting {title}: {e}")
                errors += 1

            # Rate limit: small delay between documents to respect provider limits
            _time.sleep(1)

        print(f"\n  Backfill complete: {processed} documents extracted, {skipped} skipped, {errors} errors")

    def prepare_reextract_images(self):
        """Clear extraction data for documents that have images, so they get re-extracted
        with AI image-to-section matching.

        Deletes extracted_documents rows (CASCADE cleans document_sections + document_images),
        then removes those meeting IDs from backfill_progress.json so backfill picks them up.
        """
        supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
        if not config.SUPABASE_URL or not supabase_key:
            print("  [!] SUPABASE_URL/KEY not set, aborting.")
            return

        supabase = create_client(config.SUPABASE_URL, supabase_key)

        # 1. Find extracted_documents that have images
        print("  Finding documents with images...")
        image_doc_ids = set()
        offset = 0
        page_size = 1000
        while True:
            result = (
                supabase.table("document_images")
                .select("extracted_document_id")
                .range(offset, offset + page_size - 1)
                .execute()
            )
            if not result.data:
                break
            for row in result.data:
                image_doc_ids.add(row["extracted_document_id"])
            if len(result.data) < page_size:
                break
            offset += page_size

        if not image_doc_ids:
            print("  No documents with images found. Nothing to do.")
            return

        # 2. Get the document_id and meeting_id for each extracted_document
        print(f"  Found {len(image_doc_ids)} extracted documents with images")
        meeting_ids = set()
        extracted_doc_list = list(image_doc_ids)
        # Query in batches to avoid URL length limits
        batch_size = 100
        for i in range(0, len(extracted_doc_list), batch_size):
            batch = extracted_doc_list[i : i + batch_size]
            result = (
                supabase.table("extracted_documents")
                .select("id, document_id")
                .in_("id", batch)
                .execute()
            )
            if result.data:
                doc_ids = [row["document_id"] for row in result.data]
                # Look up meeting_ids from documents table
                doc_result = (
                    supabase.table("documents")
                    .select("meeting_id")
                    .in_("id", doc_ids)
                    .execute()
                )
                if doc_result.data:
                    for row in doc_result.data:
                        meeting_ids.add(row["meeting_id"])

        print(f"  Spans {len(meeting_ids)} meetings")

        # 3. Delete extracted_documents (CASCADE removes sections + images)
        print("  Deleting extraction data (CASCADE: sections + images)...")
        for i in range(0, len(extracted_doc_list), batch_size):
            batch = extracted_doc_list[i : i + batch_size]
            supabase.table("extracted_documents").delete().in_("id", batch).execute()
        print(f"  Deleted {len(image_doc_ids)} extracted_documents")

        # 4. Remove those meeting IDs from backfill progress
        progress = self._load_backfill_progress()
        processed = set(progress.get("processed_meeting_ids", []))
        removed = processed & meeting_ids
        processed -= meeting_ids
        self._save_backfill_progress(processed, progress.get("errors", {}))
        print(f"  Removed {len(removed)} meeting IDs from backfill progress")

        print(f"\n  Ready: {len(meeting_ids)} meetings queued for re-extraction")

    def backfill_extracted_documents(self, force=False, limit=None, concurrency=1):
        """Backfill document extraction for all meetings with agenda PDFs from the local archive.

        Walks the archive directory structure to find Agenda PDFs, looks up
        each meeting in the database by archive_path, creates document records
        if needed, and runs the full AI extraction pipeline.

        Uses a local JSON progress file for resumability — can be interrupted
        and restarted without reprocessing completed meetings.

        Args:
            force: If True, delete progress file and all extraction data, start fresh.
            limit: If set, only process this many meetings (for testing).
            concurrency: Number of meetings to process in parallel (default 1).
        """
        from pipeline.ingestion.document_extractor import extract_and_store_documents

        supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
        if not config.SUPABASE_URL or not supabase_key:
            print("  [!] SUPABASE_URL/KEY not set, skipping extraction.")
            return

        supabase = create_client(config.SUPABASE_URL, supabase_key)
        municipality_id = self.municipality.id if self.municipality else 1

        # Load or initialize progress
        progress = self._load_backfill_progress(force)

        if force:
            print("  [!] Force mode: deleting all extraction data and progress...")
            try:
                supabase.table("document_sections").delete().eq(
                    "municipality_id", municipality_id
                ).execute()
                supabase.table("extracted_documents").delete().eq(
                    "municipality_id", municipality_id
                ).execute()
                print("  [+] Cleared existing extraction data")
            except Exception as e:
                print(f"  [!] Error clearing data: {e}")

        processed_ids = set(progress.get("processed_meeting_ids", []))
        error_log = progress.get("errors", {})

        # Build index of meetings by archive_path for fast lookup
        print("  Loading meetings from database...")
        all_meetings = []
        offset = 0
        page_size = 1000
        while True:
            result = supabase.table("meetings").select(
                "id, archive_path, title, meeting_date"
            ).not_.is_("archive_path", "null").range(offset, offset + page_size - 1).execute()
            batch = result.data or []
            all_meetings.extend(batch)
            if len(batch) < page_size:
                break
            offset += page_size

        # Build lookup: relative archive_path -> meeting record
        meeting_by_path = {}
        for m in all_meetings:
            ap = m.get("archive_path", "")
            if ap:
                meeting_by_path[ap] = m

        print(f"  Loaded {len(meeting_by_path)} meetings with archive paths")

        # Walk the archive to find all Agenda directories with PDFs
        print("  Scanning archive for agenda PDFs...")
        meeting_folders = []  # list of (meeting_folder_abs, pdf_paths)

        for root, dirs, files in os.walk(self.archive_root):
            if "Agenda" not in dirs:
                continue

            agenda_dir = os.path.join(root, "Agenda")
            pdfs = sorted(glob.glob(os.path.join(glob.escape(agenda_dir), "*.pdf")))
            if pdfs:
                meeting_folders.append((root, pdfs))

        print(f"  Found {len(meeting_folders)} meeting folders with agenda PDFs")

        if limit:
            meeting_folders = meeting_folders[:limit]
            print(f"  Limiting to {limit} meetings")

        # Filter out already-processed meetings before dispatching
        work_items = []
        skipped_count = 0
        for meeting_folder, pdf_paths in meeting_folders:
            rel_path = os.path.relpath(meeting_folder, BASE_DIR)
            meeting = meeting_by_path.get(rel_path)
            if not meeting:
                tqdm.write(f"  [!] No DB meeting for: {rel_path}")
                skipped_count += 1
                continue
            meeting_id = meeting["id"]
            if meeting_id in processed_ids and not force:
                skipped_count += 1
                continue
            work_items.append((meeting_folder, pdf_paths, meeting))

        print(f"  Work queue: {len(work_items)} meetings to process, {skipped_count} already done")

        if not work_items:
            print("  Nothing to process.")
            return

        # Thread-safe state for concurrent access
        progress_lock = threading.Lock()
        stats_lock = threading.Lock()
        processed_count = 0
        error_count = 0
        start_time = _time.time()
        pbar = tqdm(total=len(work_items), desc="Extracting documents", unit="meeting")

        def _process_meeting(meeting_folder, pdf_paths, meeting):
            """Process a single meeting — designed to run in a thread."""
            nonlocal processed_count, error_count

            # Each thread gets its own Supabase client to avoid connection issues
            thread_supabase = create_client(config.SUPABASE_URL, supabase_key)

            meeting_id = meeting["id"]
            meeting_title = meeting.get("title", "Unknown")
            meeting_date = meeting.get("meeting_date", "")

            meeting_had_error = False
            total_boundaries = 0
            total_sections = 0
            total_images = 0

            for pdf_path in pdf_paths:
                pdf_filename = os.path.basename(pdf_path)
                rel_file_path = os.path.join("Agenda", pdf_filename)

                doc_id = self._find_or_create_document(
                    thread_supabase, meeting_id, pdf_filename, rel_file_path, municipality_id
                )
                if not doc_id:
                    tqdm.write(f"  [!] Could not create document for {pdf_filename}")
                    meeting_had_error = True
                    continue

                try:
                    result_stats = extract_and_store_documents(
                        pdf_path, doc_id, meeting_id, thread_supabase, municipality_id
                    )
                    total_boundaries += result_stats.get("boundaries_found", 0)
                    total_sections += result_stats.get("sections_created", 0)
                    total_images += result_stats.get("images_extracted", 0)
                except Exception as e:
                    tqdm.write(f"  [!] Error extracting {pdf_filename}: {e}")
                    meeting_had_error = True

            # Update shared state under locks
            with progress_lock:
                processed_ids.add(meeting_id)
                if meeting_had_error:
                    error_log[str(meeting_id)] = f"Partial or full failure for {meeting_title}"
                self._save_backfill_progress(processed_ids, error_log)

            with stats_lock:
                if meeting_had_error:
                    error_count += 1
                else:
                    processed_count += 1
                pbar.update(1)

            tqdm.write(
                f"  [{meeting_date}] {meeting_title}: "
                f"{total_boundaries} boundaries, {total_sections} sections, {total_images} images"
            )

        # Dispatch work — sequential or concurrent
        if concurrency <= 1:
            print("  Processing sequentially...")
            for meeting_folder, pdf_paths, meeting in work_items:
                _process_meeting(meeting_folder, pdf_paths, meeting)
        else:
            print(f"  Processing with {concurrency} concurrent workers...")
            with ThreadPoolExecutor(max_workers=concurrency) as executor:
                futures = {
                    executor.submit(_process_meeting, mf, pp, mt): mt
                    for mf, pp, mt in work_items
                }
                for future in as_completed(futures):
                    try:
                        future.result()
                    except Exception as e:
                        mt = futures[future]
                        tqdm.write(f"  [!] Unhandled error for meeting {mt.get('id', '?')}: {e}")

        pbar.close()
        elapsed = _time.time() - start_time
        elapsed_min = elapsed / 60

        print(f"\n  === Extraction Backfill Complete ===")
        print(f"  Processed: {processed_count}")
        print(f"  Skipped:   {skipped_count}")
        print(f"  Errors:    {error_count}")
        print(f"  Time:      {elapsed_min:.1f} minutes")

        if error_log:
            print(f"\n  Errors encountered ({len(error_log)}):")
            for mid, msg in list(error_log.items())[:10]:
                print(f"    Meeting {mid}: {msg}")
            if len(error_log) > 10:
                print(f"    ... and {len(error_log) - 10} more")

    def _find_or_create_document(self, supabase, meeting_id, pdf_filename, rel_file_path, municipality_id):
        """Find existing document record or create one for the given PDF.

        Returns the document_id or None on failure.
        """
        # Try to find existing document by meeting_id + file_path
        try:
            result = supabase.table("documents").select("id").eq(
                "meeting_id", meeting_id
            ).eq("file_path", rel_file_path).execute()

            if result.data:
                return result.data[0]["id"]
        except Exception:
            pass

        # Create new document record
        try:
            # Generate file_hash from the PDF path
            title = os.path.splitext(pdf_filename)[0]

            doc_data = {
                "meeting_id": meeting_id,
                "title": title,
                "category": "Agenda",
                "file_path": rel_file_path,
                "municipality_id": municipality_id,
            }
            result = supabase.table("documents").insert(doc_data).execute()
            if result.data:
                return result.data[0]["id"]
        except Exception as e:
            tqdm.write(f"    [!] Failed to create document record: {e}")

        return None

    def _load_backfill_progress(self, force=False):
        """Load progress from the backfill progress JSON file.

        If force=True or file doesn't exist, returns empty progress.
        """
        if force and os.path.exists(BACKFILL_PROGRESS_FILE):
            os.remove(BACKFILL_PROGRESS_FILE)

        if os.path.exists(BACKFILL_PROGRESS_FILE):
            try:
                with open(BACKFILL_PROGRESS_FILE, "r", encoding="utf-8") as f:
                    progress = json.load(f)
                count = len(progress.get("processed_meeting_ids", []))
                print(f"  Resuming from progress file: {count} meetings already processed")
                return progress
            except (json.JSONDecodeError, IOError):
                print("  [!] Could not read progress file, starting fresh")

        return {
            "processed_meeting_ids": [],
            "errors": {},
            "started_at": datetime.now(timezone.utc).isoformat(),
            "last_updated": datetime.now(timezone.utc).isoformat(),
        }

    def _save_backfill_progress(self, processed_ids, errors):
        """Save progress to the backfill progress JSON file."""
        progress = {
            "processed_meeting_ids": sorted(processed_ids),
            "errors": errors,
            "started_at": None,  # Preserved from initial load
            "last_updated": datetime.now(timezone.utc).isoformat(),
        }

        # Preserve started_at from existing file
        if os.path.exists(BACKFILL_PROGRESS_FILE):
            try:
                with open(BACKFILL_PROGRESS_FILE, "r", encoding="utf-8") as f:
                    existing = json.load(f)
                progress["started_at"] = existing.get("started_at")
            except (json.JSONDecodeError, IOError):
                pass

        if not progress["started_at"]:
            progress["started_at"] = datetime.now(timezone.utc).isoformat()

        with open(BACKFILL_PROGRESS_FILE, "w", encoding="utf-8") as f:
            json.dump(progress, f, indent=2)

    def _resolve_target(self, target: str) -> str:
        """Resolve a --target value to a folder path. Accepts DB ID or path."""
        if target.isdigit():
            supabase_key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
            supabase = create_client(config.SUPABASE_URL, supabase_key)
            result = supabase.table("meetings").select("archive_path").eq("id", int(target)).single().execute()
            if not result.data or not result.data.get("archive_path"):
                raise ValueError(f"Meeting ID {target} not found or has no archive_path")
            path = result.data["archive_path"]
            # DB stores relative paths (e.g. viewroyal_archive/Council/...) —
            # make absolute so file operations work regardless of CWD
            if not os.path.isabs(path):
                path = os.path.join(BASE_DIR, path)
            print(f"  Resolved meeting #{target} → {path}")
            return path

        if not os.path.isdir(target):
            raise ValueError(f"Not a directory: {target}")
        return target
