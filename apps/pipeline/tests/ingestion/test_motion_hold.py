import pytest

from pipeline.ingestion.ingester import motion_hold_applies

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
