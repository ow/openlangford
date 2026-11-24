"""Tests for pipeline.ingestion.ai_refiner module.

Covers: refine_meeting_data (full/agenda-only/failure), build_refinement_prompt,
        build_agenda_only_prompt, schema models
"""

import pytest
from unittest.mock import patch, MagicMock

from pipeline.ingestion.ai_refiner import (
    AGENDA_ONLY_SYSTEM_INSTRUCTION,
    SYSTEM_INSTRUCTION,
    refine_meeting_data,
    build_refinement_prompt,
    build_agenda_only_prompt,
    MeetingRefinement,
    AgendaItemRecord,
    MotionRecord,
    SpeakerAlias,
    TranscriptCorrection,
    KeyQuote,
    KeyStatement,
    VoteRecord,
)


def _make_refinement(**kwargs):
    """Helper to create a MeetingRefinement with minimal required fields."""
    defaults = {
        "scratchpad_speaker_map": "",
        "scratchpad_timeline": "",
        "summary": "Test summary",
        "meeting_type": "Regular Council",
        "status": "Completed",
        "chair_person_name": "Sid Tobias",
        "attendees": ["Sid Tobias"],
        "speaker_aliases": [],
        "transcript_corrections": [],
        "items": [],
    }
    defaults.update(kwargs)
    return MeetingRefinement(**defaults)


# --- refine_meeting_data ---


class TestRefineMeetingData:
    @patch("pipeline.ai.json")
    def test_full_refinement_uses_extraction_schema(self, mock_json):
        """Full refinement (all 3 inputs) asks the client for a MeetingRefinement."""
        mock_json.return_value = _make_refinement()

        result = refine_meeting_data(
            agenda_text="Agenda text here" * 20,
            minutes_text="Minutes text here" * 20,
            transcript_text="Transcript text here" * 20,
        )
        assert result is not None
        kwargs = mock_json.call_args.kwargs
        assert kwargs["stage"] == "extraction"
        assert kwargs["schema"] is MeetingRefinement
        assert "TRANSCRIPT" in mock_json.call_args.args[0]
        assert kwargs["system"] == SYSTEM_INSTRUCTION

    @patch("pipeline.ai.json")
    def test_agenda_only_mode(self, mock_json):
        """Agenda-only mode (no minutes, no transcript) uses different prompt."""
        mock_json.return_value = _make_refinement(status="Planned")

        result = refine_meeting_data(
            agenda_text="Agenda text here",
            minutes_text="",
            transcript_text="",
        )
        assert result.status == "Planned"
        assert "UPCOMING" in mock_json.call_args.args[0]

    @pytest.mark.parametrize("include_attachments", [True, False])
    @patch("pipeline.ai.json")
    def test_agenda_only_proposal_grounding_contract(self, mock_json, include_attachments):
        # Neither effect is stated in the agenda index. Only the first belongs
        # to item 10.1; the second belongs to a different reading.
        index = (
            "10.1 Procedure Bylaw 2304 — First, second and third readings\n"
            "10.2 Fees Bylaw 2305 — Scheduled for adoption"
        )
        attachments = (
            "Staff Report for 10.1 — Procedure Bylaw 2304: remove the fixed 7 p.m. start.\n"
            "Draft Fees Bylaw 2305: raise the permit fee to $250."
        )
        mock_json.return_value = _make_refinement(status="Planned")
        result = refine_meeting_data(
            agenda_text=index + ("\n\n" + attachments if include_attachments else ""),
            minutes_text="",
            transcript_text="",
        )

        prompt = mock_json.call_args.args[0]
        instructions, source = prompt.split("SOURCE: AGENDA PACKET", 1)
        assert index in source
        assert (attachments in source) is include_attachments
        assert "exact bylaw/application identifier" in instructions
        assert "borrow specifics from another item" in instructions
        assert "what it would change" in instructions
        assert "Attribute it to the named staff report or draft" in instructions
        assert "packet does not specify the proposed changes" in instructions
        assert "A scheduled adoption is not an adoption" in instructions
        assert mock_json.call_args.kwargs["system"] == AGENDA_ONLY_SYSTEM_INSTRUCTION
        assert result.status == "Planned"

    @patch("pipeline.ai.json")
    def test_ai_failure_returns_none_without_nested_retries(self, mock_json):
        """The client owns retries; the refiner makes exactly one call and returns None on failure."""
        from pipeline.ai import AIRequestError

        mock_json.side_effect = AIRequestError("boom", stage="extraction", attempts=3)

        result = refine_meeting_data(
            agenda_text="Agenda",
            minutes_text="Minutes text" * 20,
            transcript_text="Transcript text" * 20,
        )
        assert result is None
        assert mock_json.call_count == 1


