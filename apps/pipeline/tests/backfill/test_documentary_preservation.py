"""A reviewed nonformal legacy row may be preserved, never promoted to a motion."""
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
import json
import hashlib

import fitz
import pytest

from ingestion.ballot_fixture import official_context, PEOPLE, TEXT
from pipeline.backfill import legacy_occurrence_reviews as reviews
from pipeline.ingestion.canonical_motions import canonical_motion_plan, source_identity
from pipeline.ingestion.official_ballots import load_official_minutes, minutes_text_source
from pipeline.ingestion.source_claims import build_claim_inventory, digest, project_claim

def full_row_proof(row):
    # Independently specify the persisted JSON fingerprint contract, including
    # actual psycopg timestamp/Decimal values and every manual metadata field.
    return hashlib.sha256(json.dumps(row,sort_keys=True,separators=(',',':'),ensure_ascii=False,default=str).encode()).hexdigest()


DOC = 'THAT Council approve the agenda as presented.'
NATIVE_DOC = 'THATCouncil approve the agenda as presented.'


@pytest.fixture
def case(tmp_path, monkeypatch, request):
    config=getattr(request,'param',{})
    printed=config.get('printed',DOC);native_body=config.get('native',NATIVE_DOC);legacy_body=config.get('legacy',DOC)
    formal_body=config.get('formal',TEXT)
    context = official_context(tmp_path)
    if config.get('meeting_type'):
        context['meeting']['type'] = config['meeting_type']
    path = tmp_path/'archive/meeting/Minutes/Minutes - SIGNED.pdf'
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((30,40), 'City of Langford\n'+config.get('source_label','Council Minutes')+'\nJanuary 8, 2026\nPRESENT:\nMayor S. Goodmanson\nCouncillor C. Harder\nCouncillor K. Guiry\nATTENDING:\nStaff\n3. APPROVAL OF THE AGENDA\n'+native_body+'\n4. PUBLIC HEARINGS', fontsize=11)
        page = pdf.new_page()
        page.insert_text((30,40), 'MOVED BY: Colby Harder\nSECONDED: Kimberley Guiry\n'+formal_body+'\nMotion CARRIED.', fontsize=10)
        pdf.save(path)
    source = load_official_minutes(context['meeting'],root=tmp_path,people=PEOPLE,cache_dir=tmp_path/'cache')
    if config.get('correct_source'):
        source=minutes_text_source(context['meeting'],root=tmp_path,people=PEOPLE,cache_dir=tmp_path/'cache',path=path,
            text=source['text'].replace(native_body,printed,1),source_format=source['source_format'],source_sha256=source['source_sha256'])
    source_body=printed if config.get('correct_source') else native_body
    old = {'id':309,'meeting_id':77,'text_content':legacy_body,'result':None,'mover_id':None,'seconder_id':None,
           'meta':{'manual_evidence':{'keep':'unchanged'}},'created_at':datetime(2026,1,8,tzinfo=timezone.utc),
           'financial_cost':Decimal('12.50')}
    inventory = build_claim_inventory([old],meeting_id=77,expected_count=1)
    with fitz.open(path) as pdf:
        native = pdf[0].get_text()
        entry = {'motion_id':309,'claim_sha256':digest(project_claim(old)),'claim_row_sha256':full_row_proof(old),
                 'legacy_text':legacy_body,'printed_body':printed,'authority':'documentary_preservation_only',
                 'result_policy':'preserve_unknown','page':1,'native_text_sha256':hashlib.sha256(native.encode()).hexdigest(),
                 'render_sha256':hashlib.sha256(pdf[0].get_pixmap(matrix=fitz.Matrix(1.5,1.5)).tobytes('png')).hexdigest(),
                 'native_passage':native_body,'native_passage_start':native.index(native_body),
                 'source_passage':source_body,'source_passage_start':source['text'].index(source_body)}
    if config.get('type'):entry['type']=config['type']
    review = {'schema':'reviewed-legacy-occurrence-reservations-v1','meeting_id':77,'project_ref':'test-project','municipality_id':1,
              'source_sha256':source['source_sha256'],'source_url':source['source_url'],'source_file':source['source_file'],
              'source_date':source['local_date'],'source_text_sha256':hashlib.sha256(source['text'].encode()).hexdigest(),
              'formal_inventory_sha256':digest(source['formal_occurrence_inventory']),'claim_inventory_sha256':inventory['fingerprint'],
              'native_pages':[],'reservations':[],'documentary_preservations':[entry],
              'render_scale':1.5,'pymupdf_version':fitz.VersionBind}
    monkeypatch.setattr(reviews,'load_review',lambda meeting_id:deepcopy(review))
    context.update(source=source,meeting_claim_inventory=inventory,allow_reviewed_legacy_reservations=True,
                   project_ref='test-project',municipality_id=1,archive_root=tmp_path)
    return context,[old],review


