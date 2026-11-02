"""Write the per-member committee votes the history catch-up planned for the motions it added.

The catch-up (history_coverage apply) adds committee motions only; each planned motion carries the result of
committee_roster_votes, a reconstructable ballot or a hold. This writes the reconstructable ballots whose basis is
validated (a recorded unanimous result, a roll call naming every member present, or Procedure Bylaw No. 1971's
deemed-affirmative rule from October 18, 2021) onto the rows that apply inserted, matched by their source key.
A motion that already has votes is left alone. Holds stay held.

    uv run python -m pipeline.backfill.committee_vote_writes DIR [--dry-run]   # DIR: batch-NNN-manifest/receipt.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from psycopg2.extras import Json

VALIDATED_BASES = {'recorded_unanimous_result', 'every_present_voter_explicitly_named',
                   'bylaw_1971_dissent_recording_deemed_affirmative'}


def planned_ballots(manifest: dict, receipt: dict) -> list[dict]:
    """(motion id, ballot) for every inserted motion whose planned ballot is reconstructable on a validated basis."""
    out = []
    by_meeting = {m['meeting_id']: m for m in receipt.get('meetings') or []}
    for plan in manifest['meetings']:
        inserted = by_meeting.get(plan['meeting_id'], {}).get('inserted_ids') or []
        if len(inserted) != len(plan['new_motions']):
            raise ValueError(f"Meeting {plan['meeting_id']}: receipt and manifest disagree")
        # apply inserts new_motions in order, one row each, so the ids line up with the planned motions.
        for motion_id, proposed in zip(inserted, plan['new_motions']):
            ballot = proposed.get('committee_votes') or {}
            if ballot.get('status') == 'reconstructable_candidate' and ballot.get('inference_basis') in VALIDATED_BASES:
                out.append({'motion_id': motion_id, 'meeting_id': plan['meeting_id'],
                            'source_key': proposed['meta']['canonical_source_motion']['key'], 'ballot': ballot,
                            'source': proposed['meta']['canonical_source_motion']})
    return out


def ballot_meta(entry: dict) -> dict:
    ballot, source = entry['ballot'], entry['source']
    return {'basis': ballot['inference_basis'], 'method': 'documentary_reconstruction_not_explicit_rollcall',
            'votes': ballot['votes'], 'voting_body': 'committee', 'outcome_role': 'committee_recommendation',
            'recording_rule': ballot.get('recording_rule'), 'roster_quote': ballot.get('roster_quote'),
            'presence_adjustments': ballot.get('presence_adjustments'), 'membership_evidence': 'meeting_committee_roster',
            'source_file': source.get('source_file'), 'source_url': source.get('source_url'),
            'source_key': entry['source_key'],
            'choice_provenance': {f"person_{v['person_id']}": v['evidence'] for v in ballot['votes']}}


def write(cur, entries: list[dict]) -> int:
    written = 0
    for entry in entries:
        cur.execute('SELECT meta FROM motions WHERE id=%s FOR UPDATE', (entry['motion_id'],))
        row = cur.fetchone()
        if not row or (row[0] or {}).get('canonical_source_motion', {}).get('key') != entry['source_key']:
            raise ValueError(f"Motion {entry['motion_id']} is not the planned source motion")
        cur.execute('SELECT count(*) FROM votes WHERE motion_id=%s', (entry['motion_id'],))
        if cur.fetchone()[0]:
            continue
        for vote in entry['ballot']['votes']:
            cur.execute('INSERT INTO votes (motion_id, person_id, vote) VALUES (%s,%s,%s)',
                        (entry['motion_id'], vote['person_id'], vote['vote']))
        meta = {**(row[0] or {}), 'individual_vote_coverage': 'reconstructed_complete', 'ballot_reconstruction': ballot_meta(entry)}
        cur.execute('UPDATE motions SET meta=%s WHERE id=%s', (Json(meta), entry['motion_id']))
        written += 1
    return written


def main():
    from pipeline.db import run_write
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dir', type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    total = 0
    for manifest_path in sorted(args.dir.glob('batch-*-manifest.json')):
        receipt_path = manifest_path.with_name(manifest_path.name.replace('-manifest', '-receipt'))
        if not receipt_path.exists():
            continue
        manifest, receipt = json.loads(manifest_path.read_text()), json.loads(receipt_path.read_text())
        if receipt.get('status') not in ('applied',):
            continue
        entries = planned_ballots(manifest, receipt)
        written = len(entries) if args.dry_run else run_write(lambda cur: write(cur, entries))
        total += written
        print(f'{manifest_path.name}: {written} ballots')
    print(f'total: {total}')


if __name__ == '__main__':
    main()