# --- build_refinement_prompt ---


class TestBuildRefinementPrompt:
    def test_includes_all_sources(self):
        # Late agenda items and final motions must not silently disappear from
        # the model's official decision sources on long meetings.
        agenda = "Agenda text " * 1600 + "FINAL AGENDA ITEM: rezoning"
        minutes = "Minutes text " * 1800 + "FINAL DECISION: Bylaw 2275 adopted"
        prompt = build_refinement_prompt(
            agenda, minutes, "Transcript text"
        )
        assert "AGENDA" in prompt
        assert "MINUTES" in prompt
        assert "TRANSCRIPT" in prompt
        assert "Agenda text" in prompt
        assert "Minutes text" in prompt
        assert "Transcript text" in prompt
        assert "FINAL AGENDA ITEM: rezoning" in prompt
        assert "FINAL DECISION: Bylaw 2275 adopted" in prompt

    def test_no_transcript_uses_different_instructions(self):
        prompt = build_refinement_prompt("Agenda text", "Minutes text", "")
        assert "NO TRANSCRIPT AVAILABLE" in prompt
        assert "Not Available" in prompt

    def test_includes_attendees_context(self):
        prompt = build_refinement_prompt(
            "Agenda", "Minutes", "Transcript",
            attendees_context="Present: Mayor Tobias\nPresent: Councillor Mattson",
        )
        assert "KNOWN ATTENDEES" in prompt
        assert "Mayor Tobias" in prompt

    def test_includes_fingerprint_aliases(self):
        prompt = build_refinement_prompt(
            "Agenda", "Minutes", "Transcript",
            fingerprint_aliases=[
                {"label": "SPEAKER_01", "name": "Sid Tobias", "confidence": 0.92}
            ],
        )
        assert "PRE-IDENTIFIED SPEAKERS" in prompt
        assert "SPEAKER_01" in prompt
        assert "Sid Tobias" in prompt

    def test_includes_active_council_members(self):
        prompt = build_refinement_prompt(
            "Agenda", "Minutes", "Transcript",
            active_council_members=["Sid Tobias", "Ron Mattson"],
        )
        assert "ACTIVE COUNCIL MEMBERS" in prompt
        assert "Sid Tobias" in prompt


# --- build_agenda_only_prompt ---


class TestBuildAgendaOnlyPrompt:
    def test_includes_agenda_text(self):
        prompt = build_agenda_only_prompt("Full agenda text here")
        assert "Full agenda text here" in prompt
        assert "Planned" in prompt

    def test_upcoming_meeting_instructions(self):
        prompt = build_agenda_only_prompt("Some agenda")
        assert "UPCOMING" in prompt or "INCOMPLETE" in prompt


# --- Pydantic model validation ---


class TestPydanticModels:
    def test_meeting_refinement_minimal(self):
        r = _make_refinement()
        assert r.summary == "Test summary"
        assert r.meeting_type == "Regular Council"

    def test_agenda_item_record(self):
        item = AgendaItemRecord(
            item_order="1",
            title="Test Item",
            description=None,
            plain_english_summary="A test",
            category="Procedural",
            tags=["test"],
            financial_cost=None,
            funding_source=None,
            is_controversial=False,
            debate_summary=None,
            key_quotes=[],
            discussion_start_time=0.0,
            discussion_end_time=10.0,
            motions=[],
        )
        assert item.item_order == "1"
        assert item.title == "Test Item"

    def test_motion_record_defaults(self):
        m = MotionRecord(motion_text="Move to approve", result="CARRIED")
        assert m.mover is None
        assert m.seconder is None
        assert m.votes == []
        assert m.plain_english_summary is None

    def test_speaker_alias(self):
        sa = SpeakerAlias(label="Speaker_01", name="John Doe")
        assert sa.label == "Speaker_01"

    def test_vote_record(self):
        v = VoteRecord(person_name="Jane Smith", vote="Yes", reason=None)
        assert v.vote == "Yes"

    def test_key_statement(self):
        ks = KeyStatement(
            statement_text="Traffic increased 40%",
            speaker="Councillor Smith",
            statement_type="claim",
            context="During rezoning debate",
            timestamp=1234.5,
        )
        assert ks.statement_type == "claim"
