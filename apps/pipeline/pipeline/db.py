"""Direct Postgres connections for the pipeline (psycopg2 over DATABASE_URL).

DATABASE_URL points at Supavisor's transaction-mode pooler (port 6543). There, every
transaction may run on a different server backend, and a session-level ``SET`` (for
example ``SET default_transaction_read_only = on`` from an ad-hoc psql check) stays on
the backend that ran it and is handed to whichever client gets that backend next. On
2026-10-30 one such leaked backend made 18 pipeline writes fail with
"cannot execute UPDATE in a read-only transaction".

So: never use session-level SETs on this URL (put ``BEGIN READ ONLY`` / ``SET LOCAL``
inside a transaction instead; psycopg2's ``set_session(readonly=...)`` is fine outside
autocommit because it is sent with each ``BEGIN``), and send every write through
``run_write``: it opens the transaction with ``SET TRANSACTION READ WRITE`` and retries
once on a fresh connection if the server still reports a read-only transaction.
"""

from __future__ import annotations

import os
import re
from typing import Any, Callable, TypeVar
from urllib.parse import quote_plus, urlparse

from dotenv import load_dotenv

load_dotenv()

T = TypeVar("T")

READ_ONLY_SQLSTATE = "25006"  # read_only_sql_transaction
POOLER_REGION = os.environ.get("SUPABASE_POOLER_REGION", "us-east-2")


def _extract_project_id(url: str) -> str | None:
    """Extract Supabase project ID from a DATABASE_URL or SUPABASE_URL."""
    m = re.search(r"([a-z]{20})\.supabase", url)
    return m.group(1) if m else None


def _make_session_pooler_url(project_id: str, password: str) -> str:
    """Build a session-mode pooler URL (IPv4-accessible, supports named cursors)."""
    return (
        f"postgresql://postgres.{project_id}:{quote_plus(password)}"
        f"@aws-1-{POOLER_REGION}.pooler.supabase.com:5432/postgres"
    )


def connect():
    """Get a psycopg2 connection. Falls back to session pooler (IPv4) if direct connection fails."""
    import psycopg2

    database_url = os.environ.get("DATABASE_URL")
    if database_url:
        try:
            return psycopg2.connect(database_url, connect_timeout=5)
        except psycopg2.OperationalError:
            # Direct connection is IPv6-only; try the session pooler (IPv4)
            parsed = urlparse(database_url)
            project_id = _extract_project_id(database_url)
            if project_id and parsed.password:
                pooler_url = _make_session_pooler_url(project_id, parsed.password)
                print("  Direct connection failed (IPv6), trying session pooler (IPv4)...")
                return psycopg2.connect(pooler_url, connect_timeout=10)
            raise

    # Derive from Supabase URL: https://PROJECT_ID.supabase.co
    supabase_url = os.environ.get("SUPABASE_URL")
    if supabase_url:
        project_id = _extract_project_id(supabase_url)
        db_password = os.environ.get("SUPABASE_DB_PASSWORD")
        if project_id and db_password:
            return psycopg2.connect(
                _make_session_pooler_url(project_id, db_password), connect_timeout=10
            )

    raise RuntimeError(
        "Set DATABASE_URL or both SUPABASE_URL + SUPABASE_DB_PASSWORD in .env"
    )


def is_read_only_error(exc: BaseException) -> bool:
    """True for Postgres "cannot execute ... in a read-only transaction"."""
    return (
        getattr(exc, "pgcode", None) == READ_ONLY_SQLSTATE
        or type(exc).__name__ == "ReadOnlySqlTransaction"
    )


def _in_transaction(conn: Any) -> bool:
    try:
        from psycopg2.extensions import TRANSACTION_STATUS_IDLE

        status = conn.info.transaction_status
    except Exception:
        return False
    return isinstance(status, int) and status != TRANSACTION_STATUS_IDLE


def _write_once(conn: Any, fn: Callable[[Any], T]) -> T:
    if _in_transaction(conn):
        # SET TRANSACTION must be the first statement; don't commit someone else's work.
        raise RuntimeError("run_write needs an idle connection: commit or roll back first")
    try:
        with conn.cursor() as cur:
            cur.execute("SET TRANSACTION READ WRITE")
            result = fn(cur)
        conn.commit()
        return result
    except BaseException:
        conn.rollback()
        raise


def run_write(
    fn: Callable[[Any], T],
    conn: Any = None,
    *,
    opener: Callable[[], Any] | None = None,
) -> T:
    """Run ``fn(cursor)`` in one read-write transaction and commit; return its result.

    Uses ``conn`` when given (it must be idle and stays open), otherwise a new connection
    from ``opener`` (default: ``connect``) that is closed afterwards. If Postgres reports a
    read-only transaction, the whole transaction was rolled back, so it is retried once on
    a fresh connection from ``opener``; ``fn`` must therefore only touch the database
    through the cursor it is given.
    """
    opener = opener or connect
    owned = conn is None
    if owned:
        conn = opener()
    try:
        return _write_once(conn, fn)
    except Exception as exc:
        if not is_read_only_error(exc):
            raise
        print(f"  Read-only transaction on a pooled connection; retrying on a fresh one ({exc})".rstrip())
    finally:
        if owned:
            conn.close()

    fresh = opener()
    try:
        return _write_once(fresh, fn)
    finally:
        fresh.close()
