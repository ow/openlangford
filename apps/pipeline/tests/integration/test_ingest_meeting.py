"""Integration tests for MeetingIngester.process_meeting().

Exercises the full meeting ingestion flow end-to-end with all external
services mocked: Supabase, AI client, VimeoClient, file I/O via tmp dirs.

Covers: happy path with precomputed refinement, no-documents path,
AI failure fallback, missing-transcript processing, dry run,
and already-ingested skip.
"""

import json
import os

import pytest
from unittest.mock import patch, MagicMock, call

from pipeline.ingestion.ingester import MeetingIngester


CHAINABLE_METHODS = [
    "select", "eq", "neq", "in_", "not_", "lte", "gte", "lt", "gt",
    "or_", "single", "insert", "upsert", "update", "delete",
    "range", "order", "limit", "is_", "ilike", "like", "filter",
    "contains", "contained_by", "overlap", "text_search",
]


def _make_table_mock(default_data=None, default_count=0):
    """Create a chainable Supabase table mock."""
    t = MagicMock()
    for method in CHAINABLE_METHODS:
        getattr(t, method).return_value = t
    data = default_data if default_data is not None else []
    t.execute.return_value = MagicMock(data=data, count=default_count)
    return t


@pytest.fixture
def per_table_supabase():
    """Supabase mock with per-table tracking of inserts/upserts.

    Pre-creates all tables that process_meeting touches so that
    _setup_supabase_responses can configure them before the test runs.

    Returns (client, tables) where tables is a dict mapping table name
    to a chainable MagicMock.
    """
    client = MagicMock()

    # Pre-create ALL tables that process_meeting interacts with
    table_names = [
        "meetings", "organizations", "people", "attendance",
        "meeting_speaker_aliases", "agenda_items", "motions", "votes",
        "key_statements", "transcript_segments", "documents",
        "extracted_documents", "memberships", "matters",
    ]
    tables = {name: _make_table_mock() for name in table_names}

    def table_router(name):
        if name not in tables:
            tables[name] = _make_table_mock()
        return tables[name]

    client.table.side_effect = table_router
    return client, tables


@pytest.fixture
def ingester(per_table_supabase):
    """Create MeetingIngester with mocked Supabase and no AI client."""
    client, tables = per_table_supabase

    with patch("pipeline.ingestion.ingester.create_client", return_value=client):
        ing = MeetingIngester("http://test.url", "test-key")

    # Also mock the MatterMatcher to avoid real DB calls
    ing.matcher = MagicMock()
    ing.matcher.find_match.return_value = (None, "no_match", 0.0)

    return ing, tables


@pytest.fixture
def populated_archive(tmp_archive_dir, meeting_693_refinement):
    """Create a fully populated archive directory for meeting 693.

    Creates:
    - Folder named with date pattern for extract_meeting_metadata
    - agenda.md and minutes.md cached files
    - Audio/ directory with a transcript JSON
    - refinement.json with precomputed data
    """
    # Rename the tmp dir to match the expected date pattern
    meeting_dir = tmp_archive_dir.parent / "2025-11-18 Regular Council Meeting"
    tmp_archive_dir.rename(meeting_dir)

    # Create agenda.md
    agenda_text = """# Regular Council Meeting Agenda
## November 18, 2025

1. Call to Order
2. Approval of the Agenda
5.1 Public Participation - Traffic Concerns on Helmcken Road
8.1 Tree Protection Bylaw No. 1160 - Second and Third Readings
9.1 Annual Financial Report 2024-2025
""" + ("Padding content to exceed 100 chars. " * 5)
    (meeting_dir / "agenda.md").write_text(agenda_text)

    # Create minutes.md
    minutes_text = """# Regular Council Meeting Minutes
## November 18, 2025

Mayor Screech called the meeting to order at 7:00 PM.
All council members were present.

### 1. Call to Order
The meeting was called to order at 7:00 PM.

### 2. Approval of the Agenda
MOVED by Councillor Mattson, SECONDED by Councillor Kowalewich
THAT the agenda be approved as presented. CARRIED.

### 5.1 Public Participation - Helmcken Road
Three residents presented concerns about speeding on Helmcken Road.
""" + ("Additional minutes content for length. " * 10)
    (meeting_dir / "minutes.md").write_text(minutes_text)

    # Create Audio/ directory with transcript
    audio_dir = meeting_dir / "Audio"
    audio_dir.mkdir()
    transcript_segments = [
        {"speaker": "SPEAKER_1", "text": "Good evening, I call this meeting to order.", "start_time": 0.0, "end_time": 5.0},
        {"speaker": "Speaker_1", "text": "Can I have a motion to approve the agenda?", "start_time": 15.0, "end_time": 18.0},
        {"speaker": "Speaker_02", "text": "So moved.", "start_time": 18.5, "end_time": 19.5},
        {"speaker": "Speaker_03", "text": "Seconded.", "start_time": 19.5, "end_time": 20.5},
        {"speaker": "Speaker_01", "text": "All in favor? Carried.", "start_time": 21.0, "end_time": 23.0},
    ]
    (audio_dir / "2025-11-18_meeting.json").write_text(json.dumps(transcript_segments))

    # Save refinement.json
    (meeting_dir / "refinement.json").write_text(json.dumps(meeting_693_refinement))

    # Create Agenda/ subfolder (for _ingest_documents)
    agenda_folder = meeting_dir / "Agenda"
    agenda_folder.mkdir()

    return meeting_dir


def _setup_supabase_responses(tables):
    """Configure per-table Supabase mock responses for a standard happy-path run.

    Tables are already pre-created by the per_table_supabase fixture,
    so we just update their execute return values.
    """
    # organizations: return existing org (prevents insert path)
    tables["organizations"].execute.return_value = MagicMock(
        data=[{"id": 1}], count=1
    )

    # meetings: upsert/update returns meeting with id=693
    tables["meetings"].execute.return_value = MagicMock(
        data=[{"id": 693, "video_url": None, "meta": {}}], count=1
    )

    # people: always return an existing person
    tables["people"].execute.return_value = MagicMock(
        data=[{"id": 10}], count=1
    )

    # agenda_items: insert returns new item with id
    tables["agenda_items"].execute.return_value = MagicMock(
        data=[{"id": 5001}], count=1
    )

    # motions: insert returns new motion with id
    tables["motions"].execute.return_value = MagicMock(
        data=[{"id": 3001}], count=1
    )

    # documents: empty (no existing docs)
    tables["documents"].execute.return_value = MagicMock(data=[], count=0)

    # matters: return a new matter record when insert is called
    tables["matters"].execute.return_value = MagicMock(
        data=[{"id": 9001, "title": "test matter", "identifier": None}], count=1
    )

    # attendance, meeting_speaker_aliases, votes, key_statements: default empty OK
    # memberships: default empty OK


