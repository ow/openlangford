"""Catch-up preserves existing claims and admits only source-bound new facts."""
from copy import deepcopy
import pytest

from ingestion.ballot_fixture import official_context, TEXT
from pipeline.backfill.history_coverage import plan_meeting, digest


def test_unclaimed_official_decision_is_additive_without_invented_votes(tmp_path):
    context = official_context(tmp_path)
    plan = plan_meeting(context['meeting'], [], [], context['source'])
    assert plan['coverage'] == 'missing_source_decisions'
    assert len(plan['new_motions']) == 1
    claim = plan['new_motions'][0]
    assert claim['text_content'] == TEXT
    assert claim['result'] == 'CARRIED'
    assert claim['parent_agenda_id'] is None
    assert claim['meta']['individual_vote_coverage'] == 'not_recorded'
    assert claim['meta']['canonical_source_motion']['source_sha256'] == context['source']['source_sha256']


def test_exact_existing_claim_not_rewritten_or_duplicated(tmp_path):
    context = official_context(tmp_path)
    old = {'id': 309, 'meeting_id': 77, 'agenda_item_id': 99, 'text_content': TEXT,
           'result': None, 'meta': {'manual_evidence': 'keep'}}
    before = deepcopy(old)
    plan = plan_meeting(context['meeting'], [old], [], context['source'])
    assert plan['new_motions'] == []
    assert old == before
    assert plan['stored_outcome_unknown_ids'] == [309]
    assert plan['coverage'] == 'source_occurrences_accounted_for'


def test_truncated_legacy_claim_blocks_duplicate_insertion(tmp_path):
    context = official_context(tmp_path)
    old = {'id': 309, 'meeting_id': 77, 'agenda_item_id': 99,
           'text_content': 'THAT Council adopt a tree bylaw [conditions omitted].', 'meta': {}}
    plan = plan_meeting(context['meeting'], [old], [], context['source'])
    assert plan['new_motions'] == []
    assert plan['coverage'] == 'review_required'
    assert plan['source_report']['unmapped_legacy_ids'] == [309]


@pytest.mark.parametrize('meeting_date',['2025-01-01','2026-01-07','2026-01-09'])
def test_source_date_mismatch_cannot_be_reported_complete(tmp_path,meeting_date):
    context = official_context(tmp_path)
    meeting = {**context['meeting'], 'meeting_date': meeting_date}
    source_date = context['source']['local_date']
    plan = plan_meeting(meeting, [], [], context['source'])
    assert plan['coverage'] == 'source_validation_held'
    assert plan['new_motions'] == []
    assert meeting['meeting_date'] == meeting_date
    assert context['source']['local_date'] == source_date


def test_receipt_digest_stable_across_serialized_key_order():
    assert digest({'a': 1, 'b': [2]}) == digest({'b': [2], 'a': 1})
