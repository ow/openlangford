"""mark_source_meeting_ingested: the single place a source row becomes 'ingested'."""
from types import SimpleNamespace

from pipeline.ops import mark_source_meeting_ingested


class FakeTable:
    def __init__(self, db, name):
        self.db, self.name = db, name
        self.filters, self.payload, self.count_mode = {}, None, False

    def select(self, *_, count=None, **__):
        self.count_mode = bool(count)
        return self

    def eq(self, col, val):
        self.filters[col] = val
        return self

    def limit(self, _):
        return self

    def update(self, payload):
        self.payload = payload
        return self

    def execute(self):
        rows = [
            r for r in self.db[self.name]
            if all(r.get(k) == v for k, v in self.filters.items())
        ]
        if self.payload is not None:
            for r in rows:
                r.update(self.payload)
            self.db["updates"].append((self.filters, self.payload))
            return SimpleNamespace(data=rows, count=None)
        return SimpleNamespace(data=rows, count=len(rows) if self.count_mode else None)


class FakeSupabase:
    def __init__(self, **tables):
        self.db = {"meetings": [], "agenda_items": [], "source_meetings": [], "updates": []}
        self.db.update(tables)

    def table(self, name):
        return FakeTable(self.db, name)


def meeting(**kw):
    return {"id": 7, "municipality_id": 1, "archive_path": "a/b", "has_minutes": True,
            "has_transcript": False, **kw}


def source(status, **kw):
    return {"id": 100, "municipality_id": 1, "archive_path": "a/b", "status": status,
            "ingested_meeting_id": None, **kw}


def test_links_by_archive_path_and_marks_ingested():
    sb = FakeSupabase(meetings=[meeting()], source_meetings=[source("discovered")])
    assert mark_source_meeting_ingested(sb, 7) is True
    row = sb.db["source_meetings"][0]
    assert row["status"] == "ingested" and row["ingested_meeting_id"] == 7


def test_extracted_becomes_ingested_via_explicit_source_id():
    sb = FakeSupabase(meetings=[meeting()],
                      source_meetings=[source("extracted", ingested_meeting_id=7)])
    assert mark_source_meeting_ingested(sb, 7, source_meeting_id=100)
    assert sb.db["source_meetings"][0]["status"] == "ingested"


def test_agenda_items_alone_count_as_content():
    sb = FakeSupabase(
        meetings=[meeting(has_minutes=False)],
        agenda_items=[{"meeting_id": 7}],
        source_meetings=[source("discovered")],
    )
    assert mark_source_meeting_ingested(sb, 7)


def test_empty_meeting_is_left_alone():
    sb = FakeSupabase(meetings=[meeting(has_minutes=False)],
                      source_meetings=[source("scheduled")])
    assert mark_source_meeting_ingested(sb, 7) is False
    assert sb.db["source_meetings"][0]["status"] == "scheduled"


def test_cancelled_and_postponed_are_never_overwritten():
    for status in ("cancelled", "postponed"):
        sb = FakeSupabase(meetings=[meeting()], source_meetings=[source(status)])
        assert mark_source_meeting_ingested(sb, 7) is False
        assert sb.db["source_meetings"][0]["status"] == status


def test_already_ingested_is_idempotent_and_missing_meeting_is_false():
    sb = FakeSupabase(meetings=[meeting()],
                      source_meetings=[source("ingested", ingested_meeting_id=7)])
    assert mark_source_meeting_ingested(sb, 7) is True
    assert sb.db["updates"] == []
    assert mark_source_meeting_ingested(FakeSupabase(), 99) is False
