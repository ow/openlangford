"""Bylaw 819 recorded dissent: only inside 2004-03-15..2021-10-17, only with a named opposed list."""
from pathlib import Path

import pytest

from pipeline.ingestion.official_ballots import load_official_minutes, bylaw_819_rule
from pipeline.ingestion.meeting_ballots import merge_ballot_evidence

PEOPLE=[{'id':135,'name':'Lanny Seaton'},{'id':137,'name':'Roger Wade'},{'id':133,'name':'Denise Blackwell'},{'id':134,'name':'Matt Sahlstrom'},{'id':136,'name':'Norma Stewart'},{'id':35,'name':'Lillian Szpak'}]
POLICY_1971={'municipality_slug':'langford','enabled_from':'2021-10-18','enabled_through':'2026-10-18','policy_status':'verified_unchanged','rule_id':'langford1971'}
BODY='That Council approve the Development Variance Permit for 123 Main Street.'


def ballot(tmp_path, *, date, title_date, result='CARRIED', post='Councillor Seaton opposed.', body=BODY, title='Council Meeting'):
    folder=tmp_path/'archive/meeting/Minutes';folder.mkdir(parents=True)
    path=folder/'Minutes.html'
    path.write_text(f'''<title>{title} - {title_date}</title><div class="AgendaHeaderAttendanceTable"><div><div class="Label">PRESENT:</div><div class="Value">{'; '.join(p['name'] for p in PEOPLE)}</div></div><div><div class="Label">ATTENDING:</div><div class="Value">Staff</div></div></div><div class="AgendaItems"><div class="AgendaItemMotion"><div class="MotionText">{body}</div><div class="MotionResult">Motion {result}.</div><div class="PostMotionText">{post}</div></div></div>''')
    Path(str(path)+'.url').write_text('https://pub-langford.escribemeetings.com/Meeting.aspx?Id=1&Agenda=PostMinutes')
    meeting={'id':239,'title':title,'classification':'Council','municipality_slug':'langford','meeting_date':date,'archive_path':'archive/meeting'}
    source=load_official_minutes(meeting,root=tmp_path,people=PEOPLE,cache_dir=tmp_path/'cache')
    members=[{'person_id':p['id'],'classification':'Council','start_date':'2000-01-01','end_date':'2030-01-01'} for p in PEOPLE]
    context={'status':'available','meeting':meeting,'source':source,'people':PEOPLE,'memberships':members,'policy':POLICY_1971}
    return merge_ballot_evidence({'id':1,'meeting_id':239,'text_content':body,'result':result,'meta':{}},[],context)


def test_recorded_dissent_in_819_period_reconstructs_with_its_own_provenance(tmp_path):
    choices,meta=ballot(tmp_path,date='2016-04-04',title_date='April 4, 2016')
    assert {v['person_id']:v['vote'] for v in choices}=={135:'No',137:'Yes',133:'Yes',134:'Yes',136:'Yes',35:'Yes'}
    proof=meta['ballot_reconstruction']
    assert proof['basis']=='recorded_dissent_deemed_affirmative_819'
    assert proof['rule_id']=='langford_819_recorded_dissent_deemed_affirmative'
    assert proof['bylaw_sha256']==bylaw_819_rule()['bylaw_sha256']
    assert proof['choice_provenance']['person_135']=='explicit_named'
    assert proof['choice_provenance']['person_137']=='inferred_recorded_dissent_deemed_affirmative'


def test_recorded_tie_defeat_reconstructs(tmp_path):
    choices,meta=ballot(tmp_path,date='2015-08-17',title_date='August 17, 2015',result='DEFEATED',post='Councillors Seaton, Szpak and Wade opposed.')
    assert sorted(v['vote'] for v in choices)==['No']*3+['Yes']*3
    assert meta['ballot_reconstruction']['basis']=='recorded_dissent_deemed_affirmative_819'


def test_last_819_day_applies_and_first_1971_day_uses_the_1971_rule(tmp_path):
    _,meta=ballot(tmp_path/'a',date='2021-10-17',title_date='October 17, 2021')
    assert meta['ballot_reconstruction']['basis']=='recorded_dissent_deemed_affirmative_819'
    _,meta=ballot(tmp_path/'b',date='2021-10-18',title_date='October 18, 2021')
    assert meta['ballot_reconstruction']['basis']=='validated_dissent_recording_rule_with_per_vote_roster'


@pytest.mark.parametrize('kwargs,status',[
    ({'date':'2016-04-04','title_date':'April 4, 2016','post':''},'recording_rule_date_not_validated'),
    ({'date':'2004-03-14','title_date':'March 14, 2004'},'recording_rule_date_not_validated'),
    ({'date':'2016-04-04','title_date':'April 4, 2016','result':'DEFEATED'},'reconstructed_tally_conflicts_with_outcome'),
    ({'date':'2016-04-04','title_date':'April 4, 2016','post':'In Favour: Councillor Wade\nOpposed: Councillor Seaton'},'recording_rule_date_not_validated'),
    ({'date':'2016-04-04','title_date':'April 4, 2016','body':'That the ruling of the Chair be sustained.'},'recording_rule_date_not_validated'),
])
def test_819_rule_never_fills_choices_without_a_complete_recorded_dissent(tmp_path,kwargs,status):
    choices,meta=ballot(tmp_path,**kwargs)
    assert meta['ballot_reconstruction']['status']==status
    assert meta['individual_vote_coverage']!='reconstructed_complete'
