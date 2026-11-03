import pytest

from pipeline.ingestion.ingester import minutes_not_expected, motion_hold_applies, notice_only, refreshed_item_fields

UNVALIDATED = {"status": "committee_membership_rules_need_validation"}


@pytest.mark.parametrize("classification", ["Committee", "Advisory Committee", "Board"])
def test_unvalidated_non_council_bodies_are_held(classification):
    assert motion_hold_applies(False, classification, UNVALIDATED)


@pytest.mark.parametrize("classification", ["Council", "Committee of the Whole"])
def test_council_bodies_never_held(classification):
    assert not motion_hold_applies(False, classification, UNVALIDATED)


def test_validated_cac_stays_canonical():
    assert not motion_hold_applies(False, "Advisory Committee", {"status": "available"})


def test_planned_meeting_not_held_and_other_statuses_unchanged():
    assert not motion_hold_applies(True, "Advisory Committee", UNVALIDATED)
    assert not motion_hold_applies(False, "Advisory Committee", {"status": "ballot_context_unavailable"})
    assert not motion_hold_applies(False, "Advisory Committee", None)


def test_meeting_held_entirely_in_camera_is_held():
    # 2015-08-28: Council met entirely in camera; the notice is the only public record, so nothing can verify motions.
    assert motion_hold_applies(False, "Council", {"status": "available"}, closed_only=True)
    assert not motion_hold_applies(False, "Council", {"status": "available"}, closed_only=False)


def test_meeting_marked_as_having_no_minutes():
    # 2026-11-02 inaugural meeting: the City publishes no minutes, so video readings stay unverified.
    assert minutes_not_expected(None, {"minutes_expected": False})
    assert not minutes_not_expected(None, {}, {"minutes_expected": True})
    assert motion_hold_applies(False, "Council", {"status": "available"}, closed_only=minutes_not_expected({"minutes_expected": False}))


def test_notice_only(tmp_path):
    def folder(name, files):
        for f in files:
            (tmp_path / name / f).parent.mkdir(parents=True, exist_ok=True)
            (tmp_path / name / f).write_text("x")
        return str(tmp_path / name)

    notice = "Agenda/Council - 2015-08-28 - 0900 - Special - Notice of In-Camera Meeting.pdf"
    assert notice_only(folder("closed", [notice, notice + ".url"]))
    # Minutes not posted yet, or an ordinary agenda beside the notice: the usual official-minutes rule applies.
    assert not notice_only(folder("agenda", ["Agenda/Agenda.pdf"]))
    assert not notice_only(folder("mixed", [notice, "Agenda/Agenda.pdf"]))
    assert not notice_only(folder("minuted", [notice, "Minutes/Minutes.pdf"]))
    assert not notice_only(folder("empty", []))


def test_planned_item_text_is_dropped_once_the_meeting_is_held():
    # 2026-11-02: the held meeting's run wrote no item summary, and "Council is scheduled to..." survived.
    fresh = {"description": "Council approved the agenda.", "plain_english_summary": None, "financial_cost": None}
    assert refreshed_item_fields(fresh, held_after_plan=True) == {"description": "Council approved the agenda.", "plain_english_summary": None}
    assert refreshed_item_fields(fresh, held_after_plan=False) == {"description": "Council approved the agenda."}
