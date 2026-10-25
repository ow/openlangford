"""Tests for pipeline.ingestion.ingester pure functions and utility methods.

Covers: to_seconds, extract_identifier_from_text, normalize_address_list,
        map_type_to_org, find_transcript, _classify_document, _normalize_archive_path
"""

import os
import pytest
from unittest.mock import patch, MagicMock

from pipeline.ingestion.ingester import to_seconds, MeetingIngester


# --- to_seconds ---


class TestToSeconds:
    def test_float_passthrough(self):
        assert to_seconds(123.45) == 123.45

    def test_int_passthrough(self):
        assert to_seconds(60) == 60.0

    def test_hhmmss(self):
        assert to_seconds("1:23:45") == 1 * 3600 + 23 * 60 + 45

    def test_mmss(self):
        assert to_seconds("5:30") == 5 * 60 + 30

    def test_none_returns_none(self):
        assert to_seconds(None) is None

    def test_invalid_string(self):
        assert to_seconds("not a time") is None

    def test_zero(self):
        assert to_seconds(0) == 0.0

    def test_hhmmss_with_decimals(self):
        result = to_seconds("0:01:30.5")
        assert result is not None
        assert abs(result - 90.5) < 0.01

    def test_string_without_colon(self):
        assert to_seconds("12345") is None

    def test_empty_string(self):
        assert to_seconds("") is None


# --- extract_identifier_from_text ---


class TestExtractIdentifier:
    @pytest.fixture(autouse=True)
    def setup_ingester(self):
        self.ingester = MeetingIngester("http://test.url", "test-key")

    def test_bylaw_number(self):
        result = self.ingester.extract_identifier_from_text(
            "Discussion of Bylaw No. 1160 regarding noise"
        )
        assert result == "Bylaw 1160"

    def test_amendment_bylaw(self):
        result = self.ingester.extract_identifier_from_text(
            "Amendment Bylaw No. 1101 for zoning changes"
        )
        assert result == "Bylaw 1101"

    def test_rezoning(self):
        result = self.ingester.extract_identifier_from_text(
            "Rezoning Application No. 2025-01"
        )
        assert result is not None
        assert "2025" in result

    def test_development_variance_permit(self):
        result = self.ingester.extract_identifier_from_text(
            "Development Variance Permit No. 2024-01"
        )
        assert result is not None
        assert "2024-01" in result

    def test_dvp_abbreviation(self):
        result = self.ingester.extract_identifier_from_text("DVP No. 2024-01")
        assert result is not None
        assert "2024-01" in result

    def test_development_permit(self):
        result = self.ingester.extract_identifier_from_text(
            "Development Permit No. 2024-02"
        )
        assert result is not None
        assert "2024-02" in result

    def test_no_identifier(self):
        result = self.ingester.extract_identifier_from_text(
            "General discussion about community events"
        )
        assert result is None

    def test_none_input(self):
        result = self.ingester.extract_identifier_from_text(None)
        assert result is None

    def test_empty_string(self):
        result = self.ingester.extract_identifier_from_text("")
        assert result is None

    def test_tup(self):
        result = self.ingester.extract_identifier_from_text(
            "Temporary Use Permit No. 2025-03"
        )
        assert result is not None
        assert "2025-03" in result


# --- normalize_address_list ---


