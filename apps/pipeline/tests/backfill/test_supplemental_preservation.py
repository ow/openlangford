"""Public released decisions may account old rows without primary-source ownership."""
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import subprocess
import textwrap

import fitz
import pytest

from ingestion.ballot_fixture import official_context, PEOPLE, TEXT
from pipeline.backfill import legacy_occurrence_reviews as legacy, reviewed_sources
from pipeline.backfill.history_coverage import plan_meeting
from pipeline.ingestion.canonical_motions import source_identity
from pipeline.ingestion.official_ballots import load_official_minutes
from pipeline.ingestion.source_claims import digest, project_claim, build_claim_inventory
from pipeline.ingestion.source_occurrences import original_formal_inventory
from pipeline.ingestion.vote_evidence import minutes_motion_blocks

AGENDA = 'That Council approve the agenda as presented.'
RELEASE_A = ('That Council:\n1. Award detailed design of the Larkhall Extension to McElhanney who are already working on the Peatt at Brock roundabout project; AND\n'
             '2. Rise and Report following the January 2027 Council meeting.')
OLD_A = 'That Council award detailed design of the Larkhall Extension to McElhanney; AND Rise and Report following the January 2027 Council meeting.'
RELEASE_B = 'That Council authorize the Massie connector tender package for $30,200.00 plus GST from the General Amenity Fund.'
FIRST_REVIEW = 'a'*64
SECOND_REVIEW = 'b'*64
NOTICE='This document contains in-camera decisions that have been released because they are no longer considered sensitive.'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def full_row_pin(row):
    # Independent persisted-JSON contract, including native psycopg values.
    return sha(json.dumps(row,sort_keys=True,separators=(',',':'),ensure_ascii=False,default=str).encode())


def write_pdf(path, text):
    with fitz.open() as pdf:
        page=pdf.new_page()
        page.insert_text((30,40),'\n'.join(textwrap.fill(line,width=85) if line else '' for line in text.splitlines()),fontsize=10)
        pdf.save(path)


def page_proof(path):
    with fitz.open(path) as pdf:
        native=pdf[0].get_text()
        return native,{'page':1,'native_text_sha256':sha(native.encode()),
            'render_sha256':sha(pdf[0].get_pixmap(matrix=fitz.Matrix(2,2)).tobytes('png'))}


def release_capability(path, root, body):
    layout=subprocess.run(['pdftotext','-layout',str(path),'-'],check=True,capture_output=True,text=True).stdout
    native,page=page_proof(path);block=list(minutes_motion_blocks(layout))[0]
    # Capture actual complete original header, independently parsed at runtime.
    import re
    pattern=r'Council\s+Meeting\s*\|\s*Meeting\s+Date:\s*[A-Z][a-z]+\s+\d{1,2},\s+\d{4}'
    layout_header=re.search(pattern,layout)[0];native_header=re.search(pattern,native)[0]
    return {'type':'reviewed_published_supplemental_formal_occurrence','authority':'supplemental_occurrence_accounting_only',
        'source_file':str(path.relative_to(root)),'source_sha256':sha(path.read_bytes()),'source_url':Path(str(path)+'.url').read_text().strip(),
        'source_date':'2026-01-08','layout_meeting_header_quote':layout_header,'layout_header_offset':layout.index(layout_header),
        'native_meeting_header_quote':native_header,'native_header_offset':native.index(native_header),
        'layout_text_sha256':sha(layout.encode()),**page,'render_scale':2,'pymupdf_version':fitz.VersionBind,
        'source_offset':block['source_offset'],'source_order':block['source_order'],'raw_block_sha256':digest(block),
        'formal_inventory_sha256':digest(original_formal_inventory(layout)),
        'operative_body':' '.join(body.split()),'operative_body_sha256':sha(' '.join(body.split()).encode()),
        'result':'CARRIED','outcome_quote':block['outcome_quote'],
        'first_review_sha256':FIRST_REVIEW,'independent_review_sha256':SECOND_REVIEW}


