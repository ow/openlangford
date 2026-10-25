"""Exact framing-only legacy occurrence accounting for deterministic catch-up.

This is neither substring matching nor transcription/outcome certification.
Every operative word and condition must remain equal, with one original formal
occurrence and no competing old claim. Ordinary ingestion never opts in.
"""
import re

from pipeline.ingestion.source_claims import digest, project_claim, valid_inventory
from pipeline.ingestion.vote_evidence import normalize_text
from pipeline.ingestion.source_occurrences import text_occurrence_unique


def _content(text):
    text=(text or '').strip();changed=False
    text,count=re.subn(r'^1[.)]\s+','',text,count=1);changed=bool(count)
    framing=re.match(r'(?i)^that\s+(?:the\s+)?(council|committee)\b\s*:?\s*',text)
    role=framing[1].lower() if framing else None
    if framing:
        text=text[framing.end():];changed=True
        text=re.sub(r'^1[.)]\s+','',text,count=1)
    return normalize_text(text),role,changed


def exact_scaffold_reservations(source, inventory, meeting, reserved):
    from pipeline.ingestion.canonical_motions import operative_view, bound_source_motion, source_motion_candidates, source_identity
    if (not valid_inventory(inventory,meeting['id']) or source.get('local_date')!=meeting['meeting_date']
            or source.get('source_format') not in ('original_pdf_layout','official_html_structural')):
        return {}
    claims=inventory['claims'];candidates={};claimed_blocks={id(v['block']) for v in reserved.values()}
    for block in source.get('blocks',[]):
        view=operative_view(source,block)
        if view is None and source.get('source_format')=='official_html_structural':
            # The official MotionText element is already a bounded complete
            # body; never use its post-result discussion as a match surface.
            view={'status':'explicit_operative','operative_body':block['motion_text']}
        if (id(block) in claimed_blocks or not view or view.get('status')!='explicit_operative'
                or not text_occurrence_unique(source,block)):
            continue
        body,role,changed=_content(view['operative_body'])
        if not body:continue
        owners=[]
        for claim in claims:
            old,old_role,old_changed=_content(claim['text_content'])
            if old==body and not (role and old_role and role!=old_role):
                owners.append((claim,changed or old_changed))
        if len(owners)!=1 or not owners[0][1]:continue
        claim=owners[0][0]
        if (claim['id'] in reserved or bound_source_motion(claim,source,meeting['id'],inventory)
                or source_motion_candidates(source,claim['text_content'])):
            continue
        # A raw native body can retain page headers excluded from the operative
        # view. That existing exact claim still owns the same occurrence, even
        # though its framing-normalized words differ from the cleaned view.
        if any(other['id']!=claim['id'] and
               (bound_source_motion(other,source,meeting['id'],inventory) is block
                or block in source_motion_candidates(source,other['text_content'])) for other in claims):
            continue
        candidates.setdefault(claim['id'],[]).append((block,view,claim))
    result={}
    for claim_id,choices in candidates.items():
        if len(choices)!=1:continue
        block,view,claim=choices[0]
        evidence={'method':'complete_operative_body_equal_except_leading_framing_v1',
                  'authority':'occurrence_accounting_only','claim_sha256':digest(project_claim(claim)),
                  'inventory_sha256':inventory['fingerprint'],'source_identity':source_identity(meeting['id'],source,block),
                  'operative_body_sha256':digest(view['operative_body'])}
        result[claim_id]={'block':block,'review':{'motion_id':claim_id},'evidence':evidence,
                         'evidence_sha256':digest(evidence),'inventory_sha256':inventory['fingerprint']}
    return result
