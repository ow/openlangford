"""
Bulk embedding generation through the pipeline AI client (EMBEDDING_MODEL /
EMBEDDING_DIMENSIONS; stored vectors are text-embedding-3-small @ 384-dim halfvec).
Writes embeddings directly to Supabase via psycopg2 COPY.

Usage:
    uv run python -m pipeline.ingestion.embed --table all
    uv run python -m pipeline.ingestion.embed --table agenda_items --force
"""

import argparse
import io
import os
import sys
import time

from dotenv import load_dotenv

from pipeline import ai, db

sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

load_dotenv()

# Table -> (text_columns, select_columns)
TABLE_CONFIG = {
    # transcript_segments: embeddings removed in Phase 3c PR 4 (discussion-level embeddings replace these)
    # "transcript_segments": { ... },
    "agenda_items": {
        "select": "id, title, description",
        "text_fn": lambda r: f"{r[1] or ''}\n{r[2] or ''}".strip(),
        "custom_fetch_fn": "_fetch_agenda_items_with_discussion",
    },
    "motions": {
        "select": "id, text_content",
        "text_fn": lambda r: (r[1] or "").strip(),
    },
    "matters": {
        "select": "id, plain_english_summary, title",
        "text_fn": lambda r: (r[1] or r[2] or "").strip(),
    },
    "meetings": {
        "select": "id, summary",
        "text_fn": lambda r: (r[1] or "").strip(),
    },
    "bylaws": {
        "select": "id, title, plain_english_summary",
        "text_fn": lambda r: f"{r[1] or ''}\n{r[2] or ''}".strip(),
    },
    "bylaw_chunks": {
        "select": "id, text_content",
        "text_fn": lambda r: (r[1] or "").strip(),
    },
    "documents": {
        "select": "id, title, full_text",
        "text_fn": lambda r: f"{r[1] or ''}\n{r[2] or ''}".strip(),
    },
    "key_statements": {
        "select": "id, statement_text, context",
        "text_fn": lambda r: f"{r[1] or ''}\n{r[2] or ''}".strip(),
    },
    "document_sections": {
        "select": "id, section_title, section_text",
        "text_fn": lambda r: f"{r[1] or ''}\n{r[2] or ''}".strip(),
    },
}

# OpenAI allows up to 2048 inputs per request, but smaller batches are safer
API_BATCH_SIZE = 128
DB_BATCH_SIZE = 500  # rows per database update
DEFAULT_MIN_WORDS = {
    "agenda_items": 0,
    "motions": 0,
    "matters": 0,
    "meetings": 0,
    "bylaws": 0,
    "bylaw_chunks": 0,
    "documents": 10,
    "key_statements": 5,
    "document_sections": 5,
}


# Connections live in pipeline.db (shared by every direct-Postgres writer).
get_db_connection = db.connect


MAX_EMBED_CHARS = 8000  # text-embedding-3-small handles ~8k tokens; truncate input


