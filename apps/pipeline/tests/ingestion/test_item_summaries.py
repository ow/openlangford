import json

from pipeline.ingestion import item_summaries as mod
from pipeline.ingestion.item_summaries import ITEM_SUMMARY_VERSION, ItemSummaries, _clean, _others, _prompt, decided, is_container, is_housekeeping, needs_summary, summarize_meeting_items, written_here


def motion(result="CARRIED", disposition="Substantive", text="That Council adopt Bylaw No. 1334."):
    return {"result": result, "disposition": disposition, "text_content": text}


def test_a_decision_is_a_motion_with_an_outcome_that_is_not_housekeeping():
    assert decided(motion())
    assert decided(motion(disposition=None))  # readings arrive without a disposition
    assert not decided(motion(disposition="Procedural"))
    assert not decided(motion(result=None))


def test_only_empty_summaries_with_a_decision_are_written():
    assert needs_summary({"id": 1, "plain_english_summary": None, "meta": {}}, [motion()])
    assert needs_summary({"id": 1, "plain_english_summary": "  ", "meta": None}, [motion()])
    # The refiner's or a person's text is never replaced, and an item with no decision has nothing to summarise.
    assert not needs_summary({"id": 1, "plain_english_summary": "Gave first reading.", "meta": {}}, [motion()])
    assert not needs_summary({"id": 1, "plain_english_summary": None, "meta": {"manual": {"summary": {}}}}, [motion()])
    assert not needs_summary({"id": 1, "plain_english_summary": None, "meta": {}}, [motion(disposition="Procedural")])
    assert not needs_summary({"id": 1, "plain_english_summary": None, "meta": {}}, [])


def test_the_catch_all_container_is_not_an_item_to_summarise():
    assert is_container({"id": 1, "item_order": "official-recorded-motions", "title": "x"})
    assert is_container({"id": 1, "title": "Official recorded motions"})
    assert not needs_summary({"id": 1, "title": "Official recorded motions", "plain_english_summary": None, "meta": {}}, [motion()])
    assert not is_container({"id": 2, "title": "BYLAW NO. 1334"})


def test_its_own_older_summaries_are_rewritten_but_current_ones_are_not():
    mine = lambda v: {"id": 1, "plain_english_summary": "Adopted the bylaw.", "meta": {"item_summary_version": v, "item_summary_text": "Adopted the bylaw."}}
    assert needs_summary(mine("0"), [motion()])
    assert not needs_summary(mine(ITEM_SUMMARY_VERSION), [motion()])
    assert needs_summary(mine(ITEM_SUMMARY_VERSION), [motion()], force=True)


def test_a_refiners_text_that_replaced_ours_on_re_ingest_is_never_rewritten():
    # Re-ingest merges the old meta back, so the stamp survives while the refiner's new text replaces ours.
    item = {"id": 1, "plain_english_summary": "Gave three readings to the bylaw.", "meta": {"item_summary_version": "0", "item_summary_text": "Adopted the bylaw."}}
    assert not written_here(item)
    assert not needs_summary(item, [motion()])
    assert not needs_summary(item, [motion()], force=True)


def test_agenda_minutes_and_adjournment_items_get_no_summary():
    for title in ["APPROVAL OF THE AGENDA", "2. APPROVAL OF THE AGENDA", "Approval of the Agenda", "ADOPTION OF THE MINUTES",
                  "ADOPTION OF THE MINUTES — Planning, Zoning & Affordable Housing Committee", "ADOPTION OF MINUTES", "ADJOURNMENT", "Call to Order", "Recess"]:
        assert is_housekeeping({"title": title}), title
        assert not needs_summary({"id": 1, "title": title, "plain_english_summary": None, "meta": {}}, [motion(disposition=None)]), title
    for title in ["BYLAW NO. 1334 (File No. 3900-1334)", "Establish Interest Rate Bylaw for Latecomer Agreements", "Minutes of Settlement for 3680 Trans-Canada Highway"]:
        assert not is_housekeeping({"title": title}), title


def test_clean_drops_unusable_summaries_and_ends_each_with_a_full_stop():
    result = ItemSummaries.model_validate({"items": [
        {"id": 1, "summary": ' "Adopted the new latecomer interest-rate bylaw" '},
        {"id": 2, "summary": "Too short"},
        {"id": 3, "summary": "x" * 400},
        {"id": 4, "summary": "Cancelled the earlier bylaw\nand its readings."},
    ]})
    assert _clean(result) == {1: "Adopted the new latecomer interest-rate bylaw.", 4: "Cancelled the earlier bylaw and its readings."}