class TestIngestMeeting:
    """Integration tests for process_meeting() with all externals mocked."""

    def test_explicit_replacement_refuses_source_validated_segment_ids_before_other_writes(
        self, ingester, populated_archive, meeting_693_refinement
    ):
        ing, tables = ingester
        _setup_supabase_responses(tables)
        tables["transcript_identity_evidence"] = _make_table_mock([{"segment_id": 9123}])
        with patch("pipeline.ingestion.ingester.VimeoClient"), \
             patch.object(ing, "_ingest_documents", return_value=0), \
             patch.object(ing, "_ingest_document_sections"), \
             patch.object(ing, "_geocode_agenda_items", return_value=0):
            with pytest.raises(RuntimeError, match="source-validated transcript IDs"):
                ing.process_meeting(str(populated_archive), precomputed_refinement=meeting_693_refinement,
                                    replace_transcript=True)
        assert not tables["transcript_segments"].delete.called
        assert not tables["transcript_segments"].insert.called
        assert not tables["meetings"].upsert.called
        assert not tables["meetings"].update.called
        assert not tables["attendance"].upsert.called

    def test_key_statement_cannot_promote_an_ai_name_or_a_recorded_vote(
        self, ingester, populated_archive, meeting_693_refinement
    ):
        from copy import deepcopy
        ing, tables = ingester
        _setup_supabase_responses(tables)
        refined = deepcopy(meeting_693_refinement)
        refined['items'][2]['key_statements'] = [{
            'speaker': 'Mayor Named Person', 'statement_type': 'objection',
            'statement_text': 'I oppose adopting this amendment.',
            'context': 'Mayor recorded as opposed in the minutes.',
            'evidence_kind': 'recorded_vote',
        }]
        with patch("pipeline.ingestion.ingester.VimeoClient"), \
             patch.object(ing, "_ingest_documents", return_value=0), \
             patch.object(ing, "_ingest_document_sections"), \
             patch.object(ing, "_geocode_agenda_items", return_value=0):
            ing.process_meeting(str(populated_archive), precomputed_refinement=refined)
        assert not tables['key_statements'].insert.called

    def test_named_statement_is_not_inserted_when_atomic_source_rpc_holds(
        self, ingester, populated_archive, meeting_693_refinement
    ):
        from copy import deepcopy
        import hashlib
        ing, tables = ingester
        _setup_supabase_responses(tables)
        transcript = next((populated_archive / 'Audio').glob('*.json'))
        raw = json.loads(transcript.read_text())
        raw[0]['text'] = 'The park needs more trees.'
        transcript.write_text(json.dumps(raw))
        source_hash = hashlib.sha256(transcript.read_bytes()).hexdigest()
        row = {'id': 901, 'meeting_id': 693, 'person_id': 10, 'speaker_name': 'Named Person',
               'start_time': 0., 'end_time': 5., 'text_content': raw[0]['text']}
        tables['transcript_segments'].execute.return_value = MagicMock(data=[row])
        tables['people'].execute.return_value = MagicMock(data=[{'id': 10, 'name': 'Named Person'}])
        receipt = {'id': 'receipt-1', 'status': 'applied', 'reverted_at': None,
                   'segment_id': 901, 'meeting_id': 693, 'person_id': 10,
                   'source_run': {'meeting_id': 693, 'transcript_sha256': source_hash},
                   'after_row': deepcopy(row), 'validator_sha256': 'a'*64, 'input_sha256': 'b'*64}
        tables['transcript_identity_evidence'] = _make_table_mock([receipt])
        ing.supabase.rpc.return_value.execute.side_effect = RuntimeError('atomic statement source row compare-and-swap failed')
        refined = deepcopy(meeting_693_refinement)
        refined['items'][2]['key_statements'] = [{
            'speaker': 'An Unsupported AI Name', 'statement_type': 'proposal',
            'statement_text': raw[0]['text'], 'source_quote': raw[0]['text'],
            'evidence_kind': 'transcript', 'source_segment_indexes': [0],
            'transcript_source_sha256': source_hash,
        }]
        with patch("pipeline.ingestion.ingester.VimeoClient"), \
             patch.object(ing, "_ingest_documents", return_value=0), \
             patch.object(ing, "_ingest_document_sections"), \
             patch.object(ing, "_geocode_agenda_items", return_value=0):
            with pytest.raises(RuntimeError, match='atomic statement source row compare-and-swap failed'):
                ing.process_meeting(str(populated_archive), precomputed_refinement=refined)
        assert not tables['key_statements'].insert.called

    def test_aliases_and_acoustic_purity_cannot_supply_a_named_identity(
        self, ingester, populated_archive, meeting_693_refinement
    ):
        ing, tables = ingester
        _setup_supabase_responses(tables)
        tables["meeting_speaker_aliases"].execute.return_value = MagicMock(data=[
            {"speaker_label": "Speaker_01", "person_id": 10, "people": {"name": "First Candidate"}},
            {"speaker_label": "Speaker_1", "person_id": 11, "people": {"name": "Second Candidate"}},
        ])
        transcript = next((populated_archive / "Audio").glob("*.json"))
        segments = json.loads(transcript.read_text())
        # The apparent winning voice covers the whole interval, but another
        # speaker overlaps half of it. The AI's name alias cannot settle this.
        segments[0].update(speaker_confidence=1., competing_speaker_fraction=.5)
        segments[1].update(speaker_confidence=1., competing_speaker_fraction=0.)
        transcript.write_text(json.dumps(segments))
        with patch("pipeline.ingestion.ingester.VimeoClient"), \
             patch.object(ing, "_ingest_documents", return_value=0), \
             patch.object(ing, "_ingest_document_sections"), \
             patch.object(ing, "_geocode_agenda_items", return_value=0):
            result = ing.process_meeting(str(populated_archive), precomputed_refinement=meeting_693_refinement)
        inserted = tables["transcript_segments"].insert.call_args_list[0].args[0]
        assert inserted[0]["person_id"] is None
        # A pure turn still has no independently certified NAME identity.
        assert inserted[1]["person_id"] is None
        assert result["speaker_alias_candidates"]["conflicting_labels"] == ["SPEAKER_01"]
        assert not tables["meeting_speaker_aliases"].upsert.called

    @pytest.mark.parametrize("existing_segments,force_update,replace_transcript", [
        pytest.param(False,False,False,id="populate-missing-transcript"),
        pytest.param(True,False,False,id="preserve-existing-transcript"),
        pytest.param(True,True,False,id="document-refresh-preserves-speakers"),
        pytest.param(True,False,True,id="explicit-transcript-replacement"),
    ])
    def test_process_meeting_happy_path(
        self, ingester, populated_archive, meeting_693_refinement, existing_segments, force_update, replace_transcript
    ):
        """Full meeting ingestion with precomputed refinement data.

        Verifies that process_meeting():
        1. Upserts the meeting record
        2. Processes agenda items from refinement
        3. Creates attendance records
        4. Retains speaker aliases as proposals without identity writes
        5. Returns a result dict with meeting, attendance, and items
        """
        ing, tables = ingester
        _setup_supabase_responses(tables)
        tables["transcript_segments"].execute.return_value = MagicMock(
            data=[{"id": 789}] if existing_segments else []
        )
        if replace_transcript:
            # The real verified-row query is empty; the explicit replacement
            # then performs its insert without an existing-transcript lookup.
            tables["transcript_segments"].execute.side_effect = [MagicMock(data=[]), MagicMock(data=[]), MagicMock(data=[])]

        with patch("pipeline.ingestion.ingester.VimeoClient") as mock_vimeo_cls:
            mock_vimeo = MagicMock()
            mock_vimeo.search_video.return_value = {
                "url": "https://vimeo.com/test/123"
            }
            mock_vimeo_cls.return_value = mock_vimeo

            with patch.object(ing, "_ingest_documents", return_value=0):
                with patch.object(ing, "_ingest_document_sections"):
                    with patch.object(ing, "_geocode_agenda_items", return_value=0):
                        update_args = {"force_update": force_update}
                        if replace_transcript:
                            update_args["replace_transcript"] = True
                        result = ing.process_meeting(
                            str(populated_archive),
                            precomputed_refinement=meeting_693_refinement,
                            **update_args,
                        )

        # Verify result structure
        assert result is not None
        assert "meeting" in result
        assert "attendance" in result
        assert "items" in result

        # Verify the meeting was upserted
        assert tables["meetings"].upsert.called or tables["meetings"].update.called

        # Verify attendance records were created (6 attendees in refinement)
        assert tables["attendance"].upsert.called

        # Unvalidated model aliases must never become identity assignments.
        assert not tables["meeting_speaker_aliases"].upsert.called

        # Verify agenda items were inserted
        assert tables["agenda_items"].insert.called

        # Verify motions were inserted (refinement has 2 motions across items)
        assert tables["motions"].insert.called

        # A normal import fills missing transcripts but preserves existing segments.
        assert tables["transcript_segments"].insert.called is (replace_transcript or not existing_segments)
        assert tables["transcript_segments"].delete.called is replace_transcript
        if replace_transcript or not existing_segments:
            inserted = tables["transcript_segments"].insert.call_args_list[0].args[0]
            assert inserted[0]["person_id"] is None
            assert inserted[0]["speaker_name"] == "SPEAKER_1"
            # A ten-second gap between statements must not become speaking time.
            assert sum(row["end_time"] - row["start_time"] for row in inserted) == 12

        # Verify the result contains the expected data
        assert len(result["attendance"]) == 6
        assert len(result["items"]) == 3

    @pytest.mark.parametrize("proposed_votes", [
        [],
        [{"person_name": "David Screech", "vote": "Yes", "source_quote": "All council members were present."}],
        [{"person_name": "David Screech", "vote": "Yes", "source_quote": "Mayor Screech voted in favour (fabricated)."}],
    ])
    def test_carried_without_named_votes_does_not_invent_individual_choices(
        self, ingester, populated_archive, meeting_693_refinement, proposed_votes
    ):
        """A majority result and titled attendance do not prove each person's vote."""
        import copy
        ing, tables = ingester
        _setup_supabase_responses(tables)
        refinement = copy.deepcopy(meeting_693_refinement)
        refinement["attendees"] = ["Mayor David Screech", "Councillor Ron Mattson"]
        for item in refinement["items"]:
            for motion in item.get("motions", []):
                motion["votes"] = proposed_votes
        with patch("pipeline.ingestion.ingester.VimeoClient"), \
             patch.object(ing, "_ingest_documents", return_value=0), \
             patch.object(ing, "_ingest_document_sections"), \
             patch.object(ing, "_geocode_agenda_items", return_value=0):
            ing.process_meeting(str(populated_archive), precomputed_refinement=refinement)
        assert tables["motions"].insert.called
        assert not tables["votes"].insert.called

    def test_process_meeting_no_documents(self, ingester, tmp_path):
        """Meeting with no PDF documents should still process via cached text files.

        When there are no PDFs but agenda.md exists, process_meeting should
        still run and ingest items from precomputed refinement.
        """
        ing, tables = ingester
        _setup_supabase_responses(tables)

        # Create bare minimum directory structure with date in name
        meeting_dir = tmp_path / "2025-11-18 Regular Council Meeting"
        meeting_dir.mkdir()

        # Create minimal agenda.md (> 100 chars)
        (meeting_dir / "agenda.md").write_text(
            "# Agenda\n1. Call to Order\n2. Approval of Agenda\n"
            + ("Content padding for minimum length. " * 5)
        )

        # Supply a minimal precomputed refinement
        minimal_refinement = {
            "meeting_type": "Regular Council",
            "status": "Occurred",
            "summary": "Brief meeting.",
            "chair_person_name": None,
            "attendees": [],
            "speaker_aliases": [],
            "items": [
                {
                    "item_order": "1",
                    "title": "Call to Order",
                    "matter_identifier": None,
                    "matter_title": None,
                    "plain_english_summary": "Meeting called to order.",
                    "related_address": None,
                    "description": None,
                    "category": "Procedural",
                    "tags": [],
                    "financial_cost": None,
                    "funding_source": None,
                    "is_controversial": False,
                    "debate_summary": None,
                    "key_quotes": [],
                    "key_statements": [],
                    "discussion_start_time": None,
                    "discussion_end_time": None,
                    "motions": [],
                }
            ],
            "transcript_corrections": [],
        }

        with patch("pipeline.ingestion.ingester.VimeoClient") as mock_vimeo_cls:
            mock_vimeo = MagicMock()
            mock_vimeo.search_video.return_value = None
            mock_vimeo_cls.return_value = mock_vimeo

            with patch.object(ing, "_ingest_documents", return_value=0):
                with patch.object(ing, "_ingest_document_sections"):
                    with patch.object(ing, "_geocode_agenda_items", return_value=0):
                        result = ing.process_meeting(
                            str(meeting_dir),
                            precomputed_refinement=minimal_refinement,
                        )

        assert result is not None
        assert len(result["items"]) == 1
        assert result["items"][0]["title"] == "Call to Order"
        # No transcript means has_transcript should be False
        assert result["meeting"]["has_transcript"] is False

    def test_process_meeting_ai_failure(self, ingester, tmp_path):
        """When the AI call fails and no precomputed refinement exists, process_meeting
        should attempt AI refinement, fail gracefully, and return None.
        """
        ing, tables = ingester
        _setup_supabase_responses(tables)

        # Create meeting directory with agenda and minutes
        meeting_dir = tmp_path / "2025-11-18 Regular Council Meeting"
        meeting_dir.mkdir()

        (meeting_dir / "agenda.md").write_text(
            "# Agenda\n1. Call to Order\n" + ("X" * 200)
        )
        (meeting_dir / "minutes.md").write_text(
            "# Minutes\nMayor called meeting to order.\n" + ("Y" * 200)
        )

        with patch("pipeline.ingestion.ingester.VimeoClient") as mock_vimeo_cls:
            mock_vimeo = MagicMock()
            mock_vimeo.search_video.return_value = None
            mock_vimeo_cls.return_value = mock_vimeo

            with patch.object(ing, "_ingest_documents", return_value=0):
                with patch.object(ing, "_ingest_document_sections"):
                    # Patch refine_meeting_data to simulate an AI failure
                    with patch(
                        "pipeline.ingestion.ingester.refine_meeting_data",
                        return_value=None,
                    ):
                        with pytest.raises(RuntimeError, match="AI refinement failed"):
                            ing.process_meeting(str(meeting_dir), force_update=True)

    def test_process_meeting_missing_transcript(
        self, ingester, tmp_path, meeting_693_refinement
    ):
        """Meeting without transcript data should process agenda/minutes only.

        Verifies that items, motions, and votes are still created from
        refinement data even when no transcript segments exist.
        """
        ing, tables = ingester
        _setup_supabase_responses(tables)

        # Create directory with agenda/minutes but NO Audio folder
        meeting_dir = tmp_path / "2025-11-18 Regular Council Meeting"
        meeting_dir.mkdir()

        (meeting_dir / "agenda.md").write_text(
            "# Agenda\n1. Call to Order\n" + ("Content " * 30)
        )
        (meeting_dir / "minutes.md").write_text(
            "# Minutes\nMayor opened meeting.\n" + ("Content " * 30)
        )

        with patch("pipeline.ingestion.ingester.VimeoClient") as mock_vimeo_cls:
            mock_vimeo = MagicMock()
            mock_vimeo.search_video.return_value = None
            mock_vimeo_cls.return_value = mock_vimeo

            with patch.object(ing, "_ingest_documents", return_value=0):
                with patch.object(ing, "_ingest_document_sections"):
                    with patch.object(ing, "_geocode_agenda_items", return_value=0):
                        result = ing.process_meeting(
                            str(meeting_dir),
                            precomputed_refinement=meeting_693_refinement,
                        )

        assert result is not None
        # Should still have items from refinement
        assert len(result["items"]) == 3
        # No transcript
        assert result["meeting"]["has_transcript"] is False
        # But agenda and minutes should be detected
        assert result["meeting"]["has_agenda"] is True
        assert result["meeting"]["has_minutes"] is True
        # Items should still be inserted
        assert tables["agenda_items"].insert.called
        # Motions should still be inserted (from refinement data)
        assert tables["motions"].insert.called

    def test_process_meeting_dry_run(
        self, ingester, populated_archive, meeting_693_refinement
    ):
        """Dry run should not make any Supabase writes."""
        ing, tables = ingester

        with patch.object(ing, "_ingest_documents", return_value=0):
            with patch.object(ing, "_ingest_document_sections"):
                with patch.object(ing, "_geocode_agenda_items", return_value=0):
                    result = ing.process_meeting(
                        str(populated_archive),
                        dry_run=True,
                        precomputed_refinement=meeting_693_refinement,
                    )

        # Dry run still returns data
        assert result is not None
        # But no actual DB writes should happen
        assert not tables["attendance"].upsert.called
        assert not tables["transcript_segments"].insert.called

    @pytest.mark.parametrize('new_minutes',[False,True])
    def test_process_meeting_already_ingested(self, ingester, populated_archive, meeting_693_refinement, new_minutes):
        """When meeting already exists in DB, should skip and return None."""
        ing, tables = ingester

        _setup_supabase_responses(tables)
        tables["meetings"].execute.return_value = MagicMock(
            data=[{"id": 693,"has_agenda":True,"has_minutes":False}], count=1
        )
        tables['transcript_segments'].execute.return_value=MagicMock(data=[{'id':789}])
        if new_minutes:
            for kind in ['Agenda','Minutes']:
                folder=populated_archive/kind;folder.mkdir(exist_ok=True)
                text=(populated_archive/(kind.lower()+'.md')).read_text()
                (folder/(kind+'.html')).write_text('<h1 id="AgendaHeaderTitle">Council '+kind+'</h1><div id="AgendaItem1">'+text+'</div>')
        model=MagicMock();model.model_dump.return_value=meeting_693_refinement
        with patch('pipeline.ingestion.ingester.refine_meeting_data',return_value=model) as refine,patch.object(ing,'_ingest_documents',return_value=0),patch.object(ing,'_ingest_document_sections'),patch.object(ing,'_geocode_agenda_items',return_value=0):
            result=ing.process_meeting(str(populated_archive))
        assert (result is not None) is new_minutes
        assert refine.called is new_minutes
        assert not tables['transcript_segments'].delete.called
        assert not tables['transcript_segments'].insert.called


