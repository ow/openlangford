"""Source-first motion identities and non-destructive refresh planning.

AI proposals enrich exact formal source motions. They cannot introduce a motion,
change its operative words, or erase a previously persisted record. Unresolved
legacy identities block new inserts rather than manufacture duplicates.
"""
from collections import Counter, defaultdict
from copy import deepcopy
from datetime import date
import hashlib
import json
import re

from .native_transcriptions import bound_transcription
from .source_claims import build_claim_inventory, valid_inventory
from .vote_evidence import normalize_text, _OCR_MOVED_START
from .ballot_reconstruction import validate_roster_entries
from .source_occurrences import text_occurrence_unique, own_formal_envelopes, matching_formal_envelopes, unparsed_formal_envelopes, matching_envelopes_all_parsed


def source_identity(meeting_id, source, block):
    identity = {'meeting_id': meeting_id, 'source_sha256': source['source_sha256'],
                'source_offset': block['source_offset'], 'source_order': block['source_order']}
    return {**identity, 'key': hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest(),
            'source_file': source['source_file'], 'source_url': source.get('source_url'),
            'source_format': source['source_format'], 'raw_motion_text': block['motion_text'],
            'source_block': block['source_block'], 'outcome_quote': block['outcome_quote'],
            'formal_source_kind': block.get('formal_source_kind', 'moved_motion')}


def operative_view(source, block):
    """A supplementary body never replaces its raw occurrence witness."""
    key = f"{block['source_offset']}:{block['source_order']}"
    view = source.get('operative_views', {}).get(key)
    if not view or view.get('source_sha256') != source.get('source_sha256') or view.get('raw_block') != block:
        return None
    return view


def source_motion_match_keys(source, block):
    keys = {normalize_text(block['motion_text'])}
    view = operative_view(source, block)
    if view and view['status'] == 'explicit_operative':
        keys.update(normalize_text(text) for text in [view['operative_body'], *view.get('match_aliases', [])])
    return keys - {''}


def source_motion_candidates(source, text):
    """Text fallback needs one original formal envelope, not merely one parsed body.

    Current occurrence identities are resolved separately by bound_source_motion.
    """
    key = normalize_text(text)
    return [block for block in source.get('blocks', []) if key in source_motion_match_keys(source, block) and text_occurrence_unique(source, block)]


def source_motion_ownership_issues(source, text):
    key = normalize_text(text)
    return [{'source_offset': block['source_offset'], 'source_order': block['source_order'],
             'matching_formal_envelopes': len(matching_formal_envelopes(source, block)),
             'own_formal_envelopes': len(own_formal_envelopes(source, block))}
            for block in source.get('blocks', [])
            if key in source_motion_match_keys(source, block) and not text_occurrence_unique(source, block)]


def operative_proof(source, block):
    view = operative_view(source, block)
    return {key: value for key, value in view.items() if key != 'raw_block'} if view else None


def bound_source_motion(motion, source, meeting_id, claim_inventory=None):
    """Resolve only a current, recomputed documentary occurrence identity.

    Repeated words alone cannot distinguish two ballots. Historical keys are
    continuity evidence, never permission to choose a different occurrence.
    """
    identity = (motion.get('meta') or {}).get('canonical_source_motion') or {}
    if motion.get('meeting_id') != meeting_id or identity.get('meeting_id') != meeting_id:
        return None
    if not source.get('source_sha256') or identity.get('source_sha256') != source['source_sha256']:
        return None
    matches = []
    for block in source.get('blocks', []):
        if identity.get('source_offset') != block['source_offset'] or identity.get('source_order') != block['source_order']:
            continue
        body = normalize_text(block['motion_text'])
        if not body or normalize_text(identity.get('raw_motion_text')) != body:
            continue
        payload = {'meeting_id': meeting_id, 'source_sha256': source['source_sha256'],
                   'source_offset': block['source_offset'], 'source_order': block['source_order']}
        key = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        if (identity.get('key') == key and len(own_formal_envelopes(source, block)) == 1
                and (normalize_text(motion.get('text_content')) in source_motion_match_keys(source, block)
                     or bound_transcription(motion, source, block, claim_inventory))):
            matches.append(block)
    return matches[0] if len(matches) == 1 else None


