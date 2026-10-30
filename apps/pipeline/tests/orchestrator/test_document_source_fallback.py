"""A valid HTML source permits metadata ingestion, not a claim of PDF extraction."""
from unittest.mock import MagicMock, patch

import pytest
from pipeline.orchestrator import Archiver
from pipeline.scrapers.base import MunicipalityConfig


def _archiver(archive_root):
    muni = MunicipalityConfig(id=1, slug="test-town", name="Town of Test", short_name="Test",
                              source_config={"type": "civicweb", "base_url": "https://test.invalid"})
    with patch("pipeline.orchestrator.get_scraper"), patch("pipeline.orchestrator.get_video_client"), \
         patch("pipeline.orchestrator.get_municipality_archive_root", return_value=str(archive_root)):
        return Archiver(municipality=muni, initialize_diarizer=False)


@pytest.mark.parametrize('official', [True, False])
def test_html_agenda_reports_attachment_extraction_incomplete(tmp_path, official):
    folder=tmp_path/'Agenda'
    folder.mkdir()
    html='<h1 id="AgendaHeaderTitle">Council Agenda</h1><h2 id="AgendaItem1">1. Adoption</h2>' if official else '<title>Verifying your browser</title>'
    (folder/'Agenda.html').write_text(html)
    client=MagicMock()
    client.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data={'id':42,'archive_path':str(tmp_path)}
    with patch('pipeline.orchestrator.create_client',return_value=client), patch('pipeline.orchestrator.config.SUPABASE_URL','https://example.invalid'), patch('pipeline.orchestrator.config.SUPABASE_SECRET_KEY','test-key'):
        archiver=_archiver(tmp_path)
        if official:
            result=archiver.extract_documents_for_meeting(42)
            assert result['skipped']=='html_only_agenda'
            assert result['incomplete_attachment_extraction'] is True
            assert result['documents']==0
        else:
            with pytest.raises(ValueError,match='No agenda PDFs found'):
                archiver.extract_documents_for_meeting(42)


@pytest.mark.parametrize('throws',[True,False])
def test_targeted_ingest_propagates_refinement_failure(tmp_path, throws):
    with patch('pipeline.orchestrator.create_client'),patch('pipeline.orchestrator.config.SUPABASE_URL','https://example.invalid'),patch('pipeline.orchestrator.config.SUPABASE_SECRET_KEY','test-key'),patch('pipeline.ingestion.ingester.MeetingIngester') as ingester:
        if throws:
            ingester.return_value.process_meeting.side_effect=RuntimeError('AI refinement failed')
        else:
            ingester.return_value.process_meeting.return_value=None
        archiver=_archiver(tmp_path)
        with pytest.raises(RuntimeError,match='AI refinement failed|no completed ingestion result'):
            archiver._ingest_meetings(target_folder=str(tmp_path), force_update=True)


@pytest.mark.parametrize("source_only", [True, False])
def test_ingest_schedules_alerts_and_profiles_only_for_enriched_content(tmp_path, source_only):
    result = {"meeting_id": 42, "meeting": {"has_minutes": True}, "source_only_refresh": source_only}
    archiver = _archiver(tmp_path)
    with patch("pipeline.orchestrator.config.SUPABASE_URL", "https://example.invalid"), \
         patch("pipeline.orchestrator.config.SUPABASE_SECRET_KEY", "test-only"), \
         patch("pipeline.ingestion.ingester.MeetingIngester") as ingester, \
         patch.object(archiver, "_trigger_alerts") as alerts:
        ingester.return_value.process_meeting.return_value = result
        assert archiver._ingest_meetings(target_folder="cached-meeting") == result
    assert archiver._ingested_meeting_ids == ([] if source_only else [42])
    assert alerts.called is (not source_only)
