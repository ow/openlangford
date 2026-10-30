"""eSCRIBE discovery/media sync match by meeting ID and body, never by date alone."""
import os
from datetime import date
from unittest.mock import MagicMock, patch

import pytest

from pipeline.orchestrator import Archiver
from pipeline.paths import BASE_DIR
from pipeline.scrapers.base import MunicipalityConfig, ScrapedDocument, ScrapedMeeting
from pipeline.scrapers.escribe_bodies import escribe_body
from pipeline.source_identity import (
    DuplicateGuard,
    folder_source_ids,
    gap_fill_documents,
    is_foreign_folder,
    same_body,
    select_video,
)

SDAC_ID = "37b8f3c9-72f9-4a75-87d2-584ad66254a5"
COUNCIL_ID = "6c32f0ce-0000-4000-8000-000000000000"


@pytest.mark.parametrize("label,name,special", [
    ("Planning Zoning and Affordable Housing Committee", "Planning, Zoning & Affordable Housing Committee", False),
    ("Planning, Zoning and Affordable Housing Committee Meeting", "Planning, Zoning & Affordable Housing Committee", False),
    ("Special Planning, Zoning and Affordable Housing Committee", "Planning, Zoning & Affordable Housing Committee", True),
    ("Parks, Recreation, Environment, Culture, and Beautification Committee",
     "Parks, Recreation, Culture & Beautification Committee", False),
    ("Special Sustainable Development Advisory Committee", "Sustainable Development Advisory Committee", True),
    ("Sustainable Development Advisory Committee – Special", "Sustainable Development Advisory Committee", True),
    ("Community Advisory Committee", "Community Advisory Committee", False),
    ("Board of Variance", "Board of Variance", False),
])
def test_escribe_body_canonical_names(label, name, special):
    body = escribe_body(label)
    assert (body.name, body.special) == (name, special)


@pytest.mark.parametrize("label", ["Council Meeting", "Special Council Meeting", "Committee of the Whole Meeting",
                                   "Special Inaugural Council Meeting", "Public Hearing", ""])
def test_council_family_is_not_a_committee_body(label):
    assert escribe_body(label) is None


def _meeting(raw_type, source_id, day=date(2026, 11, 9), meeting_type="Advisory Committee", docs=()):
    return ScrapedMeeting(
        date=day, title=raw_type, meeting_type=meeting_type, source_id=source_id, documents=list(docs),
        meta={"escribe_meeting": {"MeetingType": raw_type, "MeetingTime": "7:00 PM", "MeetingLinks": [
            {"Type": "Agenda", "Title": "Agenda (PDF)", "Url": "/a.pdf", "Format": ".pdf"},
            {"Type": "PostMinutes", "Title": "Minutes (HTML)", "Url": "/m", "Format": "HTML"},
        ]}},
    )


def _archiver():
    muni = MunicipalityConfig(1, "langford", "Langford", "Langford", {"type": "escribe", "base_url": "https://x"})
    with patch("pipeline.orchestrator.get_scraper"), patch("pipeline.orchestrator.get_video_client"):
        return Archiver(municipality=muni, initialize_diarizer=False)


def test_committee_folders_use_canonical_body_and_title():
    archiver = _archiver()
    root = archiver._meeting_archive_root(_meeting("Special Sustainable Development Advisory Committee", SDAC_ID))
    assert root.endswith(os.path.join(
        "Sustainable Development Advisory Committee", "2026", "11",
        "2026-11-09 700pm Sustainable Development Advisory Committee – Special [37b8f3c9]"))
    council = ScrapedMeeting(date=date(2026, 11, 9), title="Council Meeting", meeting_type="Regular Council",
                             source_id=COUNCIL_ID, meta={"escribe_meeting": {"MeetingType": "Council Meeting",
                                                                           "MeetingTime": "7:00 PM"}})
    assert archiver._meeting_archive_root(council).endswith(
        os.path.join("Council", "2026", "11", "2026-11-09 700pm Regular Council [6c32f0ce]"))