@pytest.fixture
def case(tmp_path,monkeypatch,request):
    config=getattr(request,'param',{})
    context=official_context(tmp_path);folder=tmp_path/'archive/meeting/Minutes'
    primary=folder/'Minutes - SIGNED.pdf'
    new_body=RELEASE_A if config.get('primary_full_collision') else TEXT
    hidden=('M0VED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+RELEASE_A+'\nCARRIED.\n') if config.get('unparsed_primary_collision') else ''
    write_pdf(primary,'City of Langford\nCouncil Minutes\nJanuary 8, 2026\nPRESENT:\nMayor S. Goodmanson\nCouncillor C. Harder\nCouncillor K. Guiry\nATTENDING:\nStaff\n'
        'MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+AGENDA+'\nCARRIED.\n'+hidden+
        'MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+new_body+'\nCARRIED.')
    Path(str(primary)+'.url').write_text('https://pub-langford.escribemeetings.com/FileStream.ashx?DocumentId=77')
    caps=[]
    for suffix,body in [('award',RELEASE_A),('connector',RELEASE_A if config.get('duplicate_release_body') else RELEASE_B)]:
        release=folder/(suffix+'.pdf')
        date='January 8, 2027' if config.get('wrong_release_date') else 'January 8, 2026'
        content='Rise and Report\nIn Camera Decisions\nCouncil Meeting | Meeting Date: '+date+'\n'
        content+=(NOTICE if not config.get('not_released') else 'This is a proposed staff report.')+'\nMOVED BY: COUNCILLOR WADE\nSECONDED: COUNCILLOR STEWART\n'+body+'\nCARRIED.'
        if config.get('multiple_release_motions') and suffix=='award':
            content+='\nMOVED BY: COUNCILLOR WADE\nSECONDED: COUNCILLOR STEWART\nThat Council approve another contract.\nCARRIED.'
        if config.get('unresulted_release_introduction') and suffix=='award':
            content+='\nMOVED BY: COUNCILLOR WADE\nSECONDED: COUNCILLOR STEWART\nThat Council consider another contract.'
        if config.get('extra_release_outcome') and suffix=='award':
            content+='\nCARRIED.'
        write_pdf(release,content);Path(str(release)+'.url').write_text('https://langford.ca/public/'+suffix+'.pdf')
        caps.append(release_capability(release,tmp_path,body))
    source=load_official_minutes(context['meeting'],root=tmp_path,people=PEOPLE,cache_dir=tmp_path/'cache')
    native,page=page_proof(primary)
    layout=subprocess.run(['pdftotext','-layout',str(primary),'-'],check=True,capture_output=True,text=True).stdout
    admission={'schema':'reviewed-original-minutes-v1','project_ref':'test-project','municipality_id':1,'catalog':context['meeting'],
        'file_inventory':reviewed_sources.source_inventory(tmp_path,context['meeting']),
        'selected_file':source['source_file'],'source_sha256':source['source_sha256'],'source_url':source['source_url'],
        'mode':'reviewed_native_image_decisions','review_status':'independently_reviewed_original_source','render_scale':2,
        'pymupdf_version':fitz.VersionBind,'native_layout_sha256':sha(layout.encode()),'native_first_page_sha256':sha(native.encode()),
        'pages':[page],'text_corrections':[],'corrected_text_sha256':sha(layout.encode()),'parsed_blocks_sha256':digest(source['blocks']),
        'independent_original_image_review_sha256':FIRST_REVIEW,'supplemental_independent_review_sha256':SECOND_REVIEW,
        'published_supplemental_occurrence_reviews':caps,'accepted_decisions':[]}
    for block in source['blocks'][1:]:
        admission['accepted_decisions'].append({'source_key':source_identity(77,source,block)['key'],'raw_block_sha256':digest(block),
            'operative_body':' '.join(new_body.split()),'operative_body_sha256':sha(' '.join(new_body.split()).encode()),
            'result':'CARRIED','pages':[1],'page_evidence':[page],'independent_review_sha256':FIRST_REVIEW,'authority':'operative_body_and_result_only'})
    source=reviewed_sources.source_from_review(admission,meeting=context['meeting'],root=tmp_path,people=PEOPLE,cache_dir=tmp_path/'cache',project_ref='test-project',municipality_id=1)
    rows=[{'id':100,'meeting_id':77,'agenda_item_id':99,'text_content':AGENDA,'result':'CARRIED','mover_id':21,'seconder_id':23,'meta':{}},
        {'id':309,'meeting_id':77,'agenda_item_id':99,'text_content':TEXT if config.get('primary_old_collision') else OLD_A,
         'result':None if config.get('unknown_old_result') else 'CARRIED','mover_id':21,'seconder_id':23,
         'meta':{'manual_evidence':{'preserve':'all fields'}},'created_at':datetime(2026,1,8,tzinfo=timezone.utc),'financial_cost':Decimal('12.50')},
        {'id':310,'meeting_id':77,'agenda_item_id':99,'text_content':RELEASE_B,'result':'CARRIED','mover_id':21,'seconder_id':23,'meta':None}]
    inventory=build_claim_inventory(rows,meeting_id=77,expected_count=3)
    review={'schema':'reviewed-legacy-occurrence-reservations-v1','meeting_id':77,'project_ref':'test-project','municipality_id':1,
        'source_sha256':source['source_sha256'],'source_url':source['source_url'],'source_file':source['source_file'],'source_date':source['local_date'],
        'source_text_sha256':sha(source['text'].encode()),'formal_inventory_sha256':digest(source['formal_occurrence_inventory']),
        'claim_inventory_sha256':inventory['fingerprint'],'native_pages':[],'reservations':[],
        'supplemental_preservations':[{'type':'reviewed_published_supplemental_formal_preservation','authority':'supplemental_occurrence_accounting_only',
            'result_policy':'preserve_existing_without_rewrite','motion_id':row['id'],'legacy_text':row['text_content'],
            'expected_stored_result':row['result'],'claim_sha256':digest(project_claim(row)),'claim_row_sha256':full_row_pin(row),
            'primary_source_review_sha256':digest(admission),'supplemental_review':deepcopy(cap)} for row,cap in zip(rows[1:],caps)]}
    stores={}
    for module,name,obj in [(reviewed_sources,'source-review',admission),(legacy,'legacy-review',review)]:
        store=tmp_path/name;store.mkdir();path=store/'77.json';path.write_text(json.dumps(obj,sort_keys=True))
        monkeypatch.setattr(module,'STORE',store);monkeypatch.setattr(module,'ENROLLED',{77:sha(path.read_bytes())});stores[name]=path
    context.update(source=source,meeting_claim_inventory=inventory,allow_reviewed_legacy_reservations=True,
        project_ref='test-project',municipality_id=1,archive_root=tmp_path)
    return context,rows,review,admission,stores


def plan(case):
    context,rows,*_=case
    return plan_meeting(context['meeting'],rows,[],context['source'],review_scope={k:context[k] for k in
        ('allow_reviewed_legacy_reservations','project_ref','municipality_id','archive_root') if k in context})


def test_reviewed_release_claims_unlock_only_independent_primary_additions_without_writes(case):
    context,rows,review,admission,stores=case;before=deepcopy(rows)
    result=plan(case)
    assert [m['text_content'] for m in result['new_motions']]==[TEXT]
    expected_key=source_identity(77,context['source'],context['source']['blocks'][1])['key']
    assert result['new_motions'][0]['meta']['canonical_source_motion']['key']==expected_key
    report=result['source_report']
    assert report['source_motions']==2 and report['supplemental_preserved_legacy_ids']==[309,310]
    assert report['unmapped_legacy_ids']==[]
    holds=[h for h in report['held'] if h['reason']=='reviewed_supplemental_formal_claim_preserved_no_rewrite']
    assert [h['legacy_ids'] for h in holds]==[[309],[310]] and all('source_key' not in h for h in holds)
    assert rows==before and [rows[1]['result'],rows[2]['result']]==['CARRIED','CARRIED']
    assert all(m['mover_id'] is None and m['seconder_id'] is None for m in result['new_motions'])
    snapshot=json.loads(json.dumps(rows,default=str));case_json=(context,snapshot,review,admission,stores)
    assert [m['text_content'] for m in plan(case_json)['new_motions']]==[TEXT]
    context.pop('allow_reviewed_legacy_reservations')
    ordinary=plan(case)
    assert ordinary['new_motions']==[] and ordinary['source_report']['unmapped_legacy_ids']==[309,310]
    assert rows==before


def repin(case, *, rows=False, source=False):
    context,current,review,admission,stores=case
    if rows:
        inventory=build_claim_inventory(current,meeting_id=77,expected_count=len(current))
        context['meeting_claim_inventory']=inventory
        review['claim_inventory_sha256']=inventory['fingerprint']
        for entry in review['supplemental_preservations']:
            row=next(r for r in current if r['id']==entry['motion_id'])
            entry.update(claim_sha256=digest(project_claim(row)),claim_row_sha256=full_row_pin(row),
                legacy_text=row['text_content'],expected_stored_result=row['result'])
    if source:
        admission['file_inventory']=reviewed_sources.source_inventory(context['archive_root'],context['meeting'])
        stores['source-review'].write_text(json.dumps(admission,sort_keys=True))
        reviewed_sources.ENROLLED[77]=sha(stores['source-review'].read_bytes())
        context['source']['source_review_evidence']['review_sha256']=digest(admission)
        context['source']['source_review_evidence']['mode']=admission['mode']
        for entry in review['supplemental_preservations']:
            entry['primary_source_review_sha256']=digest(admission)
    stores['legacy-review'].write_text(json.dumps(review,sort_keys=True))
    legacy.ENROLLED[77]=sha(stores['legacy-review'].read_bytes())


@pytest.mark.parametrize('case',[{'unknown_old_result':True}],indirect=True)
def test_release_preservation_keeps_unknown_old_result_and_all_known_actor_fields(case):
    before=deepcopy(case[1]);result=plan(case)
    assert [m['text_content'] for m in result['new_motions']]==[TEXT]
    assert case[1]==before and case[1][1]['result'] is None
    assert case[1][1]['mover_id']==21 and case[1][1]['seconder_id']==23


@pytest.mark.parametrize('case',[
    {'wrong_release_date':True}, {'not_released':True}, {'multiple_release_motions':True},
    {'duplicate_release_body':True}, {'primary_full_collision':True}, {'primary_old_collision':True},
    {'unparsed_primary_collision':True}, {'unresulted_release_introduction':True}, {'extra_release_outcome':True},
],indirect=True)
def test_reviewed_caps_cannot_override_actual_date_publication_occurrence_or_primary_ownership(case):
    config=case[0];before=deepcopy(case[1]);result=plan(case)
    assert result['new_motions']==[] and case[1]==before
    assert result['source_report']['status']=='reviewed_legacy_occurrence_review_stale'
    detail=result['source_report']['held'][0]['detail']
    assert any(word in detail for word in ('actual meeting date','explicit public Rise','not unique','one-to-one','primary formal owner'))


@pytest.mark.parametrize('change',[
    'row_manual_drift','row_outcome_conflict','row_existing_identity','competing_old_owner',
    'source_not_enrolled','legacy_not_enrolled','source_artifact_bytes','legacy_artifact_bytes',
    'source_proof','unchecked_capability','independent_review','duplicate_entry','duplicate_owner',
    'source_bytes','page_hash','render_hash','layout_hash','tenant','project','review_date','unlisted_pdf','forbidden_source_key',
])
def test_changed_or_unchecked_supplemental_evidence_never_unlocks_primary_inserts(case,change):
    context,rows,review,admission,stores=case;entry=review['supplemental_preservations'][0]
    if change=='row_manual_drift':rows[1]['meta']['manual_evidence']['preserve']='changed'
    elif change=='row_outcome_conflict':
        rows[1]['result']='DEFEATED';repin(case,rows=True)
    elif change=='row_existing_identity':
        rows[1]['meta']['canonical_source_motion']=source_identity(77,context['source'],context['source']['blocks'][0]);repin(case,rows=True)
    elif change=='competing_old_owner':
        rows.append({**deepcopy(rows[1]),'id':311});repin(case,rows=True)
    elif change=='source_not_enrolled':reviewed_sources.ENROLLED.clear()
    elif change=='legacy_not_enrolled':legacy.ENROLLED.clear()
    elif change=='source_artifact_bytes':stores['source-review'].write_bytes(stores['source-review'].read_bytes()+b' ')
    elif change=='legacy_artifact_bytes':stores['legacy-review'].write_bytes(stores['legacy-review'].read_bytes()+b' ')
    elif change=='source_proof':context['source']['source_review_evidence']['review_sha256']='c'*64
    elif change=='unchecked_capability':
        entry['supplemental_review']['authority']='unchecked';repin(case)
    elif change=='independent_review':
        admission['published_supplemental_occurrence_reviews'][0]['independent_review_sha256']=FIRST_REVIEW
        entry['supplemental_review']=deepcopy(admission['published_supplemental_occurrence_reviews'][0]);repin(case,source=True)
    elif change=='duplicate_entry':
        review['supplemental_preservations'].append(deepcopy(entry));repin(case)
    elif change=='duplicate_owner':
        review['supplemental_preservations'][1]['supplemental_review']=deepcopy(entry['supplemental_review']);repin(case)
    elif change=='source_bytes':
        path=context['archive_root']/entry['supplemental_review']['source_file'];path.write_bytes(path.read_bytes()+b' ')
    elif change in ('page_hash','render_hash','layout_hash'):
        field={'page_hash':'native_text_sha256','render_hash':'render_sha256','layout_hash':'layout_text_sha256'}[change]
        admission['published_supplemental_occurrence_reviews'][0][field]='bad'
        entry['supplemental_review']=deepcopy(admission['published_supplemental_occurrence_reviews'][0]);repin(case,source=True)
    elif change=='tenant':review['municipality_id']=2;repin(case)
    elif change=='project':review['project_ref']='other';repin(case)
    elif change=='review_date':review['source_date']='2026-01-09';repin(case)
    elif change=='unlisted_pdf':
        admission['published_supplemental_occurrence_reviews'][0]['source_file']='outside/award.pdf'
        entry['supplemental_review']=deepcopy(admission['published_supplemental_occurrence_reviews'][0]);repin(case,source=True)
    else:entry['source_key']='invented-primary-key';repin(case)
    before=deepcopy(rows);result=plan(case)
    assert result['new_motions']==[] and rows==before
    if change=='legacy_not_enrolled':
        assert result['source_report']['unmapped_legacy_ids']==[309,310]
    else:
        assert result['source_report']['status']=='reviewed_legacy_occurrence_review_stale'
    if change=='row_outcome_conflict':assert 'outcome conflicts' in result['source_report']['held'][0]['detail']
    elif change=='competing_old_owner':assert 'Competing old' in result['source_report']['held'][0]['detail']


def test_successful_primary_addition_stales_the_one_time_supplemental_claim_review(case):
    context,rows,*_=case
    result=plan(case);added=result['new_motions'][0]
    persisted={'id':400,'meeting_id':77,'agenda_item_id':100,'text_content':added['text_content'],
        'result':added['result'],'meta':added['meta']}
    rows.append(persisted)
    context['meeting_claim_inventory']=build_claim_inventory(rows,meeting_id=77,expected_count=4)
    before=deepcopy(rows);again=plan(case)
    assert again['new_motions']==[] and rows==before
    assert again['source_report']['status']=='reviewed_legacy_occurrence_review_stale'
