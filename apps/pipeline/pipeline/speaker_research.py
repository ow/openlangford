"""Build a source-linked speaking inventory for a named meeting participant.

Run from apps/pipeline with:
  .venv/bin/python -m pipeline.speaker_research --name "Jane Doe"
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import csv
import json
import re
import time
from collections import Counter, defaultdict
from pathlib import Path

import psycopg2
from dotenv import load_dotenv
import numpy as np

from pipeline import db


PROJECT_ROOT = Path(__file__).resolve().parents[3]


def name_aliases(name: str, extra: list[str]) -> list[str]:
    aliases = [name.strip(), *[alias.strip() for alias in extra]]
    parts = name.strip().split()
    if len(parts) == 2 and len(parts[0]) > 1:
        aliases.append(f"{parts[0][0]}. {parts[1]}")
    return list(dict.fromkeys(alias for alias in aliases if alias))


def name_pattern(aliases: list[str]) -> re.Pattern[str]:
    escaped = [re.escape(alias).replace(r"\ ", r"\s+") for alias in aliases]
    return re.compile(r"(?<![\w])(?:" + "|".join(escaped) + r")(?![\w])", re.I)


def minute_excerpts(full_text: str, pattern: re.Pattern[str]) -> list[str]:
    excerpts = []
    for match in pattern.finditer(full_text):
        snippet = full_text[match.end() : match.end() + 500]
        # Minutes commonly put a public address between the name and speech.
        separator = re.search(r"\s[-–—]\s", snippet[:100])
        if separator:
            snippet = snippet[separator.end() :]
        snippet = " ".join(snippet.split())
        next_speaker = re.search(r"\s[A-Z]\.\s*[A-Z][a-z]+(?:[,\.]|\s+[A-Z][a-z]+)", snippet)
        if next_speaker:
            snippet = snippet[: next_speaker.start()]
        snippet = re.sub(
            r"\b\d{3,5}\s+.{0,35}?(?:Rd|Road|Dr|Drive|St|Street|Ave|Avenue|Pkwy|Lane|Terr|Pl|Place)\b",
            "[address omitted]",
            snippet,
        )
        excerpts.append(snippet[:260].rstrip())
    return [excerpt for excerpt in excerpts if excerpt]


def minute_excerpt(full_text: str, pattern: re.Pattern[str]) -> str:
    """Compatibility helper for a single preview."""
    return next(iter(minute_excerpts(full_text, pattern)), "")


def research_rows(connection, municipality: str, aliases: list[str]) -> list[dict]:
    pattern = name_pattern(aliases)
    db_pattern = r"(?i)(?:" + "|".join(re.escape(a) for a in aliases) + r")"
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT m.id, m.meeting_date, m.type, m.archive_path, m.municipality_id,
                   m.video_url,
                   d.id, d.source_url, d.full_text
            FROM documents d
            JOIN meetings m ON m.id = d.meeting_id
            JOIN municipalities mu ON mu.id = m.municipality_id
            WHERE mu.slug = %s AND d.category = 'Minutes'
              AND d.full_text ~* %s
            ORDER BY m.meeting_date, m.id, d.id
            """,
            (municipality, db_pattern),
        )
        minute_records = cursor.fetchall()

        speaker_labels = aliases + [f"{alias} (public)" for alias in aliases]
        cursor.execute(
            """
            SELECT t.meeting_id, t.id, t.speaker_name, t.start_time,
                   t.end_time, t.text_content
            FROM transcript_segments t
            JOIN meetings m ON m.id = t.meeting_id
            JOIN municipalities mu ON mu.id = m.municipality_id
            WHERE mu.slug = %s AND t.speaker_name = ANY(%s)
            ORDER BY t.meeting_id, t.start_time
            """,
            (municipality, speaker_labels),
        )
        turns_by_meeting: dict[int, list[dict]] = defaultdict(list)
        for meeting_id, segment_id, speaker, start, end, text in cursor.fetchall():
            turns_by_meeting[meeting_id].append(
                {
                    "id": segment_id,
                    "speaker": speaker,
                    "start": float(start),
                    "end": float(end),
                    "text": text,
                }
            )

    by_meeting: dict[int, dict] = {}
    for meeting_id, date, meeting_type, archive_path, municipality_id, video_url, doc_id, source_url, full_text in minute_records:
        candidate = {
            "meeting_id": meeting_id,
            "municipality_id": municipality_id,
            "date": date.isoformat(),
            "meeting_type": meeting_type,
            "archive_path": archive_path,
            "video_url": video_url,
            "minutes_document_id": doc_id,
            "minutes_url": source_url,
            "minute_excerpts": minute_excerpts(full_text, pattern),
            "name_mentions": len(pattern.findall(full_text)),
        }
        previous = by_meeting.get(meeting_id)
        if previous is None or candidate["name_mentions"] > previous["name_mentions"]:
            by_meeting[meeting_id] = candidate

    transcript_only_ids = list(set(turns_by_meeting) - set(by_meeting))
    if transcript_only_ids:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, meeting_date, type, archive_path, municipality_id, video_url
                FROM meetings WHERE id = ANY(%s)
                """,
                (transcript_only_ids,),
            )
            for meeting_id, date, meeting_type, archive_path, municipality_id, video_url in cursor.fetchall():
                by_meeting[meeting_id] = {
                    "meeting_id": meeting_id,
                    "municipality_id": municipality_id,
                    "date": date.isoformat(),
                    "meeting_type": meeting_type,
                    "archive_path": archive_path,
                    "video_url": video_url,
                    "minutes_document_id": None,
                    "minutes_url": None,
                    "minute_excerpt": "",
                    "minute_excerpts": [],
                    "name_mentions": 0,
                }

    rows = sorted(by_meeting.values(), key=lambda row: (row["date"], row["meeting_id"]))
    for row in rows:
        row["turns"] = turns_by_meeting.get(row["meeting_id"], [])
        row["timed_seconds"] = round(
            sum(max(0, turn["end"] - turn["start"]) for turn in row["turns"]), 2
        )
    refresh_local_sources(rows)
    return rows


def refresh_local_sources(rows: list[dict]) -> None:
    """Filesystem discovery stays fresh without reloading database text."""
    for row in rows:
        archive = Path(row["archive_path"])
        if not archive.is_absolute():
            archive = PROJECT_ROOT / archive
        audio_files = sorted((archive / "Audio").glob("*.m4a"))
        row["audio_path"] = str(audio_files[0]) if audio_files else None
        row["local_transcript"] = bool(audio_files and audio_files[0].with_suffix(".json").exists())


def queue_missing_transcripts(connection, rows: list[dict], name: str) -> list[int]:
    """Queue local transcription only; preserve existing meeting extraction state."""
    missing = [row for row in rows if row["audio_path"] and not row["local_transcript"]]
    if not missing:
        return []
    # End the read transaction the caller's loads opened; the queueing then runs in its
    # own read-write transaction (db.run_write).
    connection.commit()

    def enqueue(cursor) -> list[int]:
        cursor.execute(
            """
            SELECT (args->>'meeting_id')::bigint
            FROM pipeline_jobs
            WHERE job_type = 'transcribe_meeting'
              AND status IN ('queued', 'running', 'succeeded')
              AND args ? 'meeting_id'
            """
        )
        already_queued = {row[0] for row in cursor.fetchall()}
        job_ids = []
        for row in missing:
            if row["meeting_id"] in already_queued:
                continue
            cursor.execute(
                """
                INSERT INTO pipeline_jobs
                    (municipality_id, job_type, args, priority, requested_by, max_attempts)
                VALUES (%s, 'transcribe_meeting', %s::jsonb, 10, %s, 2)
                RETURNING id
                """,
                (
                    row["municipality_id"],
                    json.dumps({"meeting_id": row["meeting_id"]}),
                    f"speaker-research:{name}",
                ),
            )
            job_ids.append(cursor.fetchone()[0])
        return job_ids

    return db.run_write(enqueue, connection)


def local_turns_from_segments(
    segments: list[dict], labels: set[str], windows: list[list[float]]
) -> list[dict]:
    turns: list[dict] = []
    current: list[dict] = []
    for segment in segments + [{"speaker": None}]:
        within_window = not windows or any(
            float(segment.get("start", -1)) >= float(start)
            and float(segment.get("end", -1)) <= float(end)
            for start, end in windows
        )
        if segment.get("speaker") in labels and within_window:
            current.append(segment)
        elif current:
            turns.append({
                "speaker": current[0]["speaker"],
                "start": float(current[0]["start"]),
                "end": float(current[-1]["end"]),
                "speech_seconds": round(sum(
                    max(0, float(part["end"]) - float(part["start"]))
                    for part in current
                ), 2),
                "text": " ".join(part["text"] for part in current),
                "source_kind": "provisional_local_speaker_manifest",
            })
            current = []
    return turns


def attach_reviewed_local_turns(rows: list[dict], manifest_path: Path | None) -> None:
    """Add speaker turns identified from local transcripts without changing the database."""
    if not manifest_path:
        return
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    reviews = manifest.get("meetings", {})
    for row in rows:
        review = reviews.get(str(row["meeting_id"]))
        row["local_reviewed_turns"] = []
        row["review_source_kind"] = "provisional_local_speaker_manifest"
        row["review_evidence"] = review.get("evidence", "") if review else ""
        row["review_topics"] = review.get("topics", []) if review else []
        if not review or not row["audio_path"] or row["turns"]:
            continue
        service_check = review.get("service_check")
        if service_check:
            service_path = Path(service_check["path"])
            if not service_path.is_absolute():
                service_path = PROJECT_ROOT / service_path
            result = json.loads(service_path.read_text(encoding="utf-8"))
            offset = float(result["clip_start_seconds"])
            service_windows = service_check.get("include_windows", [])
            service_speakers = set(service_check.get(
                "speaker_names", [service_check["speaker_name"]]
            ))
            selected = [
                segment for segment in result["response"]["segments"]
                if segment.get("speaker") in service_speakers
                and (not service_windows or any(
                    offset + float(segment["start"]) >= float(start)
                    and offset + float(segment["end"]) <= float(end)
                    for start, end in service_windows
                ))
            ]
            if selected:
                intervals = sorted(
                    (offset + float(segment["start"]), offset + float(segment["end"]))
                    for segment in selected
                )
                speech_seconds = 0.0
                previous_end = intervals[0][0]
                for start, end in intervals:
                    speech_seconds += max(0, end - max(start, previous_end))
                    previous_end = max(previous_end, end)
                row["local_reviewed_turns"] = [{
                    "speaker": service_check["speaker_name"],
                    "start": intervals[0][0],
                    "end": max(end for _, end in intervals),
                    "speech_seconds": round(speech_seconds, 2),
                    "text": " ".join(segment["text"].strip() for segment in selected),
                    "source_kind": "provisional_service_diarization",
                }]
                row["review_source_kind"] = "provisional_service_diarization"
                local_windows = service_check.get("include_local_windows", [])
                if local_windows:
                    local_path = Path(row["audio_path"]).with_suffix(".json")
                    local_data = json.loads(local_path.read_text(encoding="utf-8"))
                    row["local_reviewed_turns"].extend(local_turns_from_segments(
                        local_data.get("segments", []),
                        set(review.get("speaker_labels", [])),
                        local_windows,
                    ))
                    row["local_reviewed_turns"].sort(key=lambda turn: turn["start"])
                continue
        transcript_path = Path(row["audio_path"]).with_suffix(".json")
        if not transcript_path.exists():
            continue
        data = json.loads(transcript_path.read_text(encoding="utf-8"))
        labels = set(review.get("speaker_labels", []))
        windows = review.get("include_windows", [])
        row["local_reviewed_turns"] = local_turns_from_segments(
            data.get("segments", []), labels, windows
        )


def write_voice_candidates(rows: list[dict], manifest_path: Path | None, output: Path) -> int:
    """Rank diarized voices for review; never treat a similarity as identification."""
    if not manifest_path:
        return 0
    reviews = json.loads(manifest_path.read_text(encoding="utf-8")).get("meetings", {})
    references = []
    for row in rows:
        review = reviews.get(str(row["meeting_id"]))
        if not review or not row["audio_path"]:
            continue
        transcript_path = Path(row["audio_path"]).with_suffix(".json")
        if not transcript_path.exists():
            continue
        centroids = json.loads(transcript_path.read_text(encoding="utf-8")).get("speaker_centroids", {})
        for label in review.get("speaker_labels", []):
            key = f"SPEAKER_{int(label.split('_')[-1]):02d}"
            if key in centroids:
                vector = np.asarray(centroids[key], dtype=np.float32)
                references.append(vector / np.linalg.norm(vector))
    if not references:
        return 0
    reference = np.mean(references, axis=0)
    reference /= np.linalg.norm(reference)

    candidates = []
    for row in rows:
        if row["turns"] or reviews.get(str(row["meeting_id"])) or not row["audio_path"]:
            continue
        transcript_path = Path(row["audio_path"]).with_suffix(".json")
        if not transcript_path.exists():
            continue
        data = json.loads(transcript_path.read_text(encoding="utf-8"))
        ranked = []
        for key, values in data.get("speaker_centroids", {}).items():
            vector = np.asarray(values, dtype=np.float32)
            similarity = float(np.dot(reference, vector / np.linalg.norm(vector)))
            label = f"Speaker_{int(key.split('_')[-1])}"
            segments = [s for s in data.get("segments", []) if s.get("speaker") == label]
            if not segments:
                continue
            ranked.append(
                (similarity, label, round(sum(
                    max(0, float(s["end"]) - float(s["start"])) for s in segments
                ), 2), " ".join(s["text"] for s in segments[:3])[:240],
                 float(segments[0]["start"]), float(segments[0]["end"]))
            )
        for rank, (similarity, label, seconds, sample, sample_start, sample_end) in enumerate(
            sorted(ranked, reverse=True)[:3], start=1
        ):
            candidates.append({
                "date": row["date"], "meeting_id": row["meeting_id"],
                "rank": rank, "speaker_label": label,
                "voice_similarity": round(similarity, 3),
                "speech_seconds_if_confirmed": seconds,
                "sample_start_seconds": round(sample_start, 2),
                "sample_end_seconds": round(sample_end, 2),
                "sample_text": sample,
                "local_audio_path": row["audio_path"],
                "official_recording_url": row["video_url"] or "",
                "status": "needs_audio_review",
            })
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=[
            "date", "meeting_id", "rank", "speaker_label", "voice_similarity",
            "speech_seconds_if_confirmed", "sample_start_seconds", "sample_end_seconds",
            "sample_text", "local_audio_path", "official_recording_url", "status",
        ])
        writer.writeheader()
        writer.writerows(candidates)
    return len(candidates)


def build_turn_rows(rows: list[dict], name: str, site_base_url: str) -> list[dict]:
    """Flatten attributed turns for filtering without promoting them to verified claims."""
    turns = []
    for meeting in rows:
        meeting_url = f"{site_base_url.rstrip('/')}/meetings/{meeting['meeting_id']}"
        common = {
            "person_searched": name,
            "meeting_id": meeting["meeting_id"],
            "date": meeting["date"],
            "meeting_type": meeting["meeting_type"],
            "minutes_url": meeting.get("minutes_url") or "",
            "official_recording_url": meeting.get("video_url") or "",
            "local_audio_path": meeting.get("audio_path") or "",
            "meeting_topic_hints": " | ".join(meeting.get("review_topics", [])),
            "review_status": "needs_audio_review",
        }
        # The local manifest is used only when the archive has no named DB turns.
        # This prevents counting the same speech twice.
        if meeting["turns"]:
            source_turns = meeting["turns"]
            source_kind = "archive_transcript_name_match"
        else:
            source_turns = meeting.get("local_reviewed_turns", [])
            source_kind = meeting.get("review_source_kind", "provisional_local_speaker_manifest")
        for turn in source_turns:
            start, end = float(turn["start"]), float(turn["end"])
            turns.append({
                **common,
                "source_kind": turn.get("source_kind", source_kind),
                "speaker_label": turn.get("speaker", ""),
                "start_seconds": round(start, 2),
                "end_seconds": round(end, 2),
                "speech_seconds": round(turn.get("speech_seconds", max(0, end - start)), 2),
                "transcript_url": (
                    f"{meeting_url}#transcript={turn['id']}" if turn.get("id") else meeting_url
                ),
                "attribution_evidence": meeting.get("review_evidence", ""),
                "text": " ".join(turn["text"].split()),
            })
    return turns


def write_turns_csv(rows: list[dict], name: str, site_base_url: str, output: Path) -> int:
    turn_rows = build_turn_rows(rows, name, site_base_url)
    fields = [
        "person_searched", "meeting_id", "date", "meeting_type", "source_kind",
        "speaker_label", "start_seconds", "end_seconds", "speech_seconds",
        "text", "review_status", "attribution_evidence", "meeting_topic_hints",
        "transcript_url", "minutes_url", "official_recording_url", "local_audio_path",
    ]
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fields)
        writer.writeheader()
        writer.writerows(turn_rows)
    return len(turn_rows)


def write_report(
    rows: list[dict], name: str, aliases: list[str], output: Path,
    site_base_url: str, remaining_jobs: int | None = None,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    csv_path = output.with_suffix(".csv")
    transcript_turns = sum(len(row["turns"]) for row in rows)
    timed_seconds = sum(row["timed_seconds"] for row in rows)
    transcribed_meetings = sum(bool(row["turns"]) for row in rows)
    local_transcripts = sum(bool(row["local_transcript"]) for row in rows)
    reviewed_turns = sum(len(row.get("local_reviewed_turns", [])) for row in rows)
    reviewed_seconds = sum(
        turn["speech_seconds"] for row in rows for turn in row.get("local_reviewed_turns", [])
    )
    audio_meetings = sum(bool(row["audio_path"]) for row in rows)
    years = Counter(row["date"][:4] for row in rows)

    lines = [
        f"# {name}: council speaking inventory",
        "",
        f"Name labels searched: {', '.join(aliases)}.",
        "",
        f"- Meetings with a named minutes entry: **{sum(bool(row['minutes_document_id']) for row in rows)}**.",
        f"- Meetings with minutes or transcript attribution: **{len(rows)}**.",
        f"- Meetings with local audio: **{audio_meetings}/{len(rows)}**.",
        f"- Meetings with local transcripts: **{local_transcripts}/{len(rows)}**.",
        *([f"- Background transcription jobs remaining: **{remaining_jobs}**."] if remaining_jobs is not None else []),
        f"- Timed transcript coverage: **{transcribed_meetings} meetings, {transcript_turns} turns, {timed_seconds / 60:.1f} minutes**.",
        f"- Additional provisional speaker blocks: **{reviewed_turns} block(s), {reviewed_seconds / 60:.1f} minutes** (diarized timing).",
        "- These are archive observations. Timed speech includes provisional speaker attribution and requires audio review before publication.",
        "",
        "## Meetings by year",
        "",
    ]
    lines.extend(f"- {year}: {count}" for year, count in sorted(years.items()))
    lines.extend(["", "## Source-linked meeting inventory", ""])
    for row in rows:
        meeting_url = f"{site_base_url.rstrip('/')}/meetings/{row['meeting_id']}"
        lines.append(f"### [{row['date']} — {row['meeting_type']}]({meeting_url})")
        lines.append("")
        if row["minutes_url"]:
            lines.append(f"[Official minutes]({row['minutes_url']}) · {row['name_mentions']} name mention(s) in selected minutes")
        if row["video_url"]:
            lines.append(f"[Official recording]({row['video_url']})")
        for excerpt in row["minute_excerpts"]:
            lines.append(f"- Minutes excerpt near name: {excerpt}")
        if row.get("review_topics"):
            lines.append(f"- Topics noted from transcript: {', '.join(row['review_topics'])}.")
        if row["turns"]:
            for turn in row["turns"]:
                duration = max(0, turn["end"] - turn["start"])
                timestamp_url = f"{meeting_url}#transcript={turn['id']}"
                preview = " ".join(turn["text"].split())[:300].rstrip()
                lines.append(
                    f"- [Timed turn at {turn['start'] / 60:.1f} min]({timestamp_url}): "
                    f"{duration:.1f} sec — {preview}"
                )
        elif row.get("local_reviewed_turns"):
            lines.append(f"- Provisional local speaker identification: {row['review_evidence']}")
            for turn in row["local_reviewed_turns"]:
                preview = " ".join(turn["text"].split())[:500].rstrip()
                lines.append(
                    f"- Provisional timed block ({turn.get('source_kind', row.get('review_source_kind', 'local diarization'))}) "
                    f"at {turn['start'] / 60:.1f} min: "
                    f"{turn['speech_seconds']:.1f} sec — {preview}"
                )
        else:
            lines.append("- Timed speech: pending transcription and speaker review.")
        lines.append("")
    output.write_text("\n".join(lines), encoding="utf-8")

    with csv_path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(
            file,
            fieldnames=[
                "date", "meeting_id", "meeting_type", "minutes_url", "video_url",
                "minute_excerpts", "name_mentions", "audio_path",
                "timed_turns", "timed_seconds",
                "reviewed_local_turns", "reviewed_local_seconds",
            ],
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {**{key: row[key] for key in writer.fieldnames if key in row},
                 "minute_excerpts": " | ".join(row["minute_excerpts"]),
                 "timed_turns": len(row["turns"]),
                 "reviewed_local_turns": len(row.get("local_reviewed_turns", [])),
                 "reviewed_local_seconds": sum(
                     turn["speech_seconds"] for turn in row.get("local_reviewed_turns", [])
                 )}
            )


def research_job_state(connection, name: str) -> tuple:
    """Small queue fingerprint: completion/replacement matters, heartbeats don't."""
    with connection.cursor() as cursor:
        cursor.execute(
            """SELECT id, status FROM pipeline_jobs
               WHERE job_type = 'transcribe_meeting' AND requested_by = %s
               ORDER BY id""",
            (f"speaker-research:{name}",),
        )
        return tuple(cursor.fetchall())


