"""Shared PostgREST (supabase-py) plumbing: paging, chunked ``.in_()`` reads, bulk upserts.

PostgREST caps a response at 1000 rows and long ``in.(...)`` lists overflow the request
URL, so reads that can exceed either go through these helpers instead of per-module loops.
"""

from __future__ import annotations

from typing import Any, Callable, Iterator, Sequence

PAGE_SIZE = 1000
IN_CHUNK = 200
UPSERT_CHUNK = 500


def paginate(build: Callable[[], Any], page_size: int = PAGE_SIZE) -> list[dict]:
    """Every row of a query, read page by page until a short page.

    ``build()`` returns a fresh supabase-py query that is already filtered and ordered;
    a new one is built for every page, and ``.range(start, end).execute()`` is applied here.
    The query MUST have a deterministic order (for example ``.order("id")``): with no
    stable order, offset paging can skip or repeat rows between pages. Not enforced.
    """
    rows: list[dict] = []
    while True:
        # Offset by rows read so far, not by a page counter, so the paging position
        # always matches what has actually been collected.
        page = build().range(len(rows), len(rows) + page_size - 1).execute().data or []
        rows.extend(page)
        if len(page) < page_size:
            return rows


def chunked(ids: Sequence, size: int = IN_CHUNK) -> Iterator[list]:
    """``ids`` in lists of at most ``size`` (nothing for an empty sequence)."""
    for start in range(0, len(ids), size):
        yield list(ids[start : start + size])


def in_chunks(
    build: Callable[[list], Any],
    ids: Sequence,
    size: int = IN_CHUNK,
    *,
    paged: bool = False,
) -> list[dict]:
    """Rows of ``build(chunk)`` for each chunk of ``ids``, concatenated.

    ``build(chunk)`` returns a supabase-py query using ``.in_(col, chunk)``. With
    ``paged=True`` each chunk's query is read through ``paginate`` (it must then be
    ordered), for chunks that can match more than 1000 rows.
    """
    rows: list[dict] = []
    for chunk in chunked(ids, size):
        if paged:
            rows.extend(paginate(lambda: build(chunk)))
        else:
            rows.extend(build(chunk).execute().data or [])
    return rows


def bulk_upsert(
    client: Any,
    table: str,
    rows: Sequence[dict],
    *,
    on_conflict: str | None = None,
    chunk: int = UPSERT_CHUNK,
) -> int:
    """Upsert ``rows`` into ``table`` in chunks; return the number of rows sent.

    A failing chunk raises, leaving earlier chunks written (same as any multi-request write).
    """
    sent = 0
    for part in chunked(rows, chunk):
        query = client.table(table).upsert(part, on_conflict=on_conflict) if on_conflict else client.table(table).upsert(part)
        query.execute()
        sent += len(part)
    return sent
