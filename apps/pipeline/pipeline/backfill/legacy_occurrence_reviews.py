"""Reviewed reservations preserve abbreviated legacy claims without certifying text.

Only the deterministic catch-up planner opts in. Ordinary ingestion and ballots
must never treat these reservations as full transcriptions or verified outcomes.
"""
import hashlib
import json
from pathlib import Path
import re

import fitz

from pipeline.ingestion.source_claims import build_claim_inventory, digest, project_claim, valid_inventory

STORE = Path(__file__).parent / 'data' / 'legacy-occurrence-reviews'
ENROLLED = {
    227: '20371f7340fefef8e0cdac7e66d9410f7f65ef7937f5e7fac6ed20a4bc556469',
    98: '427d6c34286b10bc473d99467e652fc5088e35baedfe6ece45c7483504eb4e90',
    62: '8fd906b929274bf8574a757d23245e94683761f4fbfd1e086994187e460da20a',
    55: '7b545dd31baeba989363300897dfca2209211fa08e4a6901a22dfd10b7a29c02',
    216: 'fd0191b17e5b1847908dae19e0a7ed227c0460ebfb496f42a8f1045464c6a544',
    239: '31a3a97a8ac84d2a99a1d749fd7ee6ec282d8adcf4851cca637b2c6fad2938c7',
    271: 'fdda332788e73b1083472ad3936dd5afc766d747e02a3f16db2d5b0709c228d2',
    252: 'fb4f42e00ce6c6c8f8dc80935c2ef665102b0c6aeabe06b63fbc52c0499e8486',
    103: '43b9497f5f945d1913d341721646d016deebf2249f7e4fdd3007cfeec9f2d695',
    369: 'f211c642bb6e9f4fbdd61ae52245df9789fe009e2f43a99f1946af6ddae3d0a7',
    79: '396aa3c87da6d21ac9e5ead28d0e5a0e86eaf4a04c5fc6d4431f55701b2745c0',
    364: 'ac039572d1ee0eca2602eedf6465c3e8afab19b2a438c93757a3f820db1ed969',
    274: '9621c230b59a8ae3120405b2d44520b6bf97eece2ff6331ca286115abe518900',
    193: '97736941e3081deb997e935cba0c218e71b13b0e587ee76421c98abd4189f0ea',
    76: '599088a6179f83fac037d1f7aa6da170e709c31da71b5deb7077204860d293de',
    110: '12429947201cef62fa4989087feab0ec6cdc8c31bb8d817d38d6d9201ad77765',
    360: 'c281e7d4c9fa8985683123927a6ba29b7410ba0a770042f569cc7dbc6fc71a1d',
    308: '9f277f0a05c2dd5743775255f3d4201d231c231c05eaf8e85a8dd78ee13b985c',
    56: '0f0ef9b1f5dd7a9277647c929b3efa60eb8fef70b82ac5b459cdcbc9ac251381',
    53: 'faa2f772c2a4d1f214ab1c775baa6b214f80b3a19f64aec49daa616829961cad',
    111: 'e8ba354f94cf4ce6fa49152352e277c8f9c740bab45a61259fff43f62e7371b3',
    158: '464003e300ba9c901cdfb9ee471348439f97e01ace6f5ad6ef67627a6adf87e6',
    323: '74b658feb501387d7944640b7bbdfe06008b8cda77f26a348eaaa3034aab4799',
    237: '200d11a3758ca8a30d05d1ff0e7cbe83fa84026f9cabf06e860f2428fc15f986',
    89: '87e5b7ab618c40e573905ceb059aaefc1d1d2603206f6f33ae44d004ddb78102',
    75: '9ccb52ede4fce4f1a9abece79b37259add625aa59db096477e9f2836de254330',
    144: 'd89cbb8546ec9133c6cf54fc032b9c361404c012a26479ac17531b8eb5eac25b',
    125: 'ed381022fe20cb28bd165b12b38b791b08c388b09743cd6a57cbad86e47ff7c3',
    215: 'b9256db3cfd9a3f794d27072f9b15231237984d867768f93f72a3aec6b67cee4',
    300: 'd68ab82dbe37bba53ffc0e492d6fa4d2427018c0b3a9b59ce1d9bacb77fbde01',
    65: 'e6bccf818dfc6f7b9b84e9af57c3bdac9de243b079705f1cfb3dda02a86c9b41',
    117: '5d9fd893e2f11293b6850acfff6aef3f04485f07e7ebd0226ceb9bc163541dcd',
    253: 'c733a6c568c7be9519fe23babbb8191ab4edceba2cf7e86e0e6de36c673ac64b',
    337: 'a61e8b0f655698108c3a72e4f14b6bc918f2480705ef42bb2fb80c7033642228',
    32: 'bc0d9c37970b6bd0858d7c486224d15ab050b9fb79ef332cb17245244e0c3288',
    297: '0082d73b6e1e935994f5cb522d6d95d840d12700010b0c442c8522bd3e12dafe',
    99: '9a794307d9b4ddbe9b69a3122a265ba70624b777ff2674872335b051eed1919b',
    361: 'd7c0054f80d79ad865f374a1e24d94d6f8b4361880bd0bb48b941e87b09589bd',
}


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


