"""Reviewed blank clock fields preserve unknowns, never invent closing facts."""
from copy import deepcopy
import json
import subprocess
import fitz
import pytest
import test_closing_conflicts as closing
from pipeline.backfill import legacy_occurrence_reviews as legacy,reviewed_sources
from pipeline.backfill.history_coverage import remaining_coverage
from pipeline.ingestion.canonical_motions import source_identity
from pipeline.ingestion.official_ballots import load_official_minutes
from pipeline.ingestion.source_claims import build_claim_inventory,digest,project_claim
PREFIX='The Chair adjourned the meeting at'

@pytest.fixture
def case(tmp_path,monkeypatch,request):
    monkeypatch.setattr(closing,'NARRATION',getattr(request,'param',{}).get('narration',PREFIX))
    context,rows,review,admission,stores=closing.case.__wrapped__(tmp_path,monkeypatch,request)
    rows[1]['result']=None;path=tmp_path/context['source']['source_file']
    # Visible suffix is a raster: it is absent from native text, as in111.
    with fitz.open() as stamp:
        page=stamp.new_page(width=35,height=15);page.insert_text((0,11),'pm.',fontsize=10)
        png=page.get_pixmap(matrix=fitz.Matrix(2,2)).tobytes('png')
    with fitz.open(path) as pdf:
        rect=pdf[0].search_for(PREFIX)[0]
        pdf[0].insert_image(fitz.Rect(rect.x1+35,rect.y0,rect.x1+70,rect.y0+15),stream=png)
        pdf.save(tmp_path/'blank-final.pdf')
    path.write_bytes((tmp_path/'blank-final.pdf').read_bytes())
    source=load_official_minutes(context['meeting'],root=tmp_path,people=closing.PEOPLE,cache_dir=tmp_path/'fresh')
    with fitz.open(path) as pdf:
        native=pdf[0].get_text();proof={'page':1,'native_text_sha256':closing.sha(native.encode()),'render_sha256':closing.sha(pdf[0].get_pixmap(matrix=fitz.Matrix(2,2)).tobytes('png'))}
    layout=subprocess.run(['pdftotext','-layout',str(path),'-'],check=True,capture_output=True,text=True).stdout
    block=source['blocks'][-1];admission['accepted_decisions'][0].update(source_key=source_identity(77,source,block)['key'],raw_block_sha256=digest(block),page_evidence=[proof])
    cap={'type':'reviewed_blank_time_adjournment_presence','authority':'documentary_preservation_only','result_policy':'preserve_unknown','time_policy':'preserve_unrecorded_no_value','motion_id':309,'legacy_text':rows[1]['text_content'],'claim_sha256':digest(project_claim(rows[1])),'claim_row_sha256':legacy.full_row_fingerprint(rows[1]),**proof,'native_passage':PREFIX,'native_passage_start':native.index(PREFIX),'source_passage':PREFIX,'source_passage_start':source['text'].index(PREFIX),'image_observation':{'time_field':'blank','printed_suffix':'pm.','native_extraction_omits_suffix':True},'first_review_sha256':closing.FIRST,'independent_review_sha256':closing.SECOND}
    admission.pop('closing_conflict_capabilities')
    admission.update(source_sha256=source['source_sha256'],file_inventory=reviewed_sources.source_inventory(tmp_path,context['meeting']),native_layout_sha256=closing.sha(layout.encode()),corrected_text_sha256=closing.sha(layout.encode()),native_first_page_sha256=closing.sha(native.encode()),pages=[proof],parsed_blocks_sha256=digest(source['blocks']),blank_time_documentary_capabilities=[cap])
    source=reviewed_sources.source_from_review(admission,meeting=context['meeting'],root=tmp_path,people=closing.PEOPLE,cache_dir=tmp_path/'fresh',project_ref='test-project',municipality_id=1)
    review.pop('closing_conflict_quarantines')
    review.update(source_sha256=source['source_sha256'],source_text_sha256=closing.sha(source['text'].encode()),formal_inventory_sha256=digest(source['formal_occurrence_inventory']),claim_inventory_sha256=build_claim_inventory(rows,meeting_id=77,expected_count=2)['fingerprint'],blank_time_documentary_preservations=[{'source_review_sha256':digest(admission),'capability':deepcopy(cap)}])
    context['source']=source;result=(context,rows,review,admission,stores);repin(result);return result

