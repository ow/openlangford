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


ITEMS = {
    100: {"title": "Rezoning 100 Main Rd", "category": "Land Use", "meetings": {"meeting_date": "2016-03-01"}},
    101: {"title": "Rezoning 100 Main Rd, third reading", "category": "Land Use", "meetings": {"meeting_date": "2018-05-01"}},
    102: {"title": "Road dedication along Main Road", "category": "Land Use", "meetings": {"meeting_date": "2021-06-07"}},
    103: {"title": "Variance 200 Main Rd", "category": "Land Use", "meetings": {"meeting_date": "2019-02-01"}},
    104: {"title": "Hidden", "category": "Land Use", "meetings": {"meeting_date": "2019-02-01"}},
    105: {"title": "Main Road paving", "category": "Transportation", "meetings": {"meeting_date": "2020-01-01"}},
    106: {"title": "Main Road closure", "category": "Transportation", "meetings": {"meeting_date": "2022-01-01"}},
    107: {"title": "PUBLIC PARTICIPATION", "category": "Procedural", "meetings": {"meeting_date": "2023-01-01"}},
    108: {"title": "Mr. A Resident, of 500 Main Rd", "category": "Public Input", "meetings": {"meeting_date": "2024-01-01"}},
}


def _link(property_id, matter_id, item_id, hidden=False):
    return {"property_id": property_id, "matter_id": matter_id, "agenda_item_id": item_id, "hidden": hidden,
            "agenda_items": ITEMS.get(item_id)}


def _db(meta_by_property=None):
    meta_by_property = meta_by_property or {}

    def prop(pid, slug, address, number):
        return {"id": pid, "slug": slug, "address": address, "civic_number": number, "street": "Main Road",
                "meta": meta_by_property.get(pid)}

    return FakeDB(
        properties=[
            prop(1, "100-main-road", "100 Main Road", "100"),
            prop(2, "200-main-road", "200 Main Road", "200"),
            prop(3, "main-road", "Main Road", ""),
            prop(4, "300-main-road", "300 Main Road", "300"),
            prop(5, "500-main-road", "500 Main Road", "500"),
        ],
        property_links=[
            # 1: two matters (one via two items) and a loose item -> 3 records
            _link(1, 10, 100), _link(1, 10, 101), _link(1, 11, None), _link(1, None, 102),
            # 2: one visible matter; the second link is hidden by an admin -> 1 record
            _link(2, 12, 103), _link(2, 13, 104, hidden=True),
            # 3: street with two loose items -> 2 records
            _link(3, None, 105), _link(3, None, 106),
            # 4: a matter merged into another plus a visible one -> 1 record
            _link(4, 14, None), _link(4, 15, None),
            # 5: a resident's home, known only from what residents said or wrote to Council
            _link(5, None, 107), _link(5, None, 108),
        ],
        matters=[
            {"id": 10, "canonical": None, "hidden": None, "title": "Bylaw No. 300 Amendment No. 769 (100 Main Rd)",
             "category": "Rezoning", "status": "Adopted", "first_seen": "2016-03-01", "last_seen": "2018-05-01",
             "plain_english_summary": "Rezoning for a six-storey mixed-use building.", "meta": {"display_title": "100 Main Road rezoning"}},
            {"id": 11, "canonical": None, "hidden": None, "title": "Development permit", "category": "Development",
             "status": "Approved", "first_seen": "2019-01-01", "last_seen": "2019-01-01",
             "plain_english_summary": "x" * 900, "meta": {}},
            {"id": 12, "canonical": None, "hidden": None, "title": "Variance", "first_seen": "2019-02-01",
             "last_seen": "2019-02-01", "meta": {}},
            {"id": 13, "canonical": None, "hidden": None, "title": "Hidden link", "meta": {}},
            {"id": 14, "canonical": "15", "hidden": None, "title": "Merged duplicate", "meta": {}},
            {"id": 15, "canonical": None, "hidden": None, "title": "Real one", "first_seen": "2015-01-01", "meta": {}},
        ],
        agenda_items=[
            {"id": 102, "title": "Road dedication along Main Road", "plain_english_summary": "Land for road widening.",
             "meetings": {"meeting_date": "2021-06-07"}},
            {"id": 105, "title": "Main Road paving", "plain_english_summary": "", "meetings": {"meeting_date": "2020-01-01"}},
            {"id": 106, "title": "Main Road closure", "plain_english_summary": "", "meetings": {"meeting_date": "2022-01-01"}},
        ],
    )


