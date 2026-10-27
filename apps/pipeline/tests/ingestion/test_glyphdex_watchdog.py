import time
from unittest.mock import MagicMock

import pytest

from pipeline.ingestion.glyphdex_import import MeetingTimeout, ingest_guarded, run_with_timeout


def _fast(folder, municipality_id):
    pass


def _sleeper(folder, municipality_id):
    time.sleep(60)


def _boom(folder, municipality_id):
    raise ValueError("bad pdf")


def test_run_with_timeout_returns_when_child_finishes():
    run_with_timeout(_fast, ("f", 1), 30)


def test_run_with_timeout_kills_a_hung_child():
    started = time.time()
    with pytest.raises(MeetingTimeout):
        run_with_timeout(_sleeper, ("f", 1), 2)
    assert time.time() - started < 30


def test_run_with_timeout_reports_child_errors():
    with pytest.raises(RuntimeError, match="bad pdf"):
        run_with_timeout(_boom, ("f", 1), 30)


def _ingester(existing):
    ing = MagicMock()
    ing.municipality_id = 7
    ing._normalize_archive_path.return_value = "archive/x"
    ing.supabase.table.return_value.select.return_value.eq.return_value.limit.return_value.execute.return_value.data = existing
    return ing


def test_ingest_guarded_deletes_the_new_meeting_row_on_timeout():
    ing = _ingester([])
    ing.supabase = _FakeClient({"meetings": []})
    with pytest.raises(MeetingTimeout):
        ingest_guarded(ing, "f", timeout=2, target=_sleeper)


def test_ingest_guarded_keeps_a_preexisting_meeting_row():
    ing = _ingester([{"id": 1}])
    with pytest.raises(RuntimeError):
        ingest_guarded(ing, "f", timeout=30, target=_boom)
    ing.supabase.table.return_value.delete.assert_not_called()


def test_ingest_guarded_success_does_not_delete():
    ing = _ingester([])
    ingest_guarded(ing, "f", timeout=30, target=_fast)
    ing.supabase.table.return_value.delete.assert_not_called()


class _Q:
    def __init__(self, db, table):
        self.db, self.table, self.op, self.filters, self.n = db, table, "select", [], None

    def select(self, *_):
        return self

    def delete(self):
        self.op = "delete"
        return self

    def eq(self, col, val):
        self.filters.append(("eq", col, val))
        return self

    def in_(self, col, vals):
        self.filters.append(("in", col, list(vals)))
        return self

    def limit(self, n):
        self.n = n
        return self

    def _match(self, row):
        return all(row.get(c) == v if k == "eq" else row.get(c) in v for k, c, v in self.filters)

    def execute(self):
        self.db.calls.append((self.op, self.table))
        if self.op == "delete" and self.table in self.db.fail_tables:
            raise RuntimeError("57014 statement timeout")
        rows = self.db.rows.setdefault(self.table, [])
        hit = [r for r in rows if self._match(r)]
        if self.op == "delete":
            self.db.rows[self.table] = [r for r in rows if r not in hit]
        res = MagicMock()
        res.data = hit[: self.n] if self.n else hit
        return res


class _FakeClient:
    def __init__(self, rows, fail_tables=()):
        self.rows, self.fail_tables, self.calls = rows, set(fail_tables), []

    def table(self, name):
        return _Q(self, name)


def _meeting_db():
    return {
        "meetings": [{"id": 5, "archive_path": "archive/x"}],
        "agenda_items": [{"id": 1, "meeting_id": 5}],
        "motions": [{"id": 10, "meeting_id": 5}],
        "votes": [{"id": 100, "motion_id": 10}, {"id": 101, "motion_id": 10}],
        "transcript_segments": [{"id": i, "meeting_id": 5} for i in range(450)],
        "transcript_identity_evidence": [{"id": 1, "meeting_id": 5}],
        "documents": [{"id": 1, "meeting_id": 5}],
    }


def test_cleanup_partial_meeting_deletes_children_table_by_table_then_meeting():
    from pipeline.ingestion.glyphdex_import import cleanup_partial_meeting
    client = _FakeClient(_meeting_db())
    cleanup_partial_meeting(client, "archive/x")
    assert all(not v for v in client.rows.values())
    deletes = [t for op, t in client.calls if op == "delete"]
    assert deletes[-1] == "meetings"
    assert deletes.index("votes") < deletes.index("motions") < deletes.index("agenda_items")
    assert "meetings" not in deletes[:-1]
    assert deletes.count("transcript_segments") == 3  # paged, never one big delete


def test_ingest_guarded_continues_past_failing_child_and_reports_original():
    ing = MagicMock()
    ing.municipality_id = 7
    ing._normalize_archive_path.return_value = "archive/x"
    client = _FakeClient({"meetings": []}, fail_tables={"documents", "meetings"})
    ing.supabase = client
    # simulate a meeting created by the failed ingest
    def boom_after_create(folder, mid):
        client.rows["meetings"].append({"id": 9, "archive_path": "archive/x"})
        client.rows["documents"] = [{"id": 1, "meeting_id": 9}]
        client.rows["agenda_items"] = [{"id": 2, "meeting_id": 9}]
        raise ValueError("bad pdf")
    # run in-process: bypass the child process
    import pipeline.ingestion.glyphdex_import as gi
    orig = gi.run_with_timeout
    gi.run_with_timeout = lambda t, a, to: boom_after_create(*a)
    try:
        with pytest.raises(ValueError, match="bad pdf"):
            ingest_guarded(ing, "f", timeout=1, target=boom_after_create)
    finally:
        gi.run_with_timeout = orig
    assert client.rows["agenda_items"] == []  # later steps still ran
    assert client.rows["documents"]  # failed step logged, not fatal
