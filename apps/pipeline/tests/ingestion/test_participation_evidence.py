"""Real source-window/proposal contract; no identity or publication side effects."""
from copy import deepcopy
import pytest
from pipeline.ingestion import participation_evidence as pe

ITEM={'id':1,'meeting_id':2,'title':'Public participation','discussion_start_time':10.,'discussion_end_time':20.}
ROWS=[{'id':3,'meeting_id':2,'start_time':10.,'end_time':15.,'text_content':'My name is Chris Foxhall. I oppose this road.', 'speaker_name':'Speaker_1'},
      {'id':4,'meeting_id':2,'start_time':15.,'end_time':20.,'text_content':'I ask for a crossing.', 'speaker_name':'Speaker_2'}]

def proposal():
 return {'overview':'Two residents address road safety.','no_public_speech_reason':'','speakers':[
  {'who':'Chris Foxhall','position':'opposes','point':'Opposes the road.','topic':'Road safety','source_segment_ids':[3],'support_quote':'I oppose this road.','introduction_quote':'My name is Chris Foxhall.'},
  {'who':'Invented Person','position':'asks','point':'Asks for a crossing.','topic':'Road safety','source_segment_ids':[4],'support_quote':'I ask for a crossing.','introduction_quote':''}]}

def prepare(p):
 return pe.prepare_candidate(p,window=pe.source_window(ITEM,ROWS),people=[{'id':9,'name':'Chris Foxall'}],statement_names=[],streets={'streets':[]},excluded_names=[])

def test_complete_source_proposal_preserves_order_and_requires_own_intro_for_name():
 before=deepcopy(ROWS);r=prepare(proposal())
 assert [s['who']for s in r['speakers']]==['Chris Foxall','A resident']
 assert [p['source_segment_ids']for p in r['validation']['speaker_proofs']]==[[3],[4]]
 assert r['validation']['names'].endswith('not_voice_identity') and ROWS==before

@pytest.mark.parametrize('change,reason',[
 ('borrow_quote','support_quote_not_literal_in_own_source'),
 ('reverse','speaker_order_not_source_order'),
 ('mixed_row','mixed_source_segment_requires_measured_speaker_boundaries')])
def test_source_admission_rejects_wrong_witness_for_specific_reason(change,reason):
 p=proposal()
 if change=='borrow_quote':p['speakers'][0]['support_quote']='I ask for a crossing.'
 if change=='reverse':p['speakers'].reverse()
 if change=='mixed_row':p['speakers'][1]['source_segment_ids']=[3]
 with pytest.raises(ValueError,match=reason):prepare(p)

def test_boundary_public_speech_is_held_but_short_procedural_context_stays_auditable():
 rows=deepcopy(ROWS);rows.insert(0,{'id':1,'meeting_id':2,'start_time':9.,'end_time':10.5,'text_content':'My name is Pat. I oppose the road.'})
 assert pe.source_window(ITEM,rows)['reason']=='window_cuts_unmeasured_source_segment'
 rows[0]['text_content']='The next item is public participation.'
 w=pe.source_window(ITEM,rows)
 assert w['status']=='ready'and w['boundary_context'][0]['id']==1
 assert [s['id']for s in w['segments']]==[3,4]
 assert 'public participation' in pe.source_prompt(ITEM,w,[])

def test_long_window_is_held_instead_of_silently_truncating():
 rows=deepcopy(ROWS);rows[0]['text_content']='x'*60001
 assert pe.source_window(ITEM,rows)['reason']=='source_window_requires_reviewed_chunking'

def test_independent_review_must_agree_on_count_and_every_gate():
 c=prepare(proposal());r={'approved':True,'public_speaker_count':2,'speaking_order_correct':True,'excludes_council_staff_and_procedure':True,'points_and_topics_supported':True,'no_omitted_public_speakers':True,'names_and_locations_supported':True,'privacy_safe':True,'issues':[]}
 assert pe.review_passed(r,c)
 for key in ['speaking_order_correct','excludes_council_staff_and_procedure','points_and_topics_supported','no_omitted_public_speakers','names_and_locations_supported','privacy_safe']:
  assert not pe.review_passed({**r,key:False},c)
 assert not pe.review_passed({**r,'public_speaker_count':1},c)