def _props(db=None, this_year=2026):
    return {p["id"]: p for p in ps.load_properties(db or _db(), this_year=this_year)}


def _summary(text):
    return GenerateResult(text=json.dumps({"summary": text}))


class TestSelection:
    def test_records_count_distinct_matters_and_loose_items_excluding_hidden_and_merged(self):
        props = _props()
        assert props[1]["records"] == ["i102", "m10", "m11"]
        assert props[2]["records"] == ["m12"]
        assert props[3]["records"] == ["i105", "i106"]
        assert props[4]["records"] == ["m15"]
        assert [i for i, p in props.items() if ps.eligible(p)] == [1, 3]

    def test_a_residents_home_known_only_from_public_input_is_never_summarized(self):
        props = _props()
        assert props[5]["resident_only"] and not props[1]["resident_only"]
        assert not ps.eligible(props[5])
        # ...and never feeds its street's summary.
        assert [lot["id"] for lot in ps.summary_lots(props[3])] == [1, 2, 4]

    def test_a_hidden_lot_is_off_its_street_page_and_out_of_its_counts(self):
        db = _db()
        before = _props(db)[3]["mention_count"]
        for p in db.rows["properties"]:
            p["hidden"] = p["id"] == 5
        props = _props(db)
        assert props[5]["resident_only"] and not ps.eligible(props[5])
        assert [lot["id"] for lot in props[3]["lots"]] == [1, 2, 4]
        assert props[3]["mention_count"] == before - 2  # its two public-input mentions

    def test_street_with_two_addresses_is_eligible_without_records_of_its_own(self):
        db = _db()
        db.rows["property_links"] = [l for l in db.rows["property_links"] if l["property_id"] != 3]
        assert ps.eligible(_props(db)[3])

    def test_record_keys_skips_hidden_links_even_unfiltered(self):
        links = [{"matter_id": 1, "hidden": True}, {"matter_id": None, "agenda_item_id": 7, "hidden": False}]
        assert ps.record_keys(links) == ["i7"]

    def test_is_public_input_by_category_or_title(self):
        assert ps.is_public_input({"title": "Mr. X, of 848 Walfred Rd", "category": "Public Input"})
        assert ps.is_public_input({"title": "Delegation: A Resident", "category": None})
        assert not ps.is_public_input({"title": "Rezoning 100 Main Rd", "category": "Land Use"})

    def test_dry_run_lists_only_eligible_properties_and_calls_no_model(self, fake_ai, capsys):
        db = _db()
        result = stages.run_property_summaries(StageContext(supabase=db, dry_run=True))
        assert result == {"properties": 2, "clear": 0}
        assert "properties to summarize: 2: 1, 3" in capsys.readouterr().out
        assert fake_ai.calls == [] and db.updates == []

    def test_target_accepts_several_ids_and_skips_ineligible(self, fake_ai):
        fake_ai.queue("generate", _summary("Council paved and later closed part of the road."))
        db = _db()
        result = stages.run_property_summaries(StageContext(supabase=db, target="3,2"))
        assert result["summarized"] == 1
        assert [u[1] for u in db.updates] == [3]


