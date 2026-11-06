"""Export a copy of Open Langford's PUBLIC civic data from production for the local database.

READ-ONLY against production: one `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction
(psycopg2 set_session, sent with BEGIN — never a session-level SET, which would leak through the
transaction pooler), only SELECT/COPY TO, then ROLLBACK.

Residents' private data is never exported: accounts, profiles, subscriptions, contact messages,
email logs, AI questions and traces, staff logs and roles, voice fingerprints, speaker names
from public input, and lots that are hidden because they are only known as someone's home address.
Every public table must be classified below; the export stops if production has a table that isn't,
so a new private table can't be copied by accident.

Usage (normally via seed.sh):
  uv run --no-project --with psycopg2-binary --with python-dotenv \
    python scripts/local-db/export_public_data.py --env-file /path/to/.env [--months 12]
The env file (or the environment) must provide DATABASE_URL for production; it is read in memory only.
"""

from __future__ import annotations

import argparse
import gzip
import os
import sys
import time
from pathlib import Path

import psycopg2
from dotenv import dotenv_values

HERE = Path(__file__).resolve().parent
OUT = HERE / "data"

RECENT_MEETINGS = "(select id from public.meetings where {recent})"
RECENT_SECTIONS = (
    "(select ds.id from public.document_sections ds join public.documents d on d.id = ds.document_id "
    "where d.meeting_id in " + RECENT_MEETINGS + ")"
)

# Public civic tables, copied whole (some columns blanked below).
FULL = [
    "municipalities", "ocd_divisions", "organizations", "people", "elections", "election_offices",
    "candidacies", "council_terms", "memberships", "topics", "source_meetings", "meetings",
    "meeting_slug_history", "attendance", "bylaws", "bylaw_chunks", "matters", "agenda_items",
    "agenda_item_topics", "motions", "votes", "key_statements", "key_votes", "councillor_stances",
    "councillor_highlights", "documents", "extracted_documents", "document_images",
    "matter_links", "matter_merges", "matter_merge_proposals", "matter_report_mentions",
    "public_reports", "public_report_pages", "meeting_speaker_aliases", "meeting_events",
    "public_content_version",
    # Read by the public /updates page (staff identities and notes blanked below).
    "pipeline_jobs", "page_reviews",
]

# Public tables copied in part: big ones sliced to recent meetings, private rows left out.
FILTERED = {
    "transcript_segments": "meeting_id in " + RECENT_MEETINGS,
    "document_sections": "id in " + RECENT_SECTIONS,
    "matter_evidence": "document_section_id is null or document_section_id in " + RECENT_SECTIONS,
    "properties": "hidden = false",
    "property_links": "property_id in (select id from public.properties where hidden = false)",
}

# Never exported.
EXCLUDED = {
    "user_profiles", "subscriptions", "user_roles", "api_keys", "contact_messages", "email_messages",
    "email_events", "email_suppressions", "email_enqueue_receipts", "search_results_cache",
    "search_daily_usage", "rag_traces", "rag_feedback", "staff_actions", "ai_usage", "ai_usage_daily",
    "review_examples", "review_guidance", "voice_fingerprints", "voice_exemplars",
    "public_speaker_names", "transcript_identity_evidence", "pipeline_run_events", "server_metrics",
    "channel_posts", "calendar_sync_state", "data_reports", "hidden_pages",
}

# Columns replaced in the export (staff identities, internal notes, rows outside the slice).
OVERRIDES = {
    "matter_links": {"reviewed_by": "null"},
    "matter_evidence": {"reviewed_by": "null"},
    "matter_report_mentions": {"reviewed_by": "null"},
    "matter_merges": {"merged_by": "null"},
    "matter_merge_proposals": {"decided_by": "null"},
    "councillor_highlights": {"approved_by": "null"},
    "pipeline_jobs": {"requested_by": "null", "locked_by": "null", "last_error": "null"},
    "page_reviews": {
        "note": "null", "reviewed_by": "null", "agent_note": "null",
        "internal_note": "null", "internal_note_by": "null", "internal_note_at": "null",
    },
    "document_images": {
        "document_section_id": "case when document_section_id in " + RECENT_SECTIONS + " then document_section_id end",
    },
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--env-file", help="env file with production DATABASE_URL (read in memory only)")
    parser.add_argument("--months", default="12",
                        help="transcript/document-section slice in months (default 12), or 'all' for every meeting")
    args = parser.parse_args()
    if args.months == "all":
        recent = "true"
    elif args.months.isdigit() and int(args.months) > 0:
        recent = f"meeting_date >= current_date - interval '{int(args.months)} months'"
    else:
        parser.error("--months takes a whole number of months, or 'all'")

    url = os.environ.get("PROD_DATABASE_URL")
    if not url and args.env_file:
        url = dotenv_values(args.env_file).get("DATABASE_URL")
    if not url:
        print("No production DATABASE_URL (pass --env-file or set PROD_DATABASE_URL).", file=sys.stderr)
        return 2
    if "127.0.0.1" in url or "localhost" in url:
        print("That DATABASE_URL is local; the export reads from production.", file=sys.stderr)
        return 2

    conn = psycopg2.connect(url, connect_timeout=15)
    conn.set_session(isolation_level="REPEATABLE READ", readonly=True)  # sent with BEGIN, per transaction
    cur = conn.cursor()
    cur.execute("show transaction_read_only")
    if cur.fetchone()[0] != "on":
        print("Transaction is not read-only; stopping.", file=sys.stderr)
        conn.rollback()
        return 1

    cur.execute("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','p')")
    tables = {r[0] for r in cur.fetchall()}
    wanted = set(FULL) | set(FILTERED)
    unclassified = sorted(tables - wanted - EXCLUDED)
    if unclassified:
        print("Unclassified production tables (add each to FULL, FILTERED or EXCLUDED): " + ", ".join(unclassified),
              file=sys.stderr)
        conn.rollback()
        return 1

    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.csv.gz"):
        old.unlink()
    order = [t for t in FULL + list(FILTERED) if t in tables]
    total = 0
    for table in order:
        cur.execute(
            "select column_name from information_schema.columns where table_schema = 'public' and table_name = %s "
            "and is_generated = 'NEVER' order by ordinal_position",
            (table,),
        )
        cols = [r[0] for r in cur.fetchall()]
        overrides = OVERRIDES.get(table, {})
        select = ", ".join(
            f"{overrides[c].format(recent=recent)} as {c}" if c in overrides else f'"{c}"' for c in cols
        )
        where = FILTERED.get(table)
        sql = f"select {select} from public.{table}" + (f" where {where.format(recent=recent)}" if where else "")
        started = time.time()
        path = OUT / f"{table}.csv.gz"
        with gzip.open(path, "wb", compresslevel=3) as fh:
            cur.copy_expert(f"copy ({sql}) to stdout with (format csv, header true)", fh)
        size = path.stat().st_size
        total += size
        print(f"  {table:28s} {size / 1e6:8.1f} MB  {time.time() - started:5.1f}s")

    (OUT / "tables.txt").write_text("\n".join(order) + "\n")
    # Production's schema fingerprint, for check-parity.sh.
    cur.execute((HERE / "schema-fingerprint.sql").read_text())
    (OUT / "prod-schema.txt").write_text("".join(r[0] + "\n" for r in cur.fetchall()))
    conn.rollback()
    conn.close()
    print(f"Exported {len(order)} tables, {total / 1e6:.0f} MB compressed, to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
