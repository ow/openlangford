"""Explicit one-time accounting of old claims from public released decisions.

A supplemental witness never enters the primary source, owns a primary key,
certifies a ballot, or emits an old-row write. Only deterministic catch-up opts in.
"""
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

import fitz

from pipeline.ingestion.source_claims import build_claim_inventory, digest, project_claim
from pipeline.ingestion.source_occurrences import original_formal_inventory, formal_inventory, text_occurrence_unique, _SECOND, _OUTCOME
from pipeline.ingestion.vote_evidence import minutes_motion_blocks, normalize_text, _FORMAL_START
from .legacy_occurrence_reviews import _validate_scope, full_row_fingerprint
from .scaffold_coverage import _content

_HEADER = re.compile(r'Council[ \t]+Meeting[ \t]*\|[ \t]*Meeting[ \t]+Date:[ \t]*(?P<date>[A-Z][a-z]+[ \t]+\d{1,2},[ \t]+\d{4})')
_RELEASE_NOTICE = ('This document contains in-camera decisions that have been released because they are no longer considered sensitive.')


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _complete_keys(body):
    """Complete-body equality only; never use substring or fuzzy ownership."""
    return {normalize_text(body), _content(body)[0]} - {''}


def _source_admission(source, meeting, project_ref, municipality_id, archive_root):
    from . import reviewed_sources
    path = reviewed_sources.STORE / f"{meeting['id']}.json"
    expected = reviewed_sources.ENROLLED.get(meeting['id'])
    if (not expected or reviewed_sources.STORE.is_symlink() or path.is_symlink()
            or not path.resolve().is_relative_to(reviewed_sources.STORE.resolve())):
        raise ValueError('Supplemental source capability is not enrolled')
    raw = path.read_bytes()
    if _sha(raw) != expected:
        raise ValueError('Enrolled supplemental source capability changed')
    admission = json.loads(raw)
    reviewed_sources.validate_source_review(admission, meeting=meeting, root=archive_root,
        project_ref=project_ref, municipality_id=municipality_id)
    proof = source.get('source_review_evidence', {})
    if (admission.get('mode') != 'reviewed_native_image_decisions'
            or source.get('source_format') != 'original_pdf_reviewed_image_decisions'
            or proof.get('review_sha256') != digest(admission) or proof.get('mode') != admission['mode']
            or any(admission.get(k) != source.get(v) for k,v in (
                ('selected_file','source_file'),('source_sha256','source_sha256'),('source_url','source_url')))):
        raise ValueError('Supplemental capability is not bound to current primary source proof')
    return admission


def _header(text, quote, offset, expected_date):
    matches = list(_HEADER.finditer(text))
    if len(matches) != 1 or matches[0][0] != quote or matches[0].start() != offset:
        raise ValueError('Public release meeting header is absent, changed or not unique')
    try:
        actual = datetime.strptime(matches[0]['date'], '%B %d, %Y').date().isoformat()
    except ValueError as error:
        raise ValueError('Public release meeting date is invalid') from error
    if actual != expected_date:
        raise ValueError('Public release date does not match the actual meeting date')
    if (not re.search(r'\bRise\s+and\s+Report\b', text)
            or not re.search(r'\bIn\s+Camera\s+Decisions\b', text)
            or _RELEASE_NOTICE not in ' '.join(text.split())):
        raise ValueError('Supplement is not an explicit public Rise and Report release')