def _fetch_agenda_items_with_discussion(conn, force: bool = False):
    """Custom fetch for agenda_items: joins transcript segments to build rich discussion text."""
    where = "" if force else "WHERE ai.embedding IS NULL"
    query = f"""
        SELECT
            ai.id,
            ai.title,
            ai.plain_english_summary,
            ai.debate_summary,
            ai.discussion_start_time,
            ai.discussion_end_time,
            ai.meeting_id
        FROM agenda_items ai
        {where}
        ORDER BY ai.id
    """
    cur = conn.cursor()
    cur.execute(query)
    items = cur.fetchall()
    cur.close()

    if not items:
        return []

    # Batch-fetch transcript segments for all relevant meetings
    meeting_ids = list({row[6] for row in items})

    # Build a map: meeting_id -> list of segments
    segments_by_meeting: dict[int, list] = {}
    seg_cur = conn.cursor()
    # Fetch in batches of 50 meetings to avoid huge IN clauses
    for i in range(0, len(meeting_ids), 50):
        batch_ids = meeting_ids[i : i + 50]
        placeholders = ",".join(["%s"] * len(batch_ids))
        seg_cur.execute(
            f"""SELECT meeting_id, speaker_name, text_content as text,
                       start_time, agenda_item_id
                FROM transcript_segments
                WHERE meeting_id IN ({placeholders})
                ORDER BY start_time""",
            batch_ids,
        )
        for seg in seg_cur:
            segments_by_meeting.setdefault(seg[0], []).append(seg)
    seg_cur.close()

    # Build (id, text) pairs
    results = []
    for row in items:
        item_id, title, summary, debate, start_t, end_t, meeting_id = row

        parts = []
        if title:
            parts.append(title)
        if summary:
            parts.append(summary)
        if debate:
            parts.append(debate)

        # Find matching transcript segments
        meeting_segs = segments_by_meeting.get(meeting_id, [])
        discussion_segs = []

        for seg in meeting_segs:
            seg_meeting_id, speaker, text, seg_start, seg_item_id = seg
            # Match by agenda_item_id if available, else by time window
            if seg_item_id == item_id:
                discussion_segs.append((speaker, text))
            elif seg_item_id is None and start_t is not None and end_t is not None:
                if start_t <= seg_start <= end_t:
                    discussion_segs.append((speaker, text))

        if discussion_segs:
            parts.append("---")
            for speaker, text in discussion_segs:
                line = f"{speaker or 'Unknown'}: {text}"
                parts.append(line)

        full_text = "\n".join(parts)
        # Truncate to avoid exceeding token limits
        if len(full_text) > MAX_EMBED_CHARS:
            full_text = full_text[:MAX_EMBED_CHARS]

        results.append((item_id, full_text))

    return results


def fetch_rows_needing_embeddings(conn, table: str, force: bool = False):
    """Fetch rows that need embeddings. Uses client-side cursor (pooler-compatible)."""
    config = TABLE_CONFIG[table]
    query = f"SELECT {config['select']} FROM {table}"
    if not force:
        query += " WHERE embedding IS NULL"
    query += " ORDER BY id"

    cur = conn.cursor()
    cur.execute(query)
    return cur, config["text_fn"]


def update_embeddings_batch(conn, table: str, updates: list):
    """Bulk update embeddings using a temp table and UPDATE FROM."""
    if not updates:
        return

    dims = ai.resolve("embedding").dimensions

    def write(cur):
        # Create temp table
        cur.execute(f"""
            CREATE TEMP TABLE IF NOT EXISTS _embed_tmp (
                id INTEGER PRIMARY KEY,
                embedding halfvec({dims})
            ) ON COMMIT DROP
        """)
        cur.execute("TRUNCATE _embed_tmp")

        # Use COPY for fast bulk insert into temp table
        buf = io.StringIO()
        for row_id, embedding in updates:
            vec_str = "[" + ",".join(str(v) for v in embedding) + "]"
            buf.write(f"{row_id}\t{vec_str}\n")
        buf.seek(0)

        cur.copy_from(buf, "_embed_tmp", columns=("id", "embedding"))

        # Bulk update from temp table
        cur.execute(f"""
            UPDATE {table} t
            SET embedding = e.embedding
            FROM _embed_tmp e
            WHERE t.id = e.id
        """)
        return cur.rowcount

    return db.run_write(write, conn)


