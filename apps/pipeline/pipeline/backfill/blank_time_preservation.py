"""Explicit catch-up documentary presence; an unfilled clock stays unknown."""
import hashlib
import re
import fitz
from pipeline.ingestion.source_claims import build_claim_inventory,digest,project_claim
from pipeline.ingestion.source_occurrences import formal_inventory,original_formal_inventory
from .legacy_occurrence_reviews import _validate_scope,full_row_fingerprint,_ADJOURNMENT_LEGACY,_ADJOURNMENT_LEGACY_COMPACT
from .supplemental_preservation import _source_admission
from .closing_conflicts import _complete_passage

_PREFIX='The Chair adjourned the meeting at'
# Collision screening includes the generic Council form used by the separate
# closing-conflict validator; this does not widen eligible NULL legacy rows.
_CLOSING_COMPACT=_ADJOURNMENT_LEGACY_COMPACT|{'thatcounciladjournthemeeting'}
_CLOCK=re.compile(r'(?i)\b(?:\d{1,2}\s*:\s*[0-5]\d|\d{1,2}\s*[ap]\.?\s*m\.?)\b')
_EVENTS=re.compile(r'(?m)^\s*(?:The Chair|(?:Acting )?Mayor [A-Z][a-z]+) adjourned the meeting at\b')
_HEADING=re.compile(r'(?im)^\s*(?:\d+[.)]?\s+)?ADJOURNMENT\s*$')
_FIELDS={'type','authority','result_policy','time_policy','motion_id','legacy_text','claim_sha256','claim_row_sha256',
         'page','native_text_sha256','render_sha256','native_passage','native_passage_start','source_passage',
         'source_passage_start','image_observation','first_review_sha256','independent_review_sha256'}

def _sha(value):return hashlib.sha256(value).hexdigest()

def _closing_passage(text,start):
    span=_complete_passage(text,_PREFIX,_PREFIX,start)
    headings=list(_HEADING.finditer(text[:start]))
    if (not headings or text[headings[-1].end():start].strip()
            or len(_EVENTS.findall(text))!=1 or _HEADING.search(text[span[1]:])
            or _CLOCK.search(text[span[1]:])):
        raise ValueError('Blank-time closing is not a unique final adjournment passage')
    return span