class ResearchWatchSnapshot:
    """Reuse bulk source text within one run; periodically discover corrections.

    Local reviewed turns are intentionally attached to a fresh copy each poll.
    Queue changes refresh immediately; out-of-band edits refresh on the first poll after max_age.
    Restarting the command (or max_age=0) explicitly forces source refresh.
    """
    def __init__(self, max_age: int):
        self.max_age = max_age
        self.key = None
        self.loaded_at = 0.0
        self.rows = None

    def load(self, connection, municipality, aliases, job_state):
        key = (municipality, tuple(aliases), job_state)
        now = time.monotonic()
        if self.rows is None or key != self.key or now - self.loaded_at >= self.max_age:
            rows = research_rows(connection, municipality, aliases)
            self.rows = rows
            self.key = key
            self.loaded_at = now
        rows = deepcopy(self.rows)
        refresh_local_sources(rows)
        return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True, help="Full public name to investigate")
    parser.add_argument("--alias", action="append", default=[], help="Additional name label; repeatable")
    parser.add_argument("--municipality", default="langford", help="Municipality slug")
    parser.add_argument("--output", type=Path, help="Markdown report path")
    parser.add_argument("--queue-missing", action="store_true", help="Queue missing audio transcriptions")
    parser.add_argument("--review-manifest", type=Path, help="JSON file with reviewed local speaker labels")
    parser.add_argument("--site-base-url", default="http://localhost:5173", help="Base URL for meeting links")
    parser.add_argument("--watch-queue", action="store_true", help="Refresh reports until this person's transcription queue finishes")
    parser.add_argument("--refresh-interval", type=int, default=120, help="Seconds between queue checks")
    parser.add_argument("--data-refresh-interval", type=int, default=1800,
                        help="Maximum seconds to reuse database text while watching (default 1800; 0 refreshes every poll). Queue changes refresh immediately; restart for immediate corrections.")
    args = parser.parse_args()
    if args.data_refresh_interval < 0:
        parser.error("--data-refresh-interval must be nonnegative")

    load_dotenv(PROJECT_ROOT / ".env")
    import os

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        parser.error("DATABASE_URL is required in the environment or project .env")
    aliases = name_aliases(args.name, args.alias)
    slug = re.sub(r"[^a-z0-9]+", "-", args.name.lower()).strip("-")
    output = args.output or PROJECT_ROOT / "research" / f"{slug}-speaking.md"
    first_pass = True
    snapshot = ResearchWatchSnapshot(args.data_refresh_interval)
    while True:
        with psycopg2.connect(database_url) as connection:
            state = research_job_state(connection, args.name)
            rows = snapshot.load(connection, args.municipality, aliases, state)
            queued_ids = (
                queue_missing_transcripts(connection, rows, args.name)
                if first_pass and args.queue_missing else []
            )
            # Queueing happens after the first source load. Re-read before deciding
            # to exit, so newly created work is never mistaken for an empty queue.
            if first_pass and args.queue_missing:
                state = research_job_state(connection, args.name)
            remaining_jobs = sum(status in ("queued", "running") for _, status in state)
        attach_reviewed_local_turns(rows, args.review_manifest)
        write_report(rows, args.name, aliases, output, args.site_base_url, remaining_jobs)
        turns_path = output.with_name(output.stem + "-turns.csv")
        turn_count = write_turns_csv(rows, args.name, args.site_base_url, turns_path)
        candidate_path = output.with_name(output.stem + "-candidates.csv")
        candidates = write_voice_candidates(rows, args.review_manifest, candidate_path)
        print(json.dumps({
            "meetings": len(rows),
            "timed_turns": sum(len(r["turns"]) for r in rows),
            "queued": len(queued_ids),
            "remaining_jobs": remaining_jobs,
            "voice_candidates": candidates,
            "exported_turns": turn_count,
            "report": str(output),
            "csv": str(output.with_suffix('.csv')),
            "turns_csv": str(turns_path),
        }), flush=True)
        if not args.watch_queue or not remaining_jobs:
            break
        first_pass = False
        time.sleep(max(30, args.refresh_interval))


if __name__ == "__main__":
    main()
