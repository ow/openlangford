import json

import pytest

from pipeline import stages
from pipeline.ai.providers.base import GenerateResult
from pipeline.ingestion import property_summaries as ps
from pipeline.stages import StageContext


class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table, self.filters, self.payload = db, table, {}, None

    def select(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def range(self, start, end):
        self.window = (start, end)
        return self

    def eq(self, column, value):
        self.filters[column] = value
        return self

    def in_(self, column, values):
        self.filters[column] = set(values)
        return self

    def update(self, payload):
        self.payload = payload
        return self

    def execute(self):
        class Result:
            pass

        result = Result()
        if self.payload is not None:
            self.db.updates.append((self.table, self.filters.get("id"), self.payload))
            result.data = []
            return result
        rows = self.db.rows[self.table]
        for column, value in self.filters.items():
            rows = [r for r in rows if (r.get(column) in value if isinstance(value, set) else r.get(column) == value)]
        start, end = getattr(self, "window", (0, len(rows)))
        result.data = rows[start:end + 1]
        return result


class FakeDB:
    def __init__(self, **rows):
        self.rows, self.updates = rows, []

    def table(self, name):
        return FakeQuery(self, name)


def _db(meta_by_property=None):
    meta_by_property = meta_by_property or {}
    return FakeDB(
        properties=[
            {"id": 1, "slug": "100-main-road", "address": "100 Main Road", "civic_number": "100", "meta": meta_by_property.get(1)},
            {"id": 2, "slug": "200-main-road", "address": "200 Main Road", "civic_number": "200", "meta": meta_by_property.get(2)},
            {"id": 3, "slug": "main-road", "address": "Main Road", "civic_number": "", "meta": meta_by_property.get(3)},
            {"id": 4, "slug": "300-main-road", "address": "300 Main Road", "civic_number": "300", "meta": meta_by_property.get(4)},
        ],
        property_links=[
            # 1: two matters (one via two items) and a loose item -> 3 records
            {"property_id": 1, "matter_id": 10, "agenda_item_id": 100, "hidden": False},
            {"property_id": 1, "matter_id": 10, "agenda_item_id": 101, "hidden": False},
            {"property_id": 1, "matter_id": 11, "agenda_item_id": None, "hidden": False},
            {"property_id": 1, "matter_id": None, "agenda_item_id": 102, "hidden": False},
            # 2: one visible matter; the second link is hidden by an admin -> 1 record
            {"property_id": 2, "matter_id": 12, "agenda_item_id": 103, "hidden": False},
            {"property_id": 2, "matter_id": 13, "agenda_item_id": 104, "hidden": True},
            # 3: street with two loose items -> 2 records
            {"property_id": 3, "matter_id": None, "agenda_item_id": 105, "hidden": False},
            {"property_id": 3, "matter_id": None, "agenda_item_id": 106, "hidden": False},
            # 4: a matter merged into another plus a visible one -> 1 record
            {"property_id": 4, "matter_id": 14, "agenda_item_id": None, "hidden": False},
            {"property_id": 4, "matter_id": 15, "agenda_item_id": None, "hidden": False},
        ],
        matters=[
            {"id": 10, "canonical": None, "hidden": None, "title": "Bylaw No. 300 Amendment No. 769 (100 Main Rd)",
             "category": "Rezoning", "status": "Adopted", "first_seen": "2016-03-01", "last_seen": "2018-05-01",
             "plain_english_summary": "Rezoning for a six-storey mixed-use building.", "meta": {"display_title": "100 Main Road rezoning"}},
            {"id": 11, "canonical": None, "hidden": None, "title": "Development permit", "category": "Development",
             "status": "Approved", "first_seen": "2019-01-01", "last_seen": "2019-01-01",
             "plain_english_summary": "x" * 900, "meta": {}},
            {"id": 12, "canonical": None, "hidden": None, "title": "Variance", "meta": {}},
            {"id": 13, "canonical": None, "hidden": None, "title": "Hidden link", "meta": {}},
            {"id": 14, "canonical": "15", "hidden": None, "title": "Merged duplicate", "meta": {}},
            {"id": 15, "canonical": None, "hidden": None, "title": "Real one", "meta": {}},
        ],
        agenda_items=[
            {"id": 102, "title": "Road dedication along Main Road", "plain_english_summary": "Land for road widening.",
             "meetings": {"meeting_date": "2021-06-07"}},
            {"id": 105, "title": "Main Road paving", "plain_english_summary": "", "meetings": {"meeting_date": "2020-01-01"}},
            {"id": 106, "title": "Main Road closure", "plain_english_summary": "", "meetings": {"meeting_date": "2022-01-01"}},
        ],
    )


def _summary(text):
    return GenerateResult(text=json.dumps({"summary": text}))


class TestSelection:
    def test_records_count_distinct_matters_and_loose_items_excluding_hidden_and_merged(self):
        props = {p["id"]: p for p in ps.load_properties(_db())}
        assert props[1]["records"] == ["i102", "m10", "m11"]
        assert props[2]["records"] == ["m12"]
        assert props[3]["records"] == ["i105", "i106"]
        assert props[4]["records"] == ["m15"]
        assert [i for i, p in props.items() if ps.eligible(p)] == [1, 3]

    def test_record_keys_skips_hidden_links_even_unfiltered(self):
        links = [{"matter_id": 1, "hidden": True}, {"matter_id": None, "agenda_item_id": 7, "hidden": False}]
        assert ps.record_keys(links) == ["i7"]

    def test_dry_run_lists_only_properties_with_two_or_more_records_and_calls_no_model(self, fake_ai, capsys):
        db = _db()
        result = stages.run_property_summaries(StageContext(supabase=db, dry_run=True))
        assert result == {"properties": 2, "clear": 0}
        assert "properties to summarize: 2: 1, 3" in capsys.readouterr().out
        assert fake_ai.calls == [] and db.updates == []

    def test_target_accepts_several_ids_and_skips_ineligible(self, fake_ai):
        fake_ai.queue("generate", _summary("2 agenda items since 2020 about paving and closing the road."))
        db = _db()
        result = stages.run_property_summaries(StageContext(supabase=db, target="3,2"))
        assert result["summarized"] == 1
        assert [u[1] for u in db.updates] == [3]


class TestStale:
    def _current(self, keys):
        return {"summary": "old", "summary_version": ps.PROPERTY_SUMMARY_VERSION, "summary_inputs": ps.inputs_hash(keys)}

    def test_stale_when_missing_old_version_or_record_set_changed(self):
        keys = ["i102", "m10", "m11"]
        base = {"records": keys}
        assert ps.is_property_stale({**base, "meta": {}})
        assert not ps.is_property_stale({**base, "meta": self._current(keys)})
        assert ps.is_property_stale({**base, "meta": {**self._current(keys), "summary_version": "0"}})
        assert ps.is_property_stale({**base, "meta": self._current(["m10", "m11"])})
        assert not ps.is_property_stale({"records": ["m1"], "meta": {}})  # too few records

    def test_inputs_hash_ignores_order(self):
        assert ps.inputs_hash(["m1", "i2"]) == ps.inputs_hash(["i2", "m1"])

    def test_stale_stage_selection(self):
        db = _db({1: self._current(["i102", "m10", "m11"]), 3: self._current(["i105"])})
        assert stages.stale_property_summaries(StageContext(supabase=db, stale=True)) == [3]

    def test_summary_left_over_on_a_property_now_below_two_records_is_cleared(self, fake_ai):
        db = _db({1: self._current(["i102", "m10", "m11"]), 3: self._current(["i105", "i106"]),
                  2: {**self._current(["m12", "m13"]), "other": 1}})
        result = stages.run_property_summaries(StageContext(supabase=db, stale=True))
        assert result == {"properties": 0, "summarized": 0, "cleared": 1}
        assert db.updates == [("properties", 2, {"meta": {"other": 1}})]
        assert fake_ai.calls == []


class TestWrite:
    def test_meta_written_with_summary_version_and_inputs_hash(self, fake_ai):
        fake_ai.queue("generate", _summary('"3 matters since 2016, mostly about rezoning for a six-storey mixed-use building."'))
        db = _db({1: {"keep": True}})
        props = [p for p in ps.load_properties(db) if p["id"] == 1]
        assert ps.summarize_properties(db, props) == {1: "3 matters since 2016, mostly about rezoning for a six-storey mixed-use building."}
        (table, pid, payload), = db.updates
        meta = payload["meta"]
        assert (table, pid) == ("properties", 1)
        assert meta["keep"] is True
        assert meta["summary"].startswith("3 matters since 2016")
        assert meta["summary_version"] == ps.PROPERTY_SUMMARY_VERSION
        assert meta["summary_inputs"] == ps.inputs_hash(["i102", "m10", "m11"])

        _, kwargs = fake_ai.calls[0]
        assert kwargs["schema"].name == "PropertySummary"
        assert "never mention people's names" in kwargs["system"].lower()
        sent = json.loads(kwargs["content"][0].text.split("\n\n", 1)[1])
        assert sent["address"] == "100 Main Road"
        assert sent["record_count"] == "2 matters and 1 other agenda item"

    def test_model_input_uses_display_titles_years_and_truncated_summaries(self):
        db = _db()
        props = [p for p in ps.load_properties(db) if p["id"] == 1]
        data = ps.load_inputs(db, props)[1]
        assert data["kind"] == "lot"
        assert data["record_count"] == "2 matters and 1 other agenda item"
        assert (data["first_year"], data["last_year"]) == (2016, 2021)
        titles = [m["title"] for m in data["matters"]]
        assert titles == ["Development permit", "100 Main Road rezoning"]
        assert data["matters"][1]["years"] == "2016–2018"
        assert len(data["matters"][0]["summary"]) == 500
        assert data["other_agenda_items"] == [{"title": "Road dedication along Main Road", "year": 2021,
                                              "summary": "Land for road widening."}]

    def test_a_failed_call_writes_nothing(self, fake_ai):
        fake_ai.queue("generate", *[ValueError("bad")] * 5)
        db = _db()
        props = [p for p in ps.load_properties(db) if p["id"] == 3]
        assert ps.summarize_properties(db, props) == {}
        assert db.updates == []


@pytest.mark.parametrize("text,expected", [
    ("  A  short one. ", "A short one."),
    ("First sentence is here and fine. " + "y" * 300, "First sentence is here and fine."),
])
def test_clean(text, expected):
    if len(text) > ps.MAX_CHARS and expected.endswith("fine."):
        text = "x" * 150 + " " + text  # put the sentence end past the halfway mark
        expected = "x" * 150 + " " + expected
    assert ps.clean(text) == expected
