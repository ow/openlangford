"""Reviewed scans/selections stay explicit and cannot become ballot authority."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

import fitz
import pytest

from pipeline.backfill import reviewed_sources as reviews
from pipeline.backfill.history_coverage import plan_meeting, remaining_coverage
from pipeline.ingestion.official_ballots import minutes_text_source, load_official_minutes
from pipeline.ingestion.canonical_motions import source_identity
from pipeline.ingestion.source_claims import digest


BODY='THAT Council adopt Tree Protection Bylaw No. 2269, 2026 as presented.'
TEXT='City of Langford\nCouncil Minutes\nJanuary 8, 2026\nPRESENT:\nColby Harder\nATTENDING:\nStaff\nMOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+BODY+'\nCARRIED.\n'


def make_pdf(path,text,scan=False):
    with fitz.open() as doc:
        page=doc.new_page();page.insert_text((30,40),text,fontsize=12)
        if scan:
            image=page.get_pixmap(matrix=fitz.Matrix(2,2))
            with fitz.open() as raster:
                p=raster.new_page(width=page.rect.width,height=page.rect.height)
                p.insert_image(p.rect,stream=image.tobytes('png'));raster.save(path)
        else:doc.save(path)


@pytest.fixture
def scan_review(tmp_path):
    folder=tmp_path/'archive/meeting/Minutes';folder.mkdir(parents=True)
    path=folder/'Minutes - SIGNED.pdf';make_pdf(path,TEXT,True)
    Path(str(path)+'.url').write_text('https://langford.ca/official-minutes.pdf')
    meeting={'id':77,'title':'Council','type':'Regular Council','meeting_date':'2026-01-08',
             'classification':'Council','archive_path':'archive/meeting'}
    source_sha=reviews.sha(path.read_bytes())
    source=minutes_text_source(meeting,root=tmp_path,people=[],cache_dir=tmp_path/'cache',path=path,
        text=TEXT,source_format='original_pdf_reviewed_local_ocr',source_sha256=source_sha)
    with fitz.open(path) as doc:image=doc[0].get_pixmap(matrix=fitz.Matrix(3,3))
    helper=Path(reviews.__file__).parents[1]/'ingestion'/'native_header_vision.swift'
    review={'schema':'reviewed-original-minutes-v1','project_ref':'test-project','municipality_id':1,
        'catalog':deepcopy(meeting),'file_inventory':reviews.source_inventory(tmp_path,meeting),
        'review_status':'independently_reviewed_original_source','mode':'reviewed_scan',
        'selected_file':str(path.relative_to(tmp_path)),'source_url':'https://langford.ca/official-minutes.pdf',
        'source_sha256':source_sha,'reviewed_text':TEXT,'render_scale':3,'pymupdf_version':fitz.VersionBind,
        'helper_source_sha256':reviews.sha(helper.read_bytes()),
        'pages':[{'page':1,'source_sha256':source_sha,'source_url':'https://langford.ca/official-minutes.pdf',
                  'render_scale':3,'render_sha256':reviews.sha(image.tobytes('png')),
                  'ocr':{'engine':'macOS Vision VNRecognizeTextRequest','vision_revision':3,'lines':[]}}],
        'parsed_blocks_sha256':digest(source['blocks']),'source_text_sha256':reviews.sha(source['text'].encode()),
        'accepted_decisions':[{'source_key':source_identity(77,source,source['blocks'][0])['key'],
                              'raw_block_sha256':digest(source['blocks'][0]),'operative_body':BODY,
                              'result':'CARRIED','pages':[1]}],
        'remaining_holds':[{'reason':'Unreviewed later formal occurrence stays held'}]}
    return meeting,review,tmp_path


def read(case):
    meeting,review,root=case
    return reviews.source_from_review(review,meeting=meeting,root=root,people=[],cache_dir=root/'cache',
                                      project_ref='test-project',municipality_id=1)


def test_scan_requires_explicit_review_and_never_emits_actors_attendance_or_votes(scan_review):
    meeting,review,root=scan_review
    original=load_official_minutes(meeting,root=root,people=[],cache_dir=root/'cache')
    assert original['error']=='pdf_requires_ocr'
    source=read(scan_review)
    assert source['source_format']=='original_pdf_reviewed_local_ocr'
    assert source['present']==[] and source['roster_unknown']
    plan=plan_meeting(meeting,[],[],source)
    assert len(plan['new_motions'])==1 and plan['coverage']=='review_required'
    claim=plan['new_motions'][0]
    assert claim['text_content']==BODY and claim['result']=='CARRIED'
    assert all(claim[k] is None for k in ('mover','seconder','mover_id','seconder_id'))
    assert claim['meta']['individual_vote_coverage']=='not_recorded'
    assert source['source_sha256']==reviews.sha((root/review['selected_file']).read_bytes())
    review['accepted_decisions']=[]
    assert plan_meeting(meeting,[],[],read(scan_review))['new_motions']==[]


def cross_page_case(case):
    meeting,review,root=case
    path=root/review['selected_file'];path.unlink()
    parts=[TEXT.split(BODY)[0]+BODY[:35],BODY[35:]+'\nCARRIED.\n']
    with fitz.open() as document:
        for text in parts:
            page=document.new_page();page.insert_text((30,40),text,fontsize=12)
        document.save(path)
    source_sha=reviews.sha(path.read_bytes())
    review.update(source_sha256=source_sha,file_inventory=reviews.source_inventory(root,meeting))
    review['pages']=[]
    with fitz.open(path) as document:
        for i,page in enumerate(document):
            image=page.get_pixmap(matrix=fitz.Matrix(3,3))
            review['pages'].append({'page':i+1,'source_sha256':source_sha,'source_url':review['source_url'],
                'render_scale':3,'render_sha256':reviews.sha(image.tobytes('png')),
                'ocr':{'engine':'macOS Vision VNRecognizeTextRequest','vision_revision':3,'lines':[]}})
    source=minutes_text_source(meeting,root=root,people=[],cache_dir=root/'cache',path=path,
        text=TEXT,source_format='original_pdf_reviewed_local_ocr',source_sha256=source_sha)
    review.update(parsed_blocks_sha256=digest(source['blocks']),source_text_sha256=reviews.sha(source['text'].encode()))
    entry=review['accepted_decisions'][0]
    entry.update(source_key=source_identity(77,source,source['blocks'][0])['key'],pages=[1,2])
    entry['span_review']={'status':'independently_reviewed_complete_motion_span',
        'review_sha256':'a'*64,'operative_body_sha256':reviews.sha(BODY.encode()),
        'page_evidence':[{'page':p['page'],'render_sha256':p['render_sha256'],'ocr_sha256':digest(p['ocr'])}
                         for p in review['pages']]}
    return case


def test_complete_reviewed_cross_page_decision_keeps_body_result_and_unknown_actors(scan_review):
    meeting,review,root=cross_page_case(scan_review)
    source=read(scan_review)
    plan=plan_meeting(meeting,[],[],source)
    assert [(m['text_content'],m['result']) for m in plan['new_motions']]==[(BODY,'CARRIED')]
    claim=plan['new_motions'][0]
    assert claim['meta']['operative_motion_body']['original_image_review']['pages']==[1,2]
    assert all(claim[k] is None for k in ('mover','seconder','mover_id','seconder_id'))
    assert claim['meta']['individual_vote_coverage']=='not_recorded'


@pytest.mark.parametrize('change',['absent_review','unreviewed','body','page_proof','reordered','gap','duplicate'])
def test_cross_page_admission_requires_complete_ordered_reviewed_span(scan_review,change):
    cross_page_case(scan_review)
    entry=scan_review[1]['accepted_decisions'][0]
    if change=='absent_review':entry.pop('span_review')
    elif change=='unreviewed':entry['span_review']['status']='raw_ocr_only'
    elif change=='body':entry['operative_body']=BODY.replace('2269','2270')
    elif change=='page_proof':entry['span_review']['page_evidence'][1]['render_sha256']='changed'
    elif change=='reordered':entry['pages']=[2,1]
    elif change=='gap':entry['pages']=[1,3]
    else:entry['pages']=[1,1,2]
    with pytest.raises(ValueError):read(scan_review)


@pytest.mark.parametrize('change',['source','catalog','project','pages','render','parsing','outcome','status','extra_file'])
def test_changed_source_scope_or_review_cannot_admit_scan(scan_review,change):
    meeting,review,root=scan_review
    if change=='source':(root/review['selected_file']).write_bytes(b'changed')
    elif change=='catalog':meeting['meeting_date']='2026-01-09'
    elif change=='project':review['project_ref']='other-project'
    elif change=='pages':review['pages']=[]
    elif change=='render':review['pages'][0]['render_sha256']='different'
    elif change=='parsing':review['reviewed_text']=TEXT.replace('2269','2270')
    elif change=='outcome':review['accepted_decisions'][0]['result']='DEFEATED'
    elif change=='status':review['review_status']='raw_ocr_only'
    else:make_pdf(root/'archive/meeting/Minutes/other.pdf',TEXT)
    with pytest.raises(ValueError):read(scan_review)


def test_enrolled_artifact_tamper_fails_closed_without_fallback(scan_review,monkeypatch):
    meeting,review,root=scan_review
    store=root/'reviews';store.mkdir();path=store/'77.json';raw=json.dumps(review).encode();path.write_bytes(raw+b' ')
    monkeypatch.setattr(reviews,'STORE',store);monkeypatch.setattr(reviews,'ENROLLED',{77:reviews.sha(raw)})
    source=reviews.load_reviewed_minutes(meeting,root=root,people=[],cache_dir=root/'cache',project_ref='test-project',municipality_id=1)
    assert source['error']=='reviewed_original_source_held'


def test_cancelled_original_notice_is_not_missing_decisions_or_unknown_complete(scan_review):
    meeting,review,root=scan_review
    notice=root/'cancelled.pdf';make_pdf(notice,'The January 8 Council meeting is cancelled.')
    review.update(mode='no_decisions_expected',notice={'file':'cancelled.pdf','sha256':reviews.sha(notice.read_bytes()),
                  'url':'https://langford.ca/cancelled.pdf','status':'cancelled','source_quote':'The meeting is cancelled.'})
    source=read(scan_review);plan=plan_meeting(meeting,[],[],source)
    assert plan['coverage']=='no_decisions_expected_from_notice'
    assert remaining_coverage(plan)=='no_decisions_expected_from_notice'
    old={'id':1,'meeting_id':77,'text_content':BODY,'result':'CARRIED','meta':{}}
    assert plan_meeting(meeting,[old],[],source)['coverage']=='source_unavailable'


def native_case(case,text):
    meeting,review,root=case
    path=root/review['selected_file'];path.unlink();make_pdf(path,text)
    review.update(mode='reviewed_native_selection_or_header',source_sha256=reviews.sha(path.read_bytes()),
                  file_inventory=reviews.source_inventory(root,meeting))
    with fitz.open(path) as doc:review['native_first_page_sha256']=reviews.sha(doc[0].get_text().encode())


def image_outcome_case(case):
    """A real image-only outcome is visible but absent from embedded PDF text."""
    native_case(case,TEXT.replace('CARRIED.',''))
    meeting,review,root=case;path=root/review['selected_file']
    with fitz.open() as stamp:
        page=stamp.new_page(width=150,height=35);page.insert_text((5,22),'CARRIED.',fontsize=12)
        image=page.get_pixmap().tobytes('png')
    with fitz.open(path) as document:
        document[0].insert_image(fitz.Rect(350,210,500,245),stream=image)
        document.save(root/'image-outcome.pdf')
    path.write_bytes((root/'image-outcome.pdf').read_bytes())
    raw=reviews.subprocess.run(['pdftotext','-layout',str(path),'-'],check=True,capture_output=True,text=True).stdout
    assert 'CARRIED' not in raw and raw.count(BODY)==1
    source_sha=reviews.sha(path.read_bytes());corrected=raw.replace(BODY,BODY+'\nCARRIED.')
    source=minutes_text_source(meeting,root=root,people=[],cache_dir=root/'cache',path=path,
        text=corrected,source_format='original_pdf_reviewed_image_corrections',source_sha256=source_sha)
    with fitz.open(path) as document:
        page=document[0];native_sha=reviews.sha(page.get_text().encode())
        render_sha=reviews.sha(page.get_pixmap(matrix=fitz.Matrix(3,3)).tobytes('png'))
    review.update(mode='reviewed_native_image_corrections',source_sha256=source_sha,
        file_inventory=reviews.source_inventory(root,meeting),native_first_page_sha256=native_sha,
        native_layout_sha256=reviews.sha(raw.encode()),corrected_text_sha256=reviews.sha(corrected.encode()),
        parsed_blocks_sha256=digest(source['blocks']),pymupdf_version=fitz.VersionBind,
        pages=[{'page':1,'native_text_sha256':native_sha,'render_sha256':render_sha}],
        text_corrections=[{'page':1,'native_quote':BODY,'reviewed_quote':BODY+'\nCARRIED.',
            'authority':'original_image_text_correction_only','image_quote':'CARRIED.'}])
    return case


@pytest.mark.parametrize('with_date_review',[False,True])
def test_image_only_outcome_accounts_existing_claim_without_creating_or_certifying_rows(scan_review,with_date_review):
    meeting,review,root=image_outcome_case(scan_review)
    if with_date_review:review['header_date']={'date':meeting['meeting_date'],'authority':'reviewed_original_header'}
    people=[{'id':1,'name':'Colby Harder'},{'id':2,'name':'Kimberley Guiry'}]
    source=reviews.source_from_review(review,meeting=meeting,root=root,people=people,cache_dir=root/'cache',
                                      project_ref='test-project',municipality_id=1)
    assert len(source['blocks'])==1 and source['blocks'][0]['result']=='CARRIED'
    assert source['source_format']=='original_pdf_reviewed_image_corrections'
    assert source['present']==[] and source['header_attendance'] is None
    assert plan_meeting(meeting,[],[],source)['new_motions']==[]
    old={'id':1,'meeting_id':77,'agenda_item_id':9,'text_content':BODY,'result':None,'meta':{'manual':'preserve'}}
    before=deepcopy(old);plan=plan_meeting(meeting,[old],[],source)
    assert plan['new_motions']==[] and plan['source_report']['unmapped_legacy_ids']==[]
    assert old==before and plan['stored_outcome_unknown_ids']==[1]


@pytest.mark.parametrize('change',['page','image','quote','replacement','parsing','authority'])
def test_changed_image_correction_cannot_reconstruct_source_outcome(scan_review,change):
    image_outcome_case(scan_review);review=scan_review[1]
    if change=='page':review['pages']=[]
    elif change=='image':review['pages'][0]['render_sha256']='changed'
    elif change=='quote':review['text_corrections'][0]['native_quote']='not in the original'
    elif change=='replacement':review['text_corrections'][0]['reviewed_quote']+=' changed'
    elif change=='parsing':review['parsed_blocks_sha256']='changed'
    else:review['text_corrections'][0]['authority']='unreviewed_ocr'
    with pytest.raises(ValueError):read(scan_review)


def test_distinct_public_hearing_is_not_combined_with_selected_special_council(scan_review):
    meeting,review,root=scan_review
    native_case(scan_review,TEXT.replace('Council Minutes','Special Council Minutes'))
    other=root/'archive/meeting/Minutes/Public Hearing Minutes - SIGNED.pdf'
    make_pdf(other,TEXT.replace('Council Minutes','Public Hearing Minutes').replace('2269','9999'))
    Path(str(other)+'.url').write_text('https://langford.ca/public-hearing.pdf')
    review['file_inventory']=reviews.source_inventory(root,meeting)
    original=load_official_minutes(meeting,root=root,people=[],cache_dir=root/'cache')
    assert original['error']=='ambiguous_original_minutes_pdf'
    source=read(scan_review)
    assert len(source['blocks'])==1 and '9999' not in source['text']
    assert source['source_sha256']==review['source_sha256']


def test_reviewed_header_date_preserves_corrupted_native_text(scan_review,monkeypatch):
    from pipeline.ingestion import official_ballots
    monkeypatch.setattr(official_ballots,'recover_pdf_header_date',lambda *a,**kw:(None,None))
    native_case(scan_review,TEXT.replace('January 8, 2026','January 8ttt, 2026'))
    meeting,review,root=scan_review
    review['header_date']={'date':'2026-01-08','literal':'January 8, 2026','authority':'independently_reviewed_original_image_header'}
    source=read(scan_review)
    assert source['local_date']=='2026-01-08'
    assert 'January 8ttt' in source['text']
    assert source['source_date_evidence']['method']=='reviewed_original_image_header_date'


def test_committee_header_review_does_not_certify_roster_or_affect_ordinary_planner(scan_review):
    from pipeline.ingestion.canonical_motions import canonical_motion_plan
    meeting,review,root=scan_review
    meeting.update(title='Advisory Committee',classification='Advisory Committee')
    review['catalog']=deepcopy(meeting)
    native_case(scan_review,TEXT.replace('Council Minutes','Cornmunity Advisory Committee Minutes'))
    review['committee_scope']={'scope':'Community Advisory Committee','roster_authority':False}
    source=read(scan_review)
    assert source['present']==[] and source['header_attendance'] is None
    context={'status':'available','meeting':meeting,'source':source}
    _,report=canonical_motion_plan([],context,[])
    assert report['status']=='source_voting_body_not_bound'
    context['allow_reviewed_source_header']=True
    _,report=canonical_motion_plan([],context,[])
    assert report['status']=='source_authoritative'


IMAGE_NEW_BODIES=(
    'THAT Council give Bylaw No. 2270 first reading.',
    'THAT Council adopt Bylaw No. 2271.',
)
UNREVIEWED_BODY='THAT Council adopt Bylaw No. 2272.'


def native_image_decisions_case(case):
    meeting,review,root=case;path=root/review['selected_file'];path.unlink()
    suffix=lambda body:'MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+body+'\nCARRIED.\n'
    visible=TEXT+''.join(suffix(body) for body in (*IMAGE_NEW_BODIES,UNREVIEWED_BODY))
    native=visible.replace('SECONDED: Kimberley Guiry\n'+IMAGE_NEW_BODIES[0],
                           'SEGONDED: Kimberley Guiry\n'+IMAGE_NEW_BODIES[0].replace('THAT Council','THATCouncif'))
    # Preserve the correct printed image and an independently corrupt hidden OCR layer.
    make_pdf(path,visible,True)
    with fitz.open(path) as document:
        document[0].insert_text((30,40),native,fontsize=12,render_mode=3)
        document.save(root/'native-image-decisions.pdf')
    path.write_bytes((root/'native-image-decisions.pdf').read_bytes())
    raw=reviews.subprocess.run(['pdftotext','-layout',str(path),'-'],check=True,capture_output=True,text=True).stdout
    corrections=[{'page':1,'native_quote':before,'reviewed_quote':after,
                  'authority':'original_image_text_correction_only','image_quote':after}
                 for before,after in [('SEGONDED: Kimberley Guiry','SECONDED: Kimberley Guiry'),
                                      ('THATCouncif','THAT Council')]]
    corrected=raw
    for correction in corrections:
        assert corrected.count(correction['native_quote'])==1
        corrected=corrected.replace(correction['native_quote'],correction['reviewed_quote'])
    source_sha=reviews.sha(path.read_bytes())
    source=minutes_text_source(meeting,root=root,people=[],cache_dir=root/'cache',path=path,
        text=corrected,source_format='original_pdf_reviewed_image_decisions',source_sha256=source_sha)
    assert len(source['blocks'])==4
    with fitz.open(path) as document:
        page=document[0];native_sha=reviews.sha(page.get_text().encode())
        render_sha=reviews.sha(page.get_pixmap(matrix=fitz.Matrix(3,3)).tobytes('png'))
    proof={'page':1,'native_text_sha256':native_sha,'render_sha256':render_sha}
    review.update(mode='reviewed_native_image_decisions',source_sha256=source_sha,
        file_inventory=reviews.source_inventory(root,meeting),native_first_page_sha256=native_sha,
        native_layout_sha256=reviews.sha(raw.encode()),corrected_text_sha256=reviews.sha(corrected.encode()),
        parsed_blocks_sha256=digest(source['blocks']),pymupdf_version=fitz.VersionBind,
        pages=[proof],text_corrections=corrections,accepted_decisions=[])
    for body in IMAGE_NEW_BODIES:
        block=next(b for b in source['blocks'] if b['motion_text']==body)
        review['accepted_decisions'].append({'source_key':source_identity(77,source,block)['key'],
            'raw_block_sha256':digest(block),'operative_body':body,'operative_body_sha256':reviews.sha(body.encode()),
            'result':'CARRIED','pages':[1],'page_evidence':[deepcopy(proof)],
            'independent_review_sha256':'a'*64,'authority':'operative_body_and_result_only'})
    review.pop('remaining_holds',None)
    return case


@pytest.mark.parametrize('with_date_review',[False,True])
@pytest.mark.parametrize('with_review_hold',[False,True])
def test_native_image_admission_whitelists_two_new_decisions_and_preserves_existing_unknown(scan_review,with_date_review,with_review_hold):
    meeting,review,root=native_image_decisions_case(scan_review)
    hold={'reason':'Earlier report-to-current-proceeding association remains unresolved',
          'authority':'diagnostic_only_no_fact_or_key_authority'}
    if with_review_hold:review['remaining_holds']=[hold]
    if with_date_review:review['header_date']={'date':meeting['meeting_date'],'authority':'reviewed_original_header'}
    source=reviews.source_from_review(review,meeting=meeting,root=root,
        people=[{'id':1,'name':'Colby Harder'},{'id':2,'name':'Kimberley Guiry'}],cache_dir=root/'cache',
        project_ref='test-project',municipality_id=1)
    old={'id':10,'meeting_id':77,'agenda_item_id':99,'text_content':BODY,'result':None,
         'mover_id':9,'seconder_id':8,'meta':{'manual_evidence':'preserve'}}
    before=deepcopy(old);plan=plan_meeting(meeting,[old],[],source)
    assert [(m['text_content'],m['result']) for m in plan['new_motions']]==[(body,'CARRIED') for body in IMAGE_NEW_BODIES]
    assert any(h['reason']=='new_fact_not_explicitly_image_enrolled' for h in plan['held'])
    assert old==before and plan['stored_outcome_unknown_ids']==[10]
    assert source['present']==[] and source['header_attendance'] is None
    assert all(all(m[k] is None for k in ('mover','seconder','mover_id','seconder_id')) for m in plan['new_motions'])
    assert all(m['meta']['individual_vote_coverage']=='not_recorded' for m in plan['new_motions'])
    persisted=[old]+[{**m,'id':i+11,'meeting_id':77,'agenda_item_id':99} for i,m in enumerate(plan['new_motions'])]
    assert plan_meeting(meeting,persisted,[],source)['new_motions']==[]
    # Account for the fourth occurrence as an already persisted row. With no
    # parser/allowlist gaps left, only the explicit review note prevents a
    # misleading fully-accounted receipt; it cannot change existing facts.
    persisted.append({'id':13,'meeting_id':77,'agenda_item_id':99,
                      'text_content':UNREVIEWED_BODY,'result':'CARRIED','meta':{}})
    persisted_before=deepcopy(persisted)
    complete=plan_meeting(meeting,persisted,[],source)
    assert complete['new_motions']==[] and persisted==persisted_before
    assert complete['source_report']['unmapped_legacy_ids']==[]
    assert complete['source_report']['unparsed_formal_occurrence_leads']==[]
    assert complete['source_report']['unbound_outcome_leads']==[]
    assert complete['held']==([hold] if with_review_hold else [])
    assert remaining_coverage(complete)==('review_required' if with_review_hold else 'source_occurrences_accounted_for')


@pytest.mark.parametrize('change',['body','result','page','page_evidence','review','authority','scope','parsing'])
def test_native_image_new_decision_changes_fail_closed(scan_review,change):
    native_image_decisions_case(scan_review);review=scan_review[1];entry=review['accepted_decisions'][0]
    if change=='body':entry['operative_body']=entry['operative_body'].replace('2270','9999')
    elif change=='result':entry['result']='DEFEATED'
    elif change=='page':entry['pages']=[2]
    elif change=='page_evidence':entry['page_evidence'][0]['render_sha256']='changed'
    elif change=='review':entry['independent_review_sha256']='not-a-review-digest'
    elif change=='authority':entry['authority']='ballot_inference'
    elif change=='scope':review['project_ref']='other-project'
    else:review['parsed_blocks_sha256']='changed'
    with pytest.raises(ValueError):read(scan_review)
