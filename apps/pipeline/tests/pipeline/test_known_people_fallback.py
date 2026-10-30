"""Speaker/person matching never falls back to another town's names."""
from unittest.mock import MagicMock

import pytest

from pipeline import names, utils
from pipeline.ingestion.ai_refiner import build_refinement_prompt
from pipeline.ingestion.ingester import MeetingIngester

VIEW_ROYAL_NAMES = ("Sid Tobias", "Ron Mattson", "Nicholas Anderson", "Scott M. Sommerville", "Graham Hill", "Jeff Chow")


def _ingester():
    ingester = MeetingIngester.__new__(MeetingIngester)
    ingester.municipality_id = 1
    ingester._canonical_names = None
    ingester.supabase = MagicMock()
    return ingester


def test_db_failure_returns_no_names_with_a_warning(capsys):
    ingester = _ingester()
    ingester.supabase.table.side_effect = RuntimeError("connection refused")
    assert ingester._get_canonical_names() == []
    assert "speaker names will not be matched" in capsys.readouterr().out
    # Not cached: the next meeting tries the database again.
    ingester.supabase.table.side_effect = None
    ingester.supabase.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [{"id": 7}]
    ingester.supabase.table.return_value.select.return_value.in_.return_value.execute.return_value.data = [
        {"person": {"name": "Jordan Lee"}}
    ]
    assert ingester._get_canonical_names() == ["Jordan Lee"]


def test_no_people_on_record_returns_no_names(capsys):
    ingester = _ingester()
    ingester.supabase.table.return_value.select.return_value.eq.return_value.execute.return_value.data = []
    assert ingester._get_canonical_names() == []
    assert "No known people" in capsys.readouterr().out


@pytest.mark.parametrize("raw", ["Councillor Anderson", "Mayor Hill", "Councillor matson", "Scott", "Jeff"])
def test_names_are_not_rewritten_to_view_royal_people(raw):
    assert utils.normalize_person_name(raw) not in VIEW_ROYAL_NAMES


def test_names_module_holds_no_roster():
    assert not hasattr(names, "CANONICAL_NAMES")
    assert not hasattr(names, "COUNCIL_NAMES")
    assert not hasattr(names, "NAME_VARIANTS")


def test_prompt_without_council_list_names_no_council():
    prompt = build_refinement_prompt("Agenda", "Minutes", "Transcript")
    assert "KNOWN COUNCIL MEMBERS" not in prompt
    for name in ("Tobias", "Mattson", "Screech", "View Royal", "Helmcken"):
        assert name not in prompt