def test_other_decisions_on_the_topic_come_nearest_first_and_skip_the_item_itself():
    item = {"id": 10, "meeting_id": 5}
    siblings = [{"id": 10, "meeting_id": 5}, {"id": 11, "meeting_id": 5}, {"id": 12, "meeting_id": 2}, {"id": 13, "meeting_id": 3}]
    motions = {10: [motion(text="own")], 11: [motion(text="rescind 1179")], 12: [motion(text="first reading")], 13: [motion(disposition="Procedural", text="adjourn")]}
    dates = {10: "2011-07-18", 11: "2011-07-18", 12: "2009-03-16", 13: "2011-07-17"}
    others = _others(item, siblings, motions, dates)
    assert [o["wording"] for o in others] == ["rescind 1179", "first reading"]
    assert others[0]["same_meeting"] is True and others[1]["same_meeting"] is False


def test_the_prompt_keeps_the_record_apart_from_the_model_written_notes():
    rows = [{"id": 7, "title": "BYLAW NO. 1334", "meeting": "Regular Council, 2011-07-18", "motions": [motion()],
             "others": [{"date": "2011-06-20", "wording": "first three readings", "result": "CARRIED", "same_meeting": False}],
             "topic_title": "Latecomer interest rate", "topic_summary": "Sets a 6% rate."}]
    payload = json.loads(_prompt(rows).split("\n\n", 1)[1])[0]
    assert payload["record"]["decisions"] == [{"wording": "That Council adopt Bylaw No. 1334.", "result": "CARRIED"}]
    assert payload["record"]["other_decisions_on_this_topic"][0]["wording"] == "first three readings"
    assert payload["notes"] == {"topic": "Latecomer interest rate", "topic_summary": "Sets a 6% rate."}
    assert "6%" not in json.dumps(payload["record"])
    assert "never what is true" in mod.SYSTEM


def test_the_stage_runs_after_the_history_catch_up_that_files_the_items_it_reads():
    from pipeline.stages import STAGES, get_stage

    names = [s.name for s in STAGES]
    assert get_stage("item-summaries").depends_on == ("matter-history",)
    assert names.index("item-summaries") > names.index("matter-history")


# ---- Against a small fake of the database client ----

class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    """Just enough of the supabase-py query builder: filters, paging and updates over lists of dict rows."""

    def __init__(self, db, table):
        self.db, self.table, self.rows, self.patch, self.lo, self.hi = db, table, list(db[table]), None, 0, None

    def select(self, *a, **k): return self
    def order(self, *a, **k): return self
    def eq(self, col, val): self.rows = [r for r in self.rows if r.get(col) == val]; return self
    def in_(self, col, vals): self.rows = [r for r in self.rows if r.get(col) in vals]; return self
    def is_(self, col, val): self.rows = [r for r in self.rows if (r.get(col) is None) == (val == "null")]; return self
    def or_(self, expr): self.rows = [r for r in self.rows if not (r.get("plain_english_summary") or "").strip()]; return self
    def range(self, lo, hi): self.lo, self.hi = lo, hi; return self
    def update(self, patch): self.patch = patch; return self

    @property
    def not_(self):
        outer = self

        class Not:
            def is_(self, col, val): outer.rows = [r for r in outer.rows if (r.get(col) is None) != (val == "null")]; return outer

        return Not()

    def execute(self):
        if self.patch is not None:
            for r in self.rows:
                r.update(self.patch)
            return _Result([dict(r) for r in self.rows])
        rows = self.rows[self.lo:(self.hi + 1) if self.hi is not None else None]
        return _Result([dict(r) for r in rows])


class _DB:
    def __init__(self, **tables):
        self.tables = tables

    def table(self, name): return _Query(self.tables, name)


def _meeting_db(items, motions):
    return _DB(agenda_items=items, motions=motions, meetings=[{"id": 825, "title": "Regular Council", "meeting_date": "2011-07-18"}], matters=[])


def _with_model(monkeypatch, summaries):
    monkeypatch.setattr(mod.ai, "json", lambda *a, **k: ItemSummaries.model_validate({"items": [{"id": i, "summary": s} for i, s in summaries.items()]}))


def _item(i, **over):
    return {"id": i, "meeting_id": 825, "matter_id": None, "title": f"BYLAW NO. {i}", "item_order": None, "plain_english_summary": None, "meta": {}, **over}


def test_writing_stamps_the_summary_and_the_text_and_counts_only_what_was_saved(monkeypatch):
    db = _meeting_db([_item(1), _item(2, title="APPROVAL OF THE AGENDA"), _item(3, item_order="official-recorded-motions")],
                     [{"agenda_item_id": i, **motion(disposition=None)} for i in (1, 2, 3)])
    _with_model(monkeypatch, {1: "Adopted the latecomer interest-rate bylaw.", 2: "Approved the agenda.", 3: "Agreed to many things at once."})
    out = summarize_meeting_items(db, 825)
    assert out == {1: "Adopted the latecomer interest-rate bylaw."}  # housekeeping and the container never reach the model's answer
    row = db.tables["agenda_items"][0]
    assert row["plain_english_summary"] == "Adopted the latecomer interest-rate bylaw."
    assert row["meta"] == {"item_summary_version": ITEM_SUMMARY_VERSION, "item_summary_text": "Adopted the latecomer interest-rate bylaw."}
    assert db.tables["agenda_items"][1]["plain_english_summary"] is None and db.tables["agenda_items"][2]["plain_english_summary"] is None