@pytest.mark.parametrize('reject_review',[False,True])
@pytest.mark.parametrize('chunked',[False,True])
def test_ingestion_entrypoint_reviews_before_publishing_and_preserves_other_metadata(monkeypatch,reject_review,chunked):
 from types import SimpleNamespace
 from pipeline.ingestion import participation_summaries as ps
 item={**ITEM,'meta':{'foreign_link':17}}
 rows={'agenda_items':[item],'transcript_segments':ROWS,
       'people':[{'id':9,'name':'Chris Foxall'}], 'key_statements':[],
       'memberships':[], 'meetings':[{'meeting_date':'2024-01-01','meta':{}}],
       'documents':[], 'public_speaker_names':[]}
 updates=[];calls=[];named=[]
 if chunked:
  rows['transcript_segments']=[{**ROWS[0],'id':i,'start_time':10.+i,'end_time':11.+i,
   'text_content':'My name is Alex. I ask for a crossing. '+'Public discussion. '*1000}for i in range(4)]
 class Query:
  def __init__(self,table):self.table=table;self.one=False;self.payload=None;self.bounds=None
  def select(self,*a):return self
  def eq(self,*a):return self
  def lt(self,*a):return self
  def gt(self,*a):return self
  def order(self,*a):return self
  def range(self,a,b):self.bounds=(a,b);return self
  def single(self):self.one=True;return self
  def update(self,p):self.payload=p;return self
  def in_(self,*a):return self
  def delete(self):return self
  def upsert(self,p,**k):named.extend(p);return self
  def execute(self):
   if self.payload:updates.append(self.payload)
   values=rows[self.table]
   if self.bounds:values=values[self.bounds[0]:self.bounds[1]+1]
   return SimpleNamespace(data=values[0]if self.one else values)
 def model(prompt,*,stage,schema,system):
  calls.append(schema.__name__)
  if chunked:
   import json
   source=json.loads(prompt.split('\nPROPOSED_PUBLIC_SUMMARY:',1)[0])['source_rows'][0]
   if schema is pe.Proposal:
    return schema.model_validate({'overview':'A resident requests a crossing.','no_public_speech_reason':'','speakers':[
     {'who':'Alex','position':'asks','point':'Asks for a crossing.','topic':'Road safety','source_segment_ids':[source['id']],
      'support_quote':'I ask for a crossing.','introduction_quote':'My name is Alex.'}]})
   rejected=reject_review and source['id']==3
   return schema.model_validate({'approved':not rejected,'public_speaker_count':1,'speaking_order_correct':True,
    'excludes_council_staff_and_procedure':True,'points_and_topics_supported':True,'no_omitted_public_speakers':not rejected,
    'names_and_locations_supported':True,'privacy_safe':True,'issues':['one contribution missing']if rejected else []})
  if schema is pe.Proposal:return schema.model_validate(proposal())
  return schema.model_validate({'approved':not reject_review,'public_speaker_count':2,'speaking_order_correct':True,'excludes_council_staff_and_procedure':True,'points_and_topics_supported':True,'no_omitted_public_speakers':not reject_review,'names_and_locations_supported':True,'privacy_safe':True,'issues':['one contribution missing']if reject_review else []})
 monkeypatch.setattr(pe.ai,'json',model)
 monkeypatch.setattr(ps,'load_streets',lambda:{'streets':[]})
 def rpc(name,args):
  assert name=='apply_public_participation_summary'
  assert args['p_expected_item']==rows['agenda_items'][0]
  assert args['p_expected_segments']==rows['transcript_segments']
  updates.append({'meta':args['p_after_meta']})
  return SimpleNamespace(execute=lambda:SimpleNamespace(data=True))
 db=SimpleNamespace(table=Query,rpc=rpc)
 result=ps.summarize_participation(db,1)
 assert calls==['Proposal','Review']*(4 if chunked else 1)
 assert len(updates)==1  # A late chunk rejection cannot publish earlier chunks.
 assert updates[0]['meta']['foreign_link']==17
 if reject_review:
  assert result is None and 'participation'not in updates[0]['meta']
  assert updates[0]['meta']['participation_review_hold']['reason']==('independent_chunk_review_rejected'if chunked else'independent_source_review_rejected')
  assert 'one contribution missing' not in str(updates[0]['meta'])
  assert len(updates[0]['meta']['participation_review_hold']['details_sha256'])==64
 else:
  assert [s['who']for s in result['speakers']]==(['A resident']*4 if chunked else['Chris Foxall','A resident'])
  assert updates[0]['meta']['participation_version']=='3'
  # Single-word "Alex" is not publishable; the registry match is recorded for the admin trail.
  assert [(n['name_key'],n['status'],n['basis'])for n in named]==([]if chunked else[('chris foxhall','published','registry')])
  rows['agenda_items'][0]={**item,'meta':updates[0]['meta']}
  assert ps.summarize_participation(db,1)==result
  assert calls==['Proposal','Review']*(4 if chunked else 1)  # Identical source/registry gets no new paid calls.

def test_long_section_chunks_only_on_literal_intro_and_conserves_every_row():
 rows=[{'id':i,'meeting_id':2,'start_time':float(i),'end_time':i+1.,'text_content':('My name is Alex. 'if i in [4,8]else'')+'Public discussion. '*3}for i in range(12)]
 item={**ITEM,'discussion_start_time':0.,'discussion_end_time':12.}
 p=pe.chunk_source_window(item,rows,max_chars=280)
 assert p['status']=='ready'
 assert [s['id']for c in p['chunks']for s in c['segments']]==list(range(12))
 assert [c['segments'][0]['id']for c in p['chunks']]==[0,4,8]
 assert all(c['chunk']['start_basis']=='literal_first_person_introduction'for c in p['chunks'][1:])
 rows[4]['text_content']=rows[8]['text_content']='Public discussion. '*3
 assert pe.chunk_source_window(item,rows,max_chars=280)['reason']=='long_public_turn_without_literal_chunk_boundary'

