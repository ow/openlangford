"""Real local persistence and lifecycle; provider transport never sends mail."""
import sqlite3
from unittest.mock import Mock, patch

import pytest
import requests

from pipeline import config
from pipeline.email_outbox import EmailEnqueueOutbox, record_email_enqueue, retry_email_enqueues
from pipeline.orchestrator import Archiver


@pytest.fixture
def env(tmp_path, monkeypatch):
    path = str(tmp_path / "alerts.sqlite3")
    monkeypatch.setattr(config, 'ALERT_OUTBOX_PATH', path)
    monkeypatch.setattr(config, 'ALERT_WORKER_KEY', 'synthetic-alert-key')
    monkeypatch.setattr(config, 'SUPABASE_URL', 'https://example.invalid')
    clock = [10000.0]
    monkeypatch.setattr('pipeline.email_outbox.time.time', lambda: clock[0])
    return path, clock


def row(path):
    with sqlite3.connect(path) as db:
        db.row_factory = sqlite3.Row
        return dict(db.execute('SELECT * FROM email_enqueue_intents').fetchone())


def receipt(data=None, status=200):
    result = Mock(ok=200 <= status < 300, status_code=status,
                  text='never log provider or credential details')
    result.json.return_value = {'queued': 1} if data is None else data
    return result


def test_enqueue_waits_until_embedding_pass_and_transmits_only_scoped_key(env):
    path, _ = env
    archiver = Archiver.__new__(Archiver)
    archiver._ingested_meeting_ids = []
    ready = []
    def provider(*args, **kwargs):
        assert ready == [True]
        return receipt()
    with patch('pipeline.email_outbox.requests.post', side_effect=provider) as post, \
         patch('pipeline.stages.embed_tables', side_effect=lambda **_: ready.append(True)):
        archiver._after_meeting_ingested(42)
        assert row(path)['state'] == 'pending'
        post.assert_not_called()
        archiver._embed_new_content()
    post.assert_called_once_with('https://example.invalid/functions/v1/send-alerts',
        headers={'X-Alert-Worker-Key': 'synthetic-alert-key', 'Content-Type': 'application/json'},
        json={'action': 'enqueue', 'meeting_id': 42}, timeout=10, allow_redirects=False)
    assert row(path)['state'] == 'done'


def test_without_config_does_not_record_or_discover_work(env, monkeypatch):
    path, _ = env
    monkeypatch.setattr(config, 'ALERT_WORKER_KEY', None)
    with patch('pipeline.email_outbox.requests.post') as post:
        record_email_enqueue(42)
        assert retry_email_enqueues() == 0
    from pathlib import Path
    assert not Path(path).exists()
    post.assert_not_called()


@pytest.mark.parametrize('failure', [requests.Timeout('sensitive response'), receipt(status=503), receipt({'unexpected': True})])
def test_restart_retries_failed_enqueue_with_backoff_without_resetting_identity(env, failure, capsys):
    path, clock = env
    record_email_enqueue(42)
    with patch('pipeline.email_outbox.requests.post', side_effect=[failure, receipt({'queued': 0})]) as post:
        assert retry_email_enqueues() == 1
        first = row(path)
        assert first['state'] == 'pending' and first['attempts'] == 1
        assert retry_email_enqueues() == 0
        clock[0] += 60
        # Repeated ingestion and a new object/process cannot reset deadlines or identity.
        record_email_enqueue(42)
        assert EmailEnqueueOutbox(path).drain() == 1
        assert post.call_count == 2
    last = row(path)
    assert last['state'] == 'done' and last['attempts'] == 2
    assert last['created_at'] == first['created_at'] and last['expires_at'] == first['expires_at']
    assert 'sensitive response' not in capsys.readouterr().out
    assert 'never log' not in str(last)


@pytest.mark.parametrize('response,state', [(receipt(status=401), 'failed'), (receipt({'skipped': True}), 'skipped')])
def test_terminal_rejection_or_disabled_mode_is_not_replayed_after_restart(env, response, state):
    path, clock = env
    record_email_enqueue(42)
    with patch('pipeline.email_outbox.requests.post', return_value=response) as post:
        retry_email_enqueues()
        clock[0] += 3600
        record_email_enqueue(42)
        assert EmailEnqueueOutbox(path).drain() == 0
        assert post.call_count == 1
    assert row(path)['state'] == state


@pytest.mark.parametrize('by_deadline', [True, False])
def test_retry_window_and_attempt_cap_do_not_allow_historical_replay(env, by_deadline):
    path, clock = env
    record_email_enqueue(42)
    with patch('pipeline.email_outbox.requests.post', return_value=receipt(status=503)) as post:
        if by_deadline:
            clock[0] += 23 * 3600
        else:
            for _ in range(12):
                retry_email_enqueues()
                clock[0] = row(path)['next_attempt_at']
        assert retry_email_enqueues() == 0
        record_email_enqueue(42)
        assert retry_email_enqueues() == 0
        assert post.call_count == (0 if by_deadline else 12)
    assert row(path)['state'] == 'expired'


def test_two_processes_lease_once_and_stale_response_cannot_overwrite_receipt(env):
    path, clock = env
    record_email_enqueue(42)
    first, second = EmailEnqueueOutbox(path), EmailEnqueueOutbox(path)
    old = first.claim()
    assert second.claim() is None
    clock[0] += 121
    new = second.claim()
    second.finish(new, 'done')
    first.finish(old, 'pending', 'stale timeout')
    assert row(path)['state'] == 'done'
    assert row(path)['attempts'] == 2


