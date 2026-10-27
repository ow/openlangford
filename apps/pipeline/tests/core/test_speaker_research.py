import json

from pipeline.speaker_research import (
    attach_reviewed_local_turns,
    build_turn_rows,
    minute_excerpt,
    name_aliases,
    name_pattern,
)
from pipeline.speaker_review_pack import review_segment
from pipeline.speaker_attribution_audit import probable_self_id


def test_name_aliases_include_initial_without_matching_another_first_name():
    aliases = name_aliases("Jane Doe", [])
    pattern = name_pattern(aliases)

    assert aliases == ["Jane Doe", "J. Doe"]
    assert pattern.search("J. Doe, Langford Resident - spoke to item 5.1")
    assert not pattern.search("C. Roe, Langford Resident - spoke to item 5.1")


def test_minute_excerpt_stops_before_next_speaker_and_address():
    pattern = name_pattern(name_aliases("Jane Doe", []))
    text = (
        "J. Doe, Players Dr - Expressed concern about taxes and the budget. "
        "B.Armstrong, 2813 Rodney Rd - Supported the motion."
    )

    assert minute_excerpt(text, pattern) == "Expressed concern about taxes and the budget."


def test_turn_export_keeps_provisional_sources_distinct_without_double_counting():
    shared = {
        "date": "2026-01-01",
        "meeting_type": "Council",
        "minutes_url": "https://example.org/minutes",
        "video_url": "https://example.org/video",
        "audio_path": "/archive/audio.m4a",
        "review_topics": ["budget"],
        "review_evidence": "Self-identification in transcript",
    }
    rows = [
        {
            **shared,
            "meeting_id": 1,
            "turns": [{"id": 42, "speaker": "J. Doe", "start": 10, "end": 20, "text": "Budget remarks"}],
            "local_reviewed_turns": [{"speaker": "Speaker_2", "start": 10, "end": 20, "speech_seconds": 10, "text": "Duplicate"}],
        },
        {
            **shared,
            "meeting_id": 2,
            "turns": [],
            "local_reviewed_turns": [{"speaker": "Speaker_3", "start": 30, "end": 42, "speech_seconds": 9, "text": "Another topic"}],
        },
    ]

    turns = build_turn_rows(rows, "Jane Doe", "https://example.org",)

    assert len(turns) == 2
    assert turns[0]["transcript_url"] == "https://example.org/meetings/1#transcript=42"
    assert turns[0]["source_kind"] == "archive_transcript_name_match"
    assert turns[1]["source_kind"] == "provisional_local_speaker_manifest"
    assert turns[1]["speech_seconds"] == 9
    assert all(turn["review_status"] == "needs_audio_review" for turn in turns)


def test_review_clip_respects_selected_voice_and_review_window():
    segments = [
        {"speaker": "Speaker_1", "start": 1, "end": 5},
        {"speaker": "Speaker_2", "start": 8, "end": 11},
        {"speaker": "Speaker_1", "start": 20, "end": 24},
    ]
    assert review_segment(segments, {"Speaker_1"}, [[19, 25]]) == segments[2]


def test_probable_self_id_is_only_a_name_screen():
    assert probable_self_id("Hi, Jayne Doeball from Langford", "Jane Doe")
    assert probable_self_id("Jane Doe, speaking to item 6", "Jane Doe")
    assert not probable_self_id("Lisa spoke after Mr. Doe", "Jane Doe")


def test_service_check_replaces_a_mixed_local_diarization_segment(tmp_path):
    (tmp_path / "audio.json").write_text(json.dumps({"segments": [
        {"speaker": "Speaker_1", "start": 10, "end": 20, "text": "Earlier turn"},
    ]}))
    service = tmp_path / "service.json"
    service.write_text(json.dumps({
        "clip_start_seconds": 100,
        "response": {"segments": [
            {"speaker": "other", "start": 0, "end": 5, "text": "Previous speaker"},
            {"speaker": "Jane Doe", "start": 6, "end": 12, "text": "Jane Doe"},
            {"speaker": "Jane Doe", "start": 11, "end": 15, "text": "My remarks"},
        ]},
    }))
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"meetings": {"1": {
        "speaker_labels": ["Speaker_1"],
        "service_check": {
            "path": str(service), "speaker_name": "Jane Doe",
            "include_local_windows": [[10, 20]],
        },
    }}}))
    rows = [{
        "meeting_id": 1, "audio_path": str(tmp_path / "audio.m4a"), "turns": [],
    }]

    attach_reviewed_local_turns(rows, manifest)

    assert rows[0]["review_source_kind"] == "provisional_service_diarization"
    assert [turn["source_kind"] for turn in rows[0]["local_reviewed_turns"]] == [
        "provisional_local_speaker_manifest", "provisional_service_diarization"
    ]
    assert rows[0]["local_reviewed_turns"][1]["start"] == 106
    assert rows[0]["local_reviewed_turns"][1]["end"] == 115
    assert rows[0]["local_reviewed_turns"][1]["speech_seconds"] == 9