def _claim_aware_context(tables, *contexts):
    """Stand-in for prepare_ballot_context: like production, attach the meeting's current claim inventory.

    The ingester refuses source writes without a complete inventory, and compares it with the rows it
    reads, so the fake derives it from whatever _persisting_motions currently holds.
    """
    from pipeline.ingestion.source_claims import build_claim_inventory
    remaining = list(contexts)
    def prepare(*args, **kwargs):
        context = remaining.pop(0) if len(remaining) > 1 else remaining[0]
        rows = tables['motions'].store
        return {**context, 'meeting_claim_inventory': build_claim_inventory(rows, meeting_id=693, expected_count=len(rows))}
    return prepare


def _persisting_motions(tables, initial):
    """Write-through motions fake: updates and inserts return the persisted row, as PostgREST does.

    The ingester verifies each returned row against the semantic claim it intended to write and then
    re-reads the meeting's claim inventory, so a static mock cannot stand in for the table.
    """
    from copy import deepcopy
    table = tables['motions']
    store = table.store = [{'meeting_id': 693, **deepcopy(row)} for row in initial]
    state = {'op': None, 'payload': None, 'id': None}
    def update(data):
        state.update(op='update', payload=deepcopy(data), id=None)
        return table
    def insert(data):
        state.update(op='insert', payload=deepcopy(data), id=None)
        return table
    def eq(column, value):
        if column == 'id':
            state['id'] = value
        return table
    def execute():
        op, payload = state['op'], state['payload']
        state.update(op=None, payload=None)
        if op == 'update':
            row = next(row for row in store if row['id'] == state['id'])
            row.update(payload)
            return MagicMock(data=[deepcopy(row)], count=1)
        if op == 'insert':
            row = {**payload, 'id': max([entry['id'] for entry in store] + [3000]) + 1}
            store.append(row)
            return MagicMock(data=[deepcopy(row)], count=1)
        return MagicMock(data=deepcopy(store), count=len(store))
    table.update.side_effect = update
    table.insert.side_effect = insert
    table.eq.side_effect = eq
    table.execute.side_effect = execute
    return store


