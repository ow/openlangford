"""Catch-up-only disjointness proof; a disputed closing never becomes a bound fact."""
import hashlib
import re

import fitz

from pipeline.ingestion.source_claims import build_claim_inventory, digest, project_claim
from pipeline.ingestion.source_occurrences import original_formal_inventory, text_occurrence_unique
from .legacy_occurrence_reviews import _validate_scope, _literal_spans, full_row_fingerprint, _reviewed_native_correction
from .supplemental_preservation import _source_admission

_LEGACY = re.compile(r'(?:That (?:the )?meeting be adjourned|Motion to adjourn the meeting|That Council adjourn the meeting)\.',re.I)
_EVENT = re.compile(r'(?:The Chair|(?:Acting )?Mayor [A-Z][a-z]+) adjourned the meeting at (?:1[0-2]|[1-9]):[0-5][0-9] ?(?:(?:am|pm)\.|[ap]\.m\.)')
_COMPACT_EVENT = re.compile(_EVENT.pattern.replace(' ', ''))


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _complete_passage(text, body, passage, start):
    spans=_literal_spans(text,body)
    if len(spans)!=1 or type(start) is not int or spans[0]!=(start,start+len(passage)) or text[start:start+len(passage)]!=passage:
        raise ValueError('Closing conflict passage absent, changed or not unique')
    left=text.rfind('\n',0,start)+1;right=text.find('\n',start+len(passage))
    if right<0:right=len(text)
    if text[left:start].strip() or text[start+len(passage):right].strip():
        raise ValueError('Closing conflict passage is not a complete line')
    return spans[0]


