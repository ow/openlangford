"""Per-member committee votes from a meeting's confirmed roster (meetings.meta.committee_roster).

Who could vote is the roster built from that meeting's own minutes (stage committee-membership): the voting members
recorded present, each tied to a person. How their votes are recorded is Langford's procedure bylaw:

- From October 18, 2021, Council Procedure Bylaw No. 1971 governs "Council, COTW, Commissions, and Committees"
  (s.4). Minutes name any dissenters when a motion is not unanimous (s.44), every member present must vote unless
  conflicted, and a member who doesn't indicate a vote is deemed to have voted in favour (s.60(i)-(j)). So the
  members present at the vote voted Yes except those the minutes name as opposed.
- Before that date the committees ran under Procedure Bylaw No. 819 (2004), whose recording rule hasn't been
  verified here. Only what the minutes state outright is recorded: a result carried unanimously, or a roll call
  naming every member present.

Quorum and chair rules come from each committee's terms of reference, which vary and aren't all documented here;
nothing is inferred from them (the recorded outcome is the clerk's). Everything uncertain holds: an unparsed arrival
or departure, a name in a vote declaration that isn't a present voting member, a special voting threshold, or a
tally that contradicts the recorded result. A held motion keeps its recorded outcome with no per-member votes.
"""
from __future__ import annotations

from .ballot_reconstruction import physical_presence_events, validate_roster_entries, voters_before_vote
from .vote_evidence import named_vote_declarations, outcome_family, special_voting_threshold

BYLAW_1971_FROM = '2021-10-18'
BYLAW_1971 = {'bylaw': 'Council Procedure Bylaw No. 1971, 2021', 'adopted': BYLAW_1971_FROM,
              'sections': {'4': 'governs Council, COTW, Commissions, and Committees',
                           '44': 'where a motion is not unanimous, the minutes record the name(s) of any dissenters',
                           '60(i)-(j)': 'all members present must vote unless conflicted; members who do not indicate '
                                        'how they voted are deemed to have voted in favour'},
              'source': 'https://langford.ca/wp-content/uploads/2023/04/Procedure-Bylaw-No.-1971-Consolidated-to-20240509.pdf'}


def roster_voters(roster: dict, names: dict[int, str]) -> list[dict] | None:
    """The voting members the roster records present, as people ({id, name}); None if one has no person record."""
    present = [m for m in roster.get('members') or [] if m.get('voting') and m.get('attendance') == 'present']
    if any(m.get('person_id') not in names for m in present):
        return None
    return [{'id': m['person_id'], 'name': names[m['person_id']]} for m in present]


def committee_roster_votes(block: dict, source_text: str, roster: dict, day: str, names: dict[int, str]) -> dict:
    """names: person id -> the person's recorded name."""
    """Votes for one recorded committee motion, or a hold with its reason."""
    def hold(reason, **details):
        return {'status': 'held', 'reason': reason, **details}
    if (roster or {}).get('status') != 'votes_recordable':
        return hold('roster_not_votes_recordable', roster_status=(roster or {}).get('status'))
    family = outcome_family(block['result'])
    if family not in ('passed', 'failed'):
        return hold('not_a_yes_no_decision')
    if special_voting_threshold(block['motion_text']):
        return hold('special_voting_threshold_needs_validation')
    voters = roster_voters(roster, names)
    if voters is None:
        return hold('present_voting_member_without_person_record')
    if not voters:
        return hold('no_identified_voting_members')
    at = source_text.find(block['source_block'], max(0, block['source_offset'] - 5))
    if at < 0:
        return hold('source_offset_unknown')
    cutoff = at + block['source_block'].find(block['outcome_quote'])
    events, unparsed = physical_presence_events(source_text, voters)
    if [e for e in unparsed if e['offset'] < cutoff or e.get('initial_state_unknown')]:
        return hold('unparsed_presence_event')
    present, adjustments = voters_before_vote({v['id'] for v in voters}, events, cutoff)
    if present is None:
        return hold('initial_presence_unknown')
    eligible = [v for v in voters if v['id'] in present]
    named = {}
    for declaration in named_vote_declarations(block):
        if declaration.get('unparsed'):
            return hold('unparsed_source_choice_declaration', source_quote=declaration['source_quote'])
        resolved, unknown = validate_roster_entries(declaration['names'], eligible)
        if unknown or not resolved:
            return hold('vote_declaration_names_not_present_voting_members', unknown=unknown or [declaration['names']])
        if declaration.get('declared_count') is not None and declaration['declared_count'] != len(resolved):
            return hold('explicit_rollcall_count_mismatch')
        for person in resolved:
            if declaration['vote'] not in ('Yes', 'No'):
                return hold('special_vote_or_recusal_needs_scope')
            if person['id'] in named and named[person['id']]['vote'] != declaration['vote']:
                return hold('conflicting_named_source_choices')
            named[person['id']] = {'vote': declaration['vote'], 'source_quote': declaration['source_quote']}
    unanimous = 'UNANIMOUS' in block['result'].upper()
    if unanimous and any(v['vote'] != 'Yes' for v in named.values()):
        return hold('unanimous_result_conflicts_with_named_choice')
    complete = set(named) == present
    if unanimous:
        basis = 'recorded_unanimous_result'
    elif complete:
        basis = 'every_present_voter_explicitly_named'
    elif day >= BYLAW_1971_FROM:
        basis = 'bylaw_1971_dissent_recording_deemed_affirmative'
    else:
        return hold('pre_bylaw_1971_committee_recording_rule_not_verified')
    by_id = {v['id']: v for v in eligible}
    votes = [{'person_id': pid, 'person_name': by_id[pid]['name'],
              'vote': named.get(pid, {}).get('vote', 'Yes'),
              'source_quote': named.get(pid, {}).get('source_quote', block['outcome_quote']),
              'evidence': 'explicit_named' if pid in named else
                          'inferred_explicit_unanimity' if unanimous else 'inferred_official_dissent_recording_rule'}
             for pid in sorted(present)]
    yes = sum(v['vote'] == 'Yes' for v in votes)
    no = len(votes) - yes
    if (family == 'passed') != (yes > no):
        return hold('reconstructed_tally_conflicts_with_outcome', yes=yes, no=no)
    return {'status': 'reconstructable_candidate', 'votes': votes, 'yes': yes, 'no': no, 'inference_basis': basis,
            'recording_rule': BYLAW_1971 if basis == 'bylaw_1971_dissent_recording_deemed_affirmative' else None,
            'roster_quote': roster.get('quote'), 'presence_adjustments': adjustments,
            'outcome_role': 'committee_recommendation'}