def _capture_vote_rows(table, initial, fail_after=None):
    """A persistence fake stores writes; it has no ballot-validation behavior."""
    from copy import deepcopy
    rows = deepcopy(initial)
    pending = []
    writes = 0
    def insert(data):
        pending.append(deepcopy(data))
        return table
    def execute():
        nonlocal writes
        if pending:
            if fail_after is not None and writes == fail_after:
                raise ConnectionError('Vote persistence interrupted')
            writes += 1
            row = pending.pop(0)
            row['id'] = max([entry['id'] for entry in rows] + [0]) + 1
            rows.append(row)
            return MagicMock(data=[deepcopy(row)], count=1)
        return MagicMock(data=deepcopy(rows), count=len(rows))
    table.insert.side_effect = insert
    table.execute.side_effect = execute
    return rows


@pytest.mark.parametrize('prior_conflict,model_omits,fail_after,joined_source', [(False,False,None,False),(True,False,None,False),(False,True,None,False),(False,False,2,False),(False,False,None,True),(False,False,None,"operative")])
def test_ordinary_ingest_persists_complete_ballot_or_holds_conflicting_history(ingester,populated_archive,meeting_693_refinement,tmp_path,prior_conflict,model_omits,fail_after,joined_source):
    """The regular persistence boundary consumes native-source validated choices."""
    from copy import deepcopy
    from ingestion.ballot_fixture import official_context,TEXT
    ing,tables=ingester
    _setup_supabase_responses(tables)
    tables['transcript_segments'].execute.return_value=MagicMock(data=[{'id':789}])
    context=official_context(tmp_path/'source',meeting_id=693,source_date='November 18, 2025')
    if joined_source == 'operative':
        import fitz
        from pipeline.ingestion.official_ballots import load_official_minutes
        TEXT = 'THAT Council adjourn the meeting.'
        raw_body = TEXT+'\n\nMayor Goodmanson adjourned the meeting at 4:08 pm.'
        native = tmp_path/'source'/context['source']['source_file']
        pdf = native.with_name('Minutes - SIGNED.pdf')
        document=fitz.open();page=document.new_page()
        roster='\n'.join(('Mayor ' if p['id']==1 else 'Councillor ')+p['name'][0]+'. '+p['name'].split()[-1] for p in context['people'])
        page.insert_text((70,70),'City of Langford\nCouncil Minutes\nNovember 18, 2025\nPRESENT:\n'+roster+'\nATTENDING:\nStaff\n1. ADJOURNMENT\nMOVED BY: HARDER\nSECONDED: GUIRY\n'+raw_body+'\nCARRIED.',fontsize=8)
        document.save(pdf);document.close()
        context['source']=load_official_minutes(context['meeting'],root=tmp_path/'source',people=context['people'],cache_dir=tmp_path/'operative-cache')
    else:
        raw_body = TEXT.replace('THAT Council', 'THATCouncil') if joined_source else TEXT
    if joined_source is True:
        from pipeline.ingestion.official_ballots import load_official_minutes
        native = tmp_path/'source'/context['source']['source_file']
        native.write_text(native.read_text().replace(TEXT, raw_body))
        context['source'] = load_official_minutes(context['meeting'],root=tmp_path/'source',people=context['people'],cache_dir=tmp_path/'joined-cache')
    (populated_archive/'minutes.md').write_text('# Minutes\n'+context['source']['text'])
    refinement=deepcopy(meeting_693_refinement)
    template=deepcopy(refinement['items'][-1]);template['motions']=[{**refinement['items'][1]['motions'][0],'motion_text':TEXT,'result':'CARRIED','votes':[]}]
    if model_omits:
        template['motions']=[]
    refinement['items']=[template]
    _persisting_motions(tables,[{'plain_english_summary':'Existing readable summary','disposition':'Substantive','time_offset_seconds':1234,'financial_cost':10,'id':3001,'agenda_item_id':5001,'text_content':TEXT,'result':'CARRIED','meta':{'individual_vote_coverage':'named_only','unrelated':'preserved'}}])
    old=[{'id':7,'motion_id':3001,'person_id':21,'vote':'No','recusal_reason':None}] if prior_conflict else []
    persisted_votes = _capture_vote_rows(tables['votes'], old, fail_after)
    with patch('pipeline.ingestion.ingester.prepare_ballot_context',side_effect=_claim_aware_context(tables,context)),patch.object(ing,'_ingest_documents',return_value=0),patch.object(ing,'_ingest_document_sections'),patch.object(ing,'_geocode_agenda_items',return_value=0):
        if fail_after is None:
            ing.process_meeting(str(populated_archive),precomputed_refinement=refinement)
        else:
            with pytest.raises(ConnectionError, match='interrupted'):
                ing.process_meeting(str(populated_archive),precomputed_refinement=refinement)
    assert not tables['motions'].insert.called
    assert tables['motions'].update.called
    stored=tables['motions'].update.call_args_list[0].args[0]
    final_meta=tables['motions'].update.call_args.args[0]['meta']
    assert not tables['motions'].delete.called
    assert not tables['votes'].delete.called
    assert stored['agenda_item_id']==5001
    assert stored['meta']['unrelated']=='preserved'
    assert stored['meta']['canonical_source_motion']['raw_motion_text']==raw_body
    assert stored['text_content']==TEXT
    if joined_source == 'operative':
        assert stored['meta']['operative_motion_body']['operative_body']==TEXT
        assert final_meta['ballot_reconstruction']['source_motion_text']==raw_body
        assert final_meta['ballot_reconstruction']['operative_motion_body']['excluded_spans'][0]['kind']=='execution_event'
    choices=[call.args[0] for call in tables['votes'].insert.call_args_list]
    if fail_after is not None:
        assert len(persisted_votes)==2
        assert final_meta['individual_vote_coverage']=='named_only'
        assert final_meta['ballot_reconstruction']['status']=='vote_persistence_pending'
        receipts=[call.args[0]['meta']['motion_source_ingestion'] for call in tables['meetings'].update.call_args_list if 'motion_source_ingestion' in call.args[0].get('meta',{})]
        assert receipts[-1]['status']=='in_progress'
    elif prior_conflict:
        assert choices==[]  # Existing No row keeps its ID; never delete/reinsert it.
        assert final_meta['individual_vote_coverage']=='named_only'
        assert final_meta['ballot_reconstruction']['status']=='existing_vote_conflicts_with_reconstructed_ballot'
    else:
        assert len(choices)==6
        assert {row['vote'] for row in choices}=={'Yes'}
        assert stored['meta']['individual_vote_coverage']=='named_only'
        assert final_meta['individual_vote_coverage']=='reconstructed_complete'
        assert final_meta['ballot_reconstruction']['choice_provenance']['person_21']=='inferred_official_dissent_recording_rule'
        assert len(persisted_votes)==6
    if model_omits:
        assert stored['plain_english_summary']=='Existing readable summary'
        assert stored['disposition']=='Substantive'
        assert stored['time_offset_seconds']==1234
        assert stored['financial_cost']==10
    assert not tables['transcript_segments'].delete.called
    assert not tables['transcript_segments'].insert.called


