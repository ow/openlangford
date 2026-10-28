"""Historical recorded dissent can force one assignment without silent-dissent assumptions."""
import pytest
from pathlib import Path
from pipeline.ingestion.official_ballots import load_official_minutes
from pipeline.ingestion.meeting_ballots import merge_ballot_evidence

PEOPLE=[{'id':135,'name':'Lanny Seaton'},{'id':137,'name':'Roger Wade'},{'id':133,'name':'Denise Blackwell'},{'id':134,'name':'Matt Sahlstrom'},{'id':136,'name':'Norma Stewart'},{'id':35,'name':'Lillian Szpak'}]

@pytest.mark.parametrize('case',['forced_pass','failed_neighbor','insufficient_dissent','uncertain_presence'])
def test_march_2021_majority_only_supplies_choices_when_source_forces_every_one(tmp_path,case):
    # Actual March15 source:2473 carried with Blackwell/Szpak opposed; adjacent
    #2472 defeated with Stewart/Sahlstrom/Seaton opposed. Only2473 is forced.
    result='DEFEATED' if case=='failed_neighbor' else 'CARRIED'
    names='Councillors Stewart, Sahlstrom and Seaton' if case=='failed_neighbor' else 'Councillors Blackwell and Szpak' if case!='insufficient_dissent' else 'Councillor Blackwell'
    body='That Council: 1. Make no changes to the open burning policy at this time and allow the current burn period to occur.'
    if case=='failed_neighbor':body='That Council continue the suspension of the open burning policy.'
    event='Councillor Seaton excused himself.' if case=='uncertain_presence' else ''
    folder=tmp_path/'archive/meeting/Minutes';folder.mkdir(parents=True)
    path=folder/'Minutes.html';path.write_text(f'''<title>Council Meeting - March 15, 2021</title><div class="AgendaHeaderAttendanceTable"><div><div class="Label">PRESENT:</div><div class="Value">{'; '.join(p['name'] for p in PEOPLE)}</div></div><div><div class="Label">ATTENDING:</div><div class="Value">Staff</div></div></div><div class="AgendaItems"><div class="AgendaItemMinutes">{event}</div><div class="AgendaItemMotion"><div class="MotionText">{body}</div><div class="MotionResult">Motion {result}.</div><div class="PostMotionText">{names} opposed.</div></div></div>''')
    Path(str(path)+'.url').write_text('https://pub-langford.escribemeetings.com/Meeting.aspx?Id=2021&Agenda=PostMinutes')
    meeting={'id':239,'classification':'Council','municipality_slug':'langford','meeting_date':'2021-03-15','archive_path':'archive/meeting'}
    source=load_official_minutes(meeting,root=tmp_path,people=PEOPLE,cache_dir=tmp_path/'cache')
    context={'status':'available','meeting':meeting,'source':source,'people':PEOPLE,'memberships':[{'person_id':p['id'],'classification':'Council','start_date':'2018-11-05','end_date':'2022-11-06'} for p in PEOPLE],'policy':{'municipality_slug':'langford','enabled_from':'2021-10-18','enabled_through':'2026-10-18','policy_status':'verified_unchanged','rule_id':'langford1971'}}
    choices,meta=merge_ballot_evidence({'id':2473,'meeting_id':239,'text_content':body,'result':result,'meta':{}},[],context)
    if case=='forced_pass':
        assert {v['person_id']:v['vote'] for v in choices}=={133:'No',35:'No',135:'Yes',137:'Yes',134:'Yes',136:'Yes'}
        proof=meta['ballot_reconstruction'];assert proof['basis']=='unique_passed_majority_assignment'
        assert proof['choice_provenance']['person_133']=='explicit_named'
        assert proof['choice_provenance']['person_135']=='inferred_unique_tally_constraint'
        assert proof['majority_constraint']['unknown_voters']==4
    elif case=='uncertain_presence':
        assert choices==[] and meta.get('individual_vote_coverage')!='reconstructed_complete'
    else:
        # Not forced by the majority, but Bylaw 819 recorded dissent fixes the rest as Yes.
        assert meta['ballot_reconstruction']['basis']=='recorded_dissent_deemed_affirmative_819'
        assert 'majority_constraint' not in meta['ballot_reconstruction']
