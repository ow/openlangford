"""Official source ballot validation shared by ordinary ingestion and audits.

No model output, cached Markdown, attendance-table shortcut, or absent dissent
alone proves a ballot. Original sources, each voter and policy applicability are
validated before any inferred choice is returned. Functions do not write DB.
"""
from collections import defaultdict
from datetime import datetime
import hashlib
import re
import subprocess
from pathlib import Path

from .canonical_motions import bound_source_motion, source_identity, source_motion_candidates, source_motion_ownership_issues, operative_view, operative_proof
from .native_header_ocr import recover_pdf_header_date
from .documentary_presence import documentary_presence_before_vote
from .roster_ocr import reviewed_roster_view
from .header_attendance import original_header_attendance, header_attendance_before_vote
from .source_occurrences import original_formal_inventory, own_formal_envelopes, envelope_proof
from .historical_references import original_historical_references
from .vote_evidence import minutes_motion_blocks, normalize_text, named_votes, named_vote_declarations, outcome_family, special_voting_threshold
from .ballot_reconstruction import validate_roster_entries, physical_presence_events, voters_before_vote, resolve_people


def _surname_index(people):
    surnames=defaultdict(list)
    for person in people:
        parts=normalize_text(person['name']).split()
        if len(parts)>=2 and len(parts[-1])>=3:
            surnames[parts[-1]].append(person)
    return surnames


def _normalise_header_text(header):
    """Undo letter-spacing and split ordinals without adding or guessing digits."""
    def join_run(match):
        joined = match.group(0).replace(' ', '')
        joined = re.sub(r',(?=\S)', ', ', joined)
        return re.sub(r'(?<=[A-Za-z])(?=\d)', ' ', joined)
    # Five or more single characters separated by single spaces are a
    # letter-spaced text layer ("M o n d a y , M a r c h 3 , 2 0 1 4").
    header = re.sub(r'(?<!\S)\S(?: \S){4,}(?!\S)', join_run, header)
    # Split ordinal suffixes ("3 r d", "7 t h") rejoin their digit.
    return re.sub(r'(?<=\d)[ \t]*(s[ \t]*t|n[ \t]*d|r[ \t]*d|t[ \t]*h)(?![A-Za-z])',
                  lambda m: re.sub(r'[ \t]', '', m.group(1)), header, flags=re.I)


def _native_header_date(header):
    months = 'January|February|March|April|May|June|July|August|September|October|November|December'
    header = _normalise_header_text(header)
    direct = re.search(r'\b(' + months + r')\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(20\d{2})\b', header, re.I)
    if direct:
        date = datetime.strptime(' '.join(direct.groups()), '%B %d %Y').date()
        return date.isoformat(), {'method': 'native_month_day_year', 'source_quote': direct[0]}
    # Scanned ordinals often become ^, *^ or t^. Keep every date digit;
    # only accept the noisy suffix when the printed weekday independently fits.
    pattern = re.compile(
        r'\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[ \t]*,?[ \t]*('
        + months + r')\s+(\d{1,2})((?<=\d\d)[17]H[ \t,]*|[ \t,stndrh^*"\'’`°º™0Oo]{1,12})\s*(20\d{2})\b', re.I,
    )
    candidates = []
    for match in pattern.finditer(header):
        weekday, month, day, suffix, year = match.groups()
        try:
            date = datetime.strptime(f'{month} {day} {year}', '%B %d %Y').date()
        except ValueError:
            continue
        if date.strftime('%A').casefold() == weekday.casefold():
            candidates.append((date.isoformat(), {
                'method': 'native_weekday_with_ordinal_ocr_noise',
                'source_quote': match[0], 'weekday_verified': True,
            }))
    return candidates[0] if len({date for date, _ in candidates}) == 1 else (None, None)