def test_ambiguous_prior_ballot_blocks_destructive_item_refresh(ingester,populated_archive,meeting_693_refinement):
    from copy import deepcopy
    ing,tables=ingester;_setup_supabase_responses(tables)
    refinement=deepcopy(meeting_693_refinement)
    text=refinement['items'][1]['motions'][0]['motion_text']
    tables['transcript_segments'].execute.return_value=MagicMock(data=[{'id':789}])
    tables['motions'].execute.return_value=MagicMock(data=[{'id':3001,'text_content':text},{'id':3002,'text_content':text}],count=2)
    tables['votes'].execute.return_value=MagicMock(data=[{'id':7,'motion_id':3001,'person_id':10,'vote':'No'}])
    with patch.object(ing,'_ingest_documents',return_value=0),patch.object(ing,'_ingest_document_sections'),patch.object(ing,'_geocode_agenda_items',return_value=0):
        with pytest.raises(RuntimeError,match='cannot be mapped uniquely'):
            ing.process_meeting(str(populated_archive),precomputed_refinement=refinement)
    assert not tables['votes'].delete.called
    assert not tables['motions'].delete.called
    assert not tables['agenda_items'].delete.called
    assert not tables['key_statements'].delete.called


def test_source_revision_preserves_unmapped_legacy_rows_and_holds_old_complete_coverage(
    ingester, populated_archive, meeting_693_refinement, tmp_path
):
    """A changed critical identifier cannot create a duplicate or reuse stale proof."""
    from copy import deepcopy
    from ingestion.ballot_fixture import official_context, TEXT
    ing, tables = ingester
    _setup_supabase_responses(tables)
    tables['transcript_segments'].execute.return_value = MagicMock(data=[{'id':789}])
    context = official_context(tmp_path/'revised-source', meeting_id=693, source_date='November 18, 2025')
    # The current official source says 2269; the legacy stored motion says 2270.
    old_meta = {'individual_vote_coverage':'reconstructed_complete', 'unrelated':'keep',
                'ballot_reconstruction':{'source_sha256':'old-source-sha'},'vote_record':{'coverage':'reconstructed_complete'}}
    _persisting_motions(tables, [{
        'id':309, 'agenda_item_id':5001, 'text_content':TEXT.replace('2269','2270'),
        'meta':old_meta, 'result':'CARRIED', 'updated_at':'2026-10-01T00:00:00Z',
    }])
    tables['votes'].execute.return_value = MagicMock(data=[{'id':7,'motion_id':309,'person_id':21,'vote':'Yes'}])
    with patch('pipeline.ingestion.ingester.prepare_ballot_context', side_effect=_claim_aware_context(tables, context)), \
         patch.object(ing,'_ingest_documents',return_value=0), \
         patch.object(ing,'_ingest_document_sections'), \
         patch.object(ing,'_geocode_agenda_items',return_value=0):
        result = ing.process_meeting(str(populated_archive), precomputed_refinement=deepcopy(meeting_693_refinement))
    assert not tables['motions'].insert.called
    assert not tables['motions'].delete.called
    assert not tables['votes'].insert.called
    assert not tables['votes'].delete.called
    stored = tables['motions'].update.call_args.args[0]
    assert set(stored) == {'meta'}  # No rewritten body/outcome or lost primary key.
    assert stored['meta']['individual_vote_coverage'] == 'named_only'
    assert stored['meta']['prior_ballot_proof'] == old_meta['ballot_reconstruction']
    assert stored['meta']['vote_record']['coverage']=='partial'
    assert stored['meta']['prior_vote_record']==old_meta['vote_record']
    assert stored['meta']['unrelated'] == 'keep'
    assert result['canonical_motion_ingestion']['unmapped_legacy_ids'] == [309]
    assert result['canonical_motion_ingestion']['held'][0]['reason'] == 'unmapped_legacy_records'


