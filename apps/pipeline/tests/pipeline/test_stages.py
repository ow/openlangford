"""Stage registry: ordering, dependency validation, post-ingest isolation and --stale selection."""

from unittest.mock import MagicMock

import pytest

from pipeline import stages
from pipeline.stages import Stage, StageContext, StageError


def _names(items):
    return [s.name for s in items]


class TestRegistry:
    def test_every_required_stage_is_registered(self):
        expected = {
            "agenda-alignment", "escribe-attachments", "document-relink", "matter-summaries",
            "participation-summaries", "participation-names", "matter-images", "matter-links", "matter-resolver-audit",
            "embeddings", "profile-refresh",
        }
        assert expected <= set(stages.STAGES_BY_NAME)

    def test_dependencies_come_first(self):
        order = _names(stages.STAGES)
        for s in stages.STAGES:
            for dep in s.depends_on:
                assert order.index(dep) < order.index(s.name), f"{dep} must run before {s.name}"

    def test_post_ingest_order_matches_the_previous_hardcoded_sequence(self):
        assert _names(stages.post_ingest_stages(exclude=("embeddings", "profile-refresh"))) == [
            "escribe-attachments", "document-relink", "other-documents", "written-submissions", "matter-history", "matter-summaries", "agenda-alignment",
            "speaker-names", "participation-summaries", "participation-from-minutes", "participation-names", "participation-person-links", "motion-headlines", "matter-images", "matter-links", "properties", "property-summaries",
        ]
        assert _names(stages.post_ingest_stages())[0] == "embeddings"
        assert _names(stages.post_ingest_stages())[-1] == "profile-refresh"

    def test_backfill_only_stages_never_run_post_ingest(self):
        assert stages.get_stage("matter-resolver-audit").when == "backfill_only"
        assert "matter-resolver-audit" not in _names(stages.post_ingest_stages())

    def test_speaker_names_runs_post_ingest_and_fingerprint_rebuild_does_not(self):
        assert stages.get_stage("speaker-names").when == "post_ingest"
        assert stages.get_stage("voice-fingerprints").when == "backfill_only"
        assert "voice-fingerprints" not in _names(stages.post_ingest_stages())

    def test_relink_now_runs_post_ingest(self):
        assert stages.get_stage("document-relink").when == "post_ingest"

    def test_validate_rejects_late_dependency_and_duplicates(self):
        noop = lambda ctx: None
        a = Stage("a", "", noop, "post_ingest", "global", "1")
        b = Stage("b", "", noop, "post_ingest", "global", "1", depends_on=("a",))
        stages.validate_registry([a, b])
        with pytest.raises(StageError):
            stages.validate_registry([b, a])
        with pytest.raises(StageError):
            stages.validate_registry([a, a])

    def test_get_stage_accepts_underscores_and_rejects_unknown(self):
        assert stages.get_stage("matter_summaries").name == "matter-summaries"
        with pytest.raises(StageError):
            stages.get_stage("nope")

    def test_stale_supported_for_versioned_stages(self):
        for name in ("matter-summaries", "participation-summaries", "matter-images"):
            assert stages.get_stage(name).stale is not None


class TestRunPostIngest:
    def test_runs_in_order_and_isolates_failures(self, monkeypatch):
        calls = []

        def ok(name):
            return lambda ctx: calls.append(name) or name

        def boom(ctx):
            calls.append("boom")
            raise RuntimeError("model down")

        fake = [
            Stage("first", "", ok("first"), "post_ingest", "meeting", "1"),
            Stage("boom", "", boom, "post_ingest", "meeting", "1"),
            Stage("third", "", ok("third"), "post_ingest", "matter", "1"),
            Stage("later", "", ok("later"), "backfill_only", "global", "1"),
        ]
        monkeypatch.setattr(stages, "STAGES", fake)
        results = stages.run_post_ingest(StageContext(supabase=MagicMock(), meeting_ids=[1]))
        assert calls == ["first", "boom", "third"]
        assert results == {"first": "first", "boom": None, "third": "third"}

    def test_meeting_stages_skip_without_meetings_but_global_runs(self, monkeypatch):
        calls = []
        fake = [
            Stage("global", "", lambda c: calls.append("global"), "post_ingest", "global", "1"),
            Stage("meeting", "", lambda c: calls.append("meeting"), "post_ingest", "meeting", "1"),
        ]
        monkeypatch.setattr(stages, "STAGES", fake)
        stages.run_post_ingest(StageContext(supabase=MagicMock(), meeting_ids=[]))
        assert calls == ["global"]

    def test_stage_job_label_reaches_usage_records(self, monkeypatch):
        from pipeline.ai import usage

        seen = []
        fake = [Stage("labelled", "", lambda c: seen.append(usage.current_context()), "post_ingest", "meeting", "1")]
        monkeypatch.setattr(stages, "STAGES", fake)
        stages.run_post_ingest(StageContext(supabase=MagicMock(), meeting_ids=[42]))
        assert seen == [{"job": "labelled", "meeting_id": 42, "pipeline_job_id": None}]