def embed_table(table: str, force: bool = False, min_words: int = None):
    """Generate and store embeddings for a single table."""
    if min_words is None:
        min_words = DEFAULT_MIN_WORDS.get(table, 0)

    print(f"\n{'='*60}")
    print(f"Embedding: {table}")
    cfg = ai.resolve("embedding")
    print(f"  Model: {cfg.model} ({cfg.dimensions} dims)")
    print(f"{'='*60}")

    conn = get_db_connection()

    # Count rows needing embeddings
    cur = conn.cursor()
    count_query = f"SELECT COUNT(*) FROM {table}"
    if not force:
        count_query += " WHERE embedding IS NULL"
    cur.execute(count_query)
    total = cur.fetchone()[0]
    cur.close()

    if total == 0:
        print(f"  No rows need embeddings in {table}.")
        conn.close()
        return

    print(f"  {total} rows to process" + (f" (min {min_words} words)" if min_words else ""))

    # Check for custom fetch function
    config = TABLE_CONFIG[table]
    custom_fn_name = config.get("custom_fetch_fn")
    use_custom = custom_fn_name is not None

    if use_custom:
        # Custom fetch returns pre-built (id, text) pairs
        custom_fn = globals()[custom_fn_name]
        prebuilt_rows = custom_fn(conn, force)
        print(f"  Custom fetch returned {len(prebuilt_rows)} rows with discussion text")
    else:
        # Standard fetch returns a cursor + text_fn
        row_cursor, text_fn = fetch_rows_needing_embeddings(conn, table, force)

    # Rows are fully fetched (client-side cursor / list), so end the read transaction:
    # each batch write then opens its own read-write transaction via db.run_write.
    conn.commit()

    # Process in batches
    batch_ids = []
    batch_texts = []
    processed = 0
    skipped = 0
    db_buffer = []  # accumulate (id, embedding) for DB writes
    start_time = time.time()

    # Build iterator based on fetch mode
    if use_custom:
        row_iter = iter(prebuilt_rows)
    else:
        row_iter = row_cursor

    for row in row_iter:
        if use_custom:
            row_id, text = row
        else:
            text = text_fn(row)
            row_id = row[0]

        if not text or not text.strip() or (min_words and len(text.split()) < min_words):
            skipped += 1
            continue

        # Truncate to stay within model's token limit
        if len(text) > MAX_EMBED_CHARS:
            text = text[:MAX_EMBED_CHARS]

        batch_ids.append(row_id)
        batch_texts.append(text)

        if len(batch_texts) >= API_BATCH_SIZE:
            embeddings = ai.embed(batch_texts)
            for row_id, emb in zip(batch_ids, embeddings):
                db_buffer.append((row_id, emb))

            processed += len(batch_texts)
            batch_ids = []
            batch_texts = []

            # Throttle to stay under OpenAI TPM rate limit
            time.sleep(0.5)

            # Write to DB when buffer is large enough
            if len(db_buffer) >= DB_BATCH_SIZE:
                update_embeddings_batch(conn, table, db_buffer)
                db_buffer = []

            elapsed = time.time() - start_time
            rate = processed / elapsed if elapsed > 0 else 0
            eta = (total - processed) / rate if rate > 0 else 0
            print(
                f"  Progress: {processed}/{total} ({processed/total*100:.1f}%) "
                f"- {rate:.0f} rows/sec - ETA {eta:.0f}s",
                end="\r",
            )

    # Final batch
    if batch_texts:
        embeddings = ai.embed(batch_texts)
        for row_id, emb in zip(batch_ids, embeddings):
            db_buffer.append((row_id, emb))
        processed += len(batch_texts)

    if db_buffer:
        update_embeddings_batch(conn, table, db_buffer)

    if not use_custom:
        row_cursor.close()
    conn.close()

    elapsed = time.time() - start_time
    print(f"\n  Done: {processed} embedded, {skipped} skipped (empty text), {elapsed:.1f}s")


def main():
    parser = argparse.ArgumentParser(description="Bulk embedding generation")
    parser.add_argument(
        "--table",
        default="all",
        help="Table to embed (agenda_items, motions, matters, meetings, bylaws, bylaw_chunks, documents, key_statements, or all)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-embed all rows, even those with existing embeddings",
    )
    parser.add_argument(
        "--min-words",
        type=int,
        default=None,
        help="Skip rows with fewer words (default varies by table, e.g. 10 for documents)",
    )
    args = parser.parse_args()

    tables = (
        list(TABLE_CONFIG.keys()) if args.table == "all" else [args.table]
    )

    for table in tables:
        if table not in TABLE_CONFIG:
            print(f"Unknown table: {table}")
            continue
        embed_table(table, args.force, args.min_words)


if __name__ == "__main__":
    main()