def test_planned_refresh_cannot_downgrade_an_already_occurred_meeting(ingester, populated_archive, meeting_693_refinement):
    ing, tables = ingester
    _setup_supabase_responses(tables)
    future = populated_archive.rename(populated_archive.parent/'2027-11-18 Regular Council Meeting')
    tables['meetings'].execute.return_value = MagicMock(data=[{'id':693,'status':'Completed'}], count=1)
    with pytest.raises(RuntimeError, match='planned-source refresh'):
        ing.process_meeting(str(future), precomputed_refinement=meeting_693_refinement)
    assert not tables['meetings'].upsert.called
    assert not tables['meetings'].update.called
    assert not tables['motions'].delete.called


def test_reingest_keeps_a_cancelled_meeting_cancelled(ingester, populated_archive, meeting_693_refinement):
    """A postponed meeting has a past date and no minutes; re-ingesting must not reopen it as Occurred."""
    ing, tables = ingester
    _setup_supabase_responses(tables)
    tables['meetings'].execute.return_value = MagicMock(data=[{'id': 693, 'status': 'Cancelled', 'video_url': None, 'meta': {}}], count=1)
    with patch("pipeline.ingestion.ingester.VimeoClient"), \
         patch.object(ing, "_ingest_documents", return_value=0), \
         patch.object(ing, "_ingest_document_sections"), \
         patch.object(ing, "_geocode_agenda_items", return_value=0):
        ing.process_meeting(str(populated_archive), precomputed_refinement={**meeting_693_refinement, 'status': 'Completed'})
    written = [c.args[0] for c in tables['meetings'].upsert.call_args_list + tables['meetings'].update.call_args_list]
    statuses = [w['status'] for w in written if isinstance(w, dict) and 'status' in w]
    assert statuses and set(statuses) == {'Cancelled'}


