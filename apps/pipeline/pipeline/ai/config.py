"""Per-stage model configuration for the pipeline's AI client.

Every call names a *stage* (extraction, document, profile, embedding,
decisions, ...). Provider and model are resolved together for that stage:

    <STAGE>_AI_PROVIDER / <STAGE>_AI_MODEL   (e.g. EXTRACTION_AI_MODEL)
    AI_PROVIDER / AI_MODEL                   (pipeline-wide default)
    built-in default                         (openai / gpt-6-luna)

Embeddings use EMBEDDING_MODEL / EMBEDDING_DIMENSIONS (the stored vectors are
text-embedding-3-small @ 384 dims, so those are the defaults). The Decisions
API uses DECISIONS_MODEL.

Only the OpenAI provider is implemented. Asking for anything else is a
configuration error rather than a silent fallback.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

from pipeline.ai.errors import AIConfigError

load_dotenv()

DEFAULT_PROVIDER = "openai"
DEFAULT_MODEL = "gpt-6-luna"
DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
DEFAULT_EMBEDDING_DIMENSIONS = 384
DEFAULT_DECISIONS_MODEL = "gpt-6-luna"  # the only model the Decisions API supports (Nov 2026)
# Staff-facing judgments (link suggestions for the review bar): few calls, so the stronger model.
DEFAULT_REVIEW_MODEL = "gpt-6.1-terra"
# Public text residents read (topic summaries and headlines, meeting highlights): compared on 40 topics and 20
# meetings on 2026-11-03, Luna's first drafts had problems of fact on 17 topics and 4 meetings, Terra's on 3 and 1.
DEFAULT_WRITING_MODEL = "gpt-6.1-terra"
DEFAULT_ASR_MODEL = "gpt-4o-transcribe"

# Request timeouts (seconds). Long document/refinement calls can take minutes.
DEFAULT_TIMEOUT = 600.0
DEFAULT_EMBEDDING_TIMEOUT = 60.0
DEFAULT_DECISIONS_TIMEOUT = 120.0

SUPPORTED_PROVIDERS = {"openai"}

# Stage name -> env var prefix.
STAGE_PREFIX = {
    "rag": "RAG",
    "rerank": "RERANK",
    "extraction": "EXTRACTION",
    "document": "DOCUMENT",
    "profile": "PROFILE",
    "embedding": "EMBEDDING",
    "decisions": "DECISIONS",
    "review": "REVIEW",
    "writing": "WRITING",
    "asr": "ASR",
}


def _env(name: str) -> str | None:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else None


def _float_env(name: str, default: float) -> float:
    raw = _env(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise AIConfigError(f"{name} must be a number, got {raw!r}") from exc


@dataclass(frozen=True)
class StageConfig:
    stage: str
    provider: str
    model: str
    timeout: float
    dimensions: int | None = None  # embeddings only


def _provider_for(stage: str) -> str:
    prefix = STAGE_PREFIX.get(stage, stage.upper())
    provider = (
        _env(f"{prefix}_AI_PROVIDER")
        or (_env("EMBEDDING_PROVIDER") if stage == "embedding" else None)
        or _env("AI_PROVIDER")
        or DEFAULT_PROVIDER
    ).lower()
    if provider not in SUPPORTED_PROVIDERS:
        raise AIConfigError(
            f"Stage '{stage}' is configured for provider '{provider}', but only "
            f"{sorted(SUPPORTED_PROVIDERS)} is supported. Unset or change "
            f"{prefix}_AI_PROVIDER / AI_PROVIDER."
        )
    return provider


def resolve(stage: str) -> StageConfig:
    """Resolve provider, model and timeout for a stage."""
    provider = _provider_for(stage)
    timeout = _float_env("AI_TIMEOUT_SECONDS", DEFAULT_TIMEOUT)

    if stage == "embedding":
        raw_dims = _env("EMBEDDING_DIMENSIONS")
        try:
            dims = int(raw_dims) if raw_dims else DEFAULT_EMBEDDING_DIMENSIONS
        except ValueError as exc:
            raise AIConfigError(f"EMBEDDING_DIMENSIONS must be an integer, got {raw_dims!r}") from exc
        return StageConfig(
            stage=stage,
            provider=provider,
            model=_env("EMBEDDING_MODEL") or DEFAULT_EMBEDDING_MODEL,
            timeout=_float_env("AI_EMBEDDING_TIMEOUT_SECONDS", DEFAULT_EMBEDDING_TIMEOUT),
            dimensions=dims,
        )

    if stage == "decisions":
        return StageConfig(
            stage=stage,
            provider=provider,
            model=_env("DECISIONS_MODEL") or DEFAULT_DECISIONS_MODEL,
            timeout=_float_env("AI_DECISIONS_TIMEOUT_SECONDS", DEFAULT_DECISIONS_TIMEOUT),
        )

    if stage == "asr":
        return StageConfig(
            stage=stage,
            provider=provider,
            model=_env("ASR_AI_MODEL") or DEFAULT_ASR_MODEL,
            timeout=timeout,
        )

    prefix = STAGE_PREFIX.get(stage, stage.upper())
    if stage == "review":  # its own default, not the site-wide AI_MODEL
        return StageConfig(stage=stage, provider=provider, model=_env("REVIEW_AI_MODEL") or DEFAULT_REVIEW_MODEL, timeout=timeout)
    if stage == "writing":  # likewise
        return StageConfig(stage=stage, provider=provider, model=_env("WRITING_AI_MODEL") or DEFAULT_WRITING_MODEL, timeout=timeout)
    model = _env(f"{prefix}_AI_MODEL") or _env("AI_MODEL") or _env("OPENAI_MODEL") or DEFAULT_MODEL
    return StageConfig(stage=stage, provider=provider, model=model, timeout=timeout)


def is_configured(stage: str = "extraction") -> bool:
    """True when the stage's provider resolves and has an API key."""
    try:
        resolve(stage)
    except AIConfigError:
        return False
    return bool(_env("OPENAI_API_KEY"))