def test_idle_worker_retries_intents_even_without_a_pipeline_job(env, monkeypatch):
    import worker
    path, _ = env
    record_email_enqueue(42)
    monkeypatch.setattr('sys.argv', ['worker.py', '--once'])
    with patch('pipeline.email_outbox.requests.post', return_value=receipt()) as post, \
         patch.object(worker, 'work_once', return_value=False), \
         patch('pipeline.ai.usage_sink.install_usage_logging', return_value=None):
        worker.main()
    post.assert_called_once()
    assert row(path)['state'] == 'done'


@pytest.mark.parametrize('forced', [False, True])
def test_failed_first_write_survives_cached_or_forced_retry_without_extending_deadline(env, tmp_path, forced):
    from contextlib import nullcontext
    from pathlib import Path
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    import worker

    path, clock = env
    Path(path).mkdir()  # Real first-write failure, after the domain ingestion committed.
    job = {'id': 71, 'job_type': 'ingest_meeting', 'municipality_id': 1,
           'args': {'meeting_id': 42, 'skip_diarization': True, 'force': forced}}
    client, meetings, jobs, archiver = MagicMock(), MagicMock(), MagicMock(), MagicMock()
    client.table.side_effect = lambda name: meetings if name == 'meetings' else jobs
    meetings.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
        {'id': 42, 'summary': 'Park plan', 'has_minutes': True, 'has_agenda': True}]
    meetings.select.return_value.eq.return_value.single.return_value.execute.return_value.data = {'id': 42, 'municipality_id': 1}
    persisted = []
    jobs.update.side_effect = lambda payload: persisted.append(payload) or jobs
    ingests = []
    def ingest(**kwargs):
        ingests.append(True)
        if len(ingests) == 1:
            record_email_enqueue(42)  # Persisted content, but the first local write fails.
        if forced:
            record_email_enqueue(42)  # Noncached ingestion must reuse the restored original clock.
            return {'meeting_id': 42, 'meeting': {'has_minutes': True}}
        return None  # On retry the normal ingester reports unchanged cached content.
    archiver._ingest_meetings.side_effect = ingest
    archiver._embed_new_content.side_effect = retry_email_enqueues
    def event(*args, **kwargs):
        if args[2] == 'Job failed':
            raise RuntimeError('Event transport unavailable')
    with patch.object(worker, 'get_supabase', return_value=client), \
         patch.object(worker, 'claim_job', side_effect=lambda *a, **k: job), \
         patch.object(worker, 'start_heartbeat', return_value=(MagicMock(), MagicMock())), \
         patch.object(worker, 'capture_job_output', side_effect=lambda *a: nullcontext()), \
         patch.object(worker, 'record_job_event', side_effect=event), \
         patch.object(worker, 'load_municipality_by_id', return_value=SimpleNamespace(id=1, slug='langford')), \
         patch.object(worker, 'Archiver', return_value=archiver), \
         patch.object(worker, '_resolve_archive_path', return_value=(str(tmp_path), 42, None)), \
         patch('pipeline.email_outbox.requests.post', return_value=receipt()) as post:
        assert worker.work_once('synthetic', 5)
        assert persisted[0]['status'] == 'failed'
        marker = persisted[0]['args']['email_enqueue_retry']
        assert marker == {'version': 1, 'meeting_id': 42, 'created_at': 10000.0, 'expires_at': 92800.0}
        clock[0] += 60
        # Even a second persistence failure must preserve the original deadline.
        job = {**job, 'id': 72, 'args': persisted[0]['args']}
        assert worker.work_once('synthetic', 5)
        assert persisted[-1]['status'] == 'failed'
        assert persisted[-1]['args']['email_enqueue_retry'] == marker
        Path(path).rmdir()
        clock[0] += 60
        job = {**job, 'id': 73, 'args': persisted[-1]['args']}
        assert worker.work_once('synthetic', 5)
        assert persisted[-1]['status'] == 'succeeded'
        assert persisted[-1]['result']['ingestion_skipped'] is (not forced)
        post.assert_called_once()
    assert row(path)['state'] == 'done'
    assert row(path)['created_at'] == marker['created_at']
    assert row(path)['expires_at'] == marker['expires_at']


@pytest.mark.parametrize('change', ['expired', 'wrong meeting', 'wrong municipality'])
def test_recovery_marker_cannot_extend_deadline_or_cross_canonical_identity(env, change):
    from unittest.mock import MagicMock
    import worker
    path, clock = env
    marker = {'version': 1, 'meeting_id': 42, 'created_at': clock[0], 'expires_at': clock[0] + 23 * 3600}
    job = {'job_type': 'ingest_meeting', 'municipality_id': 1, 'args': {'email_enqueue_retry': marker}}
    client = MagicMock()
    client.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data = {'id': 42, 'municipality_id': 2 if change == 'wrong municipality' else 1}
    if change == 'expired': clock[0] = marker['expires_at']
    with pytest.raises(ValueError):
        worker.restore_email_enqueue_retry(client, job, 43 if change == 'wrong meeting' else 42)
    from pathlib import Path
    assert not Path(path).exists()