def resolve_names(text, people):
 surnames=_surname_index(people)
 found=[];ambiguous=[]
 for surname,ps in surnames.items():
  if re.search(r'\b'+re.escape(surname)+r'\b',normalize_text(text)):
   candidates=ps
   initial=re.search(r'\b([A-Z])\.\s*'+re.escape(surname)+r'\b',text,re.I)
   if initial and len(candidates)>1:candidates=[p for p in candidates if p['name'][0].casefold()==initial[1].casefold()]
   if len(candidates)==1:found.append(candidates[0])
   else:ambiguous.append(surname)
 return found,ambiguous

def html_minutes_text(path):
 from bs4 import BeautifulSoup,Tag
 soup=BeautifulSoup(path.read_text(),'html.parser')
 title=soup.title.get_text(' ',strip=True) if soup.title else ''
 table=soup.select_one('.AgendaHeaderAttendanceTable')
 if not table:raise ValueError('official_html_attendance_structure_missing')
 parts=[title]
 for row in table.find_all('div',recursive=False):
  label=row.select_one('.Label');value=row.select_one('.Value')
  if label and value:
   parts.append(label.get_text(' ',strip=True))
   entries=value.select('li')
   parts.extend(e.get_text(' ',strip=True) for e in entries)
   if not entries:parts.append(value.get_text(' ',strip=True))
 def walk(node):
  if not isinstance(node,Tag):return
  classes=set(node.get('class',[]))
  if 'AgendaItemTitleRow' in classes:
   counter=node.select_one('.AgendaItemCounter');title=node.select_one('.AgendaItemTitle')
   parts.append((counter.get_text(' ',strip=True) if counter else '')+' '+(title.get_text(' ',strip=True) if title else ''));return
  if 'AgendaItemMotion' in classes:
   def text(selector):
    item=node.select_one(selector);return item.get_text(' ',strip=True) if item else ''
   pre=text('.PreMotionText');post=text('.PostMotionText')
   if pre:parts.append(pre)
   # Structural delimiters mark an official formal motion even when the clerk
   # omitted names (allowed by the procedure bylaw); no names are invented.
   body='\n'.join(item.get_text(' ',strip=True) for item in node.select('.MotionText'))
   parts.extend(['MOVED BY: '+text('.MovedBy .Value'),'SECONDED: '+text('.SecondedBy .Value'),body,text('.MotionResult')])
   if post:parts.append(post)
   return
  if 'AgendaItemMinutes' in classes:
   parts.append(node.get_text(' ',strip=True));return
  for child in node.children:walk(child)
 body=soup.select_one('.AgendaItems')
 if not body:raise ValueError('official_html_motion_structure_missing')
 walk(body)
 return '\n'.join(parts)

def _load_official_minutes(meeting, *, root, people, cache_dir):
 ROOT=Path(root)
 CACHE=Path(cache_dir)
 CACHE.mkdir(parents=True,exist_ok=True)
 surnames=_surname_index(people)
 folder=ROOT/(meeting['archive_path'] or 'missing')
 files=list((folder/'Minutes').glob('*.pdf'))
 if files:
  signed=[f for f in files if 'signed' in f.name.lower()]
  preferred=signed or [f for f in files if f.name=='Minutes.pdf'] or files
  if len(preferred)!=1:return {'error':'ambiguous_original_minutes_pdf','files':[str(f.relative_to(ROOT)) for f in preferred]}
  path=preferred[0];digest=hashlib.sha256(path.read_bytes()).hexdigest()
  # Text layer when there is one, Marker OCR for scans (shared with ingest's minutes reading).
  from pipeline.parser import pdf_text
  text,source_format=pdf_text(path,cache_dir=CACHE)
 else:
  html=list((folder/'Minutes').glob('*.html'))
  if len(html)!=1:return {'error':'no_original_minutes_pdf_or_unique_official_html'}
  path=html[0];digest=hashlib.sha256(path.read_bytes()).hexdigest()
  try:text=html_minutes_text(path)
  except ValueError as error:return {'error':str(error)}
  source_format='official_html_structural'
 if len(text.strip())<100:return {'error':'pdf_requires_ocr'}
 return minutes_text_source(meeting,root=ROOT,people=people,cache_dir=CACHE,path=path,
                            text=text,source_format=source_format,source_sha256=digest)


