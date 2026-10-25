"""Audit and add only canonical, unclaimed official-source decisions.

Uses existing DATABASE_URL configuration. No models, vote reconstruction,
transcript refresh, existing-motion rewrites or inferred matter links. An audit
manifest is mandatory; apply regenerates it under locks before inserting facts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

import psycopg2
from psycopg2.extras import Json, RealDictCursor
from dotenv import load_dotenv

from pipeline.ingestion.canonical_motions import canonical_motion_plan, existing_agenda_item
from pipeline.ingestion.official_ballots import load_official_minutes
from pipeline.ingestion.source_claims import build_claim_inventory
from pipeline.ingestion.source_occurrences import text_occurrence_unique


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str, ensure_ascii=False).encode()).hexdigest()


def query(connection, sql, args=None):
    with connection.cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute(sql, args)
        return [dict(row) for row in cursor.fetchall()] if cursor.description else []


def read_meeting(connection, meeting_id, municipality_id):
    rows = query(connection, "SELECT m.id,m.title,m.type,m.meeting_date::text,m.archive_path,m.minutes_url,m.meta,m.updated_at,o.classification FROM meetings m JOIN organizations o ON o.id=m.organization_id WHERE m.id=%s AND m.municipality_id=%s", (meeting_id, municipality_id))
    if len(rows) != 1:
        raise ValueError('Meeting outside selected municipality or missing')
    meeting = rows[0]
    motions = query(connection, 'SELECT * FROM motions WHERE meeting_id=%s ORDER BY id', (meeting_id,))
    items = query(connection, 'SELECT * FROM agenda_items WHERE meeting_id=%s ORDER BY id', (meeting_id,))
    return meeting, motions, items


def plan_meeting(meeting, motions, items, source, *, review_scope=None):
    """A source-authoritative report can still contain held, incomplete coverage."""
    claims = build_claim_inventory(motions, meeting_id=meeting['id'], expected_count=len(motions))
    base = {'meeting_id': meeting['id'], 'meeting_date': meeting['meeting_date'],
            'catalog_sha256': digest(meeting), 'claims_sha256': digest(motions),
            'agenda_sha256': digest(items), 'new_motions': [], 'held': [],
            'stored_outcome_unknown_ids': [row['id'] for row in motions if not row.get('result')]}
    if review_scope and 'closing_linked_vote_counts' in review_scope:
        base['closing_linked_vote_counts']=review_scope['closing_linked_vote_counts']
    if source.get('error'):
        if source['error']=='no_decisions_expected_from_original_notice' and not motions:
            return {**base,'coverage':'no_decisions_expected_from_notice','notice':source['notice'],
                    'source_file':source['source_file'],'source_sha256':source['source_sha256'],
                    'source_review_evidence':source['source_review_evidence']}
        return {**base, 'coverage': 'source_unavailable', 'reason': source['error']}
    base.update(source_file=source['source_file'], source_sha256=source['source_sha256'],
                source_url=source.get('source_url'), parsed_blocks=len(source.get('blocks', [])),
                source_date=source.get('local_date'), source_date_evidence=source.get('source_date_evidence'))
    different_day = bool(source.get('local_date') and source['local_date'] != meeting['meeting_date'])
    base['source_date_comparison'] = ('different_day' if different_day else
        'same_day' if source.get('local_date') else 'unknown')
    if source.get('source_review_evidence'):
        base['source_review_evidence']=source['source_review_evidence']
    # Existing rows only supply an agenda parent when their complete literal
    # motion matches the original. New unassociated facts use an explicit
    # source container, never a guessed legal proceeding or heading number.
    proposals = [{**item, 'motions': [{'motion_text': row['text_content']} for row in motions
                                     if row['agenda_item_id'] == item['id']]} for item in items]
    planned, report = canonical_motion_plan(proposals, {'status': 'available', 'meeting': meeting,
                                                       'source': source, 'meeting_claim_inventory': claims, **(review_scope or {})}, motions)
    base.update(source_report=report, held=[*source.get('source_review_holds', []), *report.get('held', [])])
    if different_day:
        # The legacy body matcher tolerates a one-day calendar difference, but
        # additive catch-up must not silently publish facts under the wrong day.
        # Keep both original dates and all other diagnostics for separate review.
        base['held'].append({'reason': 'catalog_source_date_mismatch',
            'catalog_date': meeting['meeting_date'], 'source_date': source['local_date'],
            'authority': 'coverage_diagnostic_only_no_date_correction'})
        return {**base, 'coverage': 'source_validation_held', 'reason': 'catalog_source_date_mismatch'}
    if report['status'] != 'source_authoritative':
        return {**base, 'coverage': 'source_validation_held'}
    for item in planned:
        parent = existing_agenda_item(item, items)
        for motion in item.get('motions', []):
            if motion.get('_existing_motion'):
                continue  # Preserve every existing body, actor, result and proof.
            identity = motion['_canonical_source_motion']
            block = motion['_source_motion']
            proof = motion.get('_operative_motion_body') or {}
            reviewed_native = source.get('source_format') == 'original_pdf_reviewed_image_decisions'
            if reviewed_native and identity['key'] not in source.get('reviewed_new_decision_keys', []):
                base['held'].append({'source_key': identity['key'], 'reason': 'new_fact_not_explicitly_image_enrolled'})
                continue
            explicit = proof.get('status') == 'explicit_operative' or source.get('source_format') == 'official_html_structural'
            if not text_occurrence_unique(source, block) or not explicit:
                base['held'].append({'source_key': identity['key'], 'reason': 'new_fact_requires_unique_explicit_operative_body'})
                continue
            actors = motion['_canonical_actor_ids']
            actors_unreviewed = reviewed_native or source['source_format']=='original_pdf_reviewed_local_ocr'
            base['new_motions'].append({'parent_agenda_id': parent['id'] if parent else None,
                'text_content': motion.get('_operative_motion_text') or motion['motion_text'], 'result': motion['result'],
                'mover': motion.get('mover') if not actors_unreviewed else None,
                'seconder': motion.get('seconder') if not actors_unreviewed else None,
                'mover_id': actors['mover'] if not actors_unreviewed else None,
                'seconder_id': actors['seconder'] if not actors_unreviewed else None,
                'meta': {'canonical_source_motion': identity, 'operative_motion_body': proof,
                         'individual_vote_coverage': 'not_recorded',
                         'vote_record': {'coverage': 'not_recorded', 'source': 'bounded_official_minutes',
                                         'outcome_status': 'verified', 'outcome_source_quote': identity['outcome_quote']}}})
    incomplete = (base['held'] or report.get('unmapped_legacy_ids') or report.get('unbound_outcome_leads')
                  or report.get('unparsed_formal_occurrence_leads'))
    return {**base, 'coverage': 'review_required' if incomplete else 'missing_source_decisions' if base['new_motions'] else 'source_occurrences_accounted_for',
            'stored_motions': len(motions), 'mapped_source_motions': report.get('mapped_motions', 0)}


def remaining_coverage(plan):
    return ('source_occurrences_accounted_for' if plan['coverage'] in
            ('missing_source_decisions','source_occurrences_accounted_for') else plan['coverage'])


def closing_linked_vote_counts(connection, meeting_id, motion_ids):
    """Only explicitly scoped closing IDs, no vote text/person exports.

    Quarantine applies serialize vote writes with a short table lock; the count
    and concurrency contract does not depend on foreign-key trigger settings.
    """
    if len(motion_ids)!=1 or type(motion_ids[0]) is not int:
        raise ValueError('Exactly one reviewed closing ID required for linked-vote audit')
    counts=query(connection, '''SELECT m.id motion_id,COUNT(v.id)::bigint linked_votes
        FROM motions m LEFT JOIN votes v ON v.motion_id=m.id
        WHERE m.meeting_id=%s AND m.id=ANY(%s) GROUP BY m.id ORDER BY m.id''', (meeting_id,motion_ids))
    if [r['motion_id'] for r in counts]!=motion_ids:
        raise ValueError('Reviewed closing ID is absent or belongs to another meeting')
    return {'authority':'operator_scoped_linked_vote_count_v1','meeting_id':meeting_id,'counts':counts}


def audit(connection, meeting_ids, municipality_id, archive_root, cache_dir, project_ref=None):
    people = query(connection, 'SELECT id,name FROM people ORDER BY id')
    plans = []
    for meeting_id in meeting_ids:
        meeting, motions, items = read_meeting(connection, meeting_id, municipality_id)
        folder = (archive_root / (meeting['archive_path'] or 'missing')).resolve()
        if not folder.is_relative_to(archive_root.resolve()):
            raise ValueError('Archive path escapes selected root')
        from .reviewed_sources import load_reviewed_minutes
        source = load_reviewed_minutes(meeting,root=archive_root,people=people,cache_dir=cache_dir,
                                       project_ref=project_ref,municipality_id=municipality_id)
        if source is None:
            source = load_official_minutes(meeting, root=archive_root, people=people, cache_dir=cache_dir)
        scope={'allow_reviewed_legacy_reservations': True, 'allow_reviewed_source_header':True,
            'project_ref':project_ref, 'municipality_id':municipality_id, 'archive_root':archive_root}
        from .legacy_occurrence_reviews import load_review
        try:
            review=load_review(meeting_id)
        except (ValueError,OSError,KeyError):
            review=None  # Existing planner reports stale reviews without widening scope.
        entries=([*review.get('closing_conflict_quarantines',[]),
                  *review.get('blank_time_documentary_preservations',[])] if review else [])
        if entries:
            ids=[e['capability']['motion_id'] for e in entries]
            if not set(ids)<={m['id'] for m in motions}:
                raise ValueError('Reviewed closing ID not in current meeting claim inventory')
            scope['closing_linked_vote_counts']=closing_linked_vote_counts(connection,meeting_id,ids)
        plans.append(plan_meeting(meeting, motions, items, source, review_scope=scope))
    return {'version': 1, 'municipality_id': municipality_id, 'people_sha256': digest(people), 'meetings': plans}


def write_report(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, default=str, ensure_ascii=False) + '\n')
    path.chmod(0o600)


def verify_manifest(connection, manifest):
    """Read-only acknowledgement recovery; never turns an uncertain retry into writes."""
    manifest_sha = digest(manifest)
    mids = [row['meeting_id'] for row in manifest['meetings']]
    # A committed manifest is identified in the same transaction as its inserts.
    prior = query(connection, "SELECT id,meta->'history_catchup_receipts'->%s receipt FROM meetings WHERE id=ANY(%s)", (manifest_sha, mids))
    if len(prior) != len(mids):
        raise ValueError('Missing batch meeting; review required')
    if any(row['receipt'] for row in prior):
        if not all(row['receipt'] for row in prior):
            raise ValueError('Partial receipt state; read-only reconciliation required')
        expected = [claim for row in prior for claim in row['receipt']['inserted_claims']]
        actual = query(connection, 'SELECT id,meeting_id,agenda_item_id,text_content,result,mover,seconder,mover_id,seconder_id,meta FROM motions WHERE id=ANY(%s) ORDER BY id', ([r['id'] for r in expected],)) if expected else []
        if digest(actual) != digest(sorted(expected, key=lambda row: row['id'])):
            raise ValueError('Committed batch claims changed; do not retry')
        return {'status': 'already_applied', 'manifest_sha256': manifest_sha, 'inserted_motions': len(expected)}
    return None


def apply_manifest(connection, manifest, regenerate, archive_root):
    """Atomic additive facts, full current-row guards, no votes or rewrites."""
    manifest_sha = digest(manifest)
    mids = [row['meeting_id'] for row in manifest['meetings']]
    prior = verify_manifest(connection, manifest)
    if prior:
        return prior
    # Source parsing/OCR runs before any global write lock.
    if digest(regenerate()) != manifest_sha:
        raise ValueError('Source/catalog/agenda/claims changed; audit and review again')
    closing_plans=[p for p in manifest['meetings'] if 'closing_linked_vote_counts' in p]
    if closing_plans and query(connection,'SHOW transaction_isolation')[0]['transaction_isolation']!='read committed':
        raise ValueError('Closing linked-vote recheck requires READ COMMITTED isolation')
    # Only this scoped capability locks vote DML. Ordinary public SELECTs are
    # compatible; source parsing/regeneration has already completed above.
    tables='motions, agenda_items, votes' if closing_plans else 'motions, agenda_items'
    query(connection, 'LOCK TABLE '+tables+' IN SHARE ROW EXCLUSIVE MODE NOWAIT')
    for plan in sorted(closing_plans,key=lambda p:p['meeting_id']):
        proof=plan['closing_linked_vote_counts'];counts=proof.get('counts',[])
        ids=[c['motion_id'] for c in counts]
        if (proof.get('authority')!='operator_scoped_linked_vote_count_v1'
                or proof.get('meeting_id')!=plan['meeting_id'] or len(ids)!=1
                or ids!=sorted(set(plan.get('source_report',{}).get('unresolved_closing_conflict_ids',[])
                                   +plan.get('source_report',{}).get('blank_time_documentary_preserved_legacy_ids',[])))
                or counts!=[{'motion_id':ids[0],'linked_votes':0}]):
            raise ValueError('Closing linked-vote manifest scope is not exactly reviewed zero')
        # The vote table lock excludes all vote DML, including installations
        # with absent/deferred/disabled FKs; row pins remain a separate guard.
        locked=query(connection, 'SELECT id FROM motions WHERE meeting_id=%s AND id=ANY(%s) ORDER BY id FOR UPDATE NOWAIT',
            (plan['meeting_id'],ids))
        if [r['id'] for r in locked]!=ids or closing_linked_vote_counts(connection,plan['meeting_id'],ids)!=proof:
            raise ValueError('Closing linked votes changed; audit and review again')
    query(connection, 'SELECT id FROM meetings WHERE id=ANY(%s) ORDER BY id FOR UPDATE', (mids,))
    query(connection, 'SELECT id FROM agenda_items WHERE meeting_id=ANY(%s) ORDER BY id FOR UPDATE', (mids,))
    prior = verify_manifest(connection, manifest)
    if prior:
        return prior
    if digest(query(connection, 'SELECT id,name FROM people ORDER BY id')) != manifest['people_sha256']:
        raise ValueError('People changed; audit and review again')
    for plan in manifest['meetings']:
        meeting, motions, items = read_meeting(connection, plan['meeting_id'], manifest['municipality_id'])
        if any(digest(value) != plan[key] for value, key in ((meeting, 'catalog_sha256'), (motions, 'claims_sha256'), (items, 'agenda_sha256'))):
            raise ValueError('Current database claims changed; audit and review again')
        if plan.get('source_review_evidence'):
            from .reviewed_sources import source_inventory
            if source_inventory(archive_root,meeting)!=plan['source_review_evidence']['file_inventory']:
                raise ValueError('Reviewed source inventory changed; audit and review again')
        if plan.get('source_file'):
            path = (archive_root / plan['source_file']).resolve()
            if not path.is_relative_to(archive_root.resolve()) or hashlib.sha256(path.read_bytes()).hexdigest() != plan['source_sha256']:
                raise ValueError('Original source changed; audit and review again')
    if not any(plan['new_motions'] for plan in manifest['meetings']):
        return {'status': 'no_safe_additions', 'manifest_sha256': manifest_sha, 'meetings': []}
    receipt = {'status': 'applied', 'manifest_sha256': manifest_sha, 'meetings': []}
    for plan in manifest['meetings']:
        meeting_id, inserted = plan['meeting_id'], []
        container = None
        for proposed in plan['new_motions']:
            parent = proposed['parent_agenda_id']
            if parent is None:
                if container is None:
                    existing = query(connection, "SELECT id FROM agenda_items WHERE meeting_id=%s AND item_order='official-recorded-motions' AND title='Official recorded motions'", (meeting_id,))
                    if len(existing) > 1:
                        raise ValueError('Ambiguous source container')
                    if existing:
                        container = existing[0]['id']
                    else:
                        container = query(connection, "INSERT INTO agenda_items(meeting_id,item_order,title,category,slug) VALUES(%s,'official-recorded-motions','Official recorded motions','procedural',%s) RETURNING id", (meeting_id, f'{meeting_id}-official-recorded-motions'))[0]['id']
                parent = container
            row = {k: v for k, v in proposed.items() if k != 'parent_agenda_id'}
            row.update(meeting_id=meeting_id, agenda_item_id=parent)
            row['meta'] = Json({**row['meta'], 'history_catchup_manifest': manifest_sha})
            keys = list(row)
            inserted += query(connection, 'INSERT INTO motions (' + ','.join(keys) + ') VALUES (' + ','.join(['%s'] * len(keys)) + ') RETURNING id,meeting_id,agenda_item_id,text_content,result,mover,seconder,mover_id,seconder_id,meta', tuple(row[k] for k in keys))
        entry = {'inserted_claims': inserted, 'source_sha256': plan.get('source_sha256'),
                 'remaining_coverage': remaining_coverage(plan), 'held': plan.get('held', []),
                 'stored_outcome_unknown_ids': plan.get('stored_outcome_unknown_ids', [])}
        if 'closing_linked_vote_counts' in plan:
            entry['unresolved_closing_conflict_ids']=plan['source_report']['unresolved_closing_conflict_ids']
            if plan['source_report'].get('blank_time_documentary_preserved_legacy_ids'):
                entry['blank_time_documentary_preserved_legacy_ids']=plan['source_report']['blank_time_documentary_preserved_legacy_ids']
            entry['closing_linked_vote_counts']=plan['closing_linked_vote_counts']
        query(connection, "UPDATE meetings SET meta=jsonb_set(COALESCE(meta,'{}'::jsonb),'{history_catchup_receipts}',COALESCE(meta->'history_catchup_receipts','{}'::jsonb)||jsonb_build_object(%s,%s::jsonb)) WHERE id=%s", (manifest_sha, Json(entry), meeting_id))
        receipt['meetings'].append({'meeting_id': meeting_id, 'inserted_ids': [r['id'] for r in inserted], 'coverage': remaining_coverage(plan)})
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('audit', 'apply', 'verify'))
    parser.add_argument('--env-file', type=Path)
    parser.add_argument('--project-ref', required=True)
    parser.add_argument('--municipality-id', type=int, default=1)
    parser.add_argument('--meeting-id', action='append', type=int, default=[])
    parser.add_argument('--archive-root', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--reviewed-sha256')
    args = parser.parse_args()
    load_dotenv(args.env_file)
    url = os.environ.get('DATABASE_URL', '')
    parsed = urlsplit(url)
    pooler = (parsed.hostname or '').endswith('.pooler.supabase.com') and parsed.username == 'postgres.' + args.project_ref
    if not pooler and parsed.hostname != f'db.{args.project_ref}.supabase.co':
        raise ValueError('Configured database does not match selected project')
    apply = args.action == 'apply'
    manifest = json.loads(args.manifest.read_text()) if args.manifest else None
    if args.action in ('apply', 'verify'):
        if not manifest or digest(manifest) != args.reviewed_sha256:
            raise ValueError('Apply requires the exact reviewed audit manifest digest')
        if manifest.get('project_ref') != args.project_ref or manifest['municipality_id'] != args.municipality_id:
            raise ValueError('Manifest project/municipality mismatch')
        mids = [row['meeting_id'] for row in manifest['meetings']]
    else:
        mids = args.meeting_id
    if not mids or len(mids) > 20 or len(set(mids)) != len(mids):
        raise ValueError('Select 1–20 unique meeting IDs per bounded batch')
    connection = psycopg2.connect(url, sslmode='require', connect_timeout=10)
    connection.set_session(readonly=not apply)
    committing = committed = False
    try:
        query(connection, 'SET LOCAL statement_timeout=15000')
        query(connection, 'SET LOCAL lock_timeout=1000')
        def regenerate():
            return {'project_ref': args.project_ref, **audit(connection, mids, args.municipality_id, args.archive_root, args.cache_dir, args.project_ref)}
        if args.action == 'verify':
            result = verify_manifest(connection, manifest) or {'status': 'not_applied', 'manifest_sha256': digest(manifest)}
            connection.rollback()
        elif apply:
            result = apply_manifest(connection, manifest, regenerate, args.archive_root)
            committing = True
            connection.commit()
            committed = True
        else:
            result = regenerate()
            connection.rollback()
        write_report(args.report, result)
        print(json.dumps({'action': args.action, 'status': result.get('status', 'audited'),
                          'manifest_sha256': digest(result) if args.action == 'audit' else result['manifest_sha256'],
                          'meetings': len(mids), 'report': str(args.report)}))
    except BaseException:
        if committed:
            print(json.dumps({'status': 'committed_receipt_output_failed', 'next': 'Read the database receipt before retrying.'}))
        elif committing:
            print(json.dumps({'status': 'uncertain_commit', 'next': 'Do not retry apply. Run verify read-only before any further action.'}))
        else:
            connection.rollback()
        raise
    finally:
        connection.close()


if __name__ == '__main__':
    main()