def _validate_scope(review, *, source, inventory, meeting_id, project_ref, municipality_id, archive_root):
    """All claim/source changes invalidate the entire one-time reviewed batch."""
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
    return original


def validate_review(review, *, source, inventory, meeting_id, project_ref, municipality_id, archive_root):
    from pipeline.ingestion.canonical_motions import source_identity, source_motion_candidates, bound_source_motion
    _validate_scope(review, source=source, inventory=inventory, meeting_id=meeting_id,
        project_ref=project_ref, municipality_id=municipality_id, archive_root=archive_root)
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


def full_row_fingerprint(row):
    """Bind every field, including native DB timestamps/decimals and manual meta.

    Snapshot JSON uses the same default=str representation as the guarded
    operator; semantic claim fingerprints intentionally remain unchanged.
    """
    return hashlib.sha256(json.dumps(row, sort_keys=True, separators=(',', ':'),
        ensure_ascii=False, default=str).encode()).hexdigest()


def _literal_spans(text, body):
    # Only whitespace may differ from the complete reviewed printed body.
    # Case, punctuation and every non-whitespace character remain literal.
    letters = ''.join(body.split())
    if not letters:
        return []
    pattern = r'\s*'.join(re.escape(char) for char in letters)
    return [(match.start(), match.end()) for match in re.finditer(pattern, text)]


_ADJOURNMENT_LEGACY = re.compile(r'(?:That (?:the )?meeting be adjourned|Motion to adjourn the meeting|Adjournment of the meeting)\.', re.I)
_COUNCIL_ADJOURNMENT_LEGACY = re.compile(r'That Council adjourn the meeting\.', re.I)
_SPECIAL_COUNCIL_ADJOURNMENT_LEGACY = re.compile(r'That the Special Council meeting be adjourned\.', re.I)
_ADJOURNMENT_LEGACY_COMPACT = frozenset(
    re.sub(r'[^a-z0-9]', '', body.casefold()) for body in (
        'That the meeting be adjourned.', 'That meeting be adjourned.',
        'Motion to adjourn the meeting.', 'Adjournment of the meeting.',
        'That Council adjourn the meeting.',
        'That the Special Council meeting be adjourned.'))
_ADJOURNMENT_NARRATION = re.compile(r'(?:The Chair|(?:Acting )?Mayor [A-Z][a-z]+) adjourned the meeting at (?:1[0-2]|[1-9]):[0-5][0-9] ?(?:(?:am|pm)\.|[ap]\.m\.)')
_ADJOURNMENT_COMPACT = re.compile(r'(?:TheChair|(?:Acting)?Mayor[A-Z][a-z]+)adjournedthemeetingat(?:1[0-2]|[1-9]):[0-5][0-9](?:(?:am|pm)\.|[ap]\.m\.)')


