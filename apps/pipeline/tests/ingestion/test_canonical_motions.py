"""Source inventory and identity continuity at the ordinary-ingest planner."""
from copy import deepcopy
from pathlib import Path

import pytest

from pipeline.ingestion.canonical_motions import canonical_motion_plan
from pipeline.ingestion.official_ballots import load_official_minutes
from ingestion.ballot_fixture import official_context, TEXT


@pytest.mark.parametrize('proposal', [None, 'THAT Council deny Bylaw No. 2269, 2026.'])
def test_official_motion_exists_even_when_model_omits_it_or_invents_another(tmp_path, proposal):
    context = official_context(tmp_path)
    proposals = [] if proposal is None else [{'motion_text': proposal, 'result': 'DEFEATED'}]
    items, report = canonical_motion_plan([{'title': 'Model agenda', 'item_order': '1', 'motions': proposals}], context, [])
    motions = [motion for item in items for motion in item['motions']]
    assert [(motion['motion_text'], motion['result']) for motion in motions] == [(TEXT, 'CARRIED')]
    assert report['mapped_motions'] == report['source_motions'] == 1
    assert report['held'] == []
    assert items[0]['_unverified_motion_proposals'] == proposals


@pytest.mark.parametrize('source_body_changed', [False, True])
def test_replaced_source_reuses_exact_legacy_id_or_holds_without_duplicate(tmp_path, source_body_changed):
    context = official_context(tmp_path)
    items, _ = canonical_motion_plan([], context, [])
    original = items[0]['motions'][0]
    legacy = {'id': 309, 'agenda_item_id': 99, 'text_content': TEXT, 'meta': {'canonical_source_motion': original['_canonical_source_motion']}}
    revision = deepcopy(context)
    path = tmp_path / context['source']['source_file']
    html = path.read_text()
    path.write_text(html.replace('2269', '2270') if source_body_changed else html+'<!-- publisher revision -->')
    revision['source'] = load_official_minutes(context['meeting'], root=tmp_path, people=context['people'], cache_dir=tmp_path/'cache')
    items, report = canonical_motion_plan([], revision, [legacy])
    motions = [motion for item in items for motion in item['motions']]
    if source_body_changed:
        assert motions == []
        assert report['held'][0]['reason'] == 'unmapped_legacy_records'
        assert report['unmapped_legacy_ids'] == [309]
    else:
        assert len(motions) == 1
        assert motions[0]['_existing_motion']['id'] == 309
        identity = motions[0]['_canonical_source_motion']
        assert identity['key'] != original['_canonical_source_motion']['key']
        assert identity['previous_keys'] == [original['_canonical_source_motion']['key']]
        assert report['held'] == []


def test_ordinary_committee_source_context_routes_cac_and_retains_membership_proofs(tmp_path):
    from unittest.mock import MagicMock, patch
    from ingestion.test_committee_ballots import context, PEOPLE, MEMBERS, POLICY
    from pipeline.ingestion.meeting_ballots import prepare_ballot_context, evaluate_ballot
    motion, source, meeting = context(tmp_path)
    # Actual catalog title is generic despite the original CAC heading.
    assert meeting['title'] == 'Advisory Committee'
    client = MagicMock()
    values = {'municipalities':{'slug':'langford'}, 'organizations':[{'id':10}],
              'memberships':[{**member, 'person':{'name':member['name']}} for member in MEMBERS], 'people':PEOPLE}
    tables = {}
    for name, value in values.items():
        table = MagicMock()
        for method in ('select','eq','in_','maybe_single','order','range'):
            getattr(table, method).return_value = table
        table.execute.return_value = MagicMock(data=value)
        tables[name] = table
    client.table.side_effect = tables.__getitem__
    fixtures = Path(__file__).parents[1]/'fixtures'
    http = MagicMock()
    http.get.side_effect = [MagicMock(content=(fixtures/'langford-cac-policy-2024.pdf').read_bytes()), MagicMock(content=(fixtures/'langford-cac-appointments-section.html').read_bytes())]
    with patch('pipeline.ingestion.meeting_ballots.refresh_vote_policy', return_value={**POLICY,'rule_id':'validated-cac-policy'}), patch('pipeline.ingestion.committee_ballots.requests.Session', return_value=http):
        prepared = prepare_ballot_context(client, municipality_id=2, meeting=meeting, root=tmp_path)
    assert prepared['status'] == 'available'
    items, report = canonical_motion_plan([], prepared, [])
    assert report['mapped_motions'] == 1
    assert items[0]['motions'][0]['motion_text'] == motion['text_content']
    ballot = evaluate_ballot(motion, prepared)
    assert ballot['status'] == 'reconstructable_candidate'
    proof = ballot['proof']
    assert proof['voting_body'] == 'community_advisory_committee'
    assert proof['outcome_role'] == 'committee_guidance_or_recommendation'
    assert len(proof['member_observations']) == 8
    assert proof['committee_quorum_minimum_appointees'] == 5
    assert proof['committee_chair_person_ids'] == [1,2]
    assert 'excluded_nonvoting_attendees' in proof
    assert proof['committee_policy_validation']['status']=='verified_unchanged'
    assert proof['committee_policy_validation']['identity_section_sha256']