def test_canonical_dry_run_reports_actual_existing_motion_without_writes(ingester,populated_archive,meeting_693_refinement,tmp_path):
    from copy import deepcopy
    from ingestion.ballot_fixture import official_context, TEXT
    ing, tables = ingester
    _setup_supabase_responses(tables)
    context = official_context(tmp_path/'native', meeting_id=693, source_date='November 18, 2025')
    _persisting_motions(tables, [{'id':309,'agenda_item_id':5001,'text_content':TEXT,'meta':{}}])
    with patch('pipeline.ingestion.ingester.prepare_ballot_context',side_effect=_claim_aware_context(tables,context)), \
         patch.object(ing,'_ingest_documents',return_value=0):
        result = ing.process_meeting(str(populated_archive),dry_run=True,precomputed_refinement=deepcopy(meeting_693_refinement))
    canonical = [motion for item in result['items'] for motion in item['motions']]
    assert result['meeting_id']==693
    assert canonical[0]['_existing_motion']['id']==309
    assert result['canonical_motion_ingestion']['mapped_motions']==1
    for table in tables.values():
        assert not table.insert.called
        assert not table.update.called
        assert not table.upsert.called
        assert not table.delete.called


@pytest.mark.parametrize('receipt_status,cache_present', [('source_authoritative',True),('in_progress',True),('in_progress',False),('changed_context',True)])
def test_only_finished_current_source_receipt_can_skip_a_cached_ingestion(
    ingester,populated_archive,tmp_path,receipt_status,cache_present
):
    from ingestion.ballot_fixture import official_context, TEXT
    ing, tables = ingester
    _setup_supabase_responses(tables)
    tables['attendance'].execute.return_value=MagicMock(data=[{'person_id':24,'attendance_mode':'Remote'}])
    tables['meeting_speaker_aliases'].execute.return_value=MagicMock(data=[{'speaker_label':'Speaker_01','person_id':26}])
    if not cache_present:
        (populated_archive/'refinement.json').unlink()
    source_root = tmp_path/'native'
    context = official_context(source_root, meeting_id=693, source_date='November 18, 2025')
    receipt = {'status':receipt_status,'source_file':context['source']['source_file'],'source_sha256':context['source']['source_sha256']}
    tables['meetings'].execute.return_value = MagicMock(data=[{'id':693,'status':'Completed','has_agenda':True,'has_minutes':True,'has_transcript':True,'meta':{'motion_source_ingestion':receipt},'meeting_date':'2025-11-17','title':'Corrected Council title','type':'Special Council','organization_id':777,'archive_path':'archive/langford/Council/2025/meeting','organization':{'classification':'Council'}}], count=1)
    legacy_present = cache_present
    legacy = [{'id':309,'agenda_item_id':5001,'text_content':TEXT,'result':'CARRIED','meta':{}}] if legacy_present else []
    _persisting_motions(tables, legacy)
    _capture_vote_rows(tables['votes'], [])
    tables['transcript_segments'].execute.return_value=MagicMock(data=[{'id':789}])
    from copy import deepcopy
    changed_context = deepcopy(context)
    changed_context['memberships'][0]['end_date'] = '2025-11-16'
    with patch.object(ing,'_normalize_archive_path',return_value='archive/langford/Council/2025/meeting'), \
         patch('pipeline.ingestion.ingester.parser.extract_meeting_metadata',side_effect=AssertionError('Fact-only identity must come from the stored catalog')), \
         patch('pipeline.ingestion.ingester.BASE_DIR',source_root), \
         patch('pipeline.ingestion.ingester.refine_meeting_data',side_effect=AssertionError('Source-only refresh must not buy new AI enrichment')), \
         patch('pipeline.ingestion.ingester.prepare_ballot_context',side_effect=_claim_aware_context(tables, context, changed_context) if receipt_status=='changed_context' else _claim_aware_context(tables, context)) as context_loader, \
         patch.object(ing,'get_raw_texts',return_value=((populated_archive/'agenda.md').read_text(),(populated_archive/'minutes.md').read_text(),'')), \
         patch.object(ing,'_ingest_documents',return_value=0), \
         patch.object(ing,'_ingest_document_sections'), \
         patch.object(ing,'_geocode_agenda_items',return_value=0):
        if receipt_status == 'changed_context':
            with pytest.raises(RuntimeError, match='Validation inputs changed'):
                ing.process_meeting(str(populated_archive))
            receipts = [call.args[0]['meta']['motion_source_ingestion'] for call in tables['meetings'].update.call_args_list
                        if 'motion_source_ingestion' in call.args[0].get('meta', {})]
            assert receipts and all(receipt['status']=='in_progress' for receipt in receipts)
            return
        result=ing.process_meeting(str(populated_archive))
        assert context_loader.call_args_list[0].kwargs['meeting']['meeting_date'] == '2025-11-17'
        assert result['meeting']['meeting_date'] == '2025-11-17'
        assert result['meeting']['title'] == 'Corrected Council title'
        assert result['meeting']['type'] == 'Special Council'
        assert result['meeting']['organization_id'] == 777
        finished = [call.args[0]['meta'] for call in tables['meetings'].update.call_args_list
                    if 'motion_source_ingestion' in call.args[0].get('meta', {})][-1]
        assert finished['motion_source_ingestion']['validation_inputs']['version'] == 3
        assert 'hold_reasons' in finished['motion_source_ingestion']['ballot_validation']
        tables['meetings'].execute.return_value = MagicMock(data=[{'id':693,'status':'Completed','has_agenda':True,
            'has_minutes':True,'has_transcript':True,'meta':finished,'meeting_date':'2025-11-17','title':'Corrected Council title','type':'Special Council','organization_id':777,'archive_path':'archive/langford/Council/2025/meeting','organization':{'classification':'Council'}}], count=1)
        # A finished attempt may hold unsupported ballots; unchanged evidence
        # must not repeatedly run the same repair (or buy enrichment).
        assert ing.process_meeting(str(populated_archive)) is None
    # Legacy receipts do not identify validator/evidence inputs.
    assert result is not None
    assert result['source_only_refresh'] is True
    if result:
        assert result['canonical_motion_ingestion']['mapped_motions']==1
        if legacy_present:
            assert not tables['motions'].insert.called
            assert not tables['agenda_items'].insert.called
            assert not tables['agenda_items'].update.called
            stored=tables['motions'].update.call_args_list[0].args[0]
        else:
            stored=tables['motions'].insert.call_args.args[0]
            assert tables['agenda_items'].insert.call_args.args[0]['title']=='Official recorded motions'
        assert stored['meta']['canonical_source_motion']['source_sha256']==receipt['source_sha256']
        assert not tables['key_statements'].insert.called
        assert not tables['attendance'].upsert.called
        assert not tables['meeting_speaker_aliases'].upsert.called
        assert not tables['transcript_segments'].insert.called
        assert not tables['transcript_segments'].delete.called
        assert all('summary' not in call.args[0] for call in tables['meetings'].update.call_args_list)
        assert all(not {'title','meeting_date','organization_id','type','archive_path'} & call.args[0].keys()
                   for call in tables['meetings'].update.call_args_list)
        meeting=result['meeting']
        assert meeting['has_transcript'] is True
        assert meeting['status']=='Completed'