def minutes_text_source(meeting, *, root, people, cache_dir, path, text, source_format, source_sha256):
 # Shared lossless parsing; callers must separately establish source authority.
 ROOT,CACHE,path=Path(root),Path(cache_dir),Path(path)
 digest=source_sha256
 surnames=_surname_index(people)
 # Catalog classification is not proof: mislabeled Committee minutes must not
 # silently inherit Council voting scope. Retain native header before cleanup.
 header=re.split(r'\bPRESENT\b',text[:1400],maxsplit=1,flags=re.I)[0]
 source_classification='Committee of the Whole' if re.search(r'committee\s+of\s+the\s+whole|\bCOTW\b',header,re.I) else 'Committee' if re.search(r'\bcommittee\b|\bcommission\b',header,re.I) else 'Council' if re.search(r'\bcouncil\b',header,re.I) else None
 # Remove repeated page headers and footer-only page numbers, preserving order.
 clean=re.sub(r'(?im)^\s*Minutes of[^\n]*\n','\n',text)
 clean=re.sub(r'(?m)^\s*\d+\s*$','',clean).replace('\f','\n')
 # Only roster in the PRESENT block, never staff/absent/all names from header.
 present=re.search(r'\bPRESENT\s*:',clean,re.I) or re.search(r'\bPRESENT\b',clean,re.I)
 if not present:return {'error':'present_header_not_extracted','source_file':str(path.relative_to(ROOT))}
 tail=clean[present.end():]
 end=re.search(r'\b(?:ATTENDING|ABSENT|REGRETS)\s*:?|\n\s*(?:1\.|CALL TO ORDER|TERRITORIAL)',tail,re.I)
 if not end:return {'error':'present_header_boundary_unknown'}
 roster_quote=tail[:end.start()]
 # A role can touch its initial in scanned native text ("Mayors. Young").
 # Split that lexical boundary without changing a name or discarding initials.
 roster_notation=re.sub(r'\b(Mayor|Councillors?)([A-Z])\.(?=\s*[A-Z])',r'\1 \2.',roster_quote,flags=re.I)
 roster,ambiguous=validate_roster_entries(roster_notation,people)
 attendance=original_header_attendance(text,clean,path,people,source_format)
 if attendance and attendance['status']=='typed_original_header':
  roster,ambiguous=attendance['present'],[]
 # Retain unknown name-looking role mentions for audit; avoid quietly dropping a voter.
 unknown=[]
 role_names=re.findall(r'\b(?:Mayor|Councillors?|Committee [Mm]ember|Members?)[ \t]*:?[ \t]*((?:[A-Z]\.[ \t]*)?[A-Z][a-zA-Z-]+)',roster_notation)
 for token in role_names:
  # Acting-Mayor annotations can precede another role in the next column;
  # those labels are already fully accounted for by the roster validator.
  if normalize_text(token) in {'mayor','councillor','councillors','member','members','committee','chair','acting'}:continue
  token=re.sub(r'-(?:Remote|Remotely)$','',token,flags=re.I)
  if not any(normalize_text(token).split()[-1]==normalize_text(p['name']).split()[-1] for p in roster):unknown.append(token)
 # Legacy roster commas have unprefixed initials; every initial/surname must resolve.
 for initial,surname in re.findall(r'\b([A-Z])\.\s*([A-Z][A-Za-z-]+)',roster_notation):
  matches=surnames.get(normalize_text(surname),[])
  resolved,_=resolve_names(initial+'. '+surname, people)
  if len(resolved)!=1:unknown.append(initial+'. '+surname)
 # Prior minutes and agenda references can contain cleaner dates than a scanned
 # meeting header. They must never substitute for this document's own date.
 local_date,date_evidence=_native_header_date(clean[:present.start()])
 if not local_date and source_format=='original_pdf_layout':
  local_date,date_evidence=recover_pdf_header_date(path,catalog_date=meeting['meeting_date'],cache_dir=CACHE)
  if date_evidence and date_evidence['source_sha256']!=digest:local_date,date_evidence=None,None
 blocks=list(minutes_motion_blocks(clean));index=defaultdict(list)
 for block in blocks:index[normalize_text(block['motion_text'])].append(block)
 sidecar=Path(str(path)+'.url');url=sidecar.read_text().strip() if sidecar.exists() else meeting.get('minutes_url')
 views={}
 if source_format=='original_pdf_layout' and local_date:
  from .operative_motion_body import derive_operative_motion_views
  derived=derive_operative_motion_views(blocks,source_file=path,source_sha256=digest,source_date=local_date)
  views={f"{block['source_offset']}:{block['source_order']}":view for block,view in zip(blocks,derived)}
 references=original_historical_references(clean,path,blocks,local_date,source_format,digest)
 source={'historical_chronology_references':references,'formal_occurrence_inventory':original_formal_inventory(clean),'header_attendance':attendance,'operative_views':views,'text':clean,'source_classification':source_classification,'source_header':header,'source_format':source_format,'source_file':str(path.relative_to(ROOT)),'source_url':url,'source_sha256':digest,'local_date':local_date,'source_date_evidence':date_evidence,'stored_date':meeting['meeting_date'],'present':roster,'roster_quote':roster_quote.strip(),'roster_unknown':unknown,'ambiguous_names':ambiguous,'blocks':blocks,'index':index}
 from .native_transcriptions import load_reviewed_transcriptions
 reviewed=load_reviewed_transcriptions(source,path)
 if reviewed is not None:source['reviewed_transcriptions']=reviewed
 return source