@pytest.mark.parametrize('actor,expected', [('Colby Harder',21),('Keith Harder',None)])
def test_source_actor_needs_full_native_roster_identity_not_surname_only(tmp_path,actor,expected):
    context = official_context(tmp_path)
    path = tmp_path/context['source']['source_file']
    path.write_text(path.read_text().replace('Colby Harder</div></div><div class="SecondedBy">',actor+'</div></div><div class="SecondedBy">'))
    context['source'] = load_official_minutes(context['meeting'],root=tmp_path,people=context['people'],cache_dir=tmp_path/'cache')
    items, report = canonical_motion_plan([],context,[])
    assert report['mapped_motions']==1
    assert items[0]['motions'][0]['_canonical_actor_ids']['mover']==expected


@pytest.mark.parametrize('identity_case', ['valid', 'missing', 'stale_binary', 'wrong_offset', 'wrong_order', 'forged_key', 'wrong_meeting', 'wrong_raw_body'])
def test_repeated_native_words_keep_distinct_motion_ids_and_their_own_ballots(tmp_path, identity_case):
    """Identical motions with different recorded dissent cannot share a ballot."""
    import hashlib
    import json
    from pipeline.ingestion.meeting_ballots import evaluate_ballot
    context = official_context(tmp_path, opposition='Councillor Goodmanson opposed.')
    path = tmp_path/context['source']['source_file']
    html = path.read_text()
    start = html.index('<div class="AgendaItemMotion">')
    stop = html.index('</div></div></div>', start)+len('</div></div>')
    node = html[start:stop]
    path.write_text(html[:stop]+node.replace('Councillor Goodmanson opposed.', 'Councillor Guiry opposed.')+html[stop:])
    context['source'] = load_official_minutes(context['meeting'], root=tmp_path, people=context['people'], cache_dir=tmp_path/'cache')
    blocks = context['source']['blocks']
    assert len(blocks) == 2
    old = []
    for index, block in enumerate(blocks):
        identity = {'meeting_id':77, 'source_sha256':context['source']['source_sha256'], 'source_offset':block['source_offset'], 'source_order':block['source_order']}
        identity['key'] = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        identity['raw_motion_text'] = block['motion_text']
        identity.update(source_url='https://unverified.invalid', source_block='unverified stored block', outcome_quote='unverified stored result')
        if identity_case == 'stale_binary': identity['source_sha256'] = 'old-binary'
        if identity_case == 'wrong_offset': identity['source_offset'] += 1
        if identity_case == 'wrong_order': identity['source_order'] += 1
        if identity_case == 'forged_key': identity['key'] = 'forged'
        if identity_case == 'wrong_meeting': identity['meeting_id'] = 78
        if identity_case == 'wrong_raw_body': identity['raw_motion_text'] = TEXT.replace('adopt', 'deny')
        old.append({'id':309+index, 'meeting_id':77, 'agenda_item_id':99+index, 'text_content':TEXT, 'result':'CARRIED', 'meta':{} if identity_case == 'missing' else {'canonical_source_motion':identity}})
    items, report = canonical_motion_plan([], context, old)
    mapped = [motion for item in items for motion in item['motions']]
    if identity_case != 'valid':
        assert mapped == []
        for motion in old:
            assert evaluate_ballot(motion, context)['status'] == 'source_motion_not_exact_or_ambiguous'
        return
    assert [motion['_existing_motion']['id'] for motion in mapped] == [309,310]
    assert report['unmapped_legacy_ids'] == []
    for index, motion in enumerate(old):
        ballot = evaluate_ballot(motion, context)
        assert ballot['status'] == 'reconstructable_candidate'
        assert {choice['person_id'] for choice in ballot['votes'] if choice['vote'] == 'No'} == [{1},{23}][index]
        assert ballot['proof']['source_motion_identity']['key'] == motion['meta']['canonical_source_motion']['key']
        assert ballot['proof']['source_motion_identity']['source_url'] == context['source']['source_url']
        assert ballot['proof']['source_motion_identity']['source_block'] == blocks[index]['source_block']
        assert ballot['proof']['source_motion_identity']['outcome_quote'] == blocks[index]['outcome_quote']
    # A partial first ingestion may retry the other source occurrence as a NEW
    # row, but must never reuse the already bound row's primary key.
    items, report = canonical_motion_plan([], context, old[:1])
    retried = [motion for item in items for motion in item['motions']]
    assert [(motion['_existing_motion'] or {}).get('id') for motion in retried] == [309,None]
    assert report['held'] == []
    retry_ballot = evaluate_ballot({'id':None, 'meeting_id':77, 'text_content':retried[1]['motion_text'], 'result':'CARRIED', 'meta':{'canonical_source_motion':retried[1]['_canonical_source_motion']}}, context)
    assert {v['person_id'] for v in retry_ballot['votes'] if v['vote']=='No'} == {23}
    mixed = [old[0], {**old[1], 'meta':{}}]
    items, report = canonical_motion_plan([], context, mixed)
    assert [(motion['_existing_motion'] or {}).get('id') for item in items for motion in item['motions']] == [309]
    assert len(report['held']) == 1

    # A new meeting has no legacy identities to guess: its two native keys
    # create two records, with full source evidence before either has a DB ID.
    items, report = canonical_motion_plan([], context, [])
    fresh = [motion for item in items for motion in item['motions']]
    assert len(fresh) == 2 and report['held'] == []
    assert len({motion['_canonical_source_motion']['key'] for motion in fresh}) == 2
    for index, native in enumerate(fresh):
        new = {'id':None, 'meeting_id':77, 'text_content':native['motion_text'], 'result':native['result'], 'meta':{'canonical_source_motion':native['_canonical_source_motion']}}
        ballot = evaluate_ballot(new, context)
        assert ballot['status'] == 'reconstructable_candidate'
        assert {choice['person_id'] for choice in ballot['votes'] if choice['vote']=='No'} == [{1},{23}][index]