class TestNormalizeAddressList:
    @pytest.fixture(autouse=True)
    def setup_ingester(self):
        self.ingester = MeetingIngester("http://test.url", "test-key")

    def test_none_returns_empty(self):
        assert self.ingester.normalize_address_list(None) == []

    def test_list_passthrough(self):
        result = self.ingester.normalize_address_list(["100 Main St", "200 Oak Ave"])
        assert result == ["100 Main St", "200 Oak Ave"]

    def test_list_strips_whitespace(self):
        result = self.ingester.normalize_address_list(["  100 Main St  ", "200 Oak Ave"])
        assert result == ["100 Main St", "200 Oak Ave"]

    def test_list_filters_empty_entries(self):
        result = self.ingester.normalize_address_list(["100 Main St", "", None])
        assert result == ["100 Main St"]

    def test_multi_number_pattern(self):
        result = self.ingester.normalize_address_list(
            "105, 106 and 107 Glentana Road"
        )
        assert len(result) == 3
        assert "105 Glentana Road" in result
        assert "106 Glentana Road" in result
        assert "107 Glentana Road" in result

    def test_four_numbers_and_pattern(self):
        result = self.ingester.normalize_address_list(
            "100, 101, 102 and 103 Test Street"
        )
        assert len(result) == 4
        assert "100 Test Street" in result
        assert "103 Test Street" in result

    def test_comma_separated_addresses(self):
        result = self.ingester.normalize_address_list("100 Main St, 200 Oak Ave")
        assert len(result) == 2
        assert "100 Main St" in result
        assert "200 Oak Ave" in result

    def test_and_separated_addresses(self):
        result = self.ingester.normalize_address_list("100 Main St and 200 Oak Ave")
        assert len(result) == 2

    def test_single_address_string(self):
        result = self.ingester.normalize_address_list("258 Helmcken Road")
        assert result == ["258 Helmcken Road"]

    def test_empty_string(self):
        assert self.ingester.normalize_address_list("") == []

    def test_non_string_non_list(self):
        assert self.ingester.normalize_address_list(42) == []


# --- map_type_to_org ---


class TestMapTypeToOrg:
    @pytest.fixture(autouse=True)
    def setup_ingester(self):
        self.ingester = MeetingIngester("http://test.url", "test-key")

    def test_regular_council(self):
        assert self.ingester.map_type_to_org("Regular Council") == ("Council", "Council")

    def test_special_council(self):
        assert self.ingester.map_type_to_org("Special Council") == ("Council", "Council")

    def test_committee_of_the_whole(self):
        assert self.ingester.map_type_to_org("Committee of the Whole") == ("Council", "Council")

    def test_public_hearing(self):
        assert self.ingester.map_type_to_org("Public Hearing") == ("Council", "Council")

    def test_board_of_variance(self):
        assert self.ingester.map_type_to_org("Board of Variance") == ("Board of Variance", "Board")

    def test_advisory_committee(self):
        assert self.ingester.map_type_to_org("Advisory Committee") == ("Advisory Committee", "Advisory Committee")

    def test_generic_fallback(self):
        name, cls = self.ingester.map_type_to_org("Standing Committee")
        assert name == "Standing Committee"
        assert cls == "Committee"


# --- find_transcript ---


class TestFindTranscript:
    @pytest.fixture(autouse=True)
    def setup_ingester(self):
        self.ingester = MeetingIngester("http://test.url", "test-key")

    def test_no_audio_folder(self, tmp_path):
        result = self.ingester.find_transcript(str(tmp_path))
        assert result is None

    def test_finds_transcript(self, tmp_path):
        audio_dir = tmp_path / "Audio"
        audio_dir.mkdir()
        transcript = audio_dir / "2025-01-01_meeting.json"
        transcript.write_text("{}")
        result = self.ingester.find_transcript(str(tmp_path))
        assert result == str(transcript)

    def test_skips_raw_transcript(self, tmp_path):
        audio_dir = tmp_path / "Audio"
        audio_dir.mkdir()
        (audio_dir / "some_raw_transcript.json").write_text("{}")
        result = self.ingester.find_transcript(str(tmp_path))
        assert result is None

    def test_skips_segments_and_shared_media(self, tmp_path):
        audio_dir = tmp_path / "Audio"
        audio_dir.mkdir()
        (audio_dir / "meeting_segments.json").write_text("{}")
        (audio_dir / "shared_media.json").write_text("{}")
        (audio_dir / "refinement.json").write_text("{}")
        (audio_dir / "attendance.json").write_text("{}")
        result = self.ingester.find_transcript(str(tmp_path))
        assert result is None


# --- _classify_document ---