def validate_blank_time_preservations(review,*,source,inventory,current_rows,meeting,project_ref,municipality_id,
                                      archive_root,linked_vote_counts=None):
    entries=review.get('blank_time_documentary_preservations',[])
    if not entries:return {}
    if len(entries)!=1:raise ValueError('Exactly one reviewed blank-time closing supported')
    original=_validate_scope(review,source=source,inventory=inventory,meeting_id=meeting['id'],
        project_ref=project_ref,municipality_id=municipality_id,archive_root=archive_root)
    admission=_source_admission(source,meeting,project_ref,municipality_id,archive_root)
    if (source.get('local_date')!=meeting['meeting_date'] or original.suffix.lower()!='.pdf'
            or source.get('source_format')!='original_pdf_reviewed_image_decisions'
            or fitz.VersionBind!=review.get('pymupdf_version') or review.get('render_scale') not in (1.5,2,3,4)
            or review.get('render_scale')!=admission.get('render_scale')
            or build_claim_inventory(current_rows,meeting_id=meeting['id'],expected_count=len(current_rows))!=inventory
            or digest(source['blocks'])!=admission.get('parsed_blocks_sha256')
            or original_formal_inventory(source['text'])!=source.get('formal_occurrence_inventory')):
        raise ValueError('Blank-time source/date/inventory/render changed')
    entry=entries[0];cap=entry['capability']
    if (set(cap)!=_FIELDS or entry.get('source_review_sha256')!=digest(admission)
            or admission.get('blank_time_documentary_capabilities')!=[cap]
            or cap['type']!='reviewed_blank_time_adjournment_presence'
            or cap['authority']!='documentary_preservation_only' or cap['result_policy']!='preserve_unknown'
            or cap['time_policy']!='preserve_unrecorded_no_value'
            or cap['image_observation']!={'time_field':'blank','printed_suffix':'pm.','native_extraction_omits_suffix':True}):
        raise ValueError('Blank-time closing lacks exact enrolled image-observation capability')
    for field,top in [('first_review_sha256','independent_original_image_review_sha256'),
                      ('independent_review_sha256','second_independent_original_image_review_sha256')]:
        if not re.fullmatch('[a-f0-9]{64}',cap[field]) or cap[field]!=admission.get(top) or cap[field]!=review.get(top):
            raise ValueError('Blank-time closing requires two pinned independent reviews')
    if cap['first_review_sha256']==cap['independent_review_sha256']:
        raise ValueError('Blank-time closing requires distinct independent reviews')
    rows={r['id']:r for r in current_rows};row=rows.get(cap['motion_id'])
    if (len(rows)!=len(current_rows) or not row or digest(project_claim(row))!=cap['claim_sha256']
            or full_row_fingerprint(row)!=cap['claim_row_sha256'] or row['text_content']!=cap['legacy_text']
            or not _ADJOURNMENT_LEGACY.fullmatch(row['text_content']) or row.get('result') is not None
            or row.get('meta') not in (None,{}) or any(row.get(k) is not None for k in ('mover','seconder','mover_id','seconder_id'))
            or any(row.get(k) not in (None,0) for k in ('yes_votes','no_votes','abstain_votes','absent_votes'))
            or any(r['id']!=row['id'] and re.sub('[^a-z0-9]','',r['text_content'].casefold()) in _CLOSING_COMPACT for r in current_rows)):
        raise ValueError('Blank-time closing row changed or has unsupported authority')
    expected={'authority':'operator_scoped_linked_vote_count_v1','meeting_id':meeting['id'],
              'counts':[{'motion_id':row['id'],'linked_votes':0}]}
    if (linked_vote_counts!=expected or type(linked_vote_counts['counts'][0]['linked_votes']) is not int):
        raise ValueError('Blank-time closing requires authoritative zero linked-vote count')
    if cap['source_passage']!=_PREFIX or cap['native_passage']!=_PREFIX:
        raise ValueError('Blank-time exact prefix changed; no clock reconstruction allowed')
    start,stop=_closing_passage(source['text'],cap['source_passage_start'])
    with fitz.open(original) as doc:
        number=cap['page']
        if type(number) is not int or not 1<=number<=len(doc):raise ValueError('Blank-time page absent')
        page=doc[number-1];native=page.get_text();pin={k:cap[k] for k in ('page','native_text_sha256','render_sha256')}
        if (pin not in admission['pages'] or _sha(native.encode())!=cap['native_text_sha256']
                or _sha(page.get_pixmap(matrix=fitz.Matrix(review['render_scale'],review['render_scale'])).tobytes('png'))!=cap['render_sha256']):
            raise ValueError('Blank-time original image/native witness changed')
        _closing_passage(native,cap['native_passage_start'])
        if len(_EVENTS.findall('\f'.join(p.get_text() for p in doc)))!=1:
            raise ValueError('Blank-time original has competing closing events')
    from pipeline.ingestion.canonical_motions import bound_source_motion,source_motion_candidates
    envelopes=formal_inventory(source)['envelopes']
    bodies=[e.get('body_view',e.get('body','')) for e in envelopes]+[b['motion_text'] for b in source['blocks']]
    if (bound_source_motion(row,source,meeting['id'],inventory) or source_motion_candidates(source,row['text_content'])
            or any(re.sub('[^a-z0-9]','',body.casefold()) in _CLOSING_COMPACT for body in bodies)
            or any(e['outcome_end']>start for e in envelopes)):
        raise ValueError('Blank-time passage or legacy row has formal ownership')
    for block in source['blocks']:
        bstart=source['text'].find(block['source_block'],block['source_offset'])
        outcome=source['text'].find(block['outcome_quote'],bstart,bstart+len(block['source_block'])) if bstart>=0 else -1
        if bstart<0 or outcome<0 or start<outcome+len(block['outcome_quote']) and bstart<stop:
            raise ValueError('Blank-time passage overlaps parsed formal authority')
    return {row['id']:{'type':cap['type'],'review':cap,'review_sha256':digest(review),'inventory_sha256':inventory['fingerprint']}}
