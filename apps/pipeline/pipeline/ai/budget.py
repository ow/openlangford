"""Fitting model inputs to the context window without cutting the evidence.

Source text (motions, reports, minutes, transcripts) is never trimmed to fit: a model that sees part of a report
flags true figures as unconfirmed, or writes around them. Instead, work is grouped into requests by measured size:
``pack`` fills each request up to the input budget, and a single piece that can't fit on its own is reported, not
silently shortened.
"""
from __future__ import annotations

import json as _json
from typing import Any, Callable, Iterable, TypeVar

T = TypeVar("T")

# Characters of input per request. About 4 characters a token: 1,000,000 characters is roughly 250,000 tokens, under
# the 272,000-token prompt size above which the review model's price per token goes up, and well inside its window.
INPUT_BUDGET_CHARS = 1_000_000


class TooLarge(ValueError):
    """One piece of work is larger than a request can hold."""


def size(value: Any) -> int:
    """Characters ``value`` takes as prompt text (JSON for structures)."""
    return len(value) if isinstance(value, str) else len(_json.dumps(value, ensure_ascii=False, default=str))


def pack(pieces: Iterable[T], *, budget: int = INPUT_BUDGET_CHARS, measure: Callable[[T], int] = size,
         max_count: int | None = None) -> list[list[T]]:
    """Group ``pieces`` (in order) into batches whose total size stays within ``budget`` (and at most ``max_count``
    pieces each). A piece larger than the budget on its own raises ``TooLarge``."""
    batches: list[list[T]] = []
    current: list[T] = []
    used = 0
    for piece in pieces:
        n = measure(piece)
        if n > budget:
            raise TooLarge(f"one piece is {n:,} characters, over the {budget:,}-character input budget")
        if current and (used + n > budget or (max_count and len(current) >= max_count)):
            batches.append(current)
            current, used = [], 0
        current.append(piece)
        used += n
    if current:
        batches.append(current)
    return batches
