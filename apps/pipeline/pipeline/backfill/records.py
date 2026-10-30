"""Recover cached transcripts without replacing existing records.

Run from apps/pipeline: python -m pipeline.backfill.records --report /tmp/plan.json
Add --apply and optionally --limit for an inspected pilot before the full run.
No transcription or model APIs are used. Existing transcripts are preserved.
Recovered speech keeps NULL person_id and the original cached speaker label.
Named identity requires the regular strict source/audio identity producer.
Legacy vote writes are retired: use the regular official-source validation workflow.
"""
from __future__ import annotations

import argparse
import collections
from datetime import date
import hashlib
import json
import math
from pathlib import Path

import psycopg2
from psycopg2.extras import RealDictCursor, Json, execute_values

from pipeline import config, db, parser
from pipeline.paths import BASE_DIR

ROOT = Path(BASE_DIR)
EXCLUDED = ('_raw_transcript', '_segments', '_benchmark', '_gemini_speakers')


def transcript_file(folder):
    files = sorted(p for p in (folder / 'Audio').glob('*.json') if not any(x in p.name for x in EXCLUDED))
    return files[0] if len(files) == 1 else None


def load_data(connection):
    with connection.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT m.*, (SELECT count(*) FROM transcript_segments t WHERE t.meeting_id=m.id) segment_count FROM meetings m WHERE municipality_id=1 ORDER BY meeting_date DESC,id")
        meetings = list(cur.fetchall())
    return meetings


def plan_backfill(connection):
    # Cached aliases and label centroids are not independent named identity
    # evidence. Recover words/times only; the ordinary strict identity producer
    # can later admit independently proved bounded turns.
    meetings = load_data(connection)
    summary = {'transcripts': [], 'votes': [], 'skipped': [],
               'voice_eligible_people': [],
               'identity_recovery': 'unlinked only; use the regular strict source/audio identity producer',
               'vote_recovery': 'retired; use python main.py --ingest-only --target <meeting_id> for shared official-source validation; existing-choice conflicts require a separately reviewed correction'}
    plans = []
    for meeting in meetings:
        mid = meeting['id']
        folder = (ROOT / (meeting['archive_path'] or 'missing')).resolve()
        if not folder.is_relative_to(ROOT / 'archive' / 'langford') or meeting['meeting_date'] > date.today():
            continue
        plan = {'meeting_id': mid, 'rows': [], 'votes': []}
        file = transcript_file(folder) if meeting['segment_count'] == 0 else None
        if file:
            for seg in parser.extract_transcript_segments(str(file)):
                start, end = seg['start_time'], seg['end_time']
                if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or not math.isfinite(start) or not math.isfinite(end) or start < 0 or not start < end <= 24 * 3600 or not seg['text'].strip():
                    continue
                plan['rows'].append((mid, None, seg['speaker'], start, end, seg['text'], 'CACHED_TRANSCRIPT_BACKFILL'))
            plan['transcript_evidence'] = {'source_path': str(file.relative_to(ROOT)), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'identity_status': 'unlinked_use_strict_identity_producer'}
            summary['transcripts'].append({'meeting_id': mid, 'date': str(meeting['meeting_date']), 'segments': len(plan['rows']), 'attributed_segments': 0, 'people_seconds': {}})
        elif meeting['segment_count'] == 0 and (folder / 'shared_media.json').exists():
            summary['skipped'].append({'meeting_id': mid, 'reason': 'Shared recording needs verified meeting boundaries'})
        if plan['rows']:
            plans.append(plan)
    return plans, summary


def apply_plan(connection, plans):
    plans = list(plans)
    if any(plan.get('votes') for plan in plans):
        raise ValueError("Legacy vote writes are retired. Use python main.py --ingest-only --target <meeting_id> for shared official-source validation. Existing-choice conflicts need a separately reviewed correction; do not retry this legacy plan.")
    if any(row[1] is not None for plan in plans for row in plan.get('rows', [])):
        raise ValueError("Legacy speaker identities are retired. Recover cached transcripts with NULL person_id and raw labels; use the regular strict identity producer for source-proved bounded-turn links. Existing linked rows must remain unchanged.")
    counts = collections.Counter()
    def apply_one(cur, plan):
        mid = plan['meeting_id']
        cur.execute('SELECT id FROM meetings WHERE id=%s AND municipality_id=1 FOR UPDATE', (mid,))
        if cur.fetchone() is None:
            raise RuntimeError(f'Meeting {mid} disappeared')
        if plan['rows']:
            cur.execute('SELECT 1 FROM transcript_segments WHERE meeting_id=%s LIMIT 1', (mid,))
            if cur.fetchone() is None:
                execute_values(cur, 'INSERT INTO transcript_segments (meeting_id,person_id,speaker_name,start_time,end_time,text_content,attribution_source) VALUES %s', plan['rows'], page_size=300)
                cur.execute("UPDATE meetings SET has_transcript=true,meta=coalesce(meta,'{}'::jsonb)||jsonb_build_object('cached_transcript_backfill',%s::jsonb) WHERE id=%s", (Json(plan['transcript_evidence']), mid))
                return len(plan['rows'])
        return 0

    for index, plan in enumerate(plans, 1):
        # One read-write transaction per meeting (db.run_write); counted only once committed.
        segments = db.run_write(lambda cur: apply_one(cur, plan), connection)
        if segments:
            counts['transcript_meetings'] += 1
            counts['transcript_segments'] += segments
        if index % 10 == 0 or index == len(plans):
            print(json.dumps({'completed_meetings': index, 'total_meetings': len(plans), 'applied': dict(counts)}), flush=True)
    return dict(counts)


def main():
    argp = argparse.ArgumentParser(description=__doc__)
    argp.add_argument('--report', type=Path, required=True)
    argp.add_argument('--apply', action='store_true')
    argp.add_argument('--limit', type=int)
    args = argp.parse_args()
    if args.limit is not None and args.limit < 1:
        argp.error('--limit must be positive')
    connection = psycopg2.connect(config.DATABASE_URL)
    try:
        plans, summary = plan_backfill(connection)
        connection.rollback()
        args.report.write_text(json.dumps(summary, indent=2, default=str) + '\n')
        print(json.dumps({'eligible_voice_people': summary['voice_eligible_people'], 'transcript_meetings': len(summary['transcripts']), 'segments': sum(x['segments'] for x in summary['transcripts']), 'attributed_segments': sum(x['attributed_segments'] for x in summary['transcripts']), 'named_vote_candidates': 0, 'vote_recovery': summary['vote_recovery'], 'identity_recovery': summary['identity_recovery'], 'skipped': len(summary['skipped'])}))
        if args.apply:
            print(json.dumps({'applied': apply_plan(connection, plans[:args.limit] if args.limit else plans)}))
    finally:
        connection.close()


if __name__ == '__main__':
    main()
