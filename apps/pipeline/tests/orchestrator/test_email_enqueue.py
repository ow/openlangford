"""Only the scoped alert key is used, and enqueue is safe to retry."""
from unittest.mock import Mock, patch

from pipeline.orchestrator import Archiver


def test_email_enqueue_skips_without_scoped_credential():
    archiver = Archiver.__new__(Archiver)
    with patch('pipeline.orchestrator.config.ALERT_WORKER_KEY', None), patch('pipeline.orchestrator.requests.post') as post:
        archiver._trigger_alerts(42)
    post.assert_not_called()


def test_email_enqueue_transmits_only_scoped_key_and_records_no_response_body(capsys):
    archiver = Archiver.__new__(Archiver)
    response = Mock(ok=False, status_code=401, text='never log provider or credential details')
    with patch('pipeline.orchestrator.config.ALERT_WORKER_KEY', 'synthetic-alert-key'), patch('pipeline.orchestrator.config.SUPABASE_URL', 'https://example.invalid'), patch('pipeline.orchestrator.requests.post', return_value=response) as post:
        archiver._trigger_alerts(42)
    post.assert_called_once_with('https://example.invalid/functions/v1/send-alerts', headers={'X-Alert-Worker-Key': 'synthetic-alert-key', 'Content-Type': 'application/json'}, json={'action': 'enqueue', 'meeting_id': 42}, timeout=30)
    assert 'never log' not in capsys.readouterr().out
