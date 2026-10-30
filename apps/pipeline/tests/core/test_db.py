"""pipeline.db.run_write: every direct-Postgres write is explicitly read-write, retried once."""
from unittest.mock import MagicMock

import psycopg2
import pytest
from psycopg2.extensions import TRANSACTION_STATUS_IDLE, TRANSACTION_STATUS_INTRANS

from pipeline import db


class ReadOnlySqlTransaction(Exception):
    """Stands in for psycopg2.errors.ReadOnlySqlTransaction (SQLSTATE 25006)."""

    pgcode = "25006"


def fake_conn(fail_with=None, status=TRANSACTION_STATUS_IDLE):
    conn = MagicMock()
    conn.info.transaction_status = status
    cur = conn.cursor.return_value.__enter__.return_value
    statements = []

    def execute(sql, params=None):
        statements.append(sql)
        if fail_with is not None and sql != "SET TRANSACTION READ WRITE":
            raise fail_with

    cur.execute.side_effect = execute
    conn.statements = statements
    return conn


def write(cur):
    cur.execute("UPDATE meetings SET meta = meta WHERE id = 1")
    return "done"


def test_opens_a_read_write_transaction_and_commits():
    conn = fake_conn()
    assert db.run_write(write, conn) == "done"
    assert conn.statements == ["SET TRANSACTION READ WRITE", "UPDATE meetings SET meta = meta WHERE id = 1"]
    conn.commit.assert_called_once()
    conn.close.assert_not_called()  # caller's connection stays open


def test_owned_connection_is_closed():
    conn = fake_conn()
    assert db.run_write(write, opener=lambda: conn) == "done"
    conn.close.assert_called_once()


def test_read_only_error_retries_once_on_a_fresh_connection():
    stale = fake_conn(fail_with=ReadOnlySqlTransaction("cannot execute UPDATE in a read-only transaction"))
    fresh = fake_conn()
    assert db.run_write(write, stale, opener=lambda: fresh) == "done"
    stale.rollback.assert_called_once()
    stale.commit.assert_not_called()
    stale.close.assert_not_called()
    fresh.commit.assert_called_once()
    fresh.close.assert_called_once()
    assert fresh.statements[0] == "SET TRANSACTION READ WRITE"


def test_gives_up_after_one_retry():
    opened = []

    def opener():
        conn = fake_conn(fail_with=ReadOnlySqlTransaction("read-only"))
        opened.append(conn)
        return conn

    with pytest.raises(ReadOnlySqlTransaction):
        db.run_write(write, opener=opener)
    assert len(opened) == 2
    assert all(c.rollback.called and c.close.called and not c.commit.called for c in opened)


def test_other_errors_are_not_retried():
    conn = fake_conn(fail_with=ValueError("boom"))
    opener = MagicMock()
    with pytest.raises(ValueError):
        db.run_write(write, conn, opener=opener)
    opener.assert_not_called()
    conn.rollback.assert_called_once()


def test_refuses_a_connection_with_an_open_transaction():
    conn = fake_conn(status=TRANSACTION_STATUS_INTRANS)
    with pytest.raises(RuntimeError, match="idle connection"):
        db.run_write(write, conn)
    assert conn.statements == []


def test_recognises_the_real_psycopg2_error():
    assert db.is_read_only_error(psycopg2.errors.ReadOnlySqlTransaction())
    assert not db.is_read_only_error(psycopg2.errors.UniqueViolation())


def test_embedding_batches_write_through_the_helper(monkeypatch):
    from types import SimpleNamespace

    from pipeline.ingestion import embed

    monkeypatch.setattr(embed.ai, "resolve", lambda stage: SimpleNamespace(dimensions=3))
    stale = fake_conn(fail_with=ReadOnlySqlTransaction("read-only"))
    fresh = fake_conn()
    monkeypatch.setattr(db, "connect", lambda: fresh)
    embed.update_embeddings_batch(stale, "motions", [(1, [0.1, 0.2, 0.3])])
    assert fresh.statements[0] == "SET TRANSACTION READ WRITE"
    assert any("UPDATE motions" in sql for sql in fresh.statements)
    fresh.commit.assert_called_once()
