"""Per-member committee votes from a confirmed roster, under Procedure Bylaw 1971."""
from pipeline.ingestion.committee_roster_ballots import committee_roster_votes
from pipeline.ingestion.vote_evidence import minutes_motion_blocks

NAMES = {1: 'Denise Blackwell', 2: 'Roger Wade', 3: 'Cheryl Brown', 4: 'Art Creuzot'}
ROSTER = {'status': 'votes_recordable', 'members': [
    {'person_id': 1, 'voting': True, 'attendance': 'present'},
    {'person_id': 2, 'voting': True, 'attendance': 'present'},
    {'person_id': 3, 'voting': True, 'attendance': 'present'},
    {'person_id': 4, 'voting': True, 'attendance': 'absent'}]}

MINUTES = """MOVED BY: Councillor Wade
SECONDED: C. Brown

THAT the Committee recommend that Council approve the application.

Opposed: Councillor Blackwell

Motion CARRIED.
"""


def _block(text=MINUTES):
    return list(minutes_motion_blocks(text))[0]


def test_bylaw_1971_records_dissent_and_deems_the_rest_yes():
    result = committee_roster_votes(_block(), MINUTES, ROSTER, '2022-03-14', NAMES)
    assert result['status'] == 'reconstructable_candidate'
    assert {v['person_name']: v['vote'] for v in result['votes']} == {
        'Denise Blackwell': 'No', 'Roger Wade': 'Yes', 'Cheryl Brown': 'Yes'}
    assert result['inference_basis'] == 'bylaw_1971_dissent_recording_deemed_affirmative'


def test_before_bylaw_1971_only_explicit_records_count():
    result = committee_roster_votes(_block(), MINUTES, ROSTER, '2019-03-11', NAMES)
    assert result == {'status': 'held', 'reason': 'pre_bylaw_1971_committee_recording_rule_not_verified'}
    unanimous = MINUTES.replace('Opposed: Councillor Blackwell\n\n', '').replace('Motion CARRIED.', 'CARRIED UNANIMOUSLY')
    result = committee_roster_votes(_block(unanimous), unanimous, ROSTER, '2019-03-11', NAMES)
    assert result['status'] == 'reconstructable_candidate' and result['yes'] == 3


def test_a_present_member_without_a_person_record_holds():
    roster = {**ROSTER, 'members': ROSTER['members'] + [{'person_id': 99, 'voting': True, 'attendance': 'present'}]}
    assert committee_roster_votes(_block(), MINUTES, roster, '2022-03-14', NAMES)['reason'] == 'present_voting_member_without_person_record'


def test_roster_not_confirmed_holds():
    assert committee_roster_votes(_block(), MINUTES, {'status': 'held_for_review'}, '2022-03-14', NAMES)['status'] == 'held'
