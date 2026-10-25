"""Original formal occurrences own ballots; repeated headings do not."""
from copy import deepcopy
import json
from pathlib import Path
import shutil
import pytest
from pipeline.ingestion.official_ballots import load_official_minutes
from pipeline.ingestion.meeting_ballots import evaluate_ballot, merge_ballot_evidence
from pipeline.ingestion.canonical_motions import canonical_motion_plan, source_identity, normalize_text
from ingestion.ballot_fixture import POLICY

ROOT=Path(__file__).resolve().parents[4]
FIXTURE=ROOT/'apps/pipeline/tests/fixtures/source-occurrences'
DATA=json.loads((FIXTURE/'cases.json').read_bytes())


def context_for(tmp_path, meeting_id):
    meeting=deepcopy(DATA['meetings'][str(meeting_id)])
    people=DATA['people']
    members=[{'person_id':p['id'],'name':p['name'],'organization_id':1,'classification':'Council','role':'Mayor'if p['id']==1 else'Councillor','start_date':'2022-11-07','end_date':None}for p in people]
    source=load_official_minutes(meeting,root=ROOT,people=people,cache_dir=tmp_path/'cache')
    return {'status':'available','meeting':meeting,'source':source,'people':people,'memberships':members,
            'policy':{**POLICY,'committee_of_the_whole_scope':{'basis':'Council sitting as Committee of the Whole; Procedure Bylaw sections4/56'}}}


@pytest.mark.skipif(not shutil.which('pdftotext'),reason='Original formal ownership requires Poppler')
@pytest.mark.parametrize('case',['legacy_first','legacy_second','bound_second','heading_repeat','resumed_main','indented_resumed_main','omitted_resumed_anchor'])
def test_original_formal_envelope_owns_ballot_not_duplicate_words(tmp_path,case):
    mid=289 if case=='heading_repeat'else 20 if case=='resumed_main'else 167 if case in ('indented_resumed_main','omitted_resumed_anchor')else 348
    context=context_for(tmp_path,mid)
    motion=deepcopy(DATA['motions'][str(2912 if case=='heading_repeat'else 1791 if case=='resumed_main'else 1767 if mid==167 else 3457 if case=='legacy_first'else 3459)])
    if case=='bound_second':
        block=next(b for b in context['source']['blocks']if normalize_text(b['motion_text'])==normalize_text(motion['text_content']))
        # A real persisted canonical identity is re-proved against its original
        # complete envelope, not trusted because it supplies a matching key.
        motion['meta']={'canonical_source_motion':source_identity(mid,context['source'],block)}
    if case=='omitted_resumed_anchor':
        block=next(b for b in context['source']['blocks']if b.get('formal_source_kind')=='resumed_main_motion')
        block['source_block']=block['source_block'].split('\n',1)[1].lstrip()
    original=deepcopy(context['source'])
    result=evaluate_ballot(motion,context)
    assert all(context['source'][key]==original[key]for key in ('text','roster_quote','blocks','operative_views'))
    if case=='omitted_resumed_anchor':
        assert result['status']=='source_motion_not_exact_or_ambiguous'
        assert not result.get('votes')
        assert result['source_occurrence_hold'][0]['matching_formal_envelopes']==1
        assert result['source_occurrence_hold'][0]['own_formal_envelopes']==0
    elif case.startswith('legacy_'):
        assert result['status']=='source_motion_not_exact_or_ambiguous'
        assert not result.get('votes')
        assert result['source_occurrence_hold'][0]['matching_formal_envelopes']==2
        choices,metadata=merge_ballot_evidence(motion,[],context)
        assert not choices
        assert metadata['individual_vote_coverage']!='reconstructed_complete'
    else:
        assert result['status']=='reconstructable_candidate'
        expected={1:'Yes',20:'Yes',21:'Yes',22:'Yes',23:'Yes',34:'Yes',35:'Yes'}
        if case=='resumed_main':expected.update({22:'No',23:'No',35:'No'})
        assert {v['person_id']:v['vote']for v in result['votes']}==expected
        if case=='heading_repeat':
            assert result['operative_motion_body']['status']=='native_body_not_uniquely_bound_held'
        elif case in ('resumed_main','indented_resumed_main'):
            assert result['proof']['source_occurrence_validation']['envelope']['kind']=='resumed_main_motion'
        else:
            assert result['proof']['source_occurrence_validation']['method']=='current_bound_original_formal_envelope'
            assert result['proof']['source_motion_identity']['key']==motion['meta']['canonical_source_motion']['key']


