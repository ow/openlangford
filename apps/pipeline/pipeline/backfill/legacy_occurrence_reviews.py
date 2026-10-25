"""Reviewed reservations preserve abbreviated legacy claims without certifying text.

Only the deterministic catch-up planner opts in. Ordinary ingestion and ballots
must never treat these reservations as full transcriptions or verified outcomes.
"""
import hashlib
import json
from pathlib import Path

import fitz

from pipeline.ingestion.source_claims import digest, project_claim, valid_inventory

STORE = Path(__file__).parent / 'data' / 'legacy-occurrence-reviews'
ENROLLED = {144: 'd89cbb8546ec9133c6cf54fc032b9c361404c012a26479ac17531b8eb5eac25b', 125: 'ed381022fe20cb28bd165b12b38b791b08c388b09743cd6a57cbad86e47ff7c3', 215: '38f5f1c094e3e97c6f164a5c86da1e5e48ad0cdab584a11572311863815f5cbb'}


def load_review(meeting_id):
    if meeting_id not in ENROLLED:
        return None
    path = STORE / f'{meeting_id}.json'
    if STORE.is_symlink() or path.is_symlink() or not path.resolve().is_relative_to(STORE.resolve()):
        raise ValueError('Untrusted legacy review path')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != ENROLLED[meeting_id]:
        raise ValueError('Legacy review artifact changed')
    return json.loads(raw)


def validate_review(review, *, source, inventory, meeting_id, project_ref, municipality_id, archive_root):
    """All claim/source changes invalidate the entire one-time reviewed batch."""
    from pipeline.ingestion.canonical_motions import source_identity, source_motion_candidates, bound_source_motion
    if not valid_inventory(inventory, meeting_id):
        raise ValueError('Complete current claims required for legacy review')
    expected = {'schema': 'reviewed-legacy-occurrence-reservations-v1', 'meeting_id': meeting_id,
                'project_ref': project_ref, 'municipality_id': municipality_id,
                'source_sha256': source.get('source_sha256'), 'source_url': source.get('source_url'),
                'source_file': source.get('source_file'), 'source_date': source.get('local_date'),
                'source_text_sha256': hashlib.sha256(source.get('text', '').encode()).hexdigest(),
                'formal_inventory_sha256': digest(source.get('formal_occurrence_inventory')),
                'claim_inventory_sha256': inventory['fingerprint']}
    if any(review.get(key) != value for key, value in expected.items()):
        raise ValueError('Reviewed legacy claim/source scope changed')
    original = (archive_root / source['source_file']).resolve()
    if not original.is_relative_to(archive_root.resolve()) or hashlib.sha256(original.read_bytes()).hexdigest() != source['source_sha256']:
        raise ValueError('Reviewed original bytes changed')
    if review['native_pages']:
        with fitz.open(original) as document:
            for page in review['native_pages']:
                if hashlib.sha256(document[page['page']-1].get_text().encode()).hexdigest() != page['native_text_sha256']:
                    raise ValueError('Reviewed native page evidence changed')
    claims = {row['id']: row for row in inventory['claims']}
    reserved, seen = {}, set()
    for entry in review['reservations']:
        row = claims.get(entry['motion_id'])
        if not row or digest(project_claim(row)) != entry['claim_sha256'] or row['text_content'] != entry['legacy_text']:
            raise ValueError('Reviewed legacy row changed')
        choices = [block for block in source.get('blocks', [])
                   if source_identity(meeting_id, source, block) == entry['source_identity']
                   and digest(block) == entry['raw_block_sha256']]
        if len(choices) != 1 or entry['authority'] != 'occurrence_reservation_only':
            raise ValueError('Reviewed legacy occurrence changed')
        block = choices[0]
        key = entry['source_identity']['key']
        if row['id'] in reserved or key in seen or source['text'].count(block['source_block']) != 1:
            raise ValueError('Legacy review ownership is not one-to-one')
        for other in inventory['claims']:
            if other['id'] != row['id'] and (bound_source_motion(other, source, meeting_id, inventory) is block
                    or block in source_motion_candidates(source, other['text_content'])):
                raise ValueError('Competing legacy occurrence claim')
        reserved[row['id']] = {'block': block, 'review': entry,
                              'review_sha256': digest(review), 'inventory_sha256': inventory['fingerprint']}
        seen.add(key)
    return reserved
