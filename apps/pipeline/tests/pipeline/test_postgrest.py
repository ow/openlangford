"""Paging, chunked reads and bulk upserts against a fake supabase client (no network)."""

from types import SimpleNamespace

from pipeline.postgrest import bulk_upsert, chunked, in_chunks, paginate


class FakeQuery:
    def __init__(self, table, rows):
        self.table, self.rows, self.window, self.upserted = table, rows, None, None

    def range(self, start, end):
        self.window = (start, end)
        self.table.ranges.append((start, end))
        return self

    def in_(self, col, ids):
        self.rows = [r for r in self.rows if r[col] in ids]
        return self

    def upsert(self, rows, **kw):
        self.table.upserts.append((rows, kw))
        return self

    def execute(self):
        rows = self.rows if self.window is None else self.rows[self.window[0] : self.window[1] + 1]
        return SimpleNamespace(data=rows)


class FakeTable:
    def __init__(self, rows):
        self.rows, self.ranges, self.upserts = rows, [], []

    def query(self):
        return FakeQuery(self, self.rows)


class FakeClient:
    def __init__(self, rows=()):
        self.t = FakeTable(list(rows))

    def table(self, name):
        self.t.name = name
        return self.t.query()


def rows(n):
    return [{"id": i} for i in range(n)]


def test_paginate_reads_until_short_page():
    c = FakeClient(rows(25))
    assert paginate(lambda: c.table("x"), page_size=10) == rows(25)
    assert c.t.ranges == [(0, 9), (10, 19), (20, 29)]


def test_paginate_exact_multiple_needs_one_empty_page():
    c = FakeClient(rows(20))
    assert len(paginate(lambda: c.table("x"), page_size=10)) == 20
    assert c.t.ranges[-1] == (20, 29)


def test_paginate_empty_and_none_data():
    assert paginate(lambda: FakeClient([]).table("x")) == []

    class NoData:
        def range(self, *a):
            return self

        def execute(self):
            return SimpleNamespace(data=None)

    assert paginate(lambda: NoData()) == []


def test_chunked():
    assert list(chunked([1, 2, 3, 4, 5], 2)) == [[1, 2], [3, 4], [5]]
    assert list(chunked([], 2)) == []


def test_in_chunks_concatenates_and_chunks():
    c = FakeClient(rows(10))
    seen = []

    def build(chunk):
        seen.append(chunk)
        return c.table("x").in_("id", chunk)

    assert in_chunks(build, [1, 2, 3, 4, 5], size=2) == [{"id": i} for i in [1, 2, 3, 4, 5]]
    assert seen == [[1, 2], [3, 4], [5]]
    assert in_chunks(build, []) == []


def test_in_chunks_paged_reads_every_page_of_each_chunk():
    c = FakeClient(rows(10))
    got = in_chunks(lambda ch: c.table("x").in_("id", ch), list(range(10)), size=10, paged=True)
    assert got == rows(10)
    assert c.t.ranges  # went through paginate


def test_bulk_upsert_chunks_and_passes_on_conflict():
    c = FakeClient()
    assert bulk_upsert(c, "t", rows(5), on_conflict="id", chunk=2) == 5
    assert [len(r) for r, _ in c.t.upserts] == [2, 2, 1]
    assert all(kw == {"on_conflict": "id"} for _, kw in c.t.upserts)


def test_bulk_upsert_without_on_conflict_and_empty():
    c = FakeClient()
    assert bulk_upsert(c, "t", rows(3)) == 3
    assert c.t.upserts[0][1] == {}
    assert bulk_upsert(c, "t", []) == 0