def _released_occurrence(cap, admission, meeting, archive_root):
    """Read a single native one-page released occurrence; never fake a roster."""
    from .reviewed_sources import bound_file
    if (cap.get('type') != 'reviewed_published_supplemental_formal_occurrence'
            or cap.get('authority') != 'supplemental_occurrence_accounting_only'
            or any(k in cap for k in ('source_key','source_identity','canonical_source_motion'))
            or cap.get('source_date') != meeting['meeting_date']
            or cap.get('page') != 1 or cap.get('pymupdf_version') != fitz.VersionBind
            or cap.get('render_scale') not in (1.5,2,3,4)):
        raise ValueError('Unsupported or changed supplemental occurrence scope')
    for field, expected in [('first_review_sha256', admission.get('independent_original_image_review_sha256')),
            ('independent_review_sha256', admission.get('supplemental_independent_review_sha256'))]:
        if not re.fullmatch(r'[a-f0-9]{64}', cap.get(field, '')) or cap[field] != expected:
            raise ValueError('Supplemental occurrence lacks pinned independent source review')
    if cap['first_review_sha256'] == cap['independent_review_sha256']:
        raise ValueError('Supplemental source reviews must be independent')
    location = urlsplit(cap['source_url'])
    if (location.scheme != 'https' or location.hostname not in (
            'langford.ca','www.langford.ca','pub-langford.escribemeetings.com')
            or location.username or location.password):
        raise ValueError('Supplemental occurrence must have its reviewed official public URL')
    relative = Path(cap['source_file'])
    folder = Path(meeting['archive_path'])/'Minutes'
    listed = {'file':cap['source_file'],'sha256':cap['source_sha256'],'url':cap['source_url']}
    if (relative.parent != folder or relative.suffix.lower() != '.pdf'
            or relative == Path(admission['selected_file']) or cap['source_sha256'] == admission['source_sha256'] or (archive_root/folder).is_symlink()
            or admission['file_inventory'].count(listed) != 1):
        raise ValueError('Supplemental PDF is not a distinct listed meeting original')
    original = bound_file(archive_root,cap['source_file'],cap['source_sha256'])
    try:
        with fitz.open(original) as pdf:
            if len(pdf) != 1:
                raise ValueError('Only one-page published supplemental releases are supported')
            native = pdf[0].get_text()
            scale = cap['render_scale']
            render = pdf[0].get_pixmap(matrix=fitz.Matrix(scale,scale)).tobytes('png')
        layout = subprocess.run(['pdftotext','-layout',str(original),'-'],check=True,
            capture_output=True,text=True,timeout=30).stdout
    except (RuntimeError,subprocess.SubprocessError) as error:
        raise ValueError('Supplemental original extraction or render unavailable') from error
    if (_sha(native.encode()) != cap['native_text_sha256'] or _sha(render) != cap['render_sha256']
            or _sha(layout.encode()) != cap['layout_text_sha256']):
        raise ValueError('Supplemental native/render/layout evidence changed')
    _header(layout,cap['layout_meeting_header_quote'],cap['layout_header_offset'],meeting['meeting_date'])
    _header(native,cap['native_meeting_header_quote'],cap['native_header_offset'],meeting['meeting_date'])
    inventory = original_formal_inventory(layout)
    blocks = list(minutes_motion_blocks(layout))
    supplemental = {'text':layout,'blocks':blocks,'formal_occurrence_inventory':inventory}
    introductions = list(_FORMAL_START.finditer(layout))
    if (len(blocks) != 1 or len(inventory['envelopes']) != 1 or len(introductions) != 1
            or not introductions[0][0].strip().upper().startswith('MOVED')
            or len(list(_SECOND.finditer(layout))) != 1 or len(list(_OUTCOME.finditer(layout))) != 1):
        raise ValueError('Supplemental formal occurrence is absent or not unique')
    block = blocks[0]
    if (not text_occurrence_unique(supplemental,block)
            or block['source_offset'] != cap['source_offset'] or block['source_order'] != cap['source_order']
            or digest(block) != cap['raw_block_sha256'] or digest(inventory) != cap['formal_inventory_sha256']
            or block['result'] != 'CARRIED' or cap.get('result') != 'CARRIED'
            or cap['outcome_quote'] != block['outcome_quote']
            or _sha(cap['operative_body'].encode()) != cap['operative_body_sha256']
            or ''.join(cap['operative_body'].split()) != ''.join(block['motion_text'].split())):
        raise ValueError('Reviewed supplemental complete body/result/occurrence changed')
    return block