def test_a_blank_summary_is_filled_and_a_dry_run_saves_nothing(monkeypatch):
    db = _meeting_db([_item(1, plain_english_summary="  ")], [{"agenda_item_id": 1, **motion()}])
    _with_model(monkeypatch, {1: "Adopted the latecomer interest-rate bylaw."})
    assert summarize_meeting_items(db, 825, dry_run=True) == {1: "Adopted the latecomer interest-rate bylaw."}
    assert db.tables["agenda_items"][0]["plain_english_summary"] == "  "
    assert summarize_meeting_items(db, 825) == {1: "Adopted the latecomer interest-rate bylaw."}
    assert db.tables["agenda_items"][0]["plain_english_summary"] == "Adopted the latecomer interest-rate bylaw."


def test_a_summary_that_landed_while_the_model_ran_is_left_alone(monkeypatch):
    db = _meeting_db([_item(1)], [{"agenda_item_id": 1, **motion()}])

    def model(*a, **k):
        db.tables["agenda_items"][0]["plain_english_summary"] = "A person's text."  # written during the model call
        return ItemSummaries.model_validate({"items": [{"id": 1, "summary": "Adopted the latecomer interest-rate bylaw."}]})

    monkeypatch.setattr(mod.ai, "json", model)
    assert summarize_meeting_items(db, 825) == {}
    assert db.tables["agenda_items"][0]["plain_english_summary"] == "A person's text."


def test_meta_another_stage_set_during_the_model_call_survives_the_write(monkeypatch):
    db = _meeting_db([_item(1, meta={"key_quotes": []})], [{"agenda_item_id": 1, **motion()}])

    def model(*a, **k):
        db.tables["agenda_items"][0]["meta"] = {"key_quotes": [], "staff_stage": {"stage": "adopted"}}
        return ItemSummaries.model_validate({"items": [{"id": 1, "summary": "Adopted the latecomer interest-rate bylaw."}]})

    monkeypatch.setattr(mod.ai, "json", model)
    summarize_meeting_items(db, 825)
    assert db.tables["agenda_items"][0]["meta"]["staff_stage"] == {"stage": "adopted"}


def _ctx(items, motions, force=False):
    from types import SimpleNamespace
    return SimpleNamespace(supabase=_DB(agenda_items=items, motions=motions), force=force)


def _stamp_item(i, meeting, **over):
    return {"id": i, "meeting_id": meeting, "title": f"BYLAW NO. {i}", "item_order": None, "summary": None, "version": None, "text": None, "manual": None, **over}


def test_the_backfill_lists_a_meeting_once_there_is_something_to_write():
    from pipeline.stages import _item_summary_stamps, stale_item_summaries

    items = [
        _stamp_item(1, 10),                                              # needs its first summary
        _stamp_item(2, 11, summary="Refiner text."),                      # the refiner's: not ours, nothing to do
        _stamp_item(3, 12, item_order="official-recorded-motions"),       # the container: never written, so never listed
        _stamp_item(4, 13, title="APPROVAL OF THE AGENDA"),               # housekeeping
        _stamp_item(5, 14, summary="Ours.", version="0", text="Ours."),   # ours, older version
        _stamp_item(6, 15, summary="Refiner text.", version="0", text="Ours."),  # the stamp outlived our text
    ]
    motions = [{"agenda_item_id": i, "result": "CARRIED", "disposition": None} for i in range(1, 7)]
    ctx = _ctx(items, motions)
    listed = {r["id"]: r for r in _item_summary_stamps(ctx)}
    assert set(listed) == {10, 14}
    assert listed[10]["missing"] and not listed[14]["missing"]
    assert stale_item_summaries(ctx) == [10, 14]


def test_the_backfill_reads_every_page_of_decisions(monkeypatch):
    from pipeline import postgrest
    from pipeline.stages import _item_summary_stamps

    monkeypatch.setattr(postgrest, "PAGE_SIZE", 3)
    monkeypatch.setattr("pipeline.stages.paginate", lambda build: postgrest.paginate(build, page_size=3))
    items = [_stamp_item(i, 10 + i) for i in range(1, 8)]
    motions = [{"agenda_item_id": i, "result": "CARRIED", "disposition": None} for i in range(1, 8)]
    assert {r["id"] for r in _item_summary_stamps(_ctx(items, motions))} == {11, 12, 13, 14, 15, 16, 17}