class TestClosingLine:
    def test_span_and_mentions_match_the_page_header(self):
        props = _props()
        # A lot: its matters' first and last meetings and its loose items.
        assert (props[1]["first_year"], props[1]["last_year"]) == (2016, 2021)
        assert props[1]["mention_count"] == 4  # items 100, 101, 102 and matter 11 (no item)
        assert props[1]["closing"] == "Mentioned in council meetings 4 times, 2016–2021."
        # A street: every link to it or its addresses, as the per-year chart counts them.
        assert (props[3]["first_year"], props[3]["last_year"]) == (2016, 2024)
        assert props[3]["closing"] == "Mentioned in council meetings 10 times, 2016–2024."

    @pytest.mark.parametrize("args,expected", [
        ((1, 2015, 2015), "Mentioned once in council meetings, in 2015."),
        ((2, 2015, 2015), "Mentioned in council meetings twice in 2015."),
        ((41, 2009, 2026), "Mentioned in council meetings 41 times since 2009."),
        ((12, 2009, 2016), "Mentioned in council meetings 12 times, 2009–2016."),
        ((0, None, None), ""),
    ])
    def test_closing_line(self, args, expected):
        assert ps.closing_line(*args, this_year=2026) == expected


class TestStale:
    def _current(self, p):
        return {"summary": "old", "summary_version": ps.PROPERTY_SUMMARY_VERSION, "summary_inputs": ps.current_hash(p)}

    def test_stale_when_missing_old_version_or_record_set_changed(self):
        p = _props()[1]
        assert ps.is_property_stale({**p, "meta": {}})
        assert not ps.is_property_stale({**p, "meta": self._current(p)})
        assert ps.is_property_stale({**p, "meta": {**self._current(p), "summary_version": "1"}})
        assert ps.is_property_stale({**p, "meta": {**self._current(p), "summary_inputs": ps.inputs_hash(["m10", "m11"])}})
        assert not ps.is_property_stale({"records": ["m1"], "meta": {}})  # too few records

    def test_inputs_hash_ignores_order(self):
        assert ps.inputs_hash(["m1", "i2"]) == ps.inputs_hash(["i2", "m1"])

    def test_street_goes_stale_when_one_of_its_lots_changes(self):
        props = _props()
        before = ps.current_hash(props[3])
        db = _db()
        db.rows["property_links"].append(_link(2, None, 102))
        assert ps.current_hash(_props(db)[3]) != before

    def test_stale_stage_selection(self):
        props = _props()
        db = _db({1: self._current(props[1]), 3: {**self._current(props[3]), "summary_inputs": "old"}})
        assert stages.stale_property_summaries(StageContext(supabase=db, stale=True)) == [3]

    def test_summary_left_over_on_an_ineligible_property_is_cleared(self, fake_ai):
        props = _props()
        db = _db({1: self._current(props[1]), 3: self._current(props[3]),
                  2: {**self._current(props[2]), "other": 1}, 5: {"summary": "x", "summary_version": "1"}})
        stages_props = ps.load_properties(db)
        # The closing line depends on the current year; keep both hashes current.
        for p in stages_props:
            if p["id"] in (1, 3):
                db.rows["properties"][[r["id"] for r in db.rows["properties"]].index(p["id"])]["meta"] = self._current(p)
        result = stages.run_property_summaries(StageContext(supabase=db, stale=True))
        assert result == {"properties": 0, "summarized": 0, "cleared": 2}
        assert sorted(u[1] for u in db.updates) == [2, 5]
        assert ("properties", 2, {"meta": {"other": 1}}) in db.updates
        assert fake_ai.calls == []