def test_imported_folder_is_only_gap_filled(tmp_path):
    folder = tmp_path / "2025-11-10 700pm Sustainable Development Advisory Committee [gx-14d5d472]"
    (folder / "Agenda").mkdir(parents=True)
    (folder / "Agenda" / "SDAC - Agenda Package.pdf").write_bytes(b"%PDF-1.4")
    docs = [ScrapedDocument("Agenda", "https://x/a.pdf", "Agenda"), ScrapedDocument("Minutes", "https://x/m.pdf", "Minutes"),
            ScrapedDocument("Notice", "https://x/n.pdf", "Other Documents")]
    meeting = _meeting("Sustainable Development Advisory Committee", SDAC_ID, docs=docs)
    assert is_foreign_folder(str(folder), SDAC_ID)
    filled, existing = gap_fill_documents(meeting, str(folder))
    assert [d.category for d in filled.documents] == ["Minutes"]
    assert [l["Type"] for l in filled.meta["escribe_meeting"]["MeetingLinks"]] == ["PostMinutes"]
    assert existing == [str(folder / "Agenda" / "SDAC - Agenda Package.pdf")]
    assert not is_foreign_folder(str(tmp_path / "2026-11-09 700pm X [37b8f3c9]"), SDAC_ID)


def test_download_source_documents_never_adds_second_agenda(tmp_path):
    archiver = _archiver()
    folder = tmp_path / "2025-11-10 700pm Sustainable Development Advisory Committee [gx-14d5d472]"
    (folder / "Agenda").mkdir(parents=True)
    (folder / "Agenda" / "pkg.pdf").write_bytes(b"%PDF-1.4")
    meeting = _meeting("Sustainable Development Advisory Committee", SDAC_ID,
                       docs=[ScrapedDocument("Agenda", "https://x/a.pdf", "Agenda")])
    archiver.scraper.download_documents.return_value = []
    paths = archiver.download_source_documents(meeting, str(folder))
    sent = archiver.scraper.download_documents.call_args.args[0]
    assert sent.documents == [] and paths == [str(folder / "Agenda" / "pkg.pdf")]


def _video(guid, title):
    return {"url": f"https://x/Players/ISIStandAlonePlayer.aspx?Id={guid}", "title": title, "uri": guid}


def test_video_goes_only_to_the_folder_with_that_meeting_id(tmp_path):
    council_video = _video(COUNCIL_ID, "2026-11-09 Council Meeting")
    sdac_video = _video(SDAC_ID, "2026-11-09 Sustainable Development Advisory Committee")
    council = tmp_path / "2026-11-09 700pm Regular Council [6c32f0ce]"
    imported = tmp_path / "2026-11-09 700pm Sustainable Development Advisory Committee [gx-14d5d472]"
    (imported / "Video").mkdir(parents=True)
    (imported / "Video" / "player.url").write_text(sdac_video["url"])
    videos = [council_video, sdac_video]
    assert select_video(str(council), videos, folder_source_ids(str(council)), set()) is council_video
    assert select_video(str(imported), videos, folder_source_ids(str(imported)), set()) is sdac_video
    # An ID-less imported folder on a day with one other meeting's video takes nothing.
    bare = tmp_path / "2026-11-09 700pm Protective Services Committee [gx-00000000]"
    assert select_video(str(bare), [council_video], set(), {"6c32f0ce"}) is None
    assert select_video(str(bare), [council_video], set(), set()) is None  # different body
    # Known IDs from source_meetings identify a folder too.
    known = {os.path.normpath(str(bare)): {SDAC_ID}}
    assert folder_source_ids(str(bare), known) == {SDAC_ID}


def test_vimeo_style_videos_keep_title_matching(tmp_path):
    videos = [{"title": "Regular Council Jan 10", "uri": "/videos/1"}, {"title": "Public Hearing Jan 10", "uri": "/videos/2"}]
    assert select_video(str(tmp_path / "2023-01-10 Public Hearing"), videos, set(), set()) is videos[1]


def _row(mid, title, mtype, org):
    return {"id": mid, "meeting_date": "2026-11-09", "title": title, "type": mtype, "archive_path": "archive/x",
            "organization": {"name": org}}