@pytest.mark.skipif(not shutil.which('pdftotext'),reason='Original formal coverage requires Poppler')
def test_recovered_ocr_introduction_does_not_resolve_duplicate_legacy_ownership(tmp_path):
    context=context_for(tmp_path,348)
    legacy=[deepcopy(DATA['motions'][str(mid)])for mid in (3457,3459)]
    items,report=canonical_motion_plan([],context,legacy)
    assert report['formal_source_coverage']=='all_formal_envelopes_accounted_for'
    assert not report.get('unparsed_formal_occurrence_leads')
    recovered=[block for block in context['source']['blocks']if 'iVIOVED BY: HARDER'in block['source_block'].split(block['motion_text'],1)[0]]
    assert len(recovered)==1
    assert recovered[0]['motion_text']=='THATthe Committee of the Whole receive this report for information.'
    assert any(row['reason']=='original_formal_occurrence_not_unique'for row in report['held'])
    assert all(normalize_text(m['motion_text'])!=normalize_text(DATA['motions']['3459']['text_content'])for item in items for m in item['motions'])


CLERK_MAIN_RESULT = 'The vote was taken on the Main Motion as amended and declared CARRIED.'


@pytest.mark.parametrize('sentence',[CLERK_MAIN_RESULT,
    CLERK_MAIN_RESULT.replace('Main Motion','Main\nMotion'),
    CLERK_MAIN_RESULT.replace('CARRIED','DEFEATED')])
def test_explicit_clerk_main_result_remains_a_held_coverage_gap_not_a_new_motion(tmp_path,sentence):
    """A parsed amendment's trailing context must not swallow the main result."""
    from ingestion.ballot_fixture import official_context, TEXT
    from pipeline.ingestion.source_claims import build_claim_inventory
    context=official_context(tmp_path,opposition=sentence)
    context['meeting_claim_inventory']=build_claim_inventory([],meeting_id=77,expected_count=0)
    before=deepcopy(context['source'])
    identities=[source_identity(77,context['source'],b) for b in context['source']['blocks']]
    items,report=canonical_motion_plan([],context,[])
    assert report['formal_source_coverage']=='partial_unparsed_formal_occurrences'
    leads=report['unparsed_formal_occurrence_leads']
    assert len(leads)==1 and leads[0]['kind']=='explicit_clerk_main_motion_result_lead'
    assert leads[0]['source_quote']==sentence
    assert leads[0]['authority']=='coverage_diagnostic_only'
    assert not any(key in leads[0] for key in ('body','motion_text','source_key','votes'))
    start=leads[0]['source_start'];end=leads[0]['outcome_end']
    assert context['source']['text'][start:end]==sentence
    assert leads[0]['source_sha256']==context['source']['source_sha256']
    assert [m['motion_text'] for item in items for m in item['motions']]==[TEXT]
    assert report['source_motions']==1
    assert context['source']==before
    assert [source_identity(77,context['source'],b) for b in context['source']['blocks']]==identities


@pytest.mark.parametrize('paragraph',[
    'The report states that the vote was taken on the Main Motion as amended and declared CARRIED.',
    '“'+CLERK_MAIN_RESULT+'”',
    'If the vote was taken on the Main Motion as amended and declared CARRIED.',
    'The vote was not taken on the Main Motion as amended and declared CARRIED.',
    'The vote was taken on the Main Motion as amended and may be declared CARRIED.',
    CLERK_MAIN_RESULT+' This describes last year’s proceeding.',
])
def test_background_quoted_or_conditional_prose_is_not_an_explicit_clerk_result(tmp_path,paragraph):
    from ingestion.ballot_fixture import official_context
    context=official_context(tmp_path,opposition=paragraph)
    _,report=canonical_motion_plan([],context,[])
    assert report['formal_source_coverage']=='all_formal_envelopes_accounted_for'
    assert report['unparsed_formal_occurrence_leads']==[]


