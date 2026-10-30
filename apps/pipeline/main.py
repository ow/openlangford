import argparse
import os
from datetime import datetime
from pipeline import config
from pipeline import ai
from pipeline.paths import ARCHIVE_ROOT
from pipeline.orchestrator import Archiver, load_municipality
from pipeline.lockfile import PipelineLock
from pipeline.logging_config import setup_logging

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Municipal CivicWeb & Vimeo Archiver")

    parser.add_argument(
        "--municipality", type=str, default=None,
        help="Municipality slug (e.g. 'view-royal'). Loads config from DB.",
    )

    parser.add_argument(
        "--videos-only", action="store_true", help="Skip the document scanning phase."
    )

    parser.add_argument(
        "--include-video", action="store_true", help="Download MP4 video files."
    )

    parser.add_argument(
        "--download-audio",
        action="store_true",
        help="Download audio files (MP3) for processing.",
    )

    parser.add_argument(
        "--limit",
        type=int,
        help="Limit the number of videos to match/download (for testing).",
    )

    parser.add_argument(
        "--skip-diarization",
        action="store_true",
        help="Skip the diarization/transcription phase.",
    )

    parser.add_argument(
        "--process-only",
        action="store_true",
        help="Only process existing audio files (skip download/scrape).",
    )

    parser.add_argument(
        "--input-dir",
        type=str,
        help="Directory containing audio files to process (overrides default).",
    )

    parser.add_argument(
        "--rediarize",
        action="store_true",
        help="Re-run diarization only, reusing cached raw transcripts (skips STT).",
    )

    parser.add_argument(
        "--skip-ingest",
        action="store_true",
        help="Skip Phase 4 (database ingestion).",
    )

    parser.add_argument(
        "--skip-embed",
        action="store_true",
        help="Skip Phase 5 (embedding generation).",
    )

    parser.add_argument(
        "--ingest-only",
        action="store_true",
        help="Only run Phase 4 (ingestion with change detection).",
    )

    parser.add_argument(
        "--embed-only",
        action="store_true",
        help="Only run Phase 5 (embed rows where embedding IS NULL).",
    )

    parser.add_argument(
        "--reextract-images",
        action="store_true",
        help="Re-extract documents that have images to get AI-powered image-to-section mapping. "
             "Clears extraction data for image-bearing PDFs, then runs normal extraction. "
             "Use --limit N and --concurrency N as with --extract-documents.",
    )

    parser.add_argument(
        "--extract-documents",
        action="store_true",
        help="Run AI-powered document extraction on all agenda PDFs (resumable). "
             "Replaces existing document_sections. Use --force to delete and reprocess all. "
             "Use --limit N to process only N meetings.",
    )

    parser.add_argument(
        "--backfill-sections",
        action="store_true",
        help="[DEPRECATED: use --extract-documents] Backfill document sections for all existing documents.",
    )

    parser.add_argument(
        "--concurrency",
        type=int,
        default=1,
        help="Number of meetings to process in parallel (default 1). "
             "Use with --extract-documents. Recommended: 5-10.",
    )

    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-processing (delete and recreate existing data). Used with --extract-documents or --backfill-sections.",
    )

    parser.add_argument(
        "--target",
        type=str,
        help="Target a specific meeting by DB ID or folder path (force re-processes).",
    )

    parser.add_argument(
        "--update",
        action="store_true",
        help="Force update existing meetings during ingestion.",
    )

    parser.add_argument(
        "--discover",
        action="store_true",
        help="Discover source meetings and sync their documents (no audio, ingestion or AI). "
             "With --dry-run: print the plan (linked / new / blocked) and write nothing.",
    )

    parser.add_argument(
        "--check-updates",
        action="store_true",
        help="Check CivicWeb and Vimeo for new content without processing. "
             "Prints a report of meetings with changes.",
    )

    parser.add_argument(
        "--update-mode",
        action="store_true",
        help="Run in update mode: scrape CivicWeb, check Vimeo, detect changes, "
             "and selectively re-process only meetings with new content. "
             "Recommended for daily automated runs.",
    )

    parser.add_argument(
        "--test",
        action="store_true",
        help="Mark this as a test run. Push notifications will be prefixed with [TEST].",
    )

    parser.add_argument(
        "--classify-topics",
        action="store_true",
        help="Classify all agenda items into topic taxonomy (backfill agenda_item_topics table).",
    )

    parser.add_argument(
        "--generate-stances",
        action="store_true",
        help="Generate AI stance summaries for all councillors using the configured provider. "
             "Use --target to generate for a specific person ID only.",
    )
    parser.add_argument(
        "--generate-highlights",
        action="store_true",
        help="Generate councillor overview + notable policy positions using the configured provider. "
             "Use --target to generate for a specific person ID only.",
    )
    parser.add_argument(
        "--detect-key-votes",
        action="store_true",
        help="Detect key votes (minority, close, ally breaks) for all councillors. "
             "Use --target to detect for a specific person ID only.",
    )
    parser.add_argument(
        "--generate-profiles",
        action="store_true",
        help="Generate enhanced AI narrative profiles for all councillors. "
             "Use --target to generate for a specific person ID only.",
    )

    parser.add_argument(
        "--matter-summaries",
        action="store_true",
        help="Write plain-English summaries, status lines and topics for matters missing them. "
             "Use --target to regenerate one matter ID, or --force for every matter.",
    )
    parser.add_argument(
        "--attachments",
        action="store_true",
        help="Download eSCRIBE agenda attachments (staff reports, bylaws) and extract them, linked to their "
             "agenda items. Use --target for one meeting ID or --since for a date range.",
    )
    parser.add_argument(
        "--align-agenda",
        action="store_true",
        help="Fill missing agenda item discussion start/end times from transcripts (never overwrites). "
             "Use --target for one meeting ID or --since YYYY-MM-DD; --dry-run to only print.",
    )
    parser.add_argument(
        "--align-ai",
        action="store_true",
        help="With --align-agenda: let the AI place items left between two anchored items.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="With --stage (and its aliases): print what would be processed; no model calls, no writes. "
             "agenda-alignment prints its proposed times.",
    )
    parser.add_argument(
        "--matter-links",
        action="store_true",
        help="Link related matters (same initiative) and mentions in mixed-topic items. Use --since to limit.",
    )
    parser.add_argument(
        "--since",
        help="With --stage: only items on or after this date (YYYY-MM-DD; matters by last_seen).",
    )
    parser.add_argument(
        "--stage",
        help="Run one registered post-ingest/enrichment stage (see --stages). "
             "Use --target ID, --since DATE, --stale, --force, --dry-run.",
    )
    parser.add_argument(
        "--stages",
        action="store_true",
        help="List the registered stages with descriptions, then exit.",
    )
    parser.add_argument(
        "--stale",
        action="store_true",
        help="With --stage: only items whose version stamp is older than the stage's current version.",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="With --stage bylaws: every bylaw (directory + media library). Unchanged PDFs are skipped unless --force.",
    )
    parser.add_argument(
        "--source",
        choices=("all", "directory", "media"),
        default="all",
        help="With --stage bylaws --all: only the bylaws directory or only the media library.",
    )

    args = parser.parse_args()

    from pipeline import stages as stage_registry

    if args.stages:
        print("Registered stages (in run order):\n")
        print(stage_registry.describe_stages())
        raise SystemExit(0)

    # Old one-off flags are aliases for registry stages.
    for flag, name in (
        ("matter_summaries", "matter-summaries"),
        ("attachments", "escribe-attachments"),
        ("align_agenda", "agenda-alignment"),
        ("matter_links", "matter-links"),
    ):
        if getattr(args, flag) and not args.stage:
            args.stage = name

    if args.stage:
        try:
            stage_registry.get_stage(args.stage)
        except stage_registry.StageError as exc:
            parser.error(str(exc))

    # Set up rotating log file + console logging before any work
    setup_logging()

    # Persist AI usage/failures to ai_usage (batched, never blocks or fails a run).
    from pipeline.ai.usage import usage_context
    from pipeline.ai.usage_sink import install_usage_logging

    if not args.dry_run:
        install_usage_logging()

    cli_job = args.stage or next(
        (name for name in (
            "classify_topics", "discover", "check_updates", "update_mode", "generate_stances", "generate_highlights",
            "detect_key_votes", "generate_profiles", "ingest_only", "embed_only", "reextract_images",
            "extract_documents", "backfill_sections", "process_only", "rediarize",
        ) if getattr(args, name)),
        "target" if args.target else "run",
    ).replace("_", "-")

    # Acquire exclusive lock -- exits cleanly if another run is in progress
    with PipelineLock(), usage_context(job=cli_job):
        print(f"[*] Pipeline started at {datetime.now().isoformat()}")

        # Load municipality config if specified
        municipality = None
        if args.municipality:
            municipality = load_municipality(args.municipality)
            print(f"[*] Municipality: {municipality.name} ({municipality.slug})")

        # Use centralized ARCHIVE_ROOT as default
        output_dir = args.input_dir if args.input_dir else ARCHIVE_ROOT

        app = Archiver(municipality=municipality, initialize_diarizer=not args.discover)

        if args.classify_topics:
            print("\n--- Classifying Agenda Items into Topics ---")
            from pipeline.profiling.topic_classifier import classify_topics
            from pipeline import config as pipeline_config
            from pipeline.supabase_client import create_client as create_sb_client
            sb_key = pipeline_config.SUPABASE_SECRET_KEY or pipeline_config.SUPABASE_KEY
            if not pipeline_config.SUPABASE_URL or not sb_key:
                print("  [!] SUPABASE_URL/KEY not set, skipping topic classification.")
            else:
                sb = create_sb_client(pipeline_config.SUPABASE_URL, sb_key)
                classify_topics(sb)
        elif args.discover:
            print(f"\n--- Source discovery{' (dry run)' if args.dry_run else ''} ---")
            plan = app._sync_documents(limit=args.limit, dry_run=args.dry_run)
            for entry in sorted(plan.values(), key=lambda e: (e["action"], e["date"])):
                if entry["action"] != "linked":
                    print(f"  {entry['action']:<7} {entry['date']} {entry['title']} -> "
                          f"{entry.get('conflicts') or entry['archive_root']}")
        elif args.check_updates:
            print("\n--- Update Check (Dry Run) ---")
            app.run_update_check()
        elif args.update_mode:
            print("\n--- Update Mode ---")
            app.run_update_mode(
                download_audio=True,  # Always download audio in update mode
                skip_diarization=args.skip_diarization,
                skip_embed=args.skip_embed,
                test=args.test,
            )
        elif args.stage:
            stage = stage_registry.get_stage(args.stage)
            print(f"\n--- Stage: {stage.name} (v{stage.version}){' [dry run]' if args.dry_run else ''} ---")
            sb = app._get_admin_supabase()
            if sb is None:
                print("  [!] SUPABASE_URL/KEY not set.")
                raise SystemExit(1)
            ctx = stage_registry.StageContext(
                supabase=sb,
                target=args.target,
                since=args.since,
                dry_run=args.dry_run,
                stale=args.stale,
                force=args.force,
                archiver=app,
                options={"align_ai": args.align_ai, "all": args.all, "source": args.source},
            )
            try:
                stage_registry.run_stage(stage, ctx, raise_errors=True)
            except stage_registry.StageError as exc:
                print(f"  [!] {exc}")
                raise SystemExit(2)
        elif args.generate_stances:
            print("\n--- Generating Councillor Stance Summaries ---")
            person_id = int(args.target) if args.target else None
            app.generate_stances(person_id=person_id)
        elif args.generate_highlights:
            print("\n--- Generating Councillor Highlights ---")
            person_id = int(args.target) if args.target else None
            app.generate_highlights(person_id=person_id, force=args.force)
        elif args.detect_key_votes:
            print("\n--- Detecting Key Votes ---")
            from pipeline.profiling.key_vote_detector import detect_all_key_votes
            from pipeline import config as pipeline_config
            from pipeline.supabase_client import create_client as create_sb_client
            sb_key = pipeline_config.SUPABASE_SECRET_KEY or pipeline_config.SUPABASE_KEY
            if not pipeline_config.SUPABASE_URL or not sb_key:
                print("  [!] SUPABASE_URL/KEY not set, skipping key vote detection.")
            else:
                sb = create_sb_client(pipeline_config.SUPABASE_URL, sb_key)
                person_id = int(args.target) if args.target else None
                detect_all_key_votes(sb, person_id=person_id)
        elif args.generate_profiles:
            print("\n--- Generating Enhanced AI Narrative Profiles ---")
            from pipeline.profiling.stance_generator import generate_councillor_narratives
            from pipeline import config as pipeline_config
            from pipeline.supabase_client import create_client as create_sb_client
            sb_key = pipeline_config.SUPABASE_SECRET_KEY or pipeline_config.SUPABASE_KEY
            if not pipeline_config.SUPABASE_URL or not sb_key:
                print("  [!] SUPABASE_URL/KEY not set, skipping profile generation.")
            else:
                sb = create_sb_client(pipeline_config.SUPABASE_URL, sb_key)
                person_id = int(args.target) if args.target else None
                generate_councillor_narratives(sb, person_id=person_id)
        elif args.target:
            # Targeted mode: diarize → ingest → embed for a single meeting
            folder = app._resolve_target(args.target)
            diarized = set()
            if app.ai_enabled and not args.skip_diarization:
                print(f"\n--- Diarizing target: {folder} ---")
                diarized = app._process_audio_files(
                    limit=args.limit, output_dir=folder, rediarize=args.rediarize
                )
            if not args.skip_ingest:
                print(f"\n--- Ingesting target: {folder} ---")
                app._ingest_meetings(diarized_folders=diarized, target_folder=folder, force_update=True)
            if not args.skip_embed:
                print("\n--- Embedding new content ---")
                app._embed_new_content()
        elif args.ingest_only:
            print("\n--- Ingestion Only (with change detection) ---")
            app._ingest_meetings(force_update=args.update)
        elif args.embed_only:
            print("\n--- Embedding Only ---")
            app._embed_new_content()
        elif args.reextract_images:
            print("\n--- Re-extract Documents with Images (AI Image Matching) ---")
            app.prepare_reextract_images()
            app.backfill_extracted_documents(concurrency=args.concurrency, limit=args.limit)
            if not args.skip_embed:
                print("\n--- Embedding Document Sections ---")
                app._embed_new_content()
        elif args.extract_documents:
            document = ai.resolve("document")
            print(f"\n--- Extract Documents ({document.provider}: {document.model}) ---")
            app.backfill_extracted_documents(force=args.force, limit=args.limit, concurrency=args.concurrency)
            if not args.skip_embed:
                print("\n--- Embedding Document Sections ---")
                app._embed_new_content()
        elif args.backfill_sections:
            print("\n--- Backfill Document Sections (DEPRECATED: use --extract-documents) ---")
            app.backfill_document_sections(force=args.force)
            if not args.skip_embed:
                print("\n--- Embedding Document Sections ---")
                app._embed_new_content()
        elif args.process_only or args.rediarize:
            if app.ai_enabled:
                mode = "Re-diarizing" if args.rediarize else "Processing"
                print(f"{mode} existing audio files in {output_dir}...")
                # pylint: disable=protected-access
                diarized = app._process_audio_files(
                    limit=args.limit, output_dir=output_dir, rediarize=args.rediarize
                )
                if not args.skip_ingest:
                    print("\n--- Phase 4: Database Ingestion ---")
                    app._ingest_meetings(diarized_folders=diarized)
                if not args.skip_embed:
                    print("\n--- Phase 5: Embedding Generation ---")
                    app._embed_new_content()
            else:
                print("[Error] AI processing not enabled.")
        else:
            app.run(
                skip_docs=args.videos_only,
                include_video=args.include_video,
                limit=args.limit,
                download_audio=args.download_audio,
                skip_diarization=args.skip_diarization,
                rediarize=args.rediarize,
                skip_ingest=args.skip_ingest,
                skip_embed=args.skip_embed,
            )

        print(f"[*] Pipeline finished at {datetime.now().isoformat()}")
