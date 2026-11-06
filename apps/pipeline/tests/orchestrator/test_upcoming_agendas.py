"""Agenda watch (main.py --upcoming-agendas): which meetings it ingests, the unchanged-agenda skip, and
merging into the calendar's "Planned" meeting instead of creating a second one."""
import json
import os
from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from pipeline import upcoming_agendas as ua
from pipeline.ingestion.calendar_identity import find_scheduled_meeting
from pipeline.ops import meeting_source_record, upsert_source_meetings
from pipeline.orchestrator import Archiver
from pipeline.scrapers.base import MunicipalityConfig
from pipeline.scrapers.escribe import EscribeScraper

BASE = "https://pub-langford.escribemeetings.com"
TODAY = date(2026, 11, 6)
SPECIAL_ID = "cbff7e4e-ad7d-4ab0-a741-ff7bfe1680f9"
MUNI = MunicipalityConfig(1, "langford", "City of Langford", "Langford", {
    "type": "escribe", "base_url": BASE, "meeting_types": ["Council Meeting", "Special Council Meeting",
                                                          "Community Advisory Committee", "Special Inaugural Council Meeting"]})


# --- fakes ------------------------------------------------------------------------------------------


class Query:
    """Enough of the PostgREST builder for these reads and upserts."""

    def __init__(self, db, name):
        self.db, self.name, self.tests, self.payload, self.negate = db, name, [], None, False

    @property
    def not_(self):
        self.negate = True
        return self

    def _add(self, test):
        negate, self.negate = self.negate, False
        self.tests.append((lambda row: not test(row)) if negate else test)
        return self

    def select(self, *_, **__):
        return self

    def eq(self, col, val):
        return self._add(lambda row: row.get(col) == val)

    def in_(self, col, vals):
        return self._add(lambda row: row.get(col) in set(vals))

    def is_(self, col, _null):
        return self._add(lambda row: row.get(col) is None)

    def range(self, *_):
        return self

    def upsert(self, records, on_conflict=None):
        self.payload = (records, on_conflict.split(","))
        return self

    def execute(self):
        rows = self.db.setdefault(self.name, [])
        if self.payload is not None:
            records, keys = self.payload
            for record in records:
                match = next((r for r in rows if all(r.get(k) == record.get(k) for k in keys)), None)
                if match is None:
                    rows.append({"id": 1000 + len(rows), **record})
                else:
                    match.update(record)
            return SimpleNamespace(data=records)
        return SimpleNamespace(data=[dict(r) for r in rows if all(t(r) for t in self.tests)])


class DB:
    def __init__(self, **tables):
        self.tables = {name: [dict(row) for row in rows] for name, rows in tables.items()}

    def table(self, name):
        return Query(self.tables, name)

    def rpc(self, name, args):
        raise AssertionError(f"unexpected rpc {name}")


def calendar_row(meeting_id=SPECIAL_ID, meeting_type="Special Council Meeting", start="2026/11/24 17:30:00",
                 links=()):
    return {"ID": meeting_id.upper(), "MeetingType": meeting_type, "StartDate": start,
            "MeetingDocumentLink": list(links)}


AGENDA_PDF = {"Title": "Agenda (PDF)", "Type": "Agenda", "Format": ".pdf", "Url": "/FileStream.ashx?DocumentId=19600"}
AGENDA_COVER = {"Title": "Agenda Cover Page (PDF)", "Type": "AgendaCover", "Format": ".pdf",
                "Url": "/FileStream.ashx?DocumentId=19601"}
AGENDA_HTML = {"Title": "Agenda (HTML)", "Type": "Agenda", "Format": "HTML",
               "Url": f"/Meeting.aspx?Id={SPECIAL_ID}&Agenda=Agenda&lang=English"}
MINUTES_PDF = {"Title": "Minutes (PDF)", "Type": "PostMinutes", "Format": ".pdf", "Url": "/FileStream.ashx?DocumentId=19700"}
VIDEO = {"Title": "Video", "Type": "Video", "Format": "Video", "Url": f"./Players/ISIStandAlonePlayer.aspx?Id={SPECIAL_ID}"}
CANCELLED = {"Title": "Meeting Cancellation Notice ", "Type": "AdditionalDocuments", "Format": ".pdf",
             "Url": "/FileStream.ashx?DocumentId=19499"}
