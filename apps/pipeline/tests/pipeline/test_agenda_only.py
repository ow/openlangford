from unittest.mock import patch

from pipeline.ingestion.ai_refiner import (
    AGENDA_ONLY_SYSTEM_INSTRUCTION,
    MeetingRefinement,
    refine_meeting_data,
)


def test_agenda_only_refinement():
    agenda_text = """
    TOWN OF VIEW ROYAL
    COUNCIL MEETING
    AGENDA
    Tuesday, January 20, 2026

    1. CALL TO ORDER
    2. APPROVAL OF AGENDA
       Recommendation: THAT the agenda be approved.
    3. REPORTS
       3.1 Staff Report - Bridge Repair
       Recommendation: THAT the budget be approved.
    4. ADJOURNMENT
    """
    planned = MeetingRefinement.model_validate(
        {
            "scratchpad_speaker_map": "",
            "scratchpad_timeline": "",
            "summary": "- Scheduled discussion of bridge repair.",
            "meeting_type": "Regular Council",
            "status": "Planned",
            "chair_person_name": None,
            "attendees": [],
            "speaker_aliases": [],
            "transcript_corrections": [],
            "items": [
                {
                    "item_order": "3.1",
                    "title": "Staff Report - Bridge Repair",
                    "description": None,
                    "category": "Infrastructure",
                    "tags": [],
                    "financial_cost": None,
                    "funding_source": None,
                    "is_controversial": False,
                    "debate_summary": None,
                    "key_quotes": [],
                    "discussion_start_time": None,
                    "discussion_end_time": None,
                    "motions": [],
                }
            ],
        }
    )

    with patch("pipeline.ai.json", return_value=planned) as mock_json:
        result = refine_meeting_data(agenda_text, "", "")

    assert result.status == "Planned"
    assert result.items[0].motions == []
    prompt = mock_json.call_args.args[0]
    assert "UPCOMING" in prompt and "Bridge Repair" in prompt
    assert mock_json.call_args.kwargs["schema"] is MeetingRefinement
    assert mock_json.call_args.kwargs["system"] == AGENDA_ONLY_SYSTEM_INSTRUCTION