class TestWrite:
    def test_meta_written_with_summary_closing_line_version_and_inputs_hash(self, fake_ai):
        fake_ai.queue("generate", _summary('"Council approved a six-storey mixed-use building in 2018"'))
        db = _db({1: {"keep": True}})
        props = [p for p in ps.load_properties(db, this_year=2026) if p["id"] == 1]
        expected = "Council approved a six-storey mixed-use building in 2018. Mentioned in council meetings 4 times, 2016–2021."
        assert ps.summarize_properties(db, props) == {1: expected}
        (table, pid, payload), = db.updates
        meta = payload["meta"]
        assert (table, pid) == ("properties", 1)
        assert meta["keep"] is True
        assert meta["summary"] == expected
        assert meta["summary_version"] == ps.PROPERTY_SUMMARY_VERSION
        assert meta["summary_inputs"] == ps.current_hash(props[0])

        _, kwargs = fake_ai.calls[0]
        assert kwargs["schema"].name == "PropertySummary"
        system = kwargs["system"].lower()
        assert "never mention people's names" in system
        assert "no database words" in system
        sent = json.loads(kwargs["content"][0].text.split("\n\n", 1)[1])
        assert sent["address"] == "100 Main Road" and sent["kind"] == "lot"

    def test_model_input_uses_display_titles_years_and_truncated_summaries(self):
        db = _db()
        props = [p for p in ps.load_properties(db) if p["id"] == 1]
        data = ps.load_inputs(db, props)[1]
        titles = [m["title"] for m in data["council_decisions_and_projects"]]
        assert titles == ["Development permit", "100 Main Road rezoning"]
        assert data["council_decisions_and_projects"][1]["years"] == "2016–2018"
        assert len(data["council_decisions_and_projects"][0]["summary"]) == 500
        assert data["other_mentions"] == [{"title": "Road dedication along Main Road", "year": 2021,
                                           "summary": "Land for road widening."}]

    def test_street_input_covers_the_road_and_its_busiest_addresses(self):
        db = _db()
        props = [p for p in ps.load_properties(db) if p["id"] == 3]
        data = ps.load_inputs(db, props)[3]
        assert data["kind"] == "street"
        assert [i["title"] for i in data["the_street_itself"]["other_mentions"]] == ["Main Road closure", "Main Road paving"]
        addresses = [a["address"] for a in data["addresses_on_the_street"]]
        assert addresses[0] == "100 Main Road" and "500 Main Road" not in addresses
        assert data["addresses_on_the_street"][0]["times_considered"] == 3

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
    if len(text) > ps.NARRATIVE_MAX and expected.endswith("fine."):
        text = "x" * 150 + " " + text  # put the sentence end past the halfway mark
        expected = "x" * 150 + " " + expected
    assert ps.clean(text) == expected


def test_street_input_names_the_two_most_considered_addresses():
    db = _db()
    data = ps.load_inputs(db, [p for p in ps.load_properties(db) if p["id"] == 3])[3]
    assert data["most_considered"] == ["100", "200"]


def test_a_lead_that_drops_the_size_gets_one_more_try(fake_ai):
    data = {"kind": "lot", "council_decisions_and_projects": [{"title": "Subdivision", "summary": "Up to 47 lots."}]}
    fake_ai.queue("generate", _summary("Council approved a subdivision in 2015."),
                  _summary("Council approved a 47-lot subdivision in 2015."))
    assert ps.summarize(data, "Mentioned once in council meetings, in 2015.") == \
        "Council approved a 47-lot subdivision in 2015. Mentioned once in council meetings, in 2015."
    assert len(fake_ai.calls) == 2


def test_a_lead_with_database_words_gets_one_more_try(fake_ai):
    fake_ai.queue("generate", _summary("A 2014 variance matter involved homes on the street."),
                  _summary("In 2014 Council allowed a variance for homes on the street."))
    assert ps.summarize({"kind": "street", "council_decisions_and_projects": []}) == \
        "In 2014 Council allowed a variance for homes on the street."
    assert len(fake_ai.calls) == 2


def test_no_retry_when_the_inputs_give_no_size(fake_ai):
    fake_ai.queue("generate", _summary("Council closed part of the road in 2019."))
    ps.summarize({"kind": "lot", "council_decisions_and_projects": [{"title": "Road closure", "summary": ""}]})
    assert len(fake_ai.calls) == 1