def test_clerk_result_dedup_uses_actual_parsed_outcome_span_not_post_outcome_context(tmp_path):
    from ingestion.ballot_fixture import official_context
    from pipeline.ingestion.source_occurrences import unparsed_formal_envelopes
    source=official_context(tmp_path,opposition=CLERK_MAIN_RESULT)['source']
    # In the present parser this sentence is post-amendment context: it must
    # remain a lead even though it is included in that amendment's source_block.
    assert any(x['kind']=='explicit_clerk_main_motion_result_lead' for x in unparsed_formal_envelopes(source))
    # A future/native parser may explicitly account that exact result span.
    # Supply a distinct parsed block bounded at the actual sentence, not an
    # existing amendment block's earlier outcome, and require no duplicate lead.
    start=source['text'].index(CLERK_MAIN_RESULT)
    source['blocks'].append({'source_offset':start,'source_order':1,'source_block':CLERK_MAIN_RESULT,
        'motion_text':'Explicitly preserved main body','outcome_quote':CLERK_MAIN_RESULT,'result':'CARRIED',
        'formal_source_kind':'resumed_main_motion'})
    assert not any(x.get('kind')=='explicit_clerk_main_motion_result_lead' for x in unparsed_formal_envelopes(source))
    source['blocks'][-1]['source_offset']=0
    assert any(x.get('kind')=='explicit_clerk_main_motion_result_lead' for x in unparsed_formal_envelopes(source))


PARKS_APPOINTMENT = ('That Council re-appoint Councillor Roger Wade to the West Shore Parks and Recreation Board '
    'and Councillor Norma Stewart as alternate for a one-year term.')
LIBRARY_APPOINTMENT = ('That Council re-appoint Councillor Matt Sahlstrom to the Greater Victoria Library Board '
    'and Councillor Norma Stewart as alternate for a one-year term.')


def diagnostic_pdf_context(tmp_path, passage, *, continuation=None):
    """Actual PDF -> official loader; no mocked formal inventory or parser."""
    import fitz
    import textwrap
    from ingestion.ballot_fixture import official_context,PEOPLE
    context=official_context(tmp_path)
    path=tmp_path/'archive/meeting/Minutes/Minutes - SIGNED.pdf'
    with fitz.open() as pdf:
        page=pdf.new_page()
        header='City of Langford\nCouncil Minutes\nJanuary 8, 2026\nPRESENT:\nMayor S. Goodmanson\nCouncillor C. Harder\nCouncillor K. Guiry\nATTENDING:\nStaff\n'
        page.insert_text((30,40),'\n'.join(textwrap.fill(line,width=90) if line else '' for line in (header+passage).splitlines()),fontsize=9)
        if continuation:
            page=pdf.new_page();page.insert_text((30,100),continuation,fontsize=9)
        pdf.save(path)
    context['source']=load_official_minutes(context['meeting'],root=tmp_path,people=PEOPLE,cache_dir=tmp_path/'cache')
    assert not context['source'].get('error')
    return context


