import pytest

from pipeline.ingestion.ingester import motion_hold_applies, notice_only

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
