"""Disputed legacy closings remain unresolved while disjoint reviewed facts can proceed."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import subprocess
import textwrap

import fitz
import pytest

from ingestion.ballot_fixture import official_context, PEOPLE, TEXT
from pipeline.backfill import legacy_occurrence_reviews as legacy, reviewed_sources
from pipeline.backfill.history_coverage import plan_meeting, remaining_coverage
from pipeline.ingestion.canonical_motions import source_identity
from pipeline.ingestion.official_ballots import load_official_minutes, minutes_text_source
from pipeline.ingestion.source_claims import build_claim_inventory, digest, project_claim

AGENDA = 'That Council approve the agenda as presented.'
CLOSING = 'That the meeting be adjourned.'
NARRATION = 'Acting Mayor Stewart adjourned the meeting at 6:42 pm.'
FIRST, SECOND = 'a'*64, 'b'*64


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def row_sha(row):
    return sha(json.dumps(row,sort_keys=True,separators=(',',':'),ensure_ascii=False,default=str).encode())


@pytest.fixture
def case(tmp_path, monkeypatch, request):
    config=getattr(request,'param',{})
    context=official_context(tmp_path)
    context['meeting']=config.get('meeting',context['meeting'])
    path=tmp_path/'archive/meeting/Minutes/Minutes - SIGNED.pdf'
    extra=config.get('extra','')
    native_narration=config.get('native_narration',NARRATION)
    with fitz.open() as pdf:
        page=pdf.new_page()
        text=('City of Langford\nCouncil Minutes\nJanuary 8, 2026\nPRESENT:\nMayor S. Goodmanson\nCouncillor C. Harder\nCouncillor K. Guiry\nATTENDING:\nStaff\n'
            'MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+AGENDA+'\nCARRIED.\n'+extra+
            'MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+TEXT+'\nCARRIED.\nADJOURNMENT\n'+native_narration)
        page.insert_text((30,40),'\n'.join(textwrap.fill(line,85) for line in text.splitlines()),fontsize=10,
            render_mode=3 if config.get('native_correction') else 0)
        if config.get('native_correction'):
            # A correct visible page with a corrupt invisible OCR layer models
            # the actual signature/glyph problem, not a mocked proof validator.
            with fitz.open() as visible:
                image_page=visible.new_page()
                printed=text.replace(native_narration,NARRATION,1)
                image_page.insert_text((30,40),'\n'.join(textwrap.fill(line,85) for line in printed.splitlines()),fontsize=10)
                page.insert_image(page.rect,stream=image_page.get_pixmap(matrix=fitz.Matrix(2,2)).tobytes('png'))
        pdf.save(path)
    url='https://pub-langford.escribemeetings.com/FileStream.ashx?DocumentId=77'
    path.with_suffix('.pdf.url').write_text(url)
    source=load_official_minutes(context['meeting'],root=tmp_path,people=PEOPLE,cache_dir=tmp_path/'cache')
    with fitz.open(path) as pdf:
        native=pdf[0].get_text();page={'page':1,'native_text_sha256':sha(native.encode()),
            'render_sha256':sha(pdf[0].get_pixmap(matrix=fitz.Matrix(2,2)).tobytes('png'))}
    layout=subprocess.run(['pdftotext','-layout',str(path),'-'],check=True,capture_output=True,text=True).stdout
    corrected=layout
    if config.get('native_correction'):
        assert layout.count(native_narration)==1
        corrected=layout.replace(native_narration,NARRATION,1)
        source=minutes_text_source(context['meeting'],root=tmp_path,people=PEOPLE,cache_dir=tmp_path/'cache',
            path=path,text=corrected,source_format=source['source_format'],source_sha256=source['source_sha256'])
    rows=[{'id':100,'meeting_id':77,'agenda_item_id':99,'text_content':AGENDA,'result':'CARRIED','mover_id':21,'seconder_id':23,'meta':{}},
          {'id':309,'meeting_id':77,'agenda_item_id':100,'text_content':config.get('closing_text',CLOSING),'result':'CARRIED','mover_id':None,'seconder_id':None,
           'meta':{},'created_at':datetime(2026,1,8,tzinfo=timezone.utc)}]
    rows=config.get('rows',rows)
    inventory=build_claim_inventory(rows,meeting_id=77,expected_count=2)
    new=source['blocks'][-1];identity=source_identity(77,source,new)
    accepted={'source_key':identity['key'],'raw_block_sha256':digest(new),'operative_body':TEXT,'operative_body_sha256':sha(TEXT.encode()),
        'result':'CARRIED','pages':[1],'page_evidence':[page],'independent_review_sha256':FIRST,'authority':'operative_body_and_result_only'}
    cap={'type':'reviewed_unresolved_closing_conflict','authority':'duplicate_screening_only_no_fact_certification',
        'motion_id':309,'legacy_text':rows[1]['text_content'],'expected_stored_result':'CARRIED','claim_sha256':digest(project_claim(rows[1])),
        'claim_row_sha256':row_sha(rows[1]),'printed_body':NARRATION,**page,
        'source_passage':NARRATION,'source_passage_start':source['text'].index(NARRATION),
        'native_passage':native_narration,'native_passage_start':native.index(native_narration),
        'allowed_new_decisions':[deepcopy(accepted)],'first_review_sha256':FIRST,'independent_review_sha256':SECOND}
    admission={'schema':'reviewed-original-minutes-v1','project_ref':'test-project','municipality_id':1,'catalog':context['meeting'],
        'file_inventory':reviewed_sources.source_inventory(tmp_path,context['meeting']),'selected_file':source['source_file'],
        'source_sha256':source['source_sha256'],'source_url':url,'mode':'reviewed_native_image_decisions',
        'review_status':'independently_reviewed_original_source','render_scale':2,'pymupdf_version':fitz.VersionBind,
        'native_layout_sha256':sha(layout.encode()),'native_first_page_sha256':sha(native.encode()),'pages':[page],
        'text_corrections':[],'corrected_text_sha256':sha(corrected.encode()),'parsed_blocks_sha256':digest(source['blocks']),
        'independent_original_image_review_sha256':FIRST,'second_independent_original_image_review_sha256':SECOND,
        'accepted_decisions':[accepted],'closing_conflict_capabilities':[cap]}
    if config.get('native_correction'):
        correction={**page,'native_quote':native_narration,'printed_quote':NARRATION,
            'independent_review_sha256':FIRST,'authority':'reviewed_documentary_native_witness_correction_only'}
        cap['native_correction']=deepcopy(correction)
        admission['documentary_native_corrections']=[correction]
        admission['text_corrections']=[{'page':1,'native_quote':native_narration,'reviewed_quote':NARRATION,
            'authority':'original_image_text_correction_only'}]
    source=reviewed_sources.source_from_review(admission,meeting=context['meeting'],root=tmp_path,people=PEOPLE,
        cache_dir=tmp_path/'cache',project_ref='test-project',municipality_id=1)
    review={'schema':'reviewed-legacy-occurrence-reservations-v1','meeting_id':77,'project_ref':'test-project','municipality_id':1,
        'source_sha256':source['source_sha256'],'source_url':url,'source_file':source['source_file'],'source_date':source['local_date'],
        'source_text_sha256':sha(source['text'].encode()),'formal_inventory_sha256':digest(source['formal_occurrence_inventory']),
        'claim_inventory_sha256':inventory['fingerprint'],'native_pages':[],'reservations':[],
        'render_scale':2,'pymupdf_version':fitz.VersionBind,'independent_original_image_review_sha256':FIRST,
        'second_independent_original_image_review_sha256':SECOND,
        'closing_conflict_quarantines':[{'source_review_sha256':digest(admission),'capability':deepcopy(cap)}]}
    stores={}
    for module,name,obj in [(reviewed_sources,'source',admission),(legacy,'legacy',review)]:
        store=tmp_path/name;store.mkdir();p=store/'77.json';p.write_text(json.dumps(obj,sort_keys=True))
        monkeypatch.setattr(module,'STORE',store);monkeypatch.setattr(module,'ENROLLED',{77:sha(p.read_bytes())});stores[name]=p
    context.update(source=source,allow_reviewed_legacy_reservations=True,project_ref='test-project',municipality_id=1,archive_root=tmp_path,
        closing_linked_vote_counts={'authority':'operator_scoped_linked_vote_count_v1','meeting_id':77,'counts':[{'motion_id':309,'linked_votes':0}]})
    return context,rows,review,admission,stores


def plan(case):
    context,rows,*_=case
    return plan_meeting(context['meeting'],rows,[],context['source'],review_scope={k:context[k] for k in
        ('allow_reviewed_legacy_reservations','project_ref','municipality_id','archive_root','closing_linked_vote_counts') if k in context})


@pytest.mark.parametrize('case',[{},
    {'closing_text':'That the Council adjourn the meeting.'},
    {'native_narration':'Acting Mayor Stewart adjou ed the meeting at 6:42 pm.','native_correction':True},
    {'native_narration':'Acting Mayor Stewart a\nurned the meeting at 6:42 pm.','native_correction':True}],indirect=True)
def test_only_disjoint_reviewed_fact_can_proceed_while_closing_stays_unresolved(case):
    context,rows,*_=case;before=deepcopy(rows);source_before=deepcopy(context['source'])
    result=plan(case)
    assert [m['text_content'] for m in result['new_motions']]==[TEXT]
    assert result['coverage']=='review_required' and remaining_coverage(result)=='review_required'
    report=result['source_report']
    assert report['unmapped_legacy_ids']==[309]
    assert report['unresolved_closing_conflict_ids']==[309]
    assert report['documentary_preserved_legacy_ids']==[]
    assert report['supplemental_preserved_legacy_ids']==[]
    held=[x for x in report['held'] if x['reason']=='existing_closing_outcome_unresolved_no_rewrite']
    assert len(held)==1 and held[0]['legacy_ids']==[309] and 'source_key' not in held[0]
    assert rows==before and rows[1]['result']=='CARRIED' and context['source']==source_before
    # These exact holds and partial classification are what apply_manifest persists.
    receipt_fields=json.loads(json.dumps({'remaining_coverage':remaining_coverage(result),'held':result['held']}))
    assert receipt_fields['remaining_coverage']=='review_required'
    assert any(h.get('legacy_ids')==[309] and h['reason']=='existing_closing_outcome_unresolved_no_rewrite' for h in receipt_fields['held'])
    assert all(result['new_motions'][0][k] is None for k in ('mover','seconder','mover_id','seconder_id'))
    # Ordinary ingestion gets no new permission from an enrolled catch-up artifact.
    context.pop('allow_reviewed_legacy_reservations')
    assert plan(case)['new_motions']==[] and rows==before


def repin(case, *, source=False, rows=False):
    context,current,review,admission,stores=case
    cap=review['closing_conflict_quarantines'][0]['capability']
    if rows:
        review['claim_inventory_sha256']=build_claim_inventory(current,meeting_id=77,expected_count=len(current))['fingerprint']
        old=next(r for r in current if r['id']==cap['motion_id'])
        cap.update(legacy_text=old['text_content'],expected_stored_result=old['result'],
            claim_sha256=digest(project_claim(old)),claim_row_sha256=row_sha(old))
    if source:
        admission['closing_conflict_capabilities']=[deepcopy(cap)]
        stores['source'].write_text(json.dumps(admission,sort_keys=True))
        reviewed_sources.ENROLLED[77]=sha(stores['source'].read_bytes())
        actual=reviewed_sources.load_reviewed_minutes(context['meeting'],root=context['archive_root'],people=PEOPLE,
            cache_dir=context['archive_root']/'cache',project_ref='test-project',municipality_id=1)
        assert actual and not actual.get('error'),actual
        context['source']=actual
        review['closing_conflict_quarantines'][0]['source_review_sha256']=digest(admission)
    stores['legacy'].write_text(json.dumps(review,sort_keys=True))
    legacy.ENROLLED[77]=sha(stores['legacy'].read_bytes())


CORRECTED_NATIVE = {'native_narration':'Acting Mayor Stewart adjou ed the meeting at 6:42 pm.',
    'native_correction':True}


@pytest.mark.parametrize('case,change,detail',[
    (CORRECTED_NATIVE,'missing_native_capability','passage'),
    (CORRECTED_NATIVE,'source_witness_not_enrolled','independent image proof'),
    (CORRECTED_NATIVE,'duplicate_source_witness','independent image proof'),
    (CORRECTED_NATIVE,'native_page_drift','independent image proof'),
    (CORRECTED_NATIVE,'independent_pin_drift','independent image proof'),
    ({**CORRECTED_NATIVE,'native_narration':'Acting Mayor Stewart adjou ed the meeting at 6:43 pm.'},'none','only the verb'),
    ({**CORRECTED_NATIVE,'native_narration':'Mayor Young adjou ed the meeting at 6:42 pm.'},'none','only the verb'),
    ({**CORRECTED_NATIVE,'native_narration':'Acting Mayor Stewart reopened the meeting at 6:42 pm.'},'none','only the verb'),
    ({**CORRECTED_NATIVE,'native_narration':'Acting Mayor Stewart adjou\nCARRIED.\ned the meeting at 6:42 pm.'},'none','only the verb'),
    ({**CORRECTED_NATIVE,'native_narration':'Acting Mayor Stewart adjou\nMOVED BY: Colby Harder\ned the meeting at 6:42 pm.'},'none','only the verb'),
    ({**CORRECTED_NATIVE,'extra':NARRATION+'\n'},'none','one complete documentary')],indirect=['case'])
def test_native_witness_correction_cannot_remove_authority_or_change_event_or_escape_enrolled_proof(case,change,detail):
    context,rows,review,admission,_=case
    cap=review['closing_conflict_quarantines'][0]['capability']
    if change=='missing_native_capability':cap.pop('native_correction')
    elif change=='source_witness_not_enrolled':admission['documentary_native_corrections']=[]
    elif change=='duplicate_source_witness':admission['documentary_native_corrections']*=2
    elif change=='native_page_drift':cap['native_correction']['native_text_sha256']='bad'
    elif change=='independent_pin_drift':cap['native_correction']['independent_review_sha256']=SECOND
    repin(case,source=True)
    before=deepcopy(rows);result=plan(case)
    assert result['new_motions']==[] and rows==before
    assert result['source_report']['status']=='reviewed_legacy_occurrence_review_stale'
    assert detail in result['source_report']['held'][0]['detail']


@pytest.mark.parametrize('change,expected',[
    ('row_metadata_drift','row changed'),('unknown_metadata_authority','manual authority'),
    ('formal_metadata','manual authority'),('actor','manual authority'),('ballot_count','manual authority'),('row_timestamp_drift','row changed'),
    ('row_body_not_generic','row changed'),('row_closing_negated','row changed'),('stored_result_NULL','row changed'),('stored_result_DEFEATED','row changed'),
    ('linked_vote_proof_missing','zero linked-vote'),('linked_vote_count_positive','zero linked-vote'),
    ('linked_vote_wrong_ID','zero linked-vote'),('inventory_drift','scope changed'),('source_hash','scope changed'),('project','scope changed'),
    ('tenant','scope changed'),('date','catalog'),('source_capability_not_enrolled','capability'),
    ('source_capability_byte_drift','capability changed'),('unchecked_capability','capability'),
    ('first_review_missing','two pinned'),('same_reviewer','two distinct'),
    ('page_hash','witness changed'),('render_hash','witness changed'),('passage_offset','passage'),
    ('substring_passage','passage'),('negated_narration','complete documentary'),
    ('two_entries','Only one'),('invented_source_identity','capability'),
    ('new_key_swapped_to_old_stage','legacy owner'),('new_body_swapped_stage','full-body'),
    ('new_allowlist_key_drift','allowlist'),('competing_old_owner','legacy owner'),
    ('competing_old_closing','competing'),('unexplained_other_old','unmapped_legacy_records')])
def test_enrolled_closing_exclusion_cannot_bypass_drift_ownership_or_unsupported_authority(case,change,expected):
    context,rows,review,admission,stores=case
    cap=review['closing_conflict_quarantines'][0]['capability']
    source_change=False;row_change=False
    if change=='linked_vote_proof_missing':context.pop('closing_linked_vote_counts')
    elif change=='linked_vote_count_positive':context['closing_linked_vote_counts']['counts'][0]['linked_votes']=1
    elif change=='linked_vote_wrong_ID':context['closing_linked_vote_counts']['counts'][0]['motion_id']=100
    elif change=='row_metadata_drift':rows[1]['meta']={'manual_note':'changed'}
    elif change=='unknown_metadata_authority':rows[1]['meta']={'unrecognized_provenance':{'owner':44}};row_change=True;source_change=True
    elif change=='formal_metadata':rows[1]['meta']={'source_motion':{'key':'manual'}};row_change=True;source_change=True
    elif change=='actor':rows[1]['mover_id']=21;row_change=True;source_change=True
    elif change=='ballot_count':rows[1]['yes_votes']=5;row_change=True;source_change=True
    elif change=='row_timestamp_drift':rows[1]['created_at']=datetime(2026,1,9,tzinfo=timezone.utc)
    elif change=='row_body_not_generic':rows[1]['text_content']='That Council adopt Bylaw No. 2030.';row_change=True;source_change=True
    elif change=='row_closing_negated':rows[1]['text_content']='That the Council not adjourn the meeting.';row_change=True;source_change=True
    elif change.startswith('stored_result_'):rows[1]['result']=None if change.endswith('NULL') else 'DEFEATED';row_change=True;source_change=True
    elif change=='inventory_drift':review['claim_inventory_sha256']='changed'
    elif change=='source_hash':review['source_sha256']='changed'
    elif change=='project':review['project_ref']='other'
    elif change=='tenant':review['municipality_id']=2
    elif change=='date':context['meeting']={**context['meeting'],'meeting_date':'2026-01-09'}
    elif change=='source_capability_not_enrolled':reviewed_sources.ENROLLED={}
    elif change=='source_capability_byte_drift':stores['source'].write_text(stores['source'].read_text()+' ')
    elif change=='unchecked_capability':cap['expected_stored_result']='DEFEATED'
    elif change=='first_review_missing':cap['first_review_sha256']='';source_change=True
    elif change=='same_reviewer':
        cap['independent_review_sha256']=FIRST;admission['second_independent_original_image_review_sha256']=FIRST
        review['second_independent_original_image_review_sha256']=FIRST;source_change=True
    elif change in ('page_hash','render_hash'):
        cap['native_text_sha256' if change=='page_hash' else 'render_sha256']='changed';source_change=True
    elif change=='passage_offset':cap['source_passage_start']+=1;source_change=True
    elif change=='substring_passage':cap['source_passage']='adjourned the meeting';source_change=True
    elif change=='negated_narration':cap['printed_body']='Acting Mayor Stewart did not adjourn the meeting at 6:42 pm.';source_change=True
    elif change=='two_entries':review['closing_conflict_quarantines'].append(deepcopy(review['closing_conflict_quarantines'][0]))
    elif change=='invented_source_identity':cap['source_identity']={'key':'invented'};source_change=True
    elif change=='new_key_swapped_to_old_stage':
        block=context['source']['blocks'][0];identity=source_identity(77,context['source'],block)
        item=admission['accepted_decisions'][0];item.update(source_key=identity['key'],raw_block_sha256=digest(block),
            operative_body=AGENDA,operative_body_sha256=sha(AGENDA.encode()))
        cap['allowed_new_decisions']=[deepcopy(item)];source_change=True
    elif change=='new_body_swapped_stage':
        item=admission['accepted_decisions'][0];item.update(operative_body='THAT Council consider Tree Protection Bylaw No. 2269, 2026 as presented.',
            operative_body_sha256=sha(b'THAT Council consider Tree Protection Bylaw No. 2269, 2026 as presented.'))
        cap['allowed_new_decisions']=[deepcopy(item)];source_change=True
    elif change=='new_allowlist_key_drift':cap['allowed_new_decisions'][0]['source_key']='wrong';source_change=True
    elif change=='competing_old_owner':
        rows.append({'id':311,'meeting_id':77,'agenda_item_id':99,'text_content':TEXT,'result':None,'meta':{}});row_change=True;source_change=True
    elif change=='competing_old_closing':rows.append({**rows[1],'id':311});row_change=True;source_change=True
    elif change=='unexplained_other_old':
        rows.append({'id':311,'meeting_id':77,'agenda_item_id':99,'text_content':'THAT Council adopt a tree bylaw [conditions omitted].','result':None,'meta':{}});row_change=True;source_change=True
    repin(case,source=source_change,rows=row_change)
    before=deepcopy(rows);result=plan(case)
    assert result['new_motions']==[] and rows==before
    report=result['source_report']
    if change=='unexplained_other_old':
        assert report['unmapped_legacy_ids']==[309,311]
        assert any(h['reason']==expected for h in report['held'])
    else:
        assert report['status']=='reviewed_legacy_occurrence_review_stale'
        assert expected in report['held'][0]['detail']


@pytest.mark.parametrize('extra,detail',[
    ('MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\nThat Council adjourn the meeting.\nCARRIED.\n','formal adjournment'),
    ('M0VED BY: Colby Harder\nSECONDED: Kimberley Guiry\nThat Council adjourn the meeting.\nCARRIED.\n','formal adjournment'),
    ('M0VED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+TEXT+'\nCARRIED.\n','strict unique'),
    (NARRATION+'\n','one complete documentary')])
def test_original_formal_and_documentary_collisions_hold_even_when_parser_misses_a_header(tmp_path,monkeypatch,extra,detail):
    class Request:param={'extra':extra}
    value=case.__wrapped__(tmp_path,monkeypatch,Request())
    before=deepcopy(value[1]);result=plan(value)
    assert result['new_motions']==[] and value[1]==before
    assert result['source_report']['status']=='reviewed_legacy_occurrence_review_stale'
    assert detail in result['source_report']['held'][0]['detail']


def test_real_legacy_byte_gate_and_successful_insert_stale_the_one_time_closing_exclusion(case):
    context,rows,review,admission,stores=case
    result=plan(case);assert len(result['new_motions'])==1
    stores['legacy'].write_text(stores['legacy'].read_text()+' ')
    assert plan(case)['new_motions']==[]
    stores['legacy'].write_text(json.dumps(review,sort_keys=True))
    assert len(plan(case)['new_motions'])==1
    added=result['new_motions'][0]
    rows.append({'id':400,'meeting_id':77,'agenda_item_id':101,'text_content':added['text_content'],'result':added['result'],'meta':added['meta']})
    after=plan(case)
    assert after['new_motions']==[] and after['coverage']=='source_validation_held'
    assert rows[1]['text_content']==CLOSING and rows[1]['result']=='CARRIED'