def _adjournment_legacy_eligible(text, meeting, source):
    if _ADJOURNMENT_LEGACY.fullmatch(text):
        return True
    if _COUNCIL_ADJOURNMENT_LEGACY.fullmatch(text):
        return meeting.get('classification') == source.get('source_classification') == 'Council'
    # A named meeting is not a generic alias for another meeting type. This
    # correspondence is limited to the catalog and original header agreeing.
    return bool(_SPECIAL_COUNCIL_ADJOURNMENT_LEGACY.fullmatch(text)
        and meeting.get('type') == 'Special Council'
        and meeting.get('classification') == source.get('source_classification') == 'Council'
        and re.search(r'(?im)^\s*Special\s+Council\s+Minutes\b', source['text'][:1500]))


def _reviewed_native_correction(entry, source, meeting, archive_root, project_ref, municipality_id):
    """A typed event correction must live in the separately enrolled source review."""
    from pipeline.backfill import reviewed_sources
    path = reviewed_sources.STORE / f"{meeting['id']}.json"
    expected = reviewed_sources.ENROLLED.get(meeting['id'])
    if (not expected or reviewed_sources.STORE.is_symlink() or path.is_symlink()
            or not path.resolve().is_relative_to(reviewed_sources.STORE.resolve())):
        raise ValueError('Native documentary correction source review not enrolled')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('Enrolled native documentary correction review changed')
    admission = json.loads(raw)
    reviewed_sources.validate_source_review(admission, meeting=meeting, root=archive_root,
        project_ref=project_ref, municipality_id=municipality_id)
    proof = source.get('source_review_evidence', {})
    correction = entry['native_correction']
    independent = correction.get('independent_review_sha256', '')
    if (admission.get('mode') != 'reviewed_native_image_decisions'
            or source.get('source_format') != 'original_pdf_reviewed_image_decisions'
            or any(admission.get(k) != source.get(v) for k,v in (('source_sha256','source_sha256'),
                ('selected_file','source_file'),('source_url','source_url')))
            or proof.get('review_sha256') != digest(admission)
            or proof.get('mode') != admission['mode']
            or not re.fullmatch(r'[a-f0-9]{64}', independent)
            or independent != admission.get('independent_original_image_review_sha256')
            or [c for c in admission.get('documentary_native_corrections', [])
                if c.get('page') == entry['page'] and c.get('native_quote') == entry['native_passage']] != [correction]
            or correction.get('authority') != 'reviewed_documentary_native_witness_correction_only'
            or correction.get('page') != entry['page']
            or correction.get('native_quote') != entry['native_passage']
            or correction.get('printed_quote') != entry['printed_body']
            or any(correction.get(k) != entry[k] for k in ('native_text_sha256', 'render_sha256'))
            or not any(p == {k: entry[k] for k in ('page', 'native_text_sha256', 'render_sha256')}
                       for p in admission.get('pages', []))):
        raise ValueError('Native documentary correction lacks enrolled independent image proof')
    return correction