@pytest.mark.parametrize('conflict', [False, True, 'catalog'])
def test_source_role_refresh_preserves_manual_metadata_and_CAS(ingester, conflict):
    ing, tables = ingester
    method = 'official_minutes_explicit_role_v1'
    meta = {'unrelated': {'keep': True}, 'participant_roles': {
        '1': {'method': method, 'role': 'stale machine role'},
        '2': {'method': 'manual', 'role': 'curated role'},
    }}
    tables['meetings'].execute.side_effect = [
        MagicMock(data=[{'meta': meta, 'updated_at': '2026-10-19T01:02:03+00:00',
                        'meeting_date': '2026-10-17' if conflict == 'catalog' else '2026-10-18',
                        'archive_path': 'archive/langford/meeting', 'minutes_url': None}]),
        MagicMock(data=[] if conflict is True else [{'id': 693}]),
    ]
    context = {'status': 'available', 'meeting': {'id': 693, 'meeting_date': '2026-10-18',
               'archive_path': 'archive/langford/meeting', 'minutes_url': None}, 'source': {}, 'people': []}
    with patch('pipeline.ingestion.participant_roles.participant_role_observations', return_value={
        'status': 'parsed', 'observations': {
            '2': {'method': method, 'role': 'machine must not overwrite manual'},
            '3': {'method': method, 'role': 'source-proven role'},
        }, 'holds': []}):
        if conflict:
            with pytest.raises(RuntimeError, match='catalog identity' if conflict == 'catalog' else 'compare-and-swap'):
                ing.persist_participant_role_observations(context)
        else:
            assert ing.persist_participant_role_observations(context)['status'] == 'updated'
    if conflict == 'catalog':
        assert not tables['meetings'].update.called
        return
    proposed = tables['meetings'].update.call_args.args[0]['meta']
    assert proposed == {'unrelated': {'keep': True}, 'participant_roles': {
        '2': {'method': 'manual', 'role': 'curated role'},
        '3': {'method': method, 'role': 'source-proven role'},
    }}
    assert call('updated_at', '2026-10-19T01:02:03+00:00') in tables['meetings'].eq.call_args_list
    assert any(args.args[0] == 'meta' for args in tables['meetings'].eq.call_args_list)