def plan(context, rows):
    items, report = canonical_motion_plan([],context,rows)
    return [motion for item in items for motion in item['motions']], report


def refresh_claim_proof(context, rows, review):
    context['meeting_claim_inventory'] = build_claim_inventory(rows,meeting_id=77,expected_count=len(rows))
    review['claim_inventory_sha256'] = context['meeting_claim_inventory']['fingerprint']
    entry = review['documentary_preservations'][0]
    entry.update(claim_sha256=digest(project_claim(rows[0])),claim_row_sha256=full_row_proof(rows[0]),legacy_text=rows[0]['text_content'])


def test_reviewed_documentary_claim_unlocks_only_new_formal_rows_without_rewriting_unknown(case):
    context, rows, review = case
    before = deepcopy(rows)
    expected_key = source_identity(77,context['source'],context['source']['blocks'][0])['key']
    motions, report = plan(context,rows)
    assert [motion['motion_text'] for motion in motions] == [TEXT]
    assert motions[0]['_existing_motion'] is None
    assert motions[0]['_canonical_source_motion']['key'] == expected_key
    assert report['unmapped_legacy_ids'] == []
    assert report['documentary_preserved_legacy_ids'] == [309]
    held = [entry for entry in report['held'] if entry['reason']=='reviewed_documentary_claim_preserved_no_rewrite']
    assert len(held)==1 and held[0]['legacy_ids']==[309] and 'source_key' not in held[0]
    assert report['source_motions']==1 and report['formal_source_coverage']=='all_formal_envelopes_accounted_for'
    assert rows == before and rows[0]['result'] is None
    # The same enrolled fingerprint must validate actual DB values and the
    # operator's JSON snapshot, without dropping timestamp/decimal fields.
    snapshot=json.loads(json.dumps(rows,default=str))
    retried,retried_report=plan(context,snapshot)
    assert [m['_canonical_source_motion']['key'] for m in retried]==[expected_key]
    assert retried_report['documentary_preserved_legacy_ids']==[309]
    context.pop('allow_reviewed_legacy_reservations')
    motions, report = plan(context,rows)
    assert motions==[] and report['unmapped_legacy_ids']==[309]
    assert rows==before


@pytest.mark.parametrize('change',['row_meta_drift','inventory_drift','native_hash','render_hash','version','source_hash',
    'source_text','date','tenant','project','nonexact_body','substring_only','absent_body','absent_passage','duplicate_entry',
    'claimed_outcome','claimed_actor','formal_authority','competing_claim','formal_overlap','multiple_occurrences','partial_line','native_repetition'])