def repin(case):
    context,rows,review,admission,stores=case
    for module,name,value in [(reviewed_sources,'source',admission),(legacy,'legacy',review)]:
        stores[name].write_text(json.dumps(value,sort_keys=True));module.ENROLLED[77]=closing.sha(stores[name].read_bytes())
    context['source']=reviewed_sources.load_reviewed_minutes(context['meeting'],root=context['archive_root'],people=closing.PEOPLE,cache_dir=context['archive_root']/'fresh',project_ref='test-project',municipality_id=1)

def test_blank_clock_preserves_unknown_row_and_partial_receipt_without_new_authority(case):
    context,rows,*_=case;before=deepcopy(rows);result=closing.plan(case)
    assert [m['text_content'] for m in result['new_motions']]==[closing.TEXT]
    assert result['source_report']['blank_time_documentary_preserved_legacy_ids']==[309]
    assert result['source_report']['unmapped_legacy_ids']==[] and remaining_coverage(result)=='review_required'
    assert any(h['reason']=='reviewed_blank_time_adjournment_preserved_time_unknown_no_rewrite' for h in result['held'])
    assert rows==before and rows[1]['result'] is None
    assert all(result['new_motions'][0][k] is None for k in ('mover','seconder','mover_id','seconder_id'))
    context.pop('allow_reviewed_legacy_reservations');ordinary=closing.plan(case)
    assert ordinary['new_motions']==[] and ordinary['source_report']['unmapped_legacy_ids']==[309]

@pytest.mark.parametrize('change',['nonzero_votes','missing_votes','row_drift','manual_meta','actor','claimed_result','invented_time','unchecked_capability','same_reviews','wrong_suffix','source_prefix','scope','formal_key','unknown_meta'])
def test_blank_clock_failures_never_unlock_new_facts(case,change):
    context,rows,review,admission,_=case;entry=review['blank_time_documentary_preservations'][0];cap=entry['capability']
    if change=='nonzero_votes':context['closing_linked_vote_counts']['counts'][0]['linked_votes']=1
    elif change=='missing_votes':context.pop('closing_linked_vote_counts')
    elif change=='row_drift':rows[1]['created_at']='changed'
    elif change in ('manual_meta','unknown_meta'):rows[1]['meta']={change:'evidence'}
    elif change=='actor':rows[1]['mover']='Someone'
    elif change=='claimed_result':rows[1]['result']='CARRIED'
    elif change=='invented_time':cap['time_policy']='8:30 pm'
    elif change=='unchecked_capability':admission['blank_time_documentary_capabilities']=[]
    elif change=='same_reviews':cap['independent_review_sha256']=cap['first_review_sha256']
    elif change=='wrong_suffix':cap['image_observation']['printed_suffix']='am.'
    elif change=='source_prefix':cap['source_passage']='If '+PREFIX
    elif change=='scope':review['municipality_id']=2
    else:cap['source_key']='a'*64
    if change in ('manual_meta','unknown_meta','actor','claimed_result'):
        cap.update(claim_sha256=digest(project_claim(rows[1])),claim_row_sha256=legacy.full_row_fingerprint(rows[1]))
        review['claim_inventory_sha256']=build_claim_inventory(rows,meeting_id=77,expected_count=len(rows))['fingerprint']
    if change!='unchecked_capability':admission['blank_time_documentary_capabilities']=[deepcopy(cap)]
    entry['source_review_sha256']=digest(admission);repin(case)
    assert closing.plan(case)['new_motions']==[]


@pytest.mark.parametrize('case',[
    {'extra':'The Chair adjourned the meeting at 6:30 pm.\n'},
    {'extra':'Mayor Young adjourned the meeting at 6:30 pm.\n'},
    {'extra':'MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\nThat the meeting be adjourned.\nCARRIED.\n'},
    {'extra':'M0VED BY: Colby Harder\nSECONDED: Kimberley Guiry\nThat the meeting be adjourned.\nCARRIED.\n'},
    {'extra':'MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\nThat Council adjourn the meeting.\nCARRIED.\n','expected_detail':'formal ownership'},
    {'extra':'M0VED BY: Colby Harder\nSECONDED: Kimberley Guiry\nThat Council adjourn the meeting.\nCARRIED.\n','expected_detail':'formal ownership'},
    {'narration':PREFIX+'\n8:30 pm.','expected_detail':'unique final adjournment passage'},
    {'narration':'If '+PREFIX},
    {'narration':PREFIX+' 8:30 pm.'},
    {'narration':'Proposal: '+PREFIX},
],indirect=True)
def test_blank_time_competing_formal_or_nonclosing_passage_is_held(case,request):
    result=closing.plan(case)
    assert result['new_motions']==[]
    detail=request.node.callspec.params['case'].get('expected_detail')
    if detail:assert any(detail in h.get('detail','') for h in result['source_report']['held'])