def event_timeline(source, memberships):
 known={p['id']:p for p in source['present']}
 for membership in memberships:
  if membership['classification']=='Council' and membership['start_date'] and source['local_date'] and membership['start_date']<=source['local_date'] and (not membership['end_date'] or membership['end_date']>=source['local_date']):
   if membership['person_id'] not in known:
    known[membership['person_id']]={'id':membership['person_id'],'name':membership['name']}
 # Generic role references require BOTH an explicit native PRESENT role label
 # and the unique dated Mayor membership. Chairing habits are not evidence.
 role_bindings={}
 active_mayors=[m for m in memberships if m['classification']=='Council' and (m.get('role') or '').casefold()=='mayor' and m.get('start_date') and source['local_date'] and m['start_date']<=source['local_date'] and (not m.get('end_date') or m['end_date']>=source['local_date'])]
 labels=list(re.finditer(r'(?<![A-Za-z/])(?<!Acting )Mayor(?:[ \t]+|(?=[A-Z]\.))([^\n,;]+?)(?=\s{2,}|[,;\n]|$)',source['roster_quote'],re.I))
 if len(labels)==1 and len({m['person_id'] for m in active_mayors})==1:
  resolved,ambiguous=resolve_people(labels[0][1],list(known.values()));member=active_mayors[0]
  if len(resolved)==1 and not ambiguous and resolved[0]['id']==member['person_id']:
   role_bindings['mayor']={'person_id':member['person_id'],'person_name':resolved[0]['name'],'source_quote':labels[0][0].strip(),'membership_role':'Mayor','membership_start':member['start_date'],'membership_end':member.get('end_date'),'method':'unique_official_present_role_and_dated_membership'}
 text=source['text']
 header=source.get('header_attendance')or{}
 if header.get('status')=='typed_original_header':
  for start,stop in header['consumed_clean_spans']:text=text[:start]+(' '*(stop-start))+text[stop:]
 return physical_presence_events(text,list(known.values()),role_bindings=role_bindings)

