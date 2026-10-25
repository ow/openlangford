"""Ingested eSCRIBE meetings keep their archive folder when the folder date derivation changes."""
import os
from datetime import date
from unittest.mock import MagicMock, patch

from pipeline.orchestrator import Archiver
from pipeline.paths import BASE_DIR
from pipeline.scrapers.base import MunicipalityConfig, ScrapedMeeting


def _archiver():
    muni = MunicipalityConfig(7, 'langford', 'Langford', 'Langford', {'type': 'escribe', 'base_url': 'https://example.org'})
    with patch('pipeline.orchestrator.get_scraper'), patch('pipeline.orchestrator.get_video_client'):
        return Archiver(municipality=muni, initialize_diarizer=False)


def _meeting(source_id):
    return ScrapedMeeting(
        date=date(2022, 11, 21), title='Special Council Meeting', meeting_type='Special Council',
        organization_name='Langford', source_id=source_id, meta={'escribe_meeting': {'MeetingTime': '7:00 PM'}},
    )


def test_ingested_meeting_keeps_old_folder_and_new_meeting_uses_corrected_date():
    archiver = _archiver()
    old = 'archive/langford/Council/2022/11/2022-11-22 700pm Special Council [c145d400]'
    client = MagicMock()
    client.table.return_value.select.return_value.eq.return_value.eq.return_value.in_.return_value.execute.return_value.data = [
        {'source_id': 'c145d400-baac-4605-b637-c12a5b994320', 'archive_path': old, 'ingested_meeting_id': 173},
        {'source_id': 'never-ingested-0000', 'archive_path': 'archive/langford/Council/x', 'ingested_meeting_id': None},
    ]
    known, fresh, unknown = _meeting('c145d400-baac-4605-b637-c12a5b994320'), _meeting('never-ingested-0000'), _meeting('brand-new-source')
    with patch.object(archiver, '_get_admin_supabase', return_value=client):
        archiver._pin_known_archive_paths([known, fresh, unknown])

    assert archiver._meeting_archive_root(known) == os.path.join(BASE_DIR, old)
    assert archiver._meeting_archive_path_for_db(known) == old
    for other in (fresh, unknown):
        assert os.path.basename(archiver._meeting_archive_root(other)).startswith('2022-11-21 700pm Special Council [')
