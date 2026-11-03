"""Pipeline AI layer: one client, one retry policy, house rules in one place.

Call sites use the module-level helpers, which delegate to the default
client (swap it in tests with ``set_client``)::

    from pipeline import ai

    summary = ai.json(prompt, stage="extraction", schema=MatterSummaries, system=SYSTEM)
"""

from __future__ import annotations

from typing import Any, Iterable, Sequence

from pipeline.ai.client import (
    HOUSE_RULES,
    AIClient,
    RetryPolicy,
    choice,
    get_client,
    predicate,
    set_client,
    with_house_rules,
)
from pipeline.ai.config import StageConfig, is_configured, resolve
from pipeline.ai.errors import AIConfigError, AIError, AIRequestError, AIResponseError
from pipeline.ai.usage import UsageRecord, set_usage_hook, usage_context

__all__ = [
    "AIClient",
    "AIConfigError",
    "AIError",
    "AIRequestError",
    "AIResponseError",
    "HOUSE_RULES",
    "RetryPolicy",
    "StageConfig",
    "UsageRecord",
    "choice",
    "decide",
    "decide_many",
    "embed",
    "get_client",
    "is_configured",
    "json",
    "pdf",
    "predicate",
    "resolve",
    "set_client",
    "set_usage_hook",
    "text",
    "transcribe",
    "usage_context",
    "with_house_rules",
]


def text(prompt: str, *, stage: str, system: str | None = None) -> str:
    return get_client().text(prompt, stage=stage, system=system)


def json(prompt: str, *, stage: str, schema: Any, system: str | None = None) -> Any:
    return get_client().json(prompt, stage=stage, schema=schema, system=system)


def pdf(path: str, prompt: str, *, stage: str = "document", schema: Any = None, system: str | None = None,
        images: Sequence[Any] | None = None) -> Any:
    return get_client().pdf(path, prompt, stage=stage, schema=schema, system=system, images=images)


def decide(input: str, questions: list[dict], *, stage: str = "decisions", images: Sequence[Any] | None = None) -> dict:
    return get_client().decide(input, questions, stage=stage, images=images)


def decide_many(items: Iterable[tuple], *, stage: str = "decisions", workers: int = 8) -> list:
    return get_client().decide_many(items, stage=stage, workers=workers)


def embed(texts: Sequence[str], *, stage: str = "embedding") -> list[list[float]]:
    return get_client().embed(texts, stage=stage)


def transcribe(audio_path: str, *, stage: str = "asr", model: str | None = None, max_attempts: int | None = None,
               timeout: float | None = None, **options):
    return get_client().transcribe(
        audio_path, stage=stage, model=model, max_attempts=max_attempts, timeout=timeout, **options
    )

from pipeline.ai.budget import INPUT_BUDGET_CHARS, TooLarge, pack  # noqa: E402  (fitting inputs to the context window)