PDF_URL = f"{BASE}/FileStream.ashx?DocumentId=19600"
HTML_URL = f"{BASE}{AGENDA_HTML['Url']}"


def scraper(rows):
    s = EscribeScraper(MUNI)
    s.session = MagicMock()
    s.session.post.return_value.json.return_value = {"d": json.dumps(rows)}
    return s


def scraped(*links, row=None):
    row = row or calendar_row(links=links)
    return scraper([row]).discover_calendar_meetings(date(2026, 10, 23), date(2027, 1, 5))[0]


# --- calendar discovery -------------------------------------------------------------------------------


def test_calendar_rows_become_scraped_meetings_in_the_window_and_configured_types():
    rows = [
        calendar_row(links=[AGENDA_COVER, AGENDA_PDF, AGENDA_HTML]),
        calendar_row("86cbb54c-6b02-4bd9-b342-3b756439b983", "Sustainable Development Advisory Committee"),  # not configured
        calendar_row("b3e00e65-8200-4120-b0bd-ebbdbe192c08", "Council Meeting", "2027/02/01 19:00:00"),  # outside window
        {"ID": "", "MeetingType": "Council Meeting", "StartDate": "2026/11/23 19:00:00"},  # no ID
    ]
    meetings = scraper(rows).discover_calendar_meetings(date(2026, 10, 23), date(2027, 1, 5))
    assert [(m.source_id, m.date, m.title, m.meeting_type) for m in meetings] == [
        (SPECIAL_ID, date(2026, 11, 24), "Special Council Meeting", "Special Council")]
    m = meetings[0]
    assert m.agenda_url == PDF_URL and m.minutes_url is None and m.video_url is None
    assert m.meta["escribe_meeting"]["MeetingTime"] == "5:30 PM"


def test_calendar_meeting_gets_the_same_archive_folder_as_the_past_meetings_scrape():
    with patch("pipeline.orchestrator.get_scraper"), patch("pipeline.orchestrator.get_video_client"):
        archiver = Archiver(municipality=MUNI, initialize_diarizer=False)
    from_calendar = scraped(row=calendar_row("e8663643-8d9d-4d4d-9847-f7cdb8dc6f5d",
                                             "Special Inaugural Council Meeting", "2026/11/02 18:30:00"))
    past_raw = {"Id": "e8663643-8d9d-4d4d-9847-f7cdb8dc6f5d", "MeetingType": "Special Inaugural Council Meeting",
                "MeetingDate": "November 02, 2026", "MeetingTime": "6:30 PM", "MeetingLinks": []}
    from_past = scraper([])._scraped_meeting(past_raw, date(2026, 11, 2), "x")
    assert archiver._meeting_archive_path_for_db(from_calendar) == archiver._meeting_archive_path_for_db(from_past)
    assert archiver._meeting_archive_path_for_db(from_calendar).endswith(
        "Council/2026/11/2026-11-02 630pm Inauguration [e8663643]")


def test_agenda_only_drops_minutes_video_and_other_documents():
    m = scraped(AGENDA_COVER, AGENDA_PDF, AGENDA_HTML, MINUTES_PDF, VIDEO, CANCELLED)
    m.video_url = "https://example.org/video"
    only = ua.agenda_only(m)
    assert {d.category for d in only.documents} == {"Agenda"}
    assert only.video_url is None and only.minutes_url is None
    assert only.meta["escribe_meeting"]["MeetingLinks"] == [AGENDA_PDF, AGENDA_HTML]
    assert len(m.documents) > len(only.documents)  # the original is untouched


# --- decisions ------------------------------------------------------------------------------------------


def held(items=0, **row):
    meeting = {"id": 989, "status": "Planned", "has_agenda": False, "agenda_url": None, **row}
    return ua.Held(meeting=meeting, via="source link", item_count=items)