class TestClassifyDocument:
    @pytest.fixture(autouse=True)
    def setup_ingester(self):
        self.ingester = MeetingIngester("http://test.url", "test-key")

    def test_agenda(self):
        assert self.ingester._classify_document("Council Agenda.pdf") == "Agenda"

    def test_minutes(self):
        assert self.ingester._classify_document("Council Minutes.pdf") == "Minutes"

    def test_addendum(self):
        assert self.ingester._classify_document("Addendum Package.pdf") == "Addendum"

    def test_late_items(self):
        assert self.ingester._classify_document("Late Items.pdf") == "Late Items"

    def test_supplementary(self):
        assert self.ingester._classify_document("Supplementary Package.pdf") == "Supplementary"

    def test_report(self):
        assert self.ingester._classify_document("Staff Report.pdf") == "Report"

    def test_other(self):
        assert self.ingester._classify_document("random_file.pdf") == "Other"


# --- _normalize_archive_path ---


class TestNormalizeArchivePath:
    @pytest.fixture(autouse=True)
    def setup_ingester(self):
        self.ingester = MeetingIngester("http://test.url", "test-key")

    def test_legacy_viewroyal_archive(self):
        result = self.ingester._normalize_archive_path(
            "/home/user/project/viewroyal_archive/Council/2025/01"
        )
        assert result.startswith("viewroyal_archive/")

    def test_new_archive_format(self):
        result = self.ingester._normalize_archive_path(
            "/home/user/project/archive/view-royal/Council/2025"
        )
        assert result.startswith("archive/")

    def test_relative_path_fallback(self):
        result = self.ingester._normalize_archive_path("some/random/path")
        # Should return as-is or normalized form
        assert result is not None


# --- Self-healing check ---


class TestSelfHealingCheck:
    """Tests for the self-healing 'already ingested' check in process_meeting."""

    @pytest.fixture(autouse=True)
    def setup_ingester(self):
        self.ingester = MeetingIngester("http://test.url", "test-key")

    def test_skip_when_no_agenda(self):
        """Meeting with has_agenda=false should be skipped normally."""
        mock_table = MagicMock()
        self.ingester.supabase.table = MagicMock(return_value=mock_table)
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.execute.return_value = MagicMock(data=[{"id": 1, "has_agenda": False}])

        result = self.ingester.process_meeting("/fake/path")
        assert result is None  # Should skip

    def test_skip_when_has_agenda_and_items_exist(self):
        """Meeting with has_agenda=true AND agenda items should be skipped."""
        mock_table = MagicMock()
        self.ingester.supabase.table = MagicMock(return_value=mock_table)
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table

        # First call: meetings table returns has_agenda=true
        # Second call: agenda_items table returns count > 0
        mock_table.execute.side_effect = [
            MagicMock(data=[{"id": 1, "has_agenda": True}]),
            MagicMock(count=5, data=[]),
        ]

        # Skipping still reconciles transcript identities from source evidence.
        with patch.object(self.ingester, "reconcile_transcript_identities") as reconcile:
            result = self.ingester.process_meeting("/fake/path")
        assert result is None  # Should skip (items exist)
        reconcile.assert_called_once_with("/fake/path", 1)

    def test_reprocess_when_has_agenda_but_no_items(self, tmp_path):
        """Meeting with has_agenda=true but 0 items should be re-processed."""
        # Create minimal meeting folder structure so process_meeting can proceed
        agenda_dir = tmp_path / "Agenda"
        agenda_dir.mkdir()

        mock_table = MagicMock()
        self.ingester.supabase.table = MagicMock(return_value=mock_table)
        mock_table.select.return_value = mock_table
        mock_table.eq.return_value = mock_table
        mock_table.is_.return_value = mock_table

        # First call: meetings table returns has_agenda=true
        # Second call: agenda_items count returns 0
        mock_table.execute.side_effect = [
            MagicMock(data=[{"id": 1, "has_agenda": True}]),
            MagicMock(count=0, data=[]),
        ]

        # We expect it NOT to return None at the "already ingested" check.
        # It will proceed further and likely fail on metadata parsing,
        # which is fine -- the point is it didn't short-circuit with "Skipping".
        with patch("pipeline.ingestion.ingester.parser") as mock_parser:
            mock_parser.extract_meeting_metadata.return_value = None
            result = self.ingester.process_meeting(str(tmp_path))

        # Result is None because metadata parsing failed, but we verify it
        # got PAST the "already ingested" check by confirming parser was called
        mock_parser.extract_meeting_metadata.assert_called_once()