def test_chunk_merge_requires_every_review_and_rejects_cross_chunk_source():
 p=pe.chunk_source_window(ITEM,ROWS,max_chars=1000)
 c=prepare(proposal());r={'approved':True,'public_speaker_count':2,'speaking_order_correct':True,'excludes_council_staff_and_procedure':True,'points_and_topics_supported':True,'no_omitted_public_speakers':True,'names_and_locations_supported':True,'privacy_safe':True,'issues':[]}
 c['validation']['source_window_sha256']=p['chunks'][0]['fingerprint']
 result=pe.merge_reviewed_chunks(p,[{'candidate':c,'review':r}])
 assert result['speakers']==c['speakers']and result['validation']['chunk_count']==1
 with pytest.raises(ValueError,match='complete_reviewed_chunk_set_required'):pe.merge_reviewed_chunks(p,[])
 with pytest.raises(ValueError,match='unreviewed_or_wrong_source_chunk'):pe.merge_reviewed_chunks(p,[{'candidate':c,'review':{**r,'approved':False}}])
 c['validation']['speaker_proofs'][0]['source_segment_ids']=[999]
 with pytest.raises(ValueError,match='chunk_evidence_overlap_or_wrong_source'):pe.merge_reviewed_chunks(p,[{'candidate':c,'review':r}])


def prepare_with_names(p, *, minutes=(), published=(), people=()):
 return pe.prepare_candidate(p,window=pe.source_window(ITEM,ROWS),people=list(people),statement_names=[],streets={'streets':[]},
  excluded_names=[],names={'minutes':list(minutes),'published':list(published),'decisions':{}})

def test_first_time_self_introduction_is_published_and_recorded():
 r=prepare_with_names(proposal())
 assert [s['who']for s in r['speakers']]==['Chris Foxhall','A resident']
 assert r['speakers'][0]['name_ref']=='chris foxhall' and 'name_ref' not in r['speakers'][1]
 rec=r['validation']['name_records'][0]
 assert (rec['status'],rec['basis'],rec['source_segment_ids'],rec['start_time'])==('published','introduction',[3],10.)

def test_minutes_spelling_is_used_when_minutes_list_the_speaker():
 r=prepare_with_names(proposal(),minutes=[{'name':'C. Foxall'}])
 assert r['speakers'][0]['who']=='A resident'  # Foxall vs Foxhall is a near miss: review, don't guess
 assert r['validation']['name_records'][0]['status']=='review'
 r=prepare_with_names(proposal(),minutes=[{'name':'C. Foxhall'}])
 assert r['validation']['name_records'][0]['basis']=='minutes'

def test_near_miss_is_held_as_a_resident_until_reviewed():
 r=prepare_with_names(proposal(),published=['Chris Foxall'])
 assert r['speakers'][0]['who']=='A resident' and r['speakers'][0]['name_ref']=='chris foxhall'
 assert r['validation']['name_records'][0]['status']=='review'


def test_misquoted_introduction_leaves_only_that_speaker_anonymous():
 p=proposal();p['speakers'][0]['introduction_quote']='My name is Invented Person.'
 r=prepare(p)
 assert [s['who']for s in r['speakers']]==['A resident','A resident']
 assert r['validation']['speaker_proofs'][0]['introduction_quote_sha256']==pe.digest('')


def test_quotes_tolerate_case_and_punctuation_but_not_different_words():
 assert pe.quoted('i OPPOSE this road',[ROWS[0]]) and pe.quoted('Name is Chris, Foxhall',[ROWS[0]])
 assert not pe.quoted('I oppose that road',[ROWS[0]]) and not pe.quoted('crossing',[ROWS[0]]) and not pe.quoted('',[ROWS[0]])


def test_quote_from_an_uncited_row_inside_the_speakers_span_joins_its_evidence():
 rows=[{'id':3,'meeting_id':2,'start_time':10.,'end_time':11.,'text_content':'My name is Chris Foxhall.'},
       {'id':5,'meeting_id':2,'start_time':11.,'end_time':12.,'text_content':'I oppose this road.'},
       {'id':6,'meeting_id':2,'start_time':12.,'end_time':13.,'text_content':'Thank you.'},
       {'id':4,'meeting_id':2,'start_time':15.,'end_time':20.,'text_content':'I ask for a crossing.'}]
 p=proposal();p['speakers'][0]['source_segment_ids']=[3,6]
 r=pe.prepare_candidate(p,window=pe.source_window(ITEM,rows),people=[],statement_names=[],streets={'streets':[]},excluded_names=[])
 assert r['validation']['speaker_proofs'][0]['source_segment_ids']==[3,5,6]
 p['speakers'][1]['source_segment_ids']=[5,4]  # another speaker already cites row 5: no borrowing
 with pytest.raises(ValueError,match='support_quote_not_literal'):
  pe.prepare_candidate(p,window=pe.source_window(ITEM,rows),people=[],statement_names=[],streets={'streets':[]},excluded_names=[])