@pytest.mark.parametrize("meeting,state,plan,expected", [
    (dict(row=calendar_row(start="2026/11/02 19:00:00", links=[AGENDA_PDF])), ua.Held(), {}, "past"),
    (dict(links=[AGENDA_PDF]), held(status="Cancelled"), {}, "cancelled"),
    (dict(links=[CANCELLED]), ua.Held(), {}, "cancelled"),
    (dict(links=[]), held(), {}, "no_agenda"),
    (dict(links=[AGENDA_COVER]), held(), {}, "no_agenda"),  # a cover page is not the agenda
    (dict(links=[AGENDA_PDF]), ua.Held(), {"action": "blocked", "conflicts": [5]}, "blocked"),
    (dict(links=[AGENDA_PDF]), held(), {}, "ingest"),  # the calendar's Planned meeting, no items yet
    (dict(links=[AGENDA_PDF]), ua.Held(), {}, "ingest"),  # no meeting yet: a new one
    (dict(links=[AGENDA_PDF]), held(items=3, has_agenda=True), {}, "revised"),  # half-ingested elsewhere
    (dict(links=[AGENDA_PDF]), held(items=3, has_agenda=True, agenda_url=PDF_URL), {}, "unchanged"),
    (dict(links=[AGENDA_PDF, AGENDA_HTML]), held(items=3, has_agenda=True, agenda_url=HTML_URL), {}, "unchanged"),
    (dict(links=[AGENDA_HTML]), held(items=3, has_agenda=True, agenda_url=HTML_URL), {}, "unchanged"),
    (dict(links=[AGENDA_PDF]), held(items=3, has_agenda=True,
                                    agenda_url=f"{BASE}/FileStream.ashx?DocumentId=19555"), {}, "revised"),
    (dict(links=[AGENDA_PDF]), held(items=0, has_agenda=True, agenda_url=PDF_URL), {}, "ingest"),  # self-heal
])
def test_decide(meeting, state, plan, expected):
    m = scraped(*meeting.get("links", ()), row=meeting.get("row"))
    decision = ua.decide(m, today=TODAY, held=state, plan_entry=plan, base_url=BASE)
    assert decision.action == expected, decision.reason


def test_today_is_still_upcoming():
    m = scraped(row=calendar_row(start="2026/11/06 19:00:00", links=[AGENDA_PDF]))
    assert ua.decide(m, today=TODAY, held=ua.Held(), base_url=BASE).action == "ingest"


def test_unchanged_link_but_different_local_file_is_a_revision():
    m = scraped(AGENDA_PDF)
    state = held(items=4, has_agenda=True, agenda_url=PDF_URL)
    state.document_hashes = {"Agenda/Agenda.pdf": "aaa"}
    assert ua.decide(m, today=TODAY, held=state, local_hashes={"Agenda/Agenda.pdf": "aaa"},
                     base_url=BASE).action == "unchanged"
    assert ua.decide(m, today=TODAY, held=state, local_hashes={"Agenda/Agenda.pdf": "bbb"},
                     base_url=BASE).action == "revised"


# --- what the database holds ------------------------------------------------------------------------------


def calendar_db(**extra):
    tables = {
        "source_meetings": [
            {"id": 2316, "municipality_id": 1, "source_type": "escribe", "source_id": SPECIAL_ID,
             "meeting_date": "2026-11-24", "title": "Special Council", "meeting_type": "Special Council",
             "status": "scheduled", "ingested_meeting_id": 989, "archive_path": None},
        ],
        "meetings": [
            {"id": 989, "municipality_id": 1, "meeting_date": "2026-11-24", "type": "Special Council",
             "status": "Planned", "has_agenda": False, "agenda_url": None, "archive_path": None,
             "calendar_source_id": 2316, "organization_id": 1, "title": "Special Council", "meta": {"calendar": {}}},
        ],
        "agenda_items": [], "documents": [],
    }
    for name, rows in extra.items():
        tables[name] = tables.get(name, []) + rows
    return DB(**tables)


def test_load_held_finds_the_calendar_meeting_through_its_source_link():
    m = scraped(AGENDA_PDF)
    state = ua.load_held(calendar_db(), 1, [m], {SPECIAL_ID: "archive/langford/x"})[SPECIAL_ID]
    assert state.meeting["id"] == 989 and state.via == "source link" and state.item_count == 0