def test_watch_reuses_text_but_refreshes_job_changes_corrections_and_local_reviews(monkeypatch, tmp_path):
    """Exercise the CLI loop: unchanged polls must not re-download source text."""
    import sys
    from pipeline import speaker_research as research

    states = iter([[(1, "running")], [(1, "running")], [(2, "running")], [(2, "running")], [(2, "succeeded")]])
    clock = iter([0, 120, 240, 2100, 2220])
    reads = []
    reports = []
    local_reads = []

    class Cursor:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def execute(self, query, params): pass
        def fetchall(self): return next(states)
        def fetchone(self): return (sum(status in ("queued", "running") for _, status in next(states)),)

    class Connection:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def cursor(self): return Cursor()

    def source(*args):
        reads.append(True)
        return [{"archive_path": str(tmp_path), "turns": [], "minute_excerpts": [f"revision-{len(reads)}"]}]

    def local(rows, manifest):
        # If previous poll annotations leaked into the snapshot this would fail.
        assert "local_reviewed_turns" not in rows[0]
        local_reads.append(True)
        rows[0]["local_reviewed_turns"] = [len(local_reads)]

    monkeypatch.setattr(sys, "argv", ["research", "--name", "Jane Doe", "--watch-queue", "--output", str(tmp_path / "report.md")])
    monkeypatch.setenv("DATABASE_URL", "fixture-only")
    monkeypatch.setattr(research, "load_dotenv", lambda *a: None)
    monkeypatch.setattr(research.psycopg2, "connect", lambda *a: Connection())
    monkeypatch.setattr(research.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(research.time, "sleep", lambda *a: None)
    monkeypatch.setattr(research, "research_rows", source)
    monkeypatch.setattr(research, "attach_reviewed_local_turns", local)
    monkeypatch.setattr(research, "write_report", lambda rows, *a: reports.append(rows[0]["minute_excerpts"][0]))
    monkeypatch.setattr(research, "write_turns_csv", lambda *a: 0)
    monkeypatch.setattr(research, "write_voice_candidates", lambda *a: 0)
    research.main()
    assert reports == ["revision-1", "revision-1", "revision-2", "revision-3", "revision-4"]
    assert len(reads) == 4
    assert len(local_reads) == 5


def test_watch_failed_refresh_is_retried_and_zero_interval_forces_refresh(monkeypatch):
    import pytest
    from pipeline import speaker_research as research
    calls = []
    def source(*args):
        calls.append(True)
        if len(calls) == 2:
            raise RuntimeError("temporary source failure")
        return []
    monkeypatch.setattr(research, "research_rows", source)
    snapshot = research.ResearchWatchSnapshot(0)
    assert snapshot.load(None, "langford", ["Jane Doe"], ()) == []
    with pytest.raises(RuntimeError, match="temporary source failure"):
        snapshot.load(None, "langford", ["Jane Doe"], ())
    assert snapshot.load(None, "langford", ["Jane Doe"], ()) == []


def test_queue_missing_is_checked_after_enqueue_before_watch_exit(monkeypatch, tmp_path):
    import sys
    from pipeline import speaker_research as research
    states = iter([[], [(7, "queued")], [(7, "succeeded")]])
    events = []
    class Cursor:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def execute(self, *a): pass
        def fetchall(self):
            events.append("state")
            return next(states)
    class Connection:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def cursor(self): return Cursor()
    monkeypatch.setattr(sys, "argv", ["research", "--name", "Jane Doe", "--watch-queue", "--queue-missing", "--output", str(tmp_path / "report.md")])
    monkeypatch.setenv("DATABASE_URL", "fixture-only")
    monkeypatch.setattr(research, "load_dotenv", lambda *a: None)
    monkeypatch.setattr(research.psycopg2, "connect", lambda *a: Connection())
    monkeypatch.setattr(research, "research_rows", lambda *a: [])
    monkeypatch.setattr(research, "queue_missing_transcripts", lambda *a: events.append("enqueue") or [7])
    monkeypatch.setattr(research.time, "sleep", lambda *a: events.append("sleep"))
    monkeypatch.setattr(research, "attach_reviewed_local_turns", lambda *a: None)
    monkeypatch.setattr(research, "write_report", lambda *a: None)
    monkeypatch.setattr(research, "write_turns_csv", lambda *a: 0)
    monkeypatch.setattr(research, "write_voice_candidates", lambda *a: 0)
    research.main()
    assert events == ["state", "enqueue", "state", "sleep", "state"]


def test_watch_discovers_local_audio_and_transcript_without_database_reload(monkeypatch, tmp_path):
    from pipeline import speaker_research as research
    reads = []
    def source(*a):
        reads.append(True)
        return [{"archive_path": str(tmp_path), "turns": []}]
    monkeypatch.setattr(research, "research_rows", source)
    snapshot = research.ResearchWatchSnapshot(1800)
    assert snapshot.load(None, "langford", ["Jane Doe"], ())[0]["audio_path"] is None
    audio = tmp_path / "Audio" / "meeting.m4a"
    audio.parent.mkdir()
    audio.touch()
    audio.with_suffix(".json").write_text("{}")
    row = snapshot.load(None, "langford", ["Jane Doe"], ())[0]
    assert row["audio_path"] == str(audio)
    assert row["local_transcript"] is True
    audio.with_suffix(".json").unlink()
    assert snapshot.load(None, "langford", ["Jane Doe"], ())[0]["local_transcript"] is False
    audio.unlink()
    assert snapshot.load(None, "langford", ["Jane Doe"], ())[0]["audio_path"] is None
    assert len(reads) == 1
