"""Usage hook: one record per model call.

The default hook only debug-logs. ``pipeline.ai.usage_sink.install_usage_logging``
adds a hook that batches records into the ``ai_usage`` table.

``usage_context(job=..., meeting_id=..., pipeline_job_id=...)`` labels every record made inside it
(the stage runner sets ``job`` to the registry stage name; the worker sets ``pipeline_job_id``).
"""

from __future__ import annotations

import contextlib
import contextvars
import logging
import time
from dataclasses import asdict, dataclass, field
from typing import Callable, Iterator

logger = logging.getLogger("pipeline.ai.usage")


@dataclass
class UsageRecord:
    stage: str
    model: str
    operation: str  # text | json | pdf | embed | decide | transcribe
    input_tokens: int | None
    output_tokens: int | None
    latency_ms: int
    ok: bool
    error: str | None = None
    attempts: int = 1
    job: str | None = None
    meeting_id: int | None = None
    pipeline_job_id: int | None = None
    created_at: float = field(default_factory=time.time)

    def as_dict(self) -> dict:
        return asdict(self)


UsageHook = Callable[[UsageRecord], None]


def _default_hook(record: UsageRecord) -> None:
    logger.debug("ai usage %s", record.as_dict())


_hook: UsageHook = _default_hook


def set_usage_hook(hook: UsageHook | None) -> UsageHook:
    """Install a usage hook (None restores the default). Returns the previous hook."""
    global _hook
    previous = _hook
    _hook = hook or _default_hook
    return previous


# Labels for records. A ContextVar for correctness within a thread, plus a
# process-wide fallback so worker threads (decide_many, image judging) started
# inside a usage_context still get the label.
_context: contextvars.ContextVar[dict | None] = contextvars.ContextVar("ai_usage_context", default=None)
_process_context: dict = {}


def current_context() -> dict:
    return _context.get() or _process_context


@contextlib.contextmanager
def usage_context(*, job: str | None = None, meeting_id: int | None = None,
                  pipeline_job_id: int | None = None) -> Iterator[None]:
    """Label usage records made inside this block (nested blocks inherit unset fields)."""
    global _process_context
    parent = current_context()
    merged = {
        "job": job if job is not None else parent.get("job"),
        "meeting_id": meeting_id if meeting_id is not None else parent.get("meeting_id"),
        "pipeline_job_id": pipeline_job_id if pipeline_job_id is not None else parent.get("pipeline_job_id"),
    }
    token = _context.set(merged)
    previous_process = _process_context
    _process_context = merged
    try:
        yield
    finally:
        _context.reset(token)
        _process_context = previous_process


def record_usage(record: UsageRecord) -> None:
    ctx = current_context()
    if record.job is None:
        record.job = ctx.get("job")
    if record.meeting_id is None:
        record.meeting_id = ctx.get("meeting_id")
    if record.pipeline_job_id is None:
        record.pipeline_job_id = ctx.get("pipeline_job_id")
    try:
        _hook(record)
    except Exception:  # a broken hook must never break a pipeline run
        logger.exception("usage hook failed")