def test_same_body_is_generous_for_committees_and_strict_on_kind():
    sdac = _meeting("Sustainable Development Advisory Committee", SDAC_ID)
    assert same_body(sdac, _row(1, "Sustainable Development Advisory Committee", "Advisory Committee", "Advisory Committee"))
    assert same_body(sdac, _row(2, "Advisory Committee", "Advisory Committee", "Advisory Committee"))
    assert not same_body(sdac, _row(3, "Sustainable Development Advisory Committee – Special", "Advisory Committee",
                                    "Sustainable Development Advisory Committee"))
    assert not same_body(sdac, _row(4, "Community Advisory Committee", "Advisory Committee", "Community Advisory Committee"))
    bov = _meeting("Board of Variance", "ce032961-d6eb-4546-86ba-408e15e47e8e", meeting_type="Board of Variance")
    assert same_body(bov, _row(5, "Board of Variance", "Regular Council", "Council"))  # misfiled, still caught
    council = ScrapedMeeting(date=date(2026, 11, 9), title="Council Meeting", meeting_type="Regular Council",
                             source_id=COUNCIL_ID, meta={"escribe_meeting": {"MeetingType": "Council Meeting"}})
    assert same_body(council, _row(6, "Regular Council", "Regular Council", "Council"))
    assert not same_body(council, _row(7, "Special Council", "Special Council", "Council"))
    assert not same_body(council, _row(8, "Board of Variance", "Regular Council", "Council"))


def test_guard_ignores_meetings_linked_to_other_ids():
    guard = DuplicateGuard(MagicMock(), 1)
    guard.by_date = {"2026-11-09": [_row(1, "Sustainable Development Advisory Committee", "Advisory Committee",
                                         "Sustainable Development Advisory Committee")]}
    sdac = _meeting("Sustainable Development Advisory Committee", SDAC_ID)
    assert [r["id"] for r in guard.conflicts(sdac)] == [1]
    guard.linked[1] = {"aaaaaaaa-other"}
    assert guard.conflicts(sdac) == []


def test_blocked_meeting_gets_no_folder_or_archive_path():
    archiver = _archiver()
    sdac = _meeting("Sustainable Development Advisory Committee", SDAC_ID)
    guard = MagicMock()
    guard.load.return_value.conflicts.return_value = [{"id": 898}]
    from pipeline.scrapers.escribe import EscribeScraper
    archiver.scraper = MagicMock(spec=EscribeScraper)
    archiver.scraper.discover_meetings.return_value = [sdac]
    with patch.object(archiver, "_get_admin_supabase", return_value=MagicMock()), \
            patch.object(archiver, "_pin_known_archive_paths"), \
            patch("pipeline.orchestrator.DuplicateGuard", return_value=guard), \
            patch("pipeline.orchestrator.upsert_source_meetings") as upsert:
        plan = archiver._sync_documents(dry_run=True)
        assert plan[SDAC_ID]["action"] == "blocked" and not upsert.called
        archiver._sync_documents()
    archiver.scraper.download_documents.assert_not_called()
    records = upsert.call_args.args[3]
    assert records[0]["archive_path"] is None


def test_linked_meeting_syncs_into_pinned_folder():
    archiver = _archiver()
    sdac = _meeting("Sustainable Development Advisory Committee", SDAC_ID)
    pinned = "archive/langford/Sustainable Development Advisory Committee/2026/11/x [gx-14d5d472]"
    archiver._pinned_archive_paths = {SDAC_ID: pinned}
    plan = archiver.plan_source_sync([sdac])
    assert plan[SDAC_ID]["action"] == "linked" and plan[SDAC_ID]["foreign_folder"]
    assert plan[SDAC_ID]["archive_root"] == os.path.join(BASE_DIR, pinned)


def test_named_advisory_committees_get_their_own_organization():
    from pipeline.ingestion.ingester import MeetingIngester

    ingester = MeetingIngester.__new__(MeetingIngester)
    assert ingester.map_type_to_org("Advisory Committee", "Sustainable Development Advisory Committee – Special") == (
        "Sustainable Development Advisory Committee", "Committee")
    assert ingester.map_type_to_org("Advisory Committee", "Advisory Committee") == ("Advisory Committee", "Advisory Committee")
    assert ingester.map_type_to_org("Advisory Committee") == ("Advisory Committee", "Advisory Committee")
