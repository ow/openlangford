import pytest

from pipeline.backfill.committee_vote_writes import ballot_meta, planned_ballots


def _motion(key, ballot):
    return {'meta': {'canonical_source_motion': {'key': key, 'source_file': 'm.pdf', 'source_url': 'u'}},
            **({'committee_votes': ballot} if ballot is not None else {})}


def _ballot(basis, status='reconstructable_candidate'):
    return {'status': status, 'inference_basis': basis, 'votes': [
        {'person_id': 1, 'person_name': 'A', 'vote': 'Yes', 'evidence': 'inferred_official_dissent_recording_rule'}]}


def test_only_validated_reconstructable_ballots_are_written_on_their_inserted_rows():
    manifest = {'meetings': [{'meeting_id': 5, 'new_motions': [
        _motion('a', _ballot('bylaw_1971_dissent_recording_deemed_affirmative')),
        _motion('b', {'status': 'held', 'reason': 'pre_bylaw_1971_committee_recording_rule_not_verified'}),
        _motion('c', _ballot('something_unvalidated')),
        _motion('d', None),
        _motion('e', _ballot('recorded_unanimous_result'))]}]}
    receipt = {'meetings': [{'meeting_id': 5, 'inserted_ids': [101, 102, 103, 104, 105]}]}
    planned = planned_ballots(manifest, receipt)
    assert [(p['motion_id'], p['source_key']) for p in planned] == [(101, 'a'), (105, 'e')]
    meta = ballot_meta(planned[0])
    assert meta['basis'] == 'bylaw_1971_dissent_recording_deemed_affirmative' and meta['voting_body'] == 'committee'
    assert meta['choice_provenance'] == {'person_1': 'inferred_official_dissent_recording_rule'}


def test_receipt_and_manifest_must_agree():
    manifest = {'meetings': [{'meeting_id': 5, 'new_motions': [_motion('a', _ballot('recorded_unanimous_result'))]}]}
    with pytest.raises(ValueError):
        planned_ballots(manifest, {'meetings': [{'meeting_id': 5, 'inserted_ids': []}]})