def inspect_motion(motion, source, *, meeting, people, memberships, policy, claim_inventory=None):
 result={'motion_id':motion['id'],'meeting_id':motion['meeting_id'],'result':motion['result'],'source_date_evidence':source.get('source_date_evidence')}
 if motion['meeting_id']!=meeting['id']:return {**result,'status':'source_meeting_mismatch'}
 if source.get('error'):return {**result,'status':source['error']}
 source_body=source.get('source_classification')
 catalog_cotw=bool(re.search(r'committee\s+of\s+the\s+whole|\bCOTW\b',meeting.get('title','')+' '+meeting.get('archive_path',''),re.I))
 if source_body=='Committee of the Whole':
  if not catalog_cotw:return {**result,'status':'source_catalog_voting_body_mismatch'}
  if not policy.get('committee_of_the_whole_scope'):return {**result,'status':'source_committee_membership_rules_need_validation'}
  voting_body='committee_of_the_whole'
 elif source_body=='Council':
  if catalog_cotw:return {**result,'status':'source_catalog_voting_body_mismatch'}
  voting_body='council'
 else:return {**result,'status':'source_committee_membership_rules_need_validation' if source_body=='Committee' else 'source_council_scope_not_proven'}
 candidates=source_motion_candidates(source,motion['text_content'])
 bound = bound_source_motion(motion, source, meeting['id'], claim_inventory)
 if len(candidates)!=1 and bound is None:return {**result,'status':'source_motion_not_exact_or_ambiguous','exact_candidates':len(candidates),'source_occurrence_hold':source_motion_ownership_issues(source,motion['text_content'])}
 block=bound if bound is not None else candidates[0]
 result['source_occurrence_validation']={'method':'current_bound_original_formal_envelope' if bound is not None else 'unique_original_formal_envelope', 'envelope':envelope_proof(source,own_formal_envelopes(source,block)[0])}
 view=operative_view(source,block)
 if view and view['status']=='documentary_event_only_held':return {**result,'status':'source_documentary_event_not_resolution'}
 if view:result['operative_motion_body']=operative_proof(source,block)
 if bound is not None:
  from .native_transcriptions import bound_transcription
  transcription=bound_transcription(motion,source,block,claim_inventory)
  if transcription:result['full_transcription_validation']=transcription
  result['source_motion_identity'] = {**source_identity(meeting['id'], source, bound), 'validation':'current_binary_meeting_offset_order_body_and_recomputed_key'}
 if outcome_family(motion['result'])!=outcome_family(block['result']):return {**result,'status':'outcome_conflict'}
 if outcome_family(block['result']) not in ('passed','failed'):return {**result,'status':'not_a_yes_no_decision'}
 source = reviewed_roster_view(source, meeting=meeting, people=people, memberships=memberships)
 if source.get('roster_source_validation'):
  result['roster_source_validation'] = source['roster_source_validation']
  if source['roster_source_validation'].get('status'):return {**result,'status':source['roster_source_validation']['status']}
 if (source.get('header_attendance')or{}).get('status')=='header_attendance_annotation_invalid':return {**result,'status':'header_attendance_annotation_invalid'}
 if source['roster_unknown'] or source['ambiguous_names']:return {**result,'status':'roster_unknown_names','unknown':source['roster_unknown']+source['ambiguous_names']}
 present={p['id'] for p in source['present']}
 if not 3<=len(present)<=7:return {**result,'status':'roster_size_or_non_council_committee'}
 if meeting['classification']!='Council' and voting_body!='committee_of_the_whole':return {**result,'status':'committee_membership_rules_need_validation'}
 local_date=source['local_date']
 if not local_date:return {**result,'status':'source_date_unknown'}
 # Legacy catalog dates may be one UTC day ahead; an unrelated minutes file
 # must never supply a ballot merely because a generic motion text matches.
 if abs((datetime.fromisoformat(local_date)-datetime.fromisoformat(meeting['meeting_date'])).days)>1:
  return {**result,'status':'source_meeting_date_mismatch'}
 if meeting.get('municipality_slug')!='langford' or policy.get('municipality_slug')!='langford':
  return {**result,'status':'municipality_recording_rule_not_validated'}
 if 'presence_events' not in source:
  source['presence_events'],source['unknown_presence_events']=event_timeline(source,memberships)
 events,unknown=source['presence_events'],source['unknown_presence_events']
 position=source['text'].find(block['source_block'])
 if position<0:return {**result,'status':'source_offset_unknown'}
 position += block['source_block'].find(block['outcome_quote'])
 header_validation=header_attendance_before_vote(source,block,position)
 if header_validation:
  if header_validation['status']!='header_attendance_validated':return {**result,'status':header_validation['status']}
  result['header_attendance_validation']=header_validation
  absent=set(header_validation['absent_person_ids'])
  if any(e['person_id']in absent and e['state']=='present' and e['offset']<position for e in events):return {**result,'status':'header_body_attendance_conflict'}
  present-=absent
 earlier_unknown,documentary=documentary_presence_before_vote(source,block,position,events,unknown,people)
 if documentary:result['documentary_presence_observations']=documentary
 if earlier_unknown:return {**result,'status':'unparsed_presence_event','events':earlier_unknown[:5]}
 present,initial_adjustments=voters_before_vote(present,events,position)
 if present is None:return {**result,'status':'initial_presence_unknown','events':initial_adjustments}
 # Membership crosscheck when database has dated council service, source date wins.
 memberships=[m for m in memberships if m['classification']=='Council' and m['start_date'] and m['start_date']<=local_date and(not m['end_date'] or m['end_date']>=local_date)]
 ids={m['person_id'] for m in memberships}
 if not ids:return {**result,'status':'dated_council_membership_unavailable'}
 if not present<=ids:return {**result,'status':'council_membership_mismatch','present':sorted(present),'active_members':sorted(ids)}
 if len(present)<4:return {**result,'status':'possible_no_quorum'}
 eligible_people=[person for person in people if person['id'] in ids]
 explicit=named_votes(block,[p['name'] for p in eligible_people])
 declarations={}
 for declaration in named_vote_declarations(block):
  if declaration.get('unparsed'):return {**result,'status':'unparsed_source_choice_declaration','source_quote':declaration['source_quote']}
  resolved,unresolved=validate_roster_entries(declaration['names'],eligible_people)
  if unresolved or not resolved:return {**result,'status':'unresolved_dissent_names','unknown':unresolved or [declaration['names']]}
  if declaration.get('declared_count') is not None and declaration['declared_count']!=len(resolved):return {**result,'status':'explicit_rollcall_count_mismatch'}
  for person in resolved:declarations.setdefault(person['id'],set()).add(declaration['vote'])
 if any(len(choices)>1 for choices in declarations.values()):return {**result,'status':'conflicting_named_source_choices'}
 if 'UNANIMOUS' in block['result'] and any(v['vote']!='Yes' for v in explicit):
  return {**result,'status':'unanimous_result_conflicts_with_named_choice'}
 named={next(p['id'] for p in people if p['name']==v['person_name']):v for v in explicit}
 if any(p not in present for p in named):return {**result,'status':'named_choice_voter_not_present'}
 # Do not treat unresolved OPPOSED lines or nonstandard source vote notation as none.
 after=block['after_outcome'];head=block.get('before_outcome_votes','')+'\n'+after
 opposition=re.search(r'(?im)^\s*(?:OPPOSED\s*:|(?:Mayor|Councillor|Councillors)\s+[^\n]{0,160}\bopposed\b)',head)
 if opposition and not any(v['vote']=='No' for v in explicit):return {**result,'status':'unresolved_dissent_names'}
 if any(v['vote'] in ('Abstain','Recused') for v in explicit):return {**result,'status':'special_vote_or_recusal_needs_scope'}
 # A fully named Council rollcall needs no assumption about omitted dissent.
 # Incomplete historical lists cannot bypass the dated recording convention.
 complete_explicit=voting_body=='council' and set(named)==present
 # A passed ordinary Council decision can force all unnamed choices when
 # even one further No would make a majority impossible. Unlike a recording
 # convention, this uses the recorded dissent and statutory majority alone.
 # Failed decisions and committee/special-threshold votes remain outside it.
 special_threshold=special_voting_threshold(block['motion_text'])
 unknown=present-set(named)
 required_yes=len(present)//2+1
 named_yes=sum(v['vote']=='Yes' for v in named.values())
 unique_passed=('2004-01-01'<=local_date<'2021-10-18' and voting_body=='council' and not special_threshold and outcome_family(block['result'])=='passed'
                and named_yes==0 and bool(unknown) and len(unknown)==required_yes)
 if not complete_explicit and not unique_passed:
  if 'UNANIMOUS' not in block['result'] or voting_body=='committee_of_the_whole':
   if policy.get('policy_status')!='verified_unchanged':
    return {**result,'status':policy.get('policy_status','recording_rule_not_refreshed')}
   if not policy.get('enabled_from','9999')<=local_date<=policy.get('enabled_through',''):
    return {**result,'status':'recording_rule_date_not_validated'}
  if local_date<'2021-10-18' and 'UNANIMOUS' not in block['result']:return {**result,'status':'historical_recording_convention_not_yet_verified'}
 votes=[]
 for pid in sorted(present):
  v=named.get(pid)
  votes.append({'person_id':pid,'person_name':next(p['name'] for p in people if p['id']==pid),'vote':v['vote'] if v else 'Yes','evidence':'explicit_named' if v else ('inferred_explicit_unanimity' if 'UNANIMOUS' in block['result'] else 'inferred_unique_tally_constraint' if unique_passed else 'inferred_official_dissent_recording_rule'),'source_quote':v['source_quote'] if v else block['outcome_quote']})
 yes=sum(v['vote']=='Yes' for v in votes);no=sum(v['vote']=='No' for v in votes)
 if (outcome_family(block['result'])=='passed')!=(yes>no):return {**result,'status':'reconstructed_tally_conflicts_with_outcome','yes':yes,'no':no}
 # Special supermajority decisions need separate threshold verification.
 if special_threshold:return {**result,'status':'special_voting_threshold_needs_validation'}
 return {**result,'status':'reconstructable_candidate','inference_basis':'every_present_voter_explicitly_named' if complete_explicit else 'unique_passed_majority_assignment' if unique_passed else None,'majority_constraint':{'present_voters':len(present),'required_yes':required_yes,'explicit_yes':named_yes,'explicit_no':sum(v['vote']=='No' for v in named.values()),'unknown_voters':len(unknown),'unique_assignment':True,'statutory_basis':'Community Charter123(1),(3),(5), all present vote; majority decides; tie defeated','statute_url':'https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/03026_05#section123','history_url':'https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/03026_pit','history_sha256':'a650b396989fe681dd7db386e64d278c8cd23274a60c66632c441d1f2f3f6415','statute_sha256':'89e24743565b0eaab376b0a8ea02c4511749e9e4d750fdb8c39bc3b186991bec','effective_from':'2004-01-01'} if unique_passed else None,'source_classification':source_body,'voting_body':voting_body,'outcome_role':'committee_guidance_or_recommendation' if voting_body=='committee_of_the_whole' else 'council_decision','scope_basis':policy.get('committee_of_the_whole_scope') if voting_body=='committee_of_the_whole' else 'official_council_header_and_dated_council_membership','source_result':block['result'],'votes':votes,'yes':yes,'no':no,'source_file':source['source_file'],'source_format':source['source_format'],'source_url':source['source_url'],'source_sha256':source['source_sha256'],'source_date':local_date,'stored_date':source['stored_date'],'roster_quote':source['roster_quote'],'membership_evidence':'dated_db_council_membership','initial_arrival_adjustments':initial_adjustments,'presence_events':[e for e in events if e['offset']<position],'source_motion_text':block['motion_text'],'source_block':block['source_block'],'recording_rule':'CommunityCharter123 statutory majority uniquely forces unnamed Yes choices; no historical dissent-recording assumption' if unique_passed else 'Langford1971 section38(original)/44(consolidated), CommunityCharter123; proposed inferred choices, not explicit rollcall'}


