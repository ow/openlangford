from unittest.mock import MagicMock

from pipeline.ingestion import matter_summaries as ms


def _matter(meta):
    return {"id": 1791, "_meta": meta, "history": ["item"], "_owned_item_ids": [], "_has_mentions": False}


def _run(monkeypatch, meta):
    monkeypatch.setattr(ms, "_load_context", lambda _s, ids: [_matter(meta)])
    monkeypatch.setattr(ms, "_summarize", lambda batch: {1791: {
        "summary": "Purchasing policy update.", "status": "Active", "status_line": "No decision recorded.", "timeline": []}})
    return ms.refresh_matter_summaries(MagicMock(), [1791], dry_run=True)[1791]


def test_superseded_matter_keeps_its_recorded_status(monkeypatch):
    update = _run(monkeypatch, {"superseded_by": {"matter_id": 46}, "status_line": "Replaced June 1, 2026."})
    assert "status" not in update
    assert update["meta"]["status_line"] == "Replaced June 1, 2026."
    assert update["plain_english_summary"] == "Purchasing policy update."


def test_ordinary_matter_status_still_follows_the_model(monkeypatch):
    update = _run(monkeypatch, {})
    assert update["status"] == "Active"
    assert update["meta"]["status_line"] == "No decision recorded."
