"""Persist AI usage records to the ``ai_usage`` table.

Records are buffered and inserted in batches by a background thread, so a
pipeline job never waits on (or fails because of) the usage insert. A failed
insert is logged and the batch dropped. Remaining records are flushed at
process exit (bounded wait).

    from pipeline.ai.usage_sink import install_usage_logging
    install_usage_logging()   # main.py / worker.py do this at startup

Disable with ``AI_USAGE_LOGGING=0``.
"""

from __future__ import annotations

import atexit
import logging
import os
import queue
import threading
from datetime import datetime, timezone
from typing import Any, Callable

from pipeline.ai import usage as ai_usage
from pipeline.ai.usage import UsageRecord

logger = logging.getLogger("pipeline.ai.usage_sink")

DEFAULT_BATCH_SIZE = 25
EXIT_FLUSH_TIMEOUT = 10.0
MAX_PENDING = 5000  # drop records rather than grow without bound if the DB is down


def to_row(record: UsageRecord) -> dict[str, Any]:
    return {
        "created_at": datetime.fromtimestamp(record.created_at, tz=timezone.utc).isoformat(),
        "source": "pipeline",
        "stage": record.stage,
        "operation": record.operation,
        "model": record.model,
        "input_tokens": record.input_tokens,
        "output_tokens": record.output_tokens,
        "latency_ms": record.latency_ms,
        "attempts": record.attempts,
        "ok": record.ok,
        "error": (record.error or None) and record.error[:2000],
        "meeting_id": record.meeting_id,
        "job": record.job,
        "pipeline_job_id": record.pipeline_job_id,
        "request_id": None,
    }


class SupabaseUsageSink:
    """A usage hook that batches rows into ``ai_usage``.

    ``client_factory`` builds the Supabase client lazily on the writer thread
    (supabase-py's sync client is not thread-safe, so it gets its own).
    """

    def __init__(
        self,
        client_factory: Callable[[], Any],
        *,
        batch_size: int = DEFAULT_BATCH_SIZE,
        background: bool = True,
    ):
        self._client_factory = client_factory
        self._client = None
        self.batch_size = max(1, batch_size)
        self._background = background
        self._lock = threading.Lock()
        self._buffer: list[dict] = []
        self._queue: queue.Queue = queue.Queue()
        self._thread: threading.Thread | None = None
        self.dropped = 0
        self.written = 0

    # The hook itself: cheap, never raises.
    def __call__(self, record: UsageRecord) -> None:
        try:
            row = to_row(record)
        except Exception:
            logger.debug("could not convert usage record", exc_info=True)
            return
        batch = None
        with self._lock:
            if len(self._buffer) >= MAX_PENDING:
                self.dropped += 1
                return
            self._buffer.append(row)
            if len(self._buffer) >= self.batch_size:
                batch, self._buffer = self._buffer, []
        if batch:
            self._submit(batch)

    def _submit(self, batch: list[dict]) -> None:
        if not self._background:
            self._write(batch)
            return
        self._ensure_thread()
        self._queue.put(batch)

    def _ensure_thread(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._run, name="ai-usage-sink", daemon=True)
            self._thread.start()

    def _run(self) -> None:
        while True:
            batch = self._queue.get()
            try:
                if batch is None:
                    return
                self._write(batch)
            finally:
                self._queue.task_done()

    def _write(self, batch: list[dict]) -> None:
        try:
            if self._client is None:
                self._client = self._client_factory()
            self._client.table("ai_usage").insert(batch).execute()
            self.written += len(batch)
        except Exception as exc:  # never let usage logging hurt a job
            self.dropped += len(batch)
            logger.warning("ai_usage insert failed (%d rows dropped): %s", len(batch), exc)

    def flush(self, timeout: float | None = None) -> None:
        """Write anything buffered and wait (up to ``timeout``) for pending writes."""
        with self._lock:
            batch, self._buffer = self._buffer, []
        if batch:
            self._submit(batch)
        if not self._background or self._thread is None:
            return
        done = threading.Event()

        def wait():
            self._queue.join()
            done.set()

        threading.Thread(target=wait, daemon=True).start()
        done.wait(timeout)

    def close(self, timeout: float = EXIT_FLUSH_TIMEOUT) -> None:
        self.flush(timeout)


_installed: SupabaseUsageSink | None = None


def _default_client_factory():
    from supabase import create_client

    from pipeline import config

    key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
    return create_client(config.SUPABASE_URL, key)


def install_usage_logging(*, batch_size: int | None = None) -> SupabaseUsageSink | None:
    """Install the DB usage hook (idempotent). Returns the sink, or None when disabled."""
    global _installed
    if _installed is not None:
        return _installed
    if os.environ.get("AI_USAGE_LOGGING", "1").strip().lower() in ("0", "false", "no", "off"):
        return None
    from pipeline import config

    if not config.SUPABASE_URL or not (config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY):
        return None
    sink = SupabaseUsageSink(
        _default_client_factory,
        batch_size=batch_size or int(os.environ.get("AI_USAGE_BATCH_SIZE", DEFAULT_BATCH_SIZE)),
    )
    previous = ai_usage.set_usage_hook(None)  # the default debug-log hook

    def hook(record: UsageRecord) -> None:
        previous(record)
        sink(record)

    ai_usage.set_usage_hook(hook)
    atexit.register(sink.close)
    _installed = sink
    return sink
