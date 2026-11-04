from types import SimpleNamespace

from pipeline.ingestion.matter_resolver import load_records


class _Query:
    """Chainable stand-in for a supabase-py select; returns all rows on the first page."""

    def __init__(self, rows):
        self._rows = rows

    def __getattr__(self, _name):
        return lambda *args, **kwargs: self

    @property
    def not_(self):
        return self

    def range(self, start, end):
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=self._rows[start : end + 1]))


class _Supabase:
    def __init__(self, tables):
        self._tables = tables

    def table(self, name):
        return _Query(self._tables.get(name, []))


def _matter(id, title, merged_into=None, **meta):
    return {
        "id": id,
        "title": title,
        "identifier": None,
        "category": None,
        "first_seen": "2020-01-01",
        "last_seen": "2020-01-01",
        "meta": meta,
        "embedding": None,
        "merged_into": merged_into,
    }


def test_load_records_skips_merged_and_hidden_matters():
    supabase = _Supabase(
        {
            "matters": [
                _matter(97, "Bylaw No. 1678 Rezoning 2681 Claude Rd"),
                _matter(293, "Bylaws (First Readings and Adoption)", hidden="container"),
                _matter(300, "No records", hidden="no_records"),
                _matter(412, "TUP16-0006 Renewal", merged_into=738),
                _matter(738, "TUP16-0006 Group Day Care"),
            ],
            "agenda_items": [
                # merge_matters moved the merged matter's items onto the canonical
                {"matter_id": 738, "title": "Renewal", "plain_english_summary": "", "related_address": None,
                 "meetings": {"meeting_date": "2019-05-01"}},
            ],
        }
    )

    records = load_records(supabase)

    assert sorted(records) == [97, 738]
    # The merged matter's history is the canonical's own.
    assert [i["title"] for i in records[738].items] == ["Renewal"]