def catalog_cac_candidate(meeting):
    """Known Langford generic catalog labels still require the native CAC title."""
    title = normalize_text(meeting.get('title'))
    path = meeting.get('archive_path', '').replace('\\', '/')
    named = bool(re.search(r'community\s+advisory\s+committee', meeting.get('title', '')+' '+path, re.I))
    generic = title in {'advisory committee', 'joint advisory committee'} or bool(re.search(r'(?:^|/)(?:Joint|Community) Advisory Committee(?:/|$)', path, re.I))
    return named or (meeting.get('classification') in ('Committee', 'Advisory Committee') and generic)


def canonical_motion_plan(items, context, existing_motions):
    """Plan unique exact legacy bindings; leave uncertain history untouched.

    Source revisions can reuse an old ID only through an exact unique body or
    an exact previously recorded source key. No source-order-only or fuzzy
    association is safe when an official document has been replaced.
    """
    items = deepcopy(items)
    for item in items:
        item['_unverified_motion_proposals'] = item.pop('motions', [])
        item['motions'] = []
    source = context.get('source') or {}
    if context.get('status') != 'available' or source.get('error'):
        return items, {'status': source.get('error') or context.get('status'), 'held': [], 'source_motions': 0}
    # Ballot eligibility may be held separately, but source/document binding is
    # still required before its formal words can become a canonical motion.
    meeting = context['meeting']
    claim_inventory = context.get('meeting_claim_inventory')
    if claim_inventory is not None and claim_inventory.get('status') == 'complete':
        current_claims = build_claim_inventory(existing_motions, meeting_id=meeting['id'], expected_count=len(existing_motions))
        if not valid_inventory(claim_inventory, meeting['id']) or current_claims != claim_inventory:
            return items, {'status': 'meeting_claim_inventory_changed', 'held': [], 'source_motions': 0}
    if not source.get('local_date') or abs((date.fromisoformat(source['local_date']) - date.fromisoformat(meeting['meeting_date'])).days) > 1:
        return items, {'status': 'source_date_not_bound', 'held': [], 'source_motions': 0}
    body_old = defaultdict(list)
    key_old = defaultdict(list)
    for row in existing_motions:
        body_old[normalize_text(row.get('text_content'))].append(row)
        identity = (row.get('meta') or {}).get('canonical_source_motion') or {}
        for key in [identity.get('key'), *identity.get('previous_keys', [])]:
            if key:
                key_old[key].append(row)
    catalog_cotw = bool(re.search(r'committee\s+of\s+the\s+whole|\bCOTW\b', meeting.get('title', '')+' '+meeting.get('archive_path', ''), re.I))
    catalog_cac = catalog_cac_candidate(meeting)
    native_cac = bool(re.search(r'community\s+advisory\s+committee', source.get('source_header', ''), re.I))
    if context.get('allow_reviewed_source_header') and source.get('source_review_evidence') and source.get('reviewed_committee_scope',{}).get('scope')=='Community Advisory Committee':
        native_cac=True
    expected_body = 'Committee' if catalog_cac and native_cac else 'Committee of the Whole' if catalog_cotw else meeting.get('classification')
    allowed_bodies = ('Council', 'Committee of the Whole', 'Committee') if catalog_cac and native_cac else ('Council', 'Committee of the Whole')
    if source.get('source_classification') not in allowed_bodies or source.get('source_classification') != expected_body:
        return items, {'status': 'source_voting_body_not_bound', 'held': [], 'source_motions': 0}
    blocks = source.get('blocks', [])
    body_counts = Counter(key for block in blocks for key in source_motion_match_keys(source, block))
    bindings = []
    for block in blocks:
        identity = source_identity(meeting['id'], source, block)
        compatible = [row for row in existing_motions if normalize_text(row.get('text_content')) in source_motion_match_keys(source, block)]
        choices = key_old.get(identity['key']) or compatible
        choices = [row for row in choices if bound_source_motion(row, source, meeting['id'], claim_inventory) is block
                   or (len(source_motion_candidates(source, row['text_content'])) == 1
                       and normalize_text(row['text_content']) in source_motion_match_keys(source, block))]
        bindings.append((block, identity, choices))
    reservations = {}
    documentary_preservations = {}
    # This source-bound, repo-enrolled manual review reserves an abbreviated
    # legacy occurrence only in explicit deterministic catch-up. It cannot
    # authorize an ordinary rewrite, outcome update or ballot inference.
    if context.get('allow_reviewed_legacy_reservations'):
        from pipeline.backfill.legacy_occurrence_reviews import load_review, validate_review, validate_documentary_preservations
        try:
            review = load_review(meeting['id'])
            if review:
                reservations = validate_review(review, source=source, inventory=claim_inventory,
                    meeting_id=meeting['id'], project_ref=context.get('project_ref'),
                    municipality_id=context.get('municipality_id'), archive_root=context['archive_root'])
                documentary_preservations = validate_documentary_preservations(review, source=source, inventory=claim_inventory,
                    current_rows=existing_motions, meeting=meeting, project_ref=context.get('project_ref'),
                    municipality_id=context.get('municipality_id'), archive_root=context['archive_root'])
                if set(reservations) & set(documentary_preservations):
                    raise ValueError('Legacy row cannot own both formal and documentary reservations')
        except (ValueError, OSError, KeyError) as error:
            return items, {'status': 'reviewed_legacy_occurrence_review_stale',
                           'held': [{'reason': 'reviewed_legacy_occurrence_review_stale', 'detail': str(error)}],
                           'source_motions': len(blocks)}
        from pipeline.backfill.scaffold_coverage import exact_scaffold_reservations
        reservations.update(exact_scaffold_reservations(source,claim_inventory,meeting,reservations))
    bound_ids = {choices[0]['id'] for block, identity, choices in bindings if len(choices) == 1} | set(reservations) | set(documentary_preservations)
    unresolved = [row['id'] for row in existing_motions if row['id'] not in bound_ids]
    all_current_bound = all(row['id'] in reservations or row['id'] in documentary_preservations or bound_source_motion(row, source, meeting['id'], claim_inventory) is not None for row in existing_motions)
    held = [{'reason': ('reviewed_adjournment_narration_preserved_no_rewrite'
                       if entry['type']=='reviewed_adjournment_narration_preservation'
                       else 'reviewed_documentary_claim_preserved_no_rewrite'), 'legacy_ids': [claim_id],
             'authority': 'documentary_preservation_only', 'review_sha256': entry['review_sha256']}
            for claim_id, entry in documentary_preservations.items()]
    for block, identity, choices in bindings:
        reservation = next((entry for entry in reservations.values() if entry['block'] is block), None)
        if reservation:
            derived='evidence_sha256' in reservation
            held.append({'source_key': identity['key'],
                         'reason': 'exact_scaffold_occurrence_reserved_no_rewrite' if derived else 'reviewed_legacy_occurrence_reserved_no_rewrite',
                         'legacy_ids': [reservation['review']['motion_id']],
                         **({'evidence_sha256':reservation['evidence_sha256']} if derived else {'review_sha256': reservation['review_sha256']})})
            continue
        key = normalize_text(block['motion_text'])
        view = operative_view(source, block)
        if view and view['status'] == 'documentary_event_only_held':
            held.append({'source_key': identity['key'], 'reason': 'source_documentary_event_not_resolution'})
            continue
        new_current_occurrence = not choices and not unresolved and all_current_bound
        proved_current_retry = (new_current_occurrence and len(own_formal_envelopes(source, block)) == 1
                                and matching_envelopes_all_parsed(source, block))
        if not text_occurrence_unique(source, block) and not proved_current_retry and not (len(choices) == 1 and bound_source_motion(choices[0], source, meeting['id'], claim_inventory) is block):
            held.append({'source_key': identity['key'], 'reason': 'original_formal_occurrence_not_unique'})
            continue
        if len(choices) > 1 or (body_counts[key] != 1 and not new_current_occurrence and (len(choices) != 1 or bound_source_motion(choices[0], source, meeting['id'], claim_inventory) is not block)):
            held.append({'source_key': identity['key'], 'reason': 'ambiguous_legacy_or_source_body'})
            continue
        if not choices and unresolved:
            held.append({'source_key': identity['key'], 'reason': 'unmapped_legacy_records', 'legacy_ids': unresolved})
            continue
        old = choices[0] if choices else None
        transcription = bound_transcription(old, source, block, claim_inventory) if old else None
        if old and normalize_text(old['text_content']) not in source_motion_match_keys(source, block) and not transcription:
            held.append({'source_key': identity['key'], 'reason': 'source_key_body_conflict', 'legacy_ids': [old['id']]})
            continue
        enrichments = [(item, proposal) for item in items for proposal in item['_unverified_motion_proposals'] if normalize_text(proposal.get('motion_text')) in source_motion_match_keys(source, block) and len(source_motion_candidates(source, proposal.get('motion_text'))) == 1]
        if len(enrichments) == 1:
            item, proposal = enrichments[0]
        else:
            # An explicit source container avoids guessing an agenda number from
            # addresses, numbered conditions, or a model's renumbered headings.
            item = next((item for item in items if item.get('item_order') == 'official-recorded-motions'), None)
            if item is None:
                item = {'item_order': 'official-recorded-motions', 'title': 'Official recorded motions', 'category': 'procedural', 'motions': [], '_unverified_motion_proposals': []}
                items.append(item)
            proposal = {}
        source_header = block['source_block'].split(block['motion_text'], 1)[0]
        recovered_header = bool(_OCR_MOVED_START.match(source_header))
        def actor(role):
            prefix = r'(?:Amendment[ \t]*:[ \t]*|\.[ \t]*)?' if role == 'MOVED' else ''
            label = r'IV[IL]OVED' if role == 'MOVED' and recovered_header else role
            match = re.search(r'(?im)^\s*'+prefix+label+r'(?:[ \t]*BY)?\s*:\s*([^\n]+)', source_header)
            return match[1].strip() if match else None
        actor_ids = {}
        actor_names = {}
        for field, role in (('mover', 'MOVED'), ('seconder', 'SECONDED')):
            raw_actor = actor(role)
            resolved, ambiguous = validate_roster_entries(raw_actor or '', source.get('present', []))
            person = resolved[0] if len(resolved) == 1 and not ambiguous else None
            actor_ids[field] = person['id'] if person else None
            actor_names[field] = person['name'] if person else raw_actor
        # Recovering a clerk's label does not repair OCR in a person's name.
        # An ordinary refresh must not erase an actor already stored on the row.
        if recovered_header and old and any(old.get(field+'_id') is not None and actor_ids[field] is None for field in actor_ids):
            held.append({'source_key': identity['key'], 'reason': 'recovered_formal_header_actor_identity_unresolved', 'legacy_ids': [old['id']]})
            continue
        display_body = (old['text_content'] if old else view['operative_body']) if view and view['status'] == 'explicit_operative' else block['motion_text']
        if transcription:
            display_body = old['text_content']
        motion = {**proposal, 'motion_text': display_body, '_operative_motion_text': display_body if view and view['status'] == 'explicit_operative' else None, 'result': block['result'],
                  **actor_names, '_canonical_actor_ids': actor_ids,
                  '_canonical_source_motion': identity, '_existing_motion': old,
                  '_source_motion': {**block, 'anchor_method': 'canonical_native_formal_motion', 'match_score': 1.0}}
        if transcription:
            motion['_full_transcription_validation'] = transcription
        if view:
            motion['_operative_motion_body'] = operative_proof(source, block)
        if old:
            old_identity = (old.get('meta') or {}).get('canonical_source_motion') or {}
            previous = list(old_identity.get('previous_keys', []))
            if old_identity.get('key') and old_identity['key'] != identity['key']:
                previous.append(old_identity['key'])
            identity['previous_keys'] = sorted(set(previous))
            history = list(old_identity.get('previous_sources', []))
            if old_identity.get('key') and old_identity['key'] != identity['key']:
                history.append({field: old_identity.get(field) for field in ('key', 'source_sha256', 'source_file', 'source_url', 'source_format', 'source_offset', 'source_order', 'raw_motion_text', 'source_block', 'outcome_quote')})
            identity['previous_sources'] = history[-8:]
        item['motions'].append(motion)
    # Count unbound native outcome markers as source-coverage leads. A clerk's
    # hearing-closure vote or an unfamiliar formal delimiter is not permission
    # to manufacture a motion, but it must not disappear from the audit either.
    bound_outcomes = []
    text = source.get('text', '')
    for block in blocks:
        start = text.find(block['source_block'], block['source_offset'])
        if start >= 0:
            outcome_start = text.find(block['outcome_quote'], start, start+len(block['source_block']))
            if outcome_start >= 0:
                bound_outcomes.append((outcome_start, outcome_start+len(block['outcome_quote'])))
    unbound_outcomes = []
    for marker in re.finditer(r'(?im)^[ \t]*(?:Motion[ \t]+)?(?:NOT CARRIED|CARRIED(?:[ \t]+UNANIMOUSLY)?|DEFEATED|WITHDRAWN|TABLED)\b[^\n]*', text):
        if not any(marker.start() < stop and start < marker.end() for start, stop in bound_outcomes):
            unbound_outcomes.append({'source_offset':marker.start(), 'source_quote':marker[0].strip()})
    unparsed_formal = unparsed_formal_envelopes(source)
    return items, {'status': 'source_authoritative',
                   'formal_source_coverage': 'partial_unparsed_formal_occurrences' if unparsed_formal else 'all_formal_envelopes_accounted_for',
                   'unparsed_formal_occurrence_leads': unparsed_formal, 'source_motions': len(blocks), 'held': held, 'unmapped_legacy_ids': unresolved,
                   'unbound_outcome_leads': unbound_outcomes,
                   'documentary_preserved_legacy_ids': sorted(documentary_preservations),
                   'adjournment_narration_preserved_legacy_ids': sorted(claim_id for claim_id, entry in documentary_preservations.items()
                       if entry['type']=='reviewed_adjournment_narration_preservation'),
                   'mapped_motions': sum(len(item['motions']) for item in items)}