def validate_supplemental_preservations(review, *, source, inventory, current_rows, meeting,
                                       project_ref, municipality_id, archive_root):
    entries = review.get('supplemental_preservations', [])
    if not entries:
        return {}
    if not isinstance(entries,list) or any(not isinstance(entry,dict) for entry in entries):
        raise ValueError('Supplemental preservation entries must be explicitly reviewed records')
    _validate_scope(review,source=source,inventory=inventory,meeting_id=meeting['id'],project_ref=project_ref,
        municipality_id=municipality_id,archive_root=archive_root)
    if (source.get('local_date') != meeting['meeting_date'] or meeting.get('classification') != 'Council'
            or source.get('source_classification') != 'Council' or not project_ref or municipality_id is None
            or build_claim_inventory(current_rows,meeting_id=meeting['id'],expected_count=len(current_rows)) != inventory):
        raise ValueError('Complete current Council/source scope required for supplemental preservation')
    admission = _source_admission(source,meeting,project_ref,municipality_id,archive_root)
    from pipeline.ingestion.canonical_motions import bound_source_motion, operative_view
    rows = {r['id']:r for r in current_rows}
    preserved, seen_occurrences, seen_bodies = {},set(),set()
    primary_keys = set()
    for block in source.get('blocks', []):
        bodies = [block['motion_text']]
        view = operative_view(source,block)
        if view and view.get('status') == 'explicit_operative':
            bodies.extend([view['operative_body'],*view.get('match_aliases',[])])
        for text in bodies:
            primary_keys.update(_complete_keys(text))
    # An unrecognized mover spelling can leave a real original envelope
    # unparsed. It is still a potential primary owner, never an excuse to
    # account the same body as exclusively supplemental.
    for envelope in formal_inventory(source)['envelopes']:
        primary_keys.update(_complete_keys(envelope['body']))
        primary_keys.update(_complete_keys(envelope.get('body_view',envelope['body'])))
    for entry in entries:
        row = rows.get(entry['motion_id'])
        if (not row or digest(project_claim(row)) != entry['claim_sha256']
                or full_row_fingerprint(row) != entry['claim_row_sha256'] or row['text_content'] != entry['legacy_text']
                or row.get('result') != entry['expected_stored_result']):
            raise ValueError('Reviewed supplemental current row changed')
        cap = entry['supplemental_review']
        if not isinstance(cap,dict):
            raise ValueError('Supplemental preservation requires an explicit source capability')
        if (entry.get('type') != 'reviewed_published_supplemental_formal_preservation'
                or entry.get('authority') != 'supplemental_occurrence_accounting_only'
                or entry.get('result_policy') != 'preserve_existing_without_rewrite'
                or entry.get('primary_source_review_sha256') != digest(admission)
                or admission.get('published_supplemental_occurrence_reviews',[]).count(cap) != 1
                or any(k in entry for k in ('source_key','source_identity','canonical_source_motion'))):
            raise ValueError('Supplemental preservation lacks checked enrolled source capability')
        block = _released_occurrence(cap,admission,meeting,archive_root)
        if row.get('result') not in (None,block['result']):
            raise ValueError('Stored supplemental outcome conflicts with the public release')
        # Existing source/ballot identities cannot be silently relabelled. Known
        # actor IDs and arbitrary manual metadata remain untouched, not certified.
        if any((row.get('meta') or {}).get(k) for k in ('canonical_source_motion','source_motion','operative_motion_body',
                'full_transcription_validation','ballot_reconstruction','vote_record','prior_vote_record','prior_ballot_proof',
                'pending_ballot_proof','source_legacy_binding','source_motion_correction','canonical_text_restoration','canonical_text_restoration_history')):
            raise ValueError('Supplemental row has existing source or ballot authority requiring review')
        old_keys = _complete_keys(row['text_content'])
        body_keys = _complete_keys(cap['operative_body'])
        if ((old_keys|body_keys) & primary_keys
                or bound_source_motion(row,source,meeting['id'],inventory) is not None):
            raise ValueError('Supplemental claim or full body overlaps a primary formal owner')
        occurrence = (cap['source_sha256'],block['source_offset'],block['source_order'])
        if row['id'] in preserved or occurrence in seen_occurrences or body_keys & seen_bodies:
            raise ValueError('Supplemental occurrence ownership is not one-to-one')
        for other in current_rows:
            identity = (other.get('meta') or {}).get('canonical_source_motion') or {}
            if other['id'] != row['id'] and (_complete_keys(other['text_content']) & (old_keys|body_keys)
                    or identity.get('source_sha256') == cap['source_sha256']):
                raise ValueError('Competing old supplemental occurrence owner')
        preserved[row['id']] = {'review_sha256':digest(review),'supplemental_file':cap['source_file'],
            'supplemental_sha256':cap['source_sha256'],'supplemental_url':cap['source_url']}
        seen_occurrences.add(occurrence);seen_bodies.update(body_keys)
    return preserved