def test_documentary_proof_cannot_hide_drift_collision_or_formal_authority(case,change):
    context, rows, review = case
    entry = review['documentary_preservations'][0]
    if change=='row_meta_drift': rows[0]['meta']['manual_evidence']['keep']='changed'
    elif change=='inventory_drift': review['claim_inventory_sha256']='bad'
    elif change=='native_hash':entry['native_text_sha256']='bad'
    elif change=='render_hash':entry['render_sha256']='bad'
    elif change=='version':review['pymupdf_version']='different'
    elif change=='source_hash':review['source_sha256']='bad'
    elif change=='source_text':context['source']['text']+=' correction'
    elif change=='date':review['source_date']='2026-01-09'
    elif change=='tenant':review['municipality_id']=2
    elif change=='project':review['project_ref']='other'
    elif change=='nonexact_body':entry['printed_body']=DOC.replace('approve','approve only')
    elif change=='substring_only':
        rows[0]['text_content']='approve the agenda as presented.'
        refresh_claim_proof(context,rows,review)
        body=rows[0]['text_content']
        entry.update(printed_body=body,native_passage=body,source_passage=body,
            native_passage_start=entry['native_passage_start']+len('THATCouncil '),
            source_passage_start=entry['source_passage_start']+len('THATCouncil '))
    elif change=='absent_passage':entry['source_passage_start']+=1
    elif change=='duplicate_entry':review['documentary_preservations'].append(deepcopy(entry))
    elif change=='claimed_outcome':
        rows[0]['result']='CARRIED';refresh_claim_proof(context,rows,review)
    elif change=='claimed_actor':
        rows[0]['mover_id']=21;refresh_claim_proof(context,rows,review)
    elif change=='formal_authority':
        rows[0]['meta']['canonical_source_motion']=source_identity(77,context['source'],context['source']['blocks'][0])
        refresh_claim_proof(context,rows,review)
    elif change=='competing_claim':
        rows.append({**deepcopy(rows[0]),'id':310});refresh_claim_proof(context,rows,review)
    elif change=='formal_overlap':
        # The source-wide body offset is correct, but this reviewed span is a
        # claimed formal occurrence: documentary preservation must reject it.
        source=context['source'];start=entry['source_passage_start']
        source['formal_occurrence_inventory']['envelopes'].append({'source_start':start,'outcome_end':start+len(DOC),
            'anchor_offset':start,'body_start':start,'outcome_offset':start+len(DOC),'body_compact':'','kind':'seconded_motion'})
        review['formal_inventory_sha256']=digest(source['formal_occurrence_inventory'])
    elif change=='native_repetition':
        path=context['archive_root']/context['source']['source_file']
        with fitz.open(path) as pdf:
            page=pdf.new_page();page.insert_text((30,40),NATIVE_DOC);pdf.saveIncr()
        context['source']['source_sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
        review['source_sha256']=context['source']['source_sha256']
    else:
        if change=='absent_body':
            context['source']['text']=context['source']['text'].replace(NATIVE_DOC,'No agenda body recorded.')
        elif change=='partial_line':
            context['source']['text']=context['source']['text'].replace(NATIVE_DOC,'Discussion: '+NATIVE_DOC)
            entry['source_passage_start']+=len('Discussion: ')
        else:
            context['source']['text']+='\n'+NATIVE_DOC
        context['source']['formal_occurrence_inventory']['text_sha256']=hashlib.sha256(context['source']['text'].encode()).hexdigest()
        review['source_text_sha256']=hashlib.sha256(context['source']['text'].encode()).hexdigest()
        review['formal_inventory_sha256']=digest(context['source']['formal_occurrence_inventory'])
    before=deepcopy(rows)
    motions, report = plan(context,rows)
    assert motions==[] and rows==before
    assert report['status']=='reviewed_legacy_occurrence_review_stale'
    if change in ('substring_only','partial_line'):
        assert 'complete printed line body' in report['held'][0]['detail']
    elif change in ('absent_body','multiple_occurrences','native_repetition'):
        assert 'absent or not unique' in report['held'][0]['detail']
    elif change=='formal_overlap':
        assert 'overlaps formal authority' in report['held'][0]['detail']


NARRATION_CASE = {'legacy':'That the meeting be adjourned.',
    'printed':'The Chair adjourned the meeting at 8:37pm.',
    'native':'The Chair adjourn ed the meeting at 8:37pm.',
    'type':'reviewed_adjournment_narration_preservation'}
MAYOR_CASE = {**NARRATION_CASE,'legacy':'THAT the meeting be adjourned.',
    'printed':'Mayor Young adjourned the meeting at 8:50 pm.',
    'native':'Mayor Young adjourned the meeting at 8:50 pm.'}

MOTION_CASE = {**NARRATION_CASE, 'legacy':'Motion to adjourn the meeting.'}
MOTION_MAYOR_CASE = {**MAYOR_CASE, 'legacy':'MOTION TO ADJOURN THE MEETING.'}
ADJOURNMENT_CASE = {**NARRATION_CASE, 'legacy':'Adjournment of the meeting.'}
ACTING_MAYOR_CASE = {**MAYOR_CASE,
    'printed':'Acting Mayor Wade adjourned the meeting at 9:36 pm.',
    'native':'Acting Mayor Wade adjourned the meeting at 9:36 pm.'}
SPECIAL_COUNCIL_CASE = {**NARRATION_CASE,
    'legacy':'THAT the Special Council meeting be adjourned.',
    'meeting_type':'Special Council','source_label':'Special Council Minutes'}


@pytest.mark.parametrize('case',[NARRATION_CASE,MAYOR_CASE,MOTION_CASE,MOTION_MAYOR_CASE,ADJOURNMENT_CASE,
    ACTING_MAYOR_CASE,SPECIAL_COUNCIL_CASE],indirect=True)
def test_explicit_reviewed_adjournment_narration_preserves_generic_claim_without_certifying_transcription(case):
    context,rows,review=case;before=deepcopy(rows)
    motions,report=plan(context,rows)
    assert [m['motion_text'] for m in motions]==[TEXT]
    assert report['documentary_preserved_legacy_ids']==[309]
    assert report['adjournment_narration_preserved_legacy_ids']==[309]
    held=[h for h in report['held'] if h['reason']=='reviewed_adjournment_narration_preserved_no_rewrite']
    assert len(held)==1 and 'source_key' not in held[0]
    assert rows==before and rows[0]['result'] is None
    assert all(m['_existing_motion'] is None for m in motions)
    # The literal type must still reject this paraphrase correspondence.
    review['documentary_preservations'][0].pop('type')
    motions,report=plan(context,rows)
    assert motions==[] and report['status']=='reviewed_legacy_occurrence_review_stale'


@pytest.mark.parametrize('case',[
    {**SPECIAL_COUNCIL_CASE,'meeting_type':'Regular Council'},
    {**SPECIAL_COUNCIL_CASE,'source_label':'Council Minutes'}],indirect=True)
def test_special_council_closing_needs_matching_catalog_and_original_header(case):
    context,rows,review=case;before=deepcopy(rows)
    motions,report=plan(context,rows)
    assert motions==[] and report['status']=='reviewed_legacy_occurrence_review_stale'
    assert rows==before


@pytest.mark.parametrize('case',[NARRATION_CASE,MAYOR_CASE,MOTION_CASE,MOTION_MAYOR_CASE,ADJOURNMENT_CASE],indirect=True)
@pytest.mark.parametrize('change',['other_proposal','claimed_outcome','claimed_actor','conditional','negated','other_actor','proposed_event','multiple_surname','no_time','two_events','native_second_event','competing_generic','unknown_type'])
def test_typed_adjournment_review_does_not_admit_arbitrary_paraphrase_or_ambiguous_event(case,change):
    context,rows,review=case;entry=review['documentary_preservations'][0]
    if change=='other_proposal':
        rows[0]['text_content']='That Council approve the budget.';refresh_claim_proof(context,rows,review)
    elif change=='claimed_outcome':
        rows[0]['result']='CARRIED';refresh_claim_proof(context,rows,review)
    elif change=='claimed_actor':
        rows[0]['mover_id']=21;refresh_claim_proof(context,rows,review)
    elif change=='conditional':entry['printed_body']='If '+entry['printed_body']
    elif change=='negated':entry['printed_body']=entry['printed_body'].replace(' adjourned ',' did not adjourn ')
    elif change=='other_actor':entry['printed_body']='The applicant adjourned the meeting at 8:50 pm.'
    elif change=='proposed_event':entry['printed_body']=entry['printed_body'].replace(' adjourned ',' proposed adjourning ')
    elif change=='multiple_surname':entry['printed_body']='Mayor Mary Young adjourned the meeting at 8:50 pm.'
    elif change=='no_time':entry['printed_body']=entry['printed_body'].split(' at ')[0]+'.'
    elif change=='two_events':
        other_role='Mayor Young' if entry['printed_body'].startswith('The Chair') else 'The Chair'
        context['source']['text']+='\n'+other_role+' adjourned the meeting at 9:00pm.'
        context['source']['formal_occurrence_inventory']['text_sha256']=hashlib.sha256(context['source']['text'].encode()).hexdigest()
        review['source_text_sha256']=hashlib.sha256(context['source']['text'].encode()).hexdigest()
        review['formal_inventory_sha256']=digest(context['source']['formal_occurrence_inventory'])
    elif change=='native_second_event':
        other_role='Mayor Young' if entry['printed_body'].startswith('The Chair') else 'The Chair'
        path=context['archive_root']/context['source']['source_file']
        with fitz.open(path) as pdf:
            page=pdf.new_page();page.insert_text((30,40),other_role+' adjourned the meeting at 9:00pm.');pdf.saveIncr()
        context['source']['source_sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
        review['source_sha256']=context['source']['source_sha256']
    elif change=='competing_generic':
        rows.append({**deepcopy(rows[0]),'id':310,'text_content':'That meeting be adjourned.'});refresh_claim_proof(context,rows,review)
    else:entry['type']='arbitrary_paraphrase_preservation'
    motions,report=plan(context,rows)
    assert motions==[] and report['status']=='reviewed_legacy_occurrence_review_stale'
    if change=='native_second_event':
        assert 'Native documentary narration is not unique' in report['held'][0]['detail']


@pytest.mark.parametrize('case',[{**NARRATION_CASE,'formal':'That the meeting be adjourned.'},
    {**MAYOR_CASE,'formal':'THAT the meeting be adjourned.'},
    {**MOTION_CASE,'formal':'That the meeting be adjourned.'},
    {**MOTION_MAYOR_CASE,'formal':'Motion to adjourn the meeting.'},
    {**ADJOURNMENT_CASE,'formal':'Adjournment of the meeting.'},
    {**ACTING_MAYOR_CASE,'formal':'That the meeting be adjourned.'},
    {**SPECIAL_COUNCIL_CASE,'formal':'THAT the Special Council meeting be adjourned.'},
    {**MOTION_CASE,'formal':'Thatthemeetingbeadjourned.'},
    {**MOTION_CASE,'formal':'Thatthemeetingbeadjourned'}],indirect=True)
@pytest.mark.parametrize('missing_envelopes',[False,True])
def test_formal_adjournment_owner_cannot_be_reclassified_as_documentary_narration(case,missing_envelopes):
    context,rows,review=case;before=deepcopy(rows)
    if missing_envelopes:
        context['source']['formal_occurrence_inventory']['envelopes']=[]
        review['formal_inventory_sha256']=digest(context['source']['formal_occurrence_inventory'])
    motions,report=plan(context,rows)
    assert motions==[] and report['status']=='reviewed_legacy_occurrence_review_stale'
    assert rows==before
    assert 'equivalent formal owner' in report['held'][0]['detail']


GLYPH_CASE={**NARRATION_CASE,'correct_source':True,'native':'The Chair adjourn V\ned the meeting at 8:37pm.'}


def enroll_native_correction(context,review,tmp_path,monkeypatch):
    """Exercise the real separately pinned source-artifact gate, not its validator."""
    from pipeline.backfill import reviewed_sources
    entry=review['documentary_preservations'][0]
    independent='a'*64
    correction={k:entry[k] for k in ('page','native_text_sha256','render_sha256')}
    correction.update(native_quote=entry['native_passage'],printed_quote=entry['printed_body'],
        independent_review_sha256=independent,authority='reviewed_documentary_native_witness_correction_only')
    admission={'schema':'reviewed-original-minutes-v1','project_ref':'test-project','municipality_id':1,
        'catalog':context['meeting'],'file_inventory':reviewed_sources.source_inventory(context['archive_root'],context['meeting']),
        'selected_file':context['source']['source_file'],'source_sha256':context['source']['source_sha256'],'source_url':context['source']['source_url'],
        'review_status':'independently_reviewed_original_source','mode':'reviewed_native_image_decisions',
        'pages':[{k:entry[k] for k in ('page','native_text_sha256','render_sha256')}],
        'render_scale':review['render_scale'],'pymupdf_version':fitz.VersionBind,
        'independent_original_image_review_sha256':independent,'documentary_native_corrections':[correction]}
    store=tmp_path/'source-reviews';store.mkdir();path=store/'77.json'
    path.write_text(json.dumps(admission,sort_keys=True))
    monkeypatch.setattr(reviewed_sources,'STORE',store)
    monkeypatch.setattr(reviewed_sources,'ENROLLED',{77:hashlib.sha256(path.read_bytes()).hexdigest()})
    context['source'].update(source_format='original_pdf_reviewed_image_decisions',
        source_review_evidence={'review_sha256':digest(admission),'mode':admission['mode']})
    entry['native_correction']=deepcopy(correction)
    return admission,path,reviewed_sources


@pytest.mark.parametrize('case',[GLYPH_CASE,{**GLYPH_CASE,
    'printed':'The Chair adjourned the meeting at 7:03 p.m.',
    'native':'The Chair adjourned th\neting at 7:03 p.m.'}],indirect=True)
def test_signature_glyph_witness_requires_separately_enrolled_image_correction(case,tmp_path,monkeypatch):
    context,rows,review=case
    motions,report=plan(context,rows)
    assert motions==[] and report['status']=='reviewed_legacy_occurrence_review_stale'
    before=deepcopy(rows)
    enroll_native_correction(context,review,tmp_path,monkeypatch)
    motions,report=plan(context,rows)
    assert [m['motion_text'] for m in motions]==[TEXT]
    assert report['adjournment_narration_preserved_legacy_ids']==[309] and rows==before
    # This is a native witness only; the old generic claim remains unchanged.
    assert rows[0]['text_content']=='That the meeting be adjourned.'
    assert 'source_key' not in report['held'][0]


@pytest.mark.parametrize('case',[GLYPH_CASE],indirect=True)
@pytest.mark.parametrize('change',['unenrolled','artifact_bytes','unchecked_entry','review_digest','independent_hash','duplicate_correction','wrong_page','raw_quote','printed_time','literal_type'])
def test_signature_correction_cannot_bypass_real_artifact_and_independent_proof_gate(case,tmp_path,monkeypatch,change):
    context,rows,review=case
    admission,path,reviewed_sources=enroll_native_correction(context,review,tmp_path,monkeypatch)
    entry=review['documentary_preservations'][0]
    if change=='unenrolled':monkeypatch.setattr(reviewed_sources,'ENROLLED',{})
    elif change=='artifact_bytes':path.write_text(path.read_text()+' ')
    elif change=='unchecked_entry':entry['native_correction']['authority']='unchecked'
    elif change=='review_digest':context['source']['source_review_evidence']['review_sha256']='b'*64
    elif change=='independent_hash':entry['native_correction']['independent_review_sha256']='c'*64
    elif change=='duplicate_correction':
        admission['documentary_native_corrections'].append(deepcopy(entry['native_correction']))
        path.write_text(json.dumps(admission,sort_keys=True))
        monkeypatch.setattr(reviewed_sources,'ENROLLED',{77:hashlib.sha256(path.read_bytes()).hexdigest()})
        context['source']['source_review_evidence']['review_sha256']=digest(admission)
    elif change=='wrong_page':entry['native_correction']['page']=2
    elif change=='raw_quote':entry['native_correction']['native_quote']=entry['native_passage'].replace('V','X')
    elif change=='printed_time':entry['native_correction']['printed_quote']=entry['printed_body'].replace('8:37','8:38')
    else:entry['type']='reviewed_literal_documentary_preservation'
    before=deepcopy(rows);motions,report=plan(context,rows)
    assert motions==[] and rows==before and report['status']=='reviewed_legacy_occurrence_review_stale'