def validate_closing_conflicts(review, *, source, inventory, current_rows, meeting,
                              project_ref, municipality_id, archive_root, linked_vote_counts=None):
    """Return per-key exclusions, NEVER formal/documentary reservations.

    Both enrolled artifacts explicitly review the same capability. All source
    keys are candidates to add, not keys owned by the disputed legacy row.
    Only an otherwise unbound generic procedural closing can qualify; metadata
    ownership of unknown/manual origin fails closed. NULL documentary claims
    must continue through the separate, unchanged NULL-only validator.
    """
    entries=review.get('closing_conflict_quarantines',[])
    if not entries:return {}
    if len(entries)!=1:
        raise ValueError('Only one reviewed disputed closing is supported')
    original=_validate_scope(review,source=source,inventory=inventory,meeting_id=meeting['id'],
        project_ref=project_ref,municipality_id=municipality_id,archive_root=archive_root)
    admission=_source_admission(source,meeting,project_ref,municipality_id,archive_root)
    if (source.get('local_date')!=meeting['meeting_date'] or original.suffix.lower()!='.pdf'
            or fitz.VersionBind!=review.get('pymupdf_version') or review.get('render_scale')!=admission.get('render_scale')
            or review.get('render_scale') not in (1.5,2,3,4)
            or build_claim_inventory(current_rows,meeting_id=meeting['id'],expected_count=len(current_rows))!=inventory
            or digest(source['blocks'])!=admission.get('parsed_blocks_sha256')
            or original_formal_inventory(source['text'])!=source.get('formal_occurrence_inventory')):
        raise ValueError('Closing conflict original/inventory/date/render changed')
    entry=entries[0];cap=entry['capability']
    if (entry.get('source_review_sha256')!=digest(admission)
            or admission.get('closing_conflict_capabilities')!=[cap]
            or cap.get('type')!='reviewed_unresolved_closing_conflict'
            or cap.get('authority')!='duplicate_screening_only_no_fact_certification'
            or any(k in cap for k in ('source_key','source_identity','raw_block_sha256','outcome_quote'))):
        raise ValueError('Closing conflict lacks an enrolled source capability')
    for field,top in (('first_review_sha256','independent_original_image_review_sha256'),
                      ('independent_review_sha256','second_independent_original_image_review_sha256')):
        if not re.fullmatch(r'[a-f0-9]{64}',cap.get(field,'')) or cap[field]!=admission.get(top) or cap[field]!=review.get(top):
            raise ValueError('Closing conflict requires two pinned independent reviews')
    if cap['first_review_sha256']==cap['independent_review_sha256']:
        raise ValueError('Closing conflict requires two distinct reviews')
    rows={row['id']:row for row in current_rows};row=rows.get(cap['motion_id'])
    if (len(rows)!=len(current_rows) or not row or digest(project_claim(row))!=cap['claim_sha256']
            or full_row_fingerprint(row)!=cap['claim_row_sha256'] or row['text_content']!=cap['legacy_text']
            or not _LEGACY.fullmatch(row['text_content']) or row.get('result')!='CARRIED'
            or cap.get('expected_stored_result')!='CARRIED' or row.get('meta') not in (None,{})
            or any(row.get(k) is not None for k in ('mover_id','seconder_id','mover','seconder'))
            or any(row.get(k) not in (None,0) for k in ('yes_votes','no_votes','abstain_votes','absent_votes'))
            or any(other['id']!=row['id'] and _LEGACY.fullmatch(other['text_content']) for other in current_rows)):
        raise ValueError('Disputed closing row changed or has competing/manual authority')
    expected_votes={'authority':'operator_scoped_linked_vote_count_v1', 'meeting_id':meeting['id'],
                    'counts':[{'motion_id':row['id'],'linked_votes':0}]}
    if linked_vote_counts!=expected_votes:
        raise ValueError('Disputed closing requires authoritative zero linked-vote count')
    # No inferred mapping, result or formal key, even if a header was missed.
    formal=original_formal_inventory(source['text'])['envelopes']
    if any(re.search(r'\badjourn\w*\b',body,re.I) for body in
            [e.get('body_view',e['body']) for e in formal]+[b['motion_text'] for b in source['blocks']]):
        raise ValueError('Closing conflict has a possible formal adjournment owner')
    body=cap['printed_body']
    if not _EVENT.fullmatch(body) or len(_COMPACT_EVENT.findall(''.join(source['text'].split())))!=1:
        raise ValueError('Closing conflict requires one complete documentary adjournment')
    span=_complete_passage(source['text'],body,cap['source_passage'],cap['source_passage_start'])
    if any(span[0]<e['outcome_end'] and e['source_start']<span[1] for e in formal):
        raise ValueError('Closing conflict overlaps formal authority')
    with fitz.open(original) as pdf:
        page_number=cap['page']
        if type(page_number) is not int or not 1<=page_number<=len(pdf):raise ValueError('Closing conflict page absent')
        page=pdf[page_number-1];native=page.get_text();scale=review['render_scale']
        page_proof={k:cap[k] for k in ('page','native_text_sha256','render_sha256')}
        if (page_proof not in admission['pages'] or _sha(native.encode())!=cap['native_text_sha256']
                or _sha(page.get_pixmap(matrix=fitz.Matrix(scale,scale)).tobytes('png'))!=cap['render_sha256']):
            raise ValueError('Closing conflict native/render witness changed')
        native_body=body
        correction=None
        if 'native_correction' in cap:
            correction=_reviewed_native_correction(cap,source,meeting,archive_root,project_ref,municipality_id)
            native_body=correction['native_quote']
            prefix,suffix=body.split('adjourned',1)
            # Only a reviewed, damaged verb witness is supported. Actor, clock
            # and surrounding event words are literal, not editable aliases.
            if (not native_body.startswith(prefix) or not native_body.endswith(suffix)
                    or not re.fullmatch(r'a[adjourned\s]{0,24}ed',native_body[len(prefix):-len(suffix)])
                    or re.search(r'\b(?:MOVE(?:D)?|SECONDED|CARRIED|DEFEATED|WITHDRAWN|TABLED)\b',native_body,re.I)):
                raise ValueError('Closing conflict native correction may repair only the verb glyph witness')
        _complete_passage(native,native_body,cap['native_passage'],cap['native_passage_start'])
        native_all='\f'.join(p.get_text() for p in pdf)
        if correction:
            if native_all.count(native_body)!=1:
                raise ValueError('Closing conflict native correction witness is not unique')
            native_all=native_all.replace(native_body,body,1)
        if len(_literal_spans(native_all,body))!=1 or len(_COMPACT_EVENT.findall(''.join(native_all.split())))!=1:
            raise ValueError('Closing conflict native event absent or not unique')
    from pipeline.ingestion.canonical_motions import source_identity, source_motion_candidates, bound_source_motion, operative_view
    if bound_source_motion(row,source,meeting['id'],inventory) or source_motion_candidates(source,row['text_content']):
        raise ValueError('Disputed closing owns a formal source occurrence')
    allowed=cap['allowed_new_decisions']
    if not allowed or allowed!=admission.get('accepted_decisions'):
        raise ValueError('Closing conflict new-decision allowlist changed')
    keys=set()
    for accepted in allowed:
        key=accepted['source_key'];choices=[b for b in source['blocks'] if source_identity(meeting['id'],source,b)['key']==key]
        if len(choices)!=1 or key in keys:raise ValueError('Closing conflict candidate key absent or duplicate')
        block=choices[0];view=operative_view(source,block)
        if (not text_occurrence_unique(source,block) or digest(block)!=accepted['raw_block_sha256']
                or key not in source.get('reviewed_new_decision_keys',[]) or not view or view.get('status')!='explicit_operative'
                or view.get('original_image_review',{}).get('review_sha256')!=digest(admission)
                or view['operative_body']!=accepted['operative_body'] or block['result']!=accepted['result']
                or ''.join(block['motion_text'].split())!=''.join(accepted['operative_body'].split())
                or _sha(accepted['operative_body'].encode())!=accepted['operative_body_sha256']
                or re.search(r'\badjourn\w*\b',accepted['operative_body'],re.I)):
            raise ValueError('Closing conflict candidate lacks strict unique full-body source proof')
        for old in current_rows:
            if (bound_source_motion(old,source,meeting['id'],inventory) is block
                    or block in source_motion_candidates(source,old['text_content'])):
                raise ValueError('Closing conflict candidate already has a legacy owner')
        keys.add(key)
    return {row['id']:{'allowed_new_keys':keys,'review_sha256':digest(review)}}
