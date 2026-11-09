import json

from pipeline.ingestion import item_summaries as mod
from pipeline.ingestion.item_summaries import ITEM_SUMMARY_VERSION, ItemSummaries, _clean, _others, _prompt, decided, is_container, needs_summary


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
    mine = lambda v: {"id": 1, "plain_english_summary": "Adopted the bylaw.", "meta": {"item_summary_version": v}}
    assert needs_summary(mine("0"), [motion()])
    assert not needs_summary(mine(ITEM_SUMMARY_VERSION), [motion()])


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


def test_the_stage_is_registered_after_the_decisions_it_reads():
    from pipeline.stages import STAGES

    names = [s.name for s in STAGES]
    assert names.index("item-summaries") > names.index("motion-headlines")