def load_official_minutes(meeting, *, root, people, cache_dir):
    """Return a documentary hold when native source extraction is unavailable."""
    try:
        return _load_official_minutes(meeting, root=root, people=people, cache_dir=cache_dir)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        return {'error': 'official_minutes_extraction_unavailable', 'error_type': type(error).__name__}


def complete_ballot_proof(candidate, policy):
    keys = ('source_file', 'source_format', 'source_url', 'source_sha256', 'source_date',
            'stored_date', 'source_result', 'source_motion_text', 'source_block',
            'roster_quote', 'membership_evidence', 'presence_events',
            'initial_arrival_adjustments', 'votes', 'source_classification',
            'voting_body', 'scope_basis', 'outcome_role')
    proof = {key: candidate[key] for key in keys}
    if candidate.get('documentary_presence_observations'):
        proof['documentary_presence_observations'] = candidate['documentary_presence_observations']
    if candidate.get('source_occurrence_validation'):
        proof['source_occurrence_validation'] = candidate['source_occurrence_validation']
    if candidate.get('header_attendance_validation'):
        proof['header_attendance_validation'] = candidate['header_attendance_validation']
    if candidate.get('roster_source_validation'):
        proof['roster_source_validation'] = candidate['roster_source_validation']
    if candidate.get('full_transcription_validation'):
        proof['full_transcription_validation'] = candidate['full_transcription_validation']
    if candidate.get('operative_motion_body'):
        proof['operative_motion_body'] = candidate['operative_motion_body']
    if candidate.get('source_motion_identity'):
        proof['source_motion_identity'] = candidate['source_motion_identity']
    if candidate.get('source_date_evidence'):
        proof['source_date_evidence'] = candidate['source_date_evidence']
    unanimous = 'UNANIMOUS' in candidate['source_result']
    fully_explicit = candidate.get('inference_basis') == 'every_present_voter_explicitly_named'
    unique_tally = candidate.get('inference_basis') == 'unique_passed_majority_assignment'
    if unique_tally:
        proof['majority_constraint'] = candidate['majority_constraint']
    proof.update({
        'rule_id': 'explicit_complete_named_rollcall' if fully_explicit else 'explicit_unanimity' if unanimous else 'unique_passed_majority_assignment' if unique_tally else policy['rule_id'],
        'bylaw_url': None if unique_tally else policy.get('bylaw_url'),
        'bylaw_sha256': None if unique_tally else policy.get('bylaw_sha256'),
        'policy_checked_as_of': policy.get('validated_as_of'),
        'policy_status': policy.get('policy_status'),
        'method': 'explicit_official_rollcall' if fully_explicit else 'documentary_reconstruction_not_explicit_rollcall',
        'basis': 'every_present_voter_explicitly_named' if fully_explicit else 'explicit_unanimity_with_per_vote_roster' if unanimous else 'unique_passed_majority_assignment' if unique_tally else 'validated_dissent_recording_rule_with_per_vote_roster',
        'choice_provenance': {f"person_{v['person_id']}": v['evidence'] for v in candidate['votes']},
    })
    return proof
