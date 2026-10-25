"""Catch-up can account for omitted framing, never missing operative clauses."""
from copy import deepcopy

import pytest
import fitz

from ingestion.ballot_fixture import official_context, TEXT, PEOPLE
from pipeline.ingestion.official_ballots import load_official_minutes
from pipeline.ingestion.canonical_motions import canonical_motion_plan
from pipeline.ingestion.source_claims import build_claim_inventory


@pytest.fixture
def case(tmp_path):
    context=official_context(tmp_path)
    path=tmp_path/context['source']['source_file'];html=path.read_text()
    tail=html[html.index('<div class="AgendaItemMotion">'):]
    path.write_text(html[:-6]+tail[:-6].replace('2269','2270')+'</div>')
    old={'id':309,'meeting_id':77,'agenda_item_id':99,'text_content':TEXT.removeprefix('THAT Council '),
         'result':None,'meta':{'manual_evidence':'preserve'}}
    context.update(source=load_official_minutes(context['meeting'],root=tmp_path,people=PEOPLE,cache_dir=tmp_path/'cache'),
        meeting_claim_inventory=build_claim_inventory([old],meeting_id=77,expected_count=1),
        allow_reviewed_legacy_reservations=True,project_ref='test-project',municipality_id=1,archive_root=tmp_path)
    return context,[old],path


def additions(context,old):
    items,report=canonical_motion_plan([],context,old)
    return [m for item in items for m in item['motions'] if not m.get('_existing_motion')],report


def test_full_body_scaffold_equivalence_accounts_occurrence_only_in_catchup(case):
    context,old,path=case;before=deepcopy(old)
    rows,report=additions(context,old)
    assert [m['motion_text'] for m in rows]==[TEXT.replace('2269','2270')]
    assert report['unmapped_legacy_ids']==[]
    assert any(h['reason']=='exact_scaffold_occurrence_reserved_no_rewrite' for h in report['held'])
    assert old==before and old[0]['result'] is None
    context.pop('allow_reviewed_legacy_reservations')
    rows,report=additions(context,old)
    assert rows==[] and report['unmapped_legacy_ids']==[309]


@pytest.mark.parametrize('change',['partial_clause','wrong_number','different_role','competing','repeated_source','context_only','inventory_changed'])
def test_scaffold_accounting_cannot_hide_operative_or_ownership_differences(case,change):
    context,old,path=case
    if change=='partial_clause':old[0]['text_content']=old[0]['text_content'].replace(' as presented','')
    elif change=='wrong_number':old[0]['text_content']=old[0]['text_content'].replace('2269','2299')
    elif change=='different_role':old[0]['text_content']='THAT Committee '+old[0]['text_content']
    elif change=='competing':old.append({**old[0],'id':310,'text_content':TEXT})
    elif change=='repeated_source':path.write_text(path.read_text().replace('2270','2269'))
    elif change=='context_only':
        html=path.read_text().replace('2269','2271').replace('<div class="PostMotionText">','<div class="PostMotionText">'+old[0]['text_content'])
        path.write_text(html)
    else:old[0]['result']='CARRIED'
    context['source']=load_official_minutes(context['meeting'],root=context['archive_root'],people=PEOPLE,cache_dir=context['archive_root']/'cache')
    if change!='inventory_changed':context['meeting_claim_inventory']=build_claim_inventory(old,meeting_id=77,expected_count=len(old))
    before=deepcopy(old);rows,report=additions(context,old)
    assert rows==[] and old==before
    if change=='inventory_changed':assert report['status']=='meeting_claim_inventory_changed'
    else:assert 309 in report['unmapped_legacy_ids']


def test_raw_native_claim_with_page_headers_still_competes_for_same_occurrence(tmp_path):
    context=official_context(tmp_path)
    path=tmp_path/'archive/meeting/Minutes/Minutes - SIGNED.pdf'
    with fitz.open() as document:
        page=document.new_page()
        page.insert_text((30,40),'City of Langford\nCouncil Minutes\nJanuary 8, 2026\nPRESENT:\nMayor S. Goodmanson\nCouncillor C. Harder\nCouncillor K. Guiry\nATTENDING:\nStaff',fontsize=11)
        page.insert_text((50,280),'MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\nTHAT Council require a registered covenant before adoption',fontsize=11)
        page=document.new_page()
        page.insert_text((330,25),'Minutes of Regular Council',fontsize=10)
        page.insert_text((400,42),'January 8, 2026',fontsize=10)
        page.insert_text((440,57),'Page 2 of 2',fontsize=10)
        page.insert_text((50,140),'and require two affordable homes before occupancy.',fontsize=11)
        page.insert_text((400,200),'CARRIED.',fontsize=11)
        document.save(path)
    source=load_official_minutes(context['meeting'],root=tmp_path,people=PEOPLE,cache_dir=tmp_path/'cache')
    from pipeline.ingestion.canonical_motions import operative_view
    block=source['blocks'][0];view=operative_view(source,block)
    assert view['status']=='explicit_operative' and len(view['excluded_spans'])==2
    old=[{'id':309,'meeting_id':77,'text_content':'require a registered covenant before adoption and require two affordable homes before occupancy.','result':None,'meta':{}},
         {'id':310,'meeting_id':77,'text_content':block['motion_text'],'result':None,'meta':{}}]
    context.update(source=source,allow_reviewed_legacy_reservations=True,project_ref='test-project',municipality_id=1,archive_root=tmp_path,
                   meeting_claim_inventory=build_claim_inventory(old,meeting_id=77,expected_count=2))
    before=deepcopy(old);rows,report=additions(context,old)
    assert rows==[] and old==before
    assert 309 in report['unmapped_legacy_ids']