def test_load_held_counts_items_and_agenda_document_hashes():
    db = calendar_db(agenda_items=[{"meeting_id": 989}, {"meeting_id": 989}, {"meeting_id": 5}],
                     documents=[{"meeting_id": 989, "file_path": "Agenda/Agenda.pdf", "file_hash": "h"},
                                {"meeting_id": 989, "file_path": "Minutes/Minutes.pdf", "file_hash": "m"}])
    state = ua.load_held(db, 1, [scraped(AGENDA_PDF)], {})[SPECIAL_ID]
    assert state.item_count == 2 and state.document_hashes == {"Agenda/Agenda.pdf": "h"}


def test_load_held_matches_an_unlinked_calendar_meeting_only_when_unique_and_unowned():
    db = calendar_db()
    db.tables["source_meetings"] = []  # known only from the annual schedule
    state = ua.load_held(db, 1, [scraped(AGENDA_PDF)], {})[SPECIAL_ID]
    assert state.meeting["id"] == 989 and state.via == "calendar match"

    db.tables["source_meetings"] = [{"id": 1, "municipality_id": 1, "source_type": "escribe", "source_id": "other",
                                     "ingested_meeting_id": 989}]
    assert ua.load_held(db, 1, [scraped(AGENDA_PDF)], {})[SPECIAL_ID].meeting is None


def test_load_held_finds_an_archived_meeting_by_folder():
    db = calendar_db()
    db.tables["source_meetings"] = []
    db.tables["meetings"][0].update(archive_path="archive/langford/folder", calendar_source_id=None)
    state = ua.load_held(db, 1, [scraped(AGENDA_PDF)], {SPECIAL_ID: "archive/langford/folder"})[SPECIAL_ID]
    assert state.meeting["id"] == 989 and state.via == "archive path"


def test_recording_the_folder_keeps_the_calendar_link_so_the_ingester_updates_that_meeting():
    """The calendar row merge: discovery adds the folder to the calendar's source row (same eSCRIBE ID) and keeps
    its meeting link; the ingester then resolves the folder to meeting 989, never a new meeting."""
    db = calendar_db()
    m = scraped(AGENDA_PDF)
    folder = "archive/langford/Council/2026/11/2026-11-24 530pm Special Council [cbff7e4e]"
    upsert_source_meetings(db, MUNI, "escribe", [meeting_source_record(MUNI, "escribe", m, archive_path=folder,
                                                                       status="documents_downloaded")])
    rows = db.tables["source_meetings"]
    assert len(rows) == 1
    assert rows[0]["archive_path"] == folder and rows[0]["ingested_meeting_id"] == 989
    found = find_scheduled_meeting(db, 1, folder, "2026-11-24", "Special Council")
    assert found["id"] == 989 and found["calendar_source_id"] == 2316


# --- the run --------------------------------------------------------------------------------------------


@pytest.fixture
def run(tmp_path, monkeypatch):
    """An Archiver over tmp_path with a fake calendar, database and downloads; ingest and embeddings recorded."""
    def make(rows, db):
        with patch("pipeline.orchestrator.get_scraper"), patch("pipeline.orchestrator.get_video_client"), \
                patch("pipeline.orchestrator.get_municipality_archive_root", return_value=str(tmp_path)):
            archiver = Archiver(municipality=MUNI, initialize_diarizer=False)
        archiver.scraper = scraper(rows)
        downloads = []

        def download(meeting, target_dir):
            downloads.append(meeting)
            for doc in meeting.documents:
                if doc.category == "Agenda" and "cover" not in doc.title.lower():
                    os.makedirs(os.path.join(target_dir, "Agenda"), exist_ok=True)
                    path = os.path.join(target_dir, "Agenda", "Agenda.pdf")
                    with open(path, "w") as handle:
                        handle.write(doc.url)
                    with open(path + ".url", "w") as handle:
                        handle.write(doc.url)
            return []

        archiver.scraper.download_documents = download
        ingests, embeds, upserts = [], [], []

        def ingest(target_folder=None, force_update=False, **_):
            ingests.append((target_folder, force_update))
            return {"meeting_id": 989, "items": [{}, {}], "meeting": {"has_minutes": False}}

        monkeypatch.setattr(archiver, "_get_admin_supabase", lambda: db)
        monkeypatch.setattr(archiver, "_ingest_meetings", ingest)
        monkeypatch.setattr("pipeline.orchestrator.upsert_source_meetings",
                            lambda sb, muni, st, records: upserts.extend(records) or len(records))
        monkeypatch.setattr("pipeline.stages.embed_tables", lambda **kw: embeds.append(kw))
        monkeypatch.setattr(ua, "civic_today", lambda tz=None: TODAY)
        for name in ("record_email_enqueue", "retry_email_enqueues"):
            monkeypatch.setattr(f"pipeline.email_outbox.{name}",
                                lambda *a, **k: pytest.fail("the agenda watch must not touch email"))
        return SimpleNamespace(archiver=archiver, downloads=downloads, ingests=ingests, embeds=embeds,
                               upserts=upserts, tmp=tmp_path)
    return make