@pytest.mark.parametrize(('earlier', 'later', 'day'), [
    ('Draft Housing Strategy (Approx. 45 min)', 'Adoption of the Housing Strategy', '2026-09-21'),
    ('Draft Climate Action Plan (Approx. 45 min)', 'Climate Action Plan Adoption', '2026-09-28'),
    ('Economic Development Strategy (Approx. 1hr)', 'Economic Development Strategy', '2026-06-01'),
])
def test_policy_stages_reuse_the_existing_proceeding_without_a_model(earlier, later, day):
    ingester = MeetingIngester('http://test.url', 'test-key')
    ingester.matcher._loaded = True
    ingester.matcher.matters = [{'id': 26, 'title': earlier, 'identifier': None,
                                'first_seen': '2026-04-07', 'last_seen': '2026-08-17'}]
    assert ingester.get_or_create_matter(None, later, date=day, dry_run=True) == 26


@pytest.mark.parametrize(('ids', 'year'), [((26, 27), '2026'), ((26,), '2025')])
def test_ambiguous_policy_stages_stay_unassigned_instead_of_using_first_fuzzy_match(ids, year):
    ingester = MeetingIngester('http://test.url', 'test-key')
    ingester.matcher._loaded = True
    ingester.matcher.matters = [
        {'id': mid, 'title': 'Housing Strategy', 'identifier': None,
         'first_seen': f'{year}-04-07', 'last_seen': f'{year}-08-17'} for mid in ids
    ]
    assert ingester.get_or_create_matter(None, 'Adoption of the Housing Strategy',
                                       date='2026-09-21', dry_run=True) is None


@pytest.mark.parametrize(('existing', 'incoming', 'day'), [
    ('Climate Action Plan RFP Scope of Work', 'Draft Climate Action Plan (Approx. 45 min)', '2026-08-17'),
    ('Climate Action Plan', 'Climate Action Plan RFP', '2026-08-17'),
    ('Housing Strategy', 'Adoption of the Housing Strategy', '2027-09-21'),
    ('Housing Strategy 2025 Plan', 'Housing Strategy 2026 Plan', '2026-09-21'),
])
def test_policy_stage_matching_keeps_procurement_and_other_editions_separate(existing, incoming, day):
    ingester = MeetingIngester('http://test.url', 'test-key')
    ingester.matcher._loaded = True
    ingester.matcher.matters = [{'id': 26, 'title': existing, 'identifier': None,
                                'first_seen': '2026-04-07', 'last_seen': '2026-08-17'}]
    assert ingester.get_or_create_matter(None, incoming, date=day, dry_run=True) != 26


def test_normal_ingestion_does_not_let_an_entity_cluster_attach_procurement_to_a_plan():
    ingester = MeetingIngester('http://test.url', 'test-key')
    earlier = {'id': 26, 'title': 'Starlight Stadium Operating Plan', 'identifier': None,
               'first_seen': '2026-04-07', 'last_seen': '2026-08-17'}
    incoming = 'Starlight Stadium Operating Plan RFP'
    ingester.matcher._loaded = True
    ingester.matcher.matters = [earlier]
    ingester.matcher._build_entity_cluster_index()
    ingester.supabase = MagicMock()
    ingester.supabase.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [earlier]
    ingester.supabase.table.return_value.insert.return_value.execute.return_value.data = [
        {**earlier, 'id': 900, 'title': incoming}]
    # Real resolver candidate admission runs; no network/model is needed when
    # its only candidate is a different proceeding scope.
    with patch('pipeline.ingestion.matter_resolver.ai.decide', side_effect=AssertionError('Unexpected model call')):
        assert ingester.get_or_create_matter(None, incoming, date='2026-09-21') == 900
    assert ingester.supabase.table.return_value.insert.call_args.args[0]['title'] == incoming