class TestStale:
    @pytest.mark.parametrize(
        "stamp,current,expected",
        [
            (None, "1", True),
            ("", "1", True),
            ("1", "1", False),
            ("1", "2", True),
            ("2", "1", False),
            ("1.9", "1.10", True),
            ("2026-10-01", "2026-10-19", True),
        ],
    )
    def test_is_stale(self, stamp, current, expected):
        assert stages.is_stale(stamp, current) is expected

    def test_select_stale(self):
        rows = [
            {"id": 3, "summary_version": None},
            {"id": 1, "summary_version": "1"},
            {"id": 2, "summary_version": "2"},
            {"id": 4},
        ]
        assert stages.select_stale(rows, "summary_version", "2") == [1, 3, 4]

    def _ctx_returning(self, rows):
        sb = MagicMock()
        query = MagicMock()
        for method in ("select", "is_", "order", "gte", "or_", "in_", "range"):
            getattr(query, method).return_value = query
        query.execute.return_value = MagicMock(data=rows)
        sb.table.return_value = query
        return StageContext(supabase=sb), sb, query

    def test_matter_summaries_stale_uses_version_stamp(self, monkeypatch):
        monkeypatch.setattr(stages, "SUMMARY_VERSION", "2")
        ctx, sb, query = self._ctx_returning([
            {"id": 10, "stamp": "2"}, {"id": 11, "stamp": "1"}, {"id": 12, "stamp": None},
        ])
        ctx.stale = True
        assert stages.stale_matter_summaries(ctx) == [11, 12]
        sb.table.assert_called_with("matters")
        query.select.assert_called_with("id, stamp:meta->>summary_version")

    def test_participation_stale_skips_unaligned_and_non_participation(self):
        ctx, _, _ = self._ctx_returning([
            {"id": 1, "meeting_id": 5, "title": "Public Participation", "discussion_start_time": 10.0, "stamp": None},
            {"id": 2, "meeting_id": 5, "title": "Delegations", "discussion_start_time": None, "stamp": None},
            {"id": 3, "meeting_id": 5, "title": "Public Participation", "discussion_start_time": 5.0,
             "stamp": stages.PARTICIPATION_VERSION},
            {"id": 4, "meeting_id": 5, "title": "Delegated authority bylaw", "discussion_start_time": 1.0, "stamp": None},
        ])
        assert stages.stale_participation(ctx) == [1]

    def test_run_matter_summaries_stale_dry_run_makes_no_model_calls(self, monkeypatch):
        monkeypatch.setattr(stages, "stale_matter_summaries", lambda ctx: [7, 8])
        monkeypatch.setattr(
            stages, "STAGES_BY_NAME",
            {**stages.STAGES_BY_NAME,
             "matter-summaries": Stage("matter-summaries", "", stages.run_matter_summaries, "post_ingest", "matter", "1",
                                       stale=stages.stale_matter_summaries)},
        )
        refresh = MagicMock()
        import pipeline.ingestion.matter_summaries as ms

        monkeypatch.setattr(ms, "refresh_matter_summaries", refresh)
        ctx = StageContext(supabase=MagicMock(), stale=True, dry_run=True)
        stages.run_matter_summaries(ctx)
        refresh.assert_not_called()
        ctx.dry_run = False
        stages.run_matter_summaries(ctx)
        refresh.assert_called_once_with(ctx.supabase, [7, 8])

    def test_stale_on_unsupported_stage_errors(self):
        ctx = StageContext(supabase=MagicMock(), stale=True)
        with pytest.raises(StageError):
            stages._choose(ctx, "matter-links", from_meetings=list, backfill=list)


def test_newly_persisted_mentions_refresh_affected_context_after_linking(monkeypatch):
    from pipeline.ingestion import matter_links, matter_summaries
    events = []
    def link(*args, **kwargs):
        events.append("accepted-link")
        return {"related": [], "mentions": [{"matter_id": 1685, "agenda_item_id": 1368}]}
    monkeypatch.setattr(matter_links, "build_links", link)
    monkeypatch.setattr(matter_summaries, "refresh_matter_summaries", lambda client, ids, **kwargs: events.append(("refresh-context", ids, kwargs.get("context_only"))))
    ctx = StageContext(supabase=MagicMock(), meeting_ids=[394], cache={"matter_ids": [1685], "meetings": [{"meeting_date": "2026-07-20"}]})
    stages.run_matter_links(ctx)
    assert events == ["accepted-link", ("refresh-context", [1685], True)]


class TestMotionHeadlinesStale:
    def test_a_meeting_is_stale_when_any_decision_lacks_a_current_headline(self, monkeypatch):
        rows = [
            {"meeting_id": 1, "headline_version": "1"},
            {"meeting_id": 1, "headline_version": None},
            {"meeting_id": 2, "headline_version": "1"},
            {"meeting_id": 3, "headline_version": "0"},
            {"meeting_id": 3, "headline_version": "1"},
        ]
        monkeypatch.setattr(stages, "_paginate", lambda build: rows)
        monkeypatch.setattr(stages, "HEADLINE_VERSION", "1")
        assert stages.stale_motion_headlines(StageContext(supabase=MagicMock())) == [1, 3]