def test_run_ingests_a_new_agenda_into_the_calendar_meeting(run):
    r = run([calendar_row(links=[AGENDA_COVER, AGENDA_PDF, MINUTES_PDF, VIDEO])], calendar_db())
    decisions = r.archiver.run_upcoming_agendas()
    assert [d.action for d in decisions] == ["ingest"] and decisions[0].meeting_id == 989
    assert [d.category for d in r.downloads[0].documents] == ["Agenda", "Agenda"]  # cover (skipped by scraper) + agenda
    assert r.downloads[0].video_url is None
    folder, force = r.ingests[0]
    assert force is False and folder.endswith("2026-11-24 530pm Special Council [cbff7e4e]")
    assert r.upserts[0]["archive_path"].endswith("[cbff7e4e]") and r.upserts[0]["source_id"] == SPECIAL_ID
    assert r.embeds == [{"tables": ua.EMBED_TABLES}]


def test_second_run_with_the_same_agenda_does_nothing(run):
    db = calendar_db(agenda_items=[{"meeting_id": 989}])
    db.tables["meetings"][0].update(has_agenda=True, agenda_url=PDF_URL)
    r = run([calendar_row(links=[AGENDA_PDF])], db)
    assert [d.action for d in r.archiver.run_upcoming_agendas()] == ["unchanged"]
    assert r.downloads == [] and r.ingests == [] and r.upserts == [] and r.embeds == []


def test_revised_agenda_sets_the_old_copy_aside_and_forces_a_refresh(run):
    db = calendar_db(agenda_items=[{"meeting_id": 989}])
    old_url = f"{BASE}/FileStream.ashx?DocumentId=19555"
    db.tables["meetings"][0].update(has_agenda=True, agenda_url=old_url)
    r = run([calendar_row(links=[AGENDA_PDF])], db)
    folder = r.archiver._meeting_archive_root(scraped(AGENDA_PDF))
    os.makedirs(os.path.join(folder, "Agenda"))
    for name, text in (("Agenda/Agenda.pdf", "old"), ("Agenda/Agenda.pdf.url", old_url), ("agenda.md", "# old")):
        with open(os.path.join(folder, name), "w") as handle:
            handle.write(text)

    assert [d.action for d in r.archiver.run_upcoming_agendas()] == ["revised"]
    assert r.ingests == [(folder, True)]
    agenda_dir = os.listdir(os.path.join(folder, "Agenda"))
    assert any(name.startswith("Agenda.pdf.superseded-") and not name.endswith(".url") for name in agenda_dir)
    with open(os.path.join(folder, "Agenda", "Agenda.pdf.url")) as handle:
        assert handle.read() == PDF_URL
    assert not os.path.exists(os.path.join(folder, "agenda.md"))


def test_dry_run_downloads_and_writes_nothing(run):
    r = run([calendar_row(links=[AGENDA_PDF])], calendar_db())
    assert [d.action for d in r.archiver.run_upcoming_agendas(dry_run=True)] == ["ingest"]
    assert r.downloads == [] and r.ingests == [] and r.upserts == [] and r.embeds == []
    assert os.listdir(r.tmp) == []


def test_nothing_to_ingest_means_no_embedding(run):
    r = run([calendar_row(links=[]), calendar_row("f0e35a09-4e09-4e19-8059-85b18949939d",
                                                  "Community Advisory Committee", links=[CANCELLED])],
            calendar_db())
    assert sorted(d.action for d in r.archiver.run_upcoming_agendas()) == ["cancelled", "no_agenda"]
    assert r.ingests == [] and r.embeds == []