def existing_agenda_item(item, existing_items):
    """Only a unique exact order/title can retain an agenda ID automatically."""
    candidates = [old for old in existing_items if str(old.get('item_order') or '') == str(item.get('item_order') or '') and normalize_text(old.get('title')) == normalize_text(item.get('title'))]
    if len(candidates) > 1:
        raise RuntimeError('Ambiguous existing agenda identity; no agenda refresh applied')
    return candidates[0] if candidates else None


def _receipt_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), default=str).encode()).hexdigest()


def source_candidate_inventory(root, archive_path):
    """Fingerprint every selector input, including unchosen sources and URL sidecars."""
    from pathlib import Path
    folder = Path(root) / archive_path / 'Minutes'
    return [{'name': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            for path in sorted(folder.iterdir()) if path.is_file() and path.suffix.lower() in ('.pdf', '.html', '.url')] if folder.is_dir() else []


def loaded_ballot_guard_digest():
    """Hash executable objects in this worker, never newer Python files on disk.

    A worker must restart to adopt new imported code. Swift is read by the OCR
    subprocess at execution time, so its current asset bytes are an input too.
    Reviewed roster receipts are discovered at execution time; fingerprint the
    complete store so additions, removals and changes invalidate old holds.
    """
    import importlib
    import inspect
    import types
    from pathlib import Path
    modules = ('canonical_motions', 'vote_evidence', 'ballot_reconstruction', 'official_ballots',
               'meeting_ballots', 'committee_ballots', 'vote_policy', 'native_header_ocr', 'operative_motion_body', 'roster_ocr', 'header_attendance', 'source_occurrences', 'historical_references', 'native_transcriptions', 'source_claims', 'documentary_presence')
    guards = {}
    def constant(value):
        if isinstance(value, types.CodeType):
            return {"bytecode": value.co_code.hex(), "constants": constant(value.co_consts),
                    "names": value.co_names, "locals": value.co_varnames, "freevars": value.co_freevars,
                    "cellvars": value.co_cellvars, "argcount": value.co_argcount,
                    "posonly": value.co_posonlyargcount, "kwonly": value.co_kwonlyargcount,
                    "flags": value.co_flags, "exceptions": value.co_exceptiontable.hex()}
        if isinstance(value, bytes):
            return {"bytes": value.hex()}
        if value is Ellipsis:
            return {"ellipsis": True}
        if isinstance(value, re.Pattern):
            return {'pattern': value.pattern, 'flags': value.flags}
        if isinstance(value, (str, int, float, bool, type(None))):
            return value
        if isinstance(value, (tuple, list)):
            return [constant(item) for item in value]
        if isinstance(value, (set, frozenset)):
            return sorted((constant(item) for item in value), key=str)
        if isinstance(value, dict):
            return {str(key): constant(item) for key, item in value.items()}
        raise TypeError
    for name in modules:
        module = importlib.import_module(f'{__package__}.{name}')
        values = {}
        for key, value in vars(module).items():
            if inspect.isfunction(value) and value.__module__ == module.__name__:
                values[key] = {'code': constant(value.__code__), 'defaults': constant(value.__defaults__), 'kwdefaults': constant(value.__kwdefaults__)}
            elif isinstance(value, re.Pattern) or key.isupper():
                try:
                    values[key] = constant(value)
                except TypeError:
                    pass
        guards[name] = values
    guards['native_header_vision.swift'] = hashlib.sha256((Path(__file__).parent / 'native_header_vision.swift').read_bytes()).hexdigest()
    roster_store = importlib.import_module(f'{__package__}.roster_ocr').STORE
    guards['roster_ocr_receipts'] = [
        {'name': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        for path in sorted(roster_store.glob('*.json')) if path.is_file()
    ]
    transcription_module = importlib.import_module(f'{__package__}.native_transcriptions')
    guards['native_transcription_store'] = transcription_module.store_inventory()
    guards['native_transcription_renderer'] = transcription_module.renderer_dependency_inventory()
    # Compile without executing imports. Light ballot workers and ingestion
    # workers must name the same orchestration contract; an already imported
    # stale class must fail rather than hash newer source as loaded behavior.
    orchestration_path = Path(__file__).parent / 'ingester.py'
    compiled = compile(orchestration_path.read_bytes(), str(orchestration_path), 'exec')
    def find_code(code, name):
        for child in code.co_consts:
            if isinstance(child, types.CodeType):
                if child.co_name == name:
                    return child
                found = find_code(child, name)
                if found is not None:
                    return found
        return None
    intended = find_code(compiled, 'process_meeting')
    import sys
    ingester = sys.modules.get(f'{__package__}.ingester')
    if ingester is not None and constant(ingester.MeetingIngester.process_meeting.__code__) != constant(intended):
        raise RuntimeError('Stale ingestion worker; restart required')
    guards['process_meeting'] = constant(intended)
    return _receipt_digest(guards)


def source_validation_inputs(context, inventory):
    """Stable semantic evidence: daily policy checks and avatars cannot bust caches."""
    day = str(context.get('source', {}).get('local_date') or context.get('meeting', {}).get('meeting_date') or '')[:10]
    def policy_evidence(value):
        if isinstance(value, dict):
            result = {key: policy_evidence(item) for key, item in value.items()
                      if key not in ('validated_as_of', 'checked_as_of', 'checked_date', 'enabled_through', 'identity_document_sha256')}
            if 'enabled_through' in value:
                result['covers_meeting_date'] = bool(day and value.get('enabled_from', '') <= day <= value['enabled_through'])
            return result
        if isinstance(value, list):
            return [policy_evidence(item) for item in value]
        return value
    people = [{key: row.get(key) for key in ('id', 'name')} for row in context.get('people', [])]
    memberships = [{key: row.get(key) for key in ('person_id', 'name', 'role', 'start_date', 'end_date', 'classification', 'organization_id')} for row in context.get('memberships', [])]
    semantic = {'context_status': context.get('status'), 'error_type': context.get('error_type'),
                'meeting': {key: context.get('meeting', {}).get(key) for key in ('id', 'meeting_date', 'archive_path', 'classification', 'title', 'type', 'organization_id', 'minutes_url', 'municipality_slug')},
                'people': sorted(people, key=lambda row: str(row['id'])),
                'memberships': sorted(memberships, key=lambda row: json.dumps(row, sort_keys=True, default=str)),
                'policy': policy_evidence(context.get('policy', {}))}
    source = context.get('source', {})
    # Extraction environments and OCR cache availability can change the facts
    # produced by the same PDF and loaded code. Bind the actual derived facts.
    date_evidence = {key: value for key, value in (source.get('source_date_evidence') or {}).items()
                     if key not in ('render_file', 'ocr_receipt')}
    semantic['source'] = {key: source.get(key) for key in ('source_file', 'source_sha256', 'source_url', 'source_format',
        'source_classification', 'local_date', 'stored_date', 'error', 'error_type', 'roster_quote', 'roster_unknown', 'ambiguous_names')}
    semantic['source']['present'] = [{key: person.get(key) for key in ('id', 'name')} for person in source.get('present', [])]
    semantic['source']['text_sha256'] = hashlib.sha256(source.get('text', '').encode()).hexdigest()
    semantic['source']['date_evidence'] = date_evidence
    semantic['source']['operative_views'] = source.get('operative_views', {})
    semantic['source']['header_attendance'] = source.get('header_attendance')
    semantic['source']['formal_occurrence_inventory'] = source.get('formal_occurrence_inventory')
    semantic['source']['historical_chronology_references'] = source.get('historical_chronology_references')
    if 'reviewed_transcriptions' in source:
        semantic['source']['reviewed_transcriptions'] = source['reviewed_transcriptions']
    result = {'version': 3, 'guard_sha256': loaded_ballot_guard_digest(),
            'candidate_inventory_sha256': _receipt_digest(inventory), 'evidence_sha256': _receipt_digest(semantic)}
    if context.get('meeting_claim_inventory') is not None:
        result['claim_inventory_sha256'] = context['meeting_claim_inventory']['fingerprint'] if valid_inventory(context['meeting_claim_inventory'], context.get('meeting', {}).get('id')) else 'incomplete'
    return result


def source_receipt_current(root, metadata, validation_inputs=None):
    """Only a finished receipt for this source AND these validation inputs can skip."""
    from pathlib import Path
    receipt = (metadata or {}).get('motion_source_ingestion') or {}
    if not validation_inputs or validation_inputs.get('claim_inventory_sha256') == 'incomplete' or receipt.get('validation_inputs') != validation_inputs:
        return False
    if receipt.get('status') != 'source_authoritative' or not receipt.get('source_file'):
        return False
    path = (Path(root) / receipt['source_file']).resolve()
    if not path.is_relative_to(Path(root).resolve()) or not path.is_file():
        return False
    return hashlib.sha256(path.read_bytes()).hexdigest() == receipt.get('source_sha256')


def write_source_receipt(supabase, meeting_id, report, source):
    """Preserve unrelated metadata and expose retryable partial writes honestly."""
    current = supabase.table('meetings').select('meta,updated_at').eq('id', meeting_id).single().execute().data
    if isinstance(current, list):
        current = current[0]
    metadata = {**(current.get('meta') or {}), 'motion_source_ingestion': {
        **report, 'source_sha256': source['source_sha256'], 'source_file': source['source_file'],
    }}
    query = supabase.table('meetings').update({'meta': metadata}).eq('id', meeting_id)
    if current.get('updated_at'):
        query = query.eq('updated_at', current['updated_at'])
    if not query.execute().data:
        raise RuntimeError('Meeting changed concurrently; retry source audit metadata')