def validate_documentary_preservations(review, *, source, inventory, current_rows, meeting,
                                      project_ref, municipality_id, archive_root):
    """Account reviewed nonformal legacy rows without motion or ballot authority.

    These records never reserve a formal source key, never become a write, and
    remain explicit documentary holds. Unknown outcomes must stay unknown.
    The separate full-row fingerprint includes manual metadata omitted by the
    ordinary semantic inventory. Any successful addition requires re-review.
    """
    entries = review.get('documentary_preservations', [])
    if not entries:
        return {}
    original = _validate_scope(review, source=source, inventory=inventory, meeting_id=meeting['id'],
        project_ref=project_ref, municipality_id=municipality_id, archive_root=archive_root)
    if (source.get('local_date') != meeting['meeting_date'] or not project_ref or municipality_id is None
            or original.suffix.lower() != '.pdf' or fitz.VersionBind != review.get('pymupdf_version')
            or review.get('render_scale') not in (1.5, 2, 3, 4)):
        raise ValueError('Documentary original/date/render scope changed')
    rows = {row['id']: row for row in current_rows}
    if len(rows) != len(current_rows) or build_claim_inventory(current_rows, meeting_id=meeting['id'], expected_count=len(current_rows)) != inventory:
        raise ValueError('Complete current documentary rows required')
    from pipeline.ingestion.canonical_motions import bound_source_motion, source_motion_candidates
    from pipeline.ingestion.source_occurrences import formal_inventory
    from pipeline.ingestion.vote_evidence import normalize_text
    formal = formal_inventory(source)['envelopes']
    preserved = {}
    with fitz.open(original) as document:
        native_pages = [page.get_text() for page in document]
        native_text = '\f'.join(native_pages)
        for entry in entries:
            row = rows.get(entry['motion_id'])
            if (not row or digest(project_claim(row)) != entry['claim_sha256']
                    or full_row_fingerprint(row) != entry['claim_row_sha256']
                    or row['text_content'] != entry['legacy_text']):
                raise ValueError('Reviewed documentary row changed')
            kind = entry.get('type', 'reviewed_literal_documentary_preservation')
            if kind == 'reviewed_literal_documentary_preservation':
                if entry['printed_body'] != row['text_content']:
                    raise ValueError('Literal documentary body differs from legacy claim')
            elif kind == 'reviewed_adjournment_narration_preservation':
                if (not _adjournment_legacy_eligible(row['text_content'], meeting, source)
                        or not _ADJOURNMENT_NARRATION.fullmatch(entry['printed_body'])
                        or len(_ADJOURNMENT_COMPACT.findall(''.join(source['text'].split()))) != 1
                        or any(other['id'] != row['id'] and (_ADJOURNMENT_LEGACY.fullmatch(other['text_content'])
                                   or _COUNCIL_ADJOURNMENT_LEGACY.fullmatch(other['text_content'])
                                   or _SPECIAL_COUNCIL_ADJOURNMENT_LEGACY.fullmatch(other['text_content']))
                               for other in current_rows)):
                    raise ValueError('Reviewed adjournment narration is not a unique bounded documentary correspondence')
            else:
                raise ValueError('Unsupported documentary preservation type')
            if kind == 'reviewed_adjournment_narration_preservation':
                formal_bodies = [e.get('body_view', e.get('body', '')) for e in formal]
                formal_bodies.extend(block.get('motion_text', '') for block in source.get('blocks', []))
                if any(re.sub(r'[^a-z0-9]', '', body.casefold()) in _ADJOURNMENT_LEGACY_COMPACT
                       for body in formal_bodies):
                    raise ValueError('Documentary adjournment has an equivalent formal owner')
            if (bound_source_motion(row, source, meeting['id'], inventory) is not None
                    or source_motion_candidates(source, row['text_content'])
                    or any(normalize_text(e.get('body_view', e.get('body', ''))) == normalize_text(row['text_content']) for e in formal)):
                raise ValueError('Documentary legacy row owns a formal occurrence')
            if (entry['authority'] != 'documentary_preservation_only' or entry['result_policy'] != 'preserve_unknown'
                    or row.get('result') is not None or row.get('mover_id') is not None or row.get('seconder_id') is not None
                    or row['id'] in preserved
                    or any(key in entry for key in ('source_identity', 'source_key', 'raw_block_sha256'))
                    or any((row.get('meta') or {}).get(key) for key in (
                        'canonical_source_motion', 'source_motion', 'operative_motion_body', 'full_transcription_validation',
                        'ballot_reconstruction', 'vote_record', 'prior_vote_record', 'prior_ballot_proof', 'pending_ballot_proof',
                        'source_legacy_binding', 'source_motion_correction', 'canonical_text_restoration', 'canonical_text_restoration_history'))
                    or any(other['id'] != row['id'] and normalize_text(other['text_content']) == normalize_text(row['text_content'])
                           for other in current_rows)):
                raise ValueError('Documentary claim has competing or formal authority')
            page_number = entry['page']
            if not isinstance(page_number, int) or not 1 <= page_number <= len(document):
                raise ValueError('Reviewed documentary page missing')
            page = document[page_number-1]
            native = native_pages[page_number-1]
            scale = review['render_scale']
            if (hashlib.sha256(native.encode()).hexdigest() != entry['native_text_sha256']
                    or hashlib.sha256(page.get_pixmap(matrix=fitz.Matrix(scale, scale)).tobytes('png')).hexdigest() != entry['render_sha256']):
                raise ValueError('Reviewed documentary page evidence changed')
            body = entry['printed_body']
            if re.search(r'(?im)^\s*(?:MOVE(?:D)?(?:\s+BY)?\s*:|SECONDED(?:\s+BY)?\s*:|(?:Motion\s+)?(?:CARRIED|DEFEATED|WITHDRAWN|TABLED)\b)', body):
                raise ValueError('Documentary body contains formal or outcome labels')
            spans = _literal_spans(source['text'], body)
            correction = None
            if 'native_correction' in entry:
                if kind != 'reviewed_adjournment_narration_preservation':
                    raise ValueError('Literal documentary preservation cannot use native corrections')
                correction = _reviewed_native_correction(entry, source, meeting, archive_root, project_ref, municipality_id)
            native_body = correction['native_quote'] if correction else body
            native_spans = _literal_spans(native, native_body)
            if len(spans) != 1 or len(native_spans) != 1 or len(_literal_spans(native_text, native_body)) != 1:
                raise ValueError('Documentary full body is absent or not unique')
            if correction:
                before = correction['native_quote']
                if native_text.count(before) != 1 or native.count(before) != 1:
                    raise ValueError('Native documentary correction before quote is not unique')
                after_native = native_text.replace(before, correction['printed_quote'], 1)
                if len(_ADJOURNMENT_COMPACT.findall(''.join(after_native.split()))) != 1:
                    raise ValueError('Corrected documentary narration is not unique')
            elif kind == 'reviewed_adjournment_narration_preservation' and len(_ADJOURNMENT_COMPACT.findall(''.join(native_text.split()))) != 1:
                raise ValueError('Native documentary narration is not unique')
            for text, passage, start, span, complete_body in (
                    (source['text'], entry['source_passage'], entry['source_passage_start'], spans[0], body),
                    (native, entry['native_passage'], entry['native_passage_start'], native_spans[0], native_body)):
                if (not isinstance(start, int) or span != (start, start+len(passage))
                        or text[start:start+len(passage)] != passage
                        or ''.join(passage.split()) != ''.join(complete_body.split())):
                    raise ValueError('Reviewed documentary complete passage changed')
                line_start = text.rfind('\n', 0, start)+1
                line_end = text.find('\n', start+len(passage))
                if line_end < 0:
                    line_end = len(text)
                if text[line_start:start].strip() or text[start+len(passage):line_end].strip():
                    raise ValueError('Documentary passage is not a complete printed line body')
            start, stop = spans[0]
            if any(start < envelope['outcome_end'] and envelope['source_start'] < stop for envelope in formal):
                raise ValueError('Documentary passage overlaps formal authority')
            # A corrupt/missing formal inventory must not let an actual parsed
            # motion be relabelled documentary. Ignore post-outcome discussion.
            for block in source.get('blocks', []):
                block_start = source['text'].find(block['source_block'], block['source_offset'])
                outcome = source['text'].find(block['outcome_quote'], block_start,
                    block_start+len(block['source_block'])) if block_start >= 0 else -1
                if block_start < 0 or outcome < 0:
                    raise ValueError('Formal source boundaries unavailable for documentary review')
                if start < outcome+len(block['outcome_quote']) and block_start < stop:
                    raise ValueError('Documentary passage overlaps parsed formal motion')
            preserved[row['id']] = {'type': kind, 'review': entry, 'review_sha256': digest(review),
                'inventory_sha256': inventory['fingerprint']}
    return preserved