@pytest.mark.parametrize('change', ['person', 'membership', 'policy', 'source_pdf', 'source_html', 'source_url', 'loaded_code', 'loaded_regex', 'loaded_roster_code', 'roster_receipt_added', 'roster_receipt_removed', 'roster_receipt_changed', 'derived_text', 'derived_date', 'derived_roster', 'derived_error', 'derived_ocr', 'catalog_org', 'volatile_only'])
def test_finished_source_cache_tracks_validation_evidence_not_unrelated_updates(tmp_path, monkeypatch, change):
    """The same chosen binary cannot hide changed selectors/rules/eligibility."""
    import re
    from pipeline.ingestion import vote_evidence, roster_ocr
    from pipeline.ingestion.canonical_motions import source_candidate_inventory, source_validation_inputs, source_receipt_current
    context = deepcopy(official_context(tmp_path))
    if change.startswith('roster_receipt_'):
        store = tmp_path/'reviewed-rosters'
        store.mkdir()
        (store/'index.json').write_text('{}')
        (store/'existing.json').write_text('{"review":"original"}')
        monkeypatch.setattr(roster_ocr, 'STORE', store)
    inventory = source_candidate_inventory(tmp_path, context['meeting']['archive_path'])
    baseline = source_validation_inputs(context, inventory)
    metadata = {'motion_source_ingestion': {'status':'source_authoritative',
        'source_file':context['source']['source_file'], 'source_sha256':context['source']['source_sha256'],
        'validation_inputs':baseline, 'ballot_validation':{'held':1}}}
    assert source_receipt_current(tmp_path, metadata, baseline)
    if change == 'person':
        context['people'][0]['name'] = 'Corrected Full Name'
    elif change == 'membership':
        context['memberships'][0]['end_date'] = '2025-12-31'
    elif change == 'policy':
        context['policy']['bylaw_sha256'] = 'changed-official-policy'
    elif change.startswith('source_'):
        minutes = tmp_path/context['meeting']['archive_path']/'Minutes'
        if change == 'source_pdf': (minutes/'Signed Minutes.pdf').write_bytes(b'new official source')
        elif change == 'source_html': (minutes/'Second Minutes.html').write_text('<html>other candidate</html>')
        else: (minutes/'Minutes.html.url').write_text('https://example.org/revised-source')
    elif change == 'derived_text':
        context['source']['text'] += '\nCouncillor Harder left the meeting at 8:00pm.'
    elif change == 'derived_date':
        context['source']['local_date'] = '2026-01-09'
    elif change == 'derived_roster':
        context['source']['roster_unknown'] = ['Unknown Councillor']
    elif change == 'derived_error':
        context['source']['error'] = 'header_ocr_unavailable'
    elif change == 'derived_ocr':
        context['source']['source_date_evidence'] = {'render_sha256':'new-pixel-proof', 'source_quote':'January 8, 2026'}
    elif change == 'catalog_org':
        context['meeting']['organization_id'] = 777
    elif change == 'loaded_code':
        def different_normalizer(text):
            return str(text).strip()
        monkeypatch.setattr(vote_evidence.normalize_text, '__code__', different_normalizer.__code__)
    elif change == 'loaded_regex':
        monkeypatch.setattr(vote_evidence, '_FORMAL_START', re.compile(r'new grammar'))
    elif change == 'loaded_roster_code':
        def changed_roster_rule(source, **kwargs):
            return source
        monkeypatch.setattr(roster_ocr.reviewed_roster_view, '__code__', changed_roster_rule.__code__)
    elif change == 'roster_receipt_added':
        (store/'new.json').write_text('{"review":"new"}')
    elif change == 'roster_receipt_removed':
        (store/'existing.json').unlink()
    elif change == 'roster_receipt_changed':
        (store/'existing.json').write_text('{"review":"revised"}')
    else:
        context['people'][0].update(avatar_url='new-photo', updated_at='tomorrow')
        context['memberships'][0]['updated_at'] = 'tomorrow'
        context['policy'].update(validated_as_of='2026-10-19', enabled_through='2026-10-19')
        context['meeting']['summary'] = 'New editorial text'
        # Non-source caches are not selector inputs.
        (tmp_path/context['meeting']['archive_path']/'Minutes'/'minutes.md').write_text('new cached extraction')
    current = source_validation_inputs(context, source_candidate_inventory(tmp_path, context['meeting']['archive_path']))
    assert source_receipt_current(tmp_path, metadata, current) is (change == 'volatile_only')


