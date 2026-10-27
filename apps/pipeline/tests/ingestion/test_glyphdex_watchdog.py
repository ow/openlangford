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
    with pytest.raises(MeetingTimeout):
        ingest_guarded(ing, "f", timeout=2, target=_sleeper)
    ing.supabase.table.return_value.delete.assert_called_once()


def test_ingest_guarded_keeps_a_preexisting_meeting_row():
    ing = _ingester([{"id": 1}])
    with pytest.raises(RuntimeError):
        ingest_guarded(ing, "f", timeout=30, target=_boom)
    ing.supabase.table.return_value.delete.assert_not_called()


def test_ingest_guarded_success_does_not_delete():
    ing = _ingester([])
    ingest_guarded(ing, "f", timeout=30, target=_fast)
    ing.supabase.table.return_value.delete.assert_not_called()
