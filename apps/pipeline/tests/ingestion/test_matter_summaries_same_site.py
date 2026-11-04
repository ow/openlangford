from types import SimpleNamespace

from pipeline.ingestion.matter_summaries import _same_site


class _Query:
    """Just the PostgREST filters _same_site uses, applied to in-memory rows."""

    def __init__(self, rows):
        self.rows = list(rows)
        self._negate = False

    def select(self, *_a):
        return self

    def order(self, *_a):
        return self

    def in_(self, col, values):
        self.rows = [r for r in self.rows if r.get(col) in set(values)]
        return self

    def eq(self, col, value):
        self.rows = [r for r in self.rows if r.get(col, False) == value]
        return self

    def neq(self, col, value):
        self.rows = [r for r in self.rows if r.get(col) != value]
        return self

    @property
    def not_(self):
        self._negate = True
        return self

    def is_(self, col, _null):
        self.rows = [r for r in self.rows if (r.get(col) is not None) == self._negate]
        return self

    def range(self, start, end):
        self.rows = self.rows[start : end + 1]
        return self

    def execute(self):
        return SimpleNamespace(data=self.rows)


class _Supabase:
    def __init__(self, tables):
        self.tables = tables

    def table(self, name):
        return _Query(self.tables[name])


def test_same_site_lists_the_other_application_for_the_land_but_not_lists_of_many_lots():
    # 887 Klahanie Drive: rezoned for six lots (10), again for 11 lots (11); a tax-exemption list (12) names it among
    # five other lots; a resident's home next door (hidden lot 2) never links anything.
    properties = [{"id": 1, "civic_number": "887", "hidden": False}, {"id": 2, "civic_number": "889", "hidden": True},
                  *[{"id": i, "civic_number": f"{i}00", "hidden": False} for i in range(3, 8)]]
    links = [{"matter_id": 10, "property_id": 1}, {"matter_id": 11, "property_id": 1}, {"matter_id": 12, "property_id": 1},
             *[{"matter_id": 12, "property_id": i} for i in range(3, 8)],
             {"matter_id": 10, "property_id": 2}, {"matter_id": 13, "property_id": 2}]
    matters = [
        {"id": 10, "title": "Rezoning", "meta": {"display_title": "Six lots"}, "first_seen": "2018-11-06", "last_seen": "2019-07-15"},
        {"id": 11, "title": "Bylaw 1982", "meta": {"display_title": "11 lots"}, "first_seen": "2021-06-14", "last_seen": "2021-09-07"},
        {"id": 12, "title": "Tax exemptions", "meta": {}, "first_seen": "2020-01-01", "last_seen": "2020-02-01"},
        {"id": 13, "title": "Fence variance", "meta": {}, "first_seen": "2022-01-01", "last_seen": "2022-01-01"},
    ]
    sb = _Supabase({"properties": properties, "property_links": [{**l, "hidden": False} for l in links], "matters": matters})
    found = _same_site(sb, [10, 11, 12])
    assert found == {
        10: [{"title": "11 lots", "dates": "2021-06-14 to 2021-09-07"}],
        11: [{"title": "Six lots", "dates": "2018-11-06 to 2019-07-15"}],
    }