def test_old_worker_receipt_describes_loaded_code_even_when_python_file_is_replaced(tmp_path, monkeypatch):
    from pipeline.ingestion import ballot_reconstruction
    from pipeline.ingestion.canonical_motions import loaded_ballot_guard_digest
    baseline = loaded_ballot_guard_digest()
    newer_file = tmp_path/'new_ballot_reconstruction.py'
    newer_file.write_text('raise RuntimeError("new code requires worker restart")')
    monkeypatch.setattr(ballot_reconstruction, '__file__', str(newer_file))
    # The still-running worker is using its old imported executable objects.
    assert loaded_ballot_guard_digest() == baseline


def test_guard_is_stable_across_first_use_of_policy_helpers():
    """Meeting 967: a lazily filled upper-case cache changed the guard mid-ingest,
    so the final validation never matched the first one in a fresh worker."""
    from pipeline.ingestion import official_ballots
    from pipeline.ingestion.canonical_motions import loaded_ballot_guard_digest
    baseline = loaded_ballot_guard_digest()
    assert official_ballots.bylaw_819_rule()['rule_id'] == 'langford_819_recorded_dissent_deemed_affirmative'
    assert loaded_ballot_guard_digest() == baseline


@pytest.mark.parametrize('native_actor,expected_id', [('Colby Harder', 21), ('IVIORLEY', None)])
def test_recovered_native_header_cannot_erase_existing_actor(tmp_path, native_actor, expected_id):
    from pipeline.ingestion.vote_evidence import minutes_motion_blocks
    context = official_context(tmp_path)
    text = f"IVIOVEDBY: {native_actor}\nSECONDED BY: Kimberley Guiry\n{TEXT}\nCARRIED\n"
    context['source'].update(text=text, blocks=list(minutes_motion_blocks(text)), operative_views={})
    legacy = {'id':309, 'meeting_id':77, 'text_content':TEXT, 'mover_id':21, 'seconder_id':23, 'meta':{}}
    items, report = canonical_motion_plan([], context, [legacy])
    mapped = [motion for item in items for motion in item['motions']]
    if expected_id is None:
        assert mapped == []
        assert [hold['reason'] for hold in report['held']] == ['recovered_formal_header_actor_identity_unresolved']
    else:
        assert report['held'] == []
        assert mapped[0]['_canonical_actor_ids'] == {'mover':21, 'seconder':23}