def test_seconded_body_without_separate_outcome_is_a_review_lead_not_a_new_decision(tmp_path):
    from pipeline.ingestion.source_claims import build_claim_inventory
    from pipeline.backfill.history_coverage import plan_meeting
    passage=('MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+PARKS_APPOINTMENT+'\n\n'
        'MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+LIBRARY_APPOINTMENT)
    context=diagnostic_pdf_context(tmp_path,passage,continuation='CARRIED.')
    source=context['source'];before=deepcopy(source)
    assert len(source['blocks'])==1 and source['blocks'][0]['source_order']==1
    block=source['blocks'][0];identity=source_identity(77,source,block)
    existing={'id':309,'meeting_id':77,'agenda_item_id':99,'text_content':block['motion_text'],
        'result':'CARRIED','meta':{'canonical_source_motion':deepcopy(identity),'manual_evidence':'keep'}}
    context['meeting_claim_inventory']=build_claim_inventory([existing],meeting_id=77,expected_count=1)
    existing_before=deepcopy(existing)
    items,report=canonical_motion_plan([],context,[existing])
    assert report['formal_source_coverage']=='partial_unparsed_formal_occurrences'
    leads=report['unparsed_formal_occurrence_leads']
    assert len(leads)==1 and leads[0]['kind']=='unresulted_formal_introduction_lead'
    lead=leads[0]
    assert lead['reason']=='no_separately_recorded_outcome' and lead['authority']=='coverage_diagnostic_only'
    assert source['text'][lead['source_start']:lead['source_end']]==lead['source_quote']
    assert source['text'][lead['next_formal_anchor_offset']:].lstrip().startswith('MOVED BY:')
    assert 'Roger Wade' in lead['source_quote'] and 'Library' not in lead['source_quote'] and 'CARRIED' not in lead['source_quote']
    assert lead['source_sha256']==source['source_sha256']
    assert not any(key in lead for key in ('body','body_view','motion_text','result','outcome_quote','source_key','votes'))
    motions=[m for item in items for m in item['motions']]
    assert len(motions)==1 and motions[0]['_canonical_source_motion']['key']==identity['key']
    assert motions[0]['result']=='CARRIED' and motions[0]['_existing_motion']['id']==309
    final=plan_meeting(context['meeting'],[existing],[],source)
    assert final['coverage']=='review_required' and final['new_motions']==[]
    assert source==before and existing==existing_before
    assert source_identity(77,source,source['blocks'][0])==identity


@pytest.mark.parametrize('passage',[
    PARKS_APPOINTMENT,
    'The report said someone moved the proposal and another person seconded it.',
    '"SECONDED: Kimberley Guiry"\n'+PARKS_APPOINTMENT,
    'MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\n',
    'MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+PARKS_APPOINTMENT+'\nCARRIED.',
    'MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+PARKS_APPOINTMENT+'\nDEFEATED.',
])
def test_unresulted_diagnostic_does_not_match_body_prose_or_already_recorded_results(tmp_path,passage):
    from pipeline.ingestion.source_occurrences import unparsed_formal_envelopes
    context=diagnostic_pdf_context(tmp_path,passage);before=deepcopy(context['source'])
    assert unparsed_formal_envelopes(context['source'])==[]
    assert context['source']==before


def test_unparsed_result_bearing_envelope_keeps_its_existing_lead_without_duplicate(tmp_path):
    from pipeline.ingestion.source_occurrences import unparsed_formal_envelopes,envelope_proof,formal_inventory
    context=diagnostic_pdf_context(tmp_path,'M0VED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+PARKS_APPOINTMENT+'\nCARRIED.')
    source=context['source'];before=deepcopy(source)
    assert source['blocks']==[]
    original=envelope_proof(source,formal_inventory(source)['envelopes'][0])
    assert unparsed_formal_envelopes(source)==[original]
    assert source==before


@pytest.mark.parametrize('next_header',['On the Main Motion as amended:',
    'Amendment:\nMOVED BY: Colby Harder\nSECONDED: Kimberley Guiry'])
def test_new_formal_or_resumed_anchor_never_lends_its_result_to_earlier_wording(tmp_path,next_header):
    from pipeline.ingestion.source_occurrences import unparsed_formal_envelopes
    passage=('MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+PARKS_APPOINTMENT+'\n\n'
        +next_header+'\n'+LIBRARY_APPOINTMENT+'\nCARRIED.')
    context=diagnostic_pdf_context(tmp_path,passage);source=context['source'];before=deepcopy(source)
    identities=[source_identity(77,source,b) for b in source['blocks']]
    leads=unparsed_formal_envelopes(source)
    assert len(leads)==1 and leads[0]['kind']=='unresulted_formal_introduction_lead'
    assert 'Roger Wade' in leads[0]['source_quote'] and 'Library' not in leads[0]['source_quote'] and 'CARRIED' not in leads[0]['source_quote']
    assert len(source['blocks'])==1 and source['blocks'][0]['source_order']==1 and source['blocks'][0]['result']=='CARRIED'
    assert source==before and [source_identity(77,source,b) for b in source['blocks']]==identities
