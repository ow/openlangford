from pipeline.ingestion.motion_summaries import MotionSummaries, _clean


def test_clean_strips_quotes_and_drops_empty_summaries():
    result = MotionSummaries.model_validate(
        {"motions": [{"id": 1, "summary": "Approved the agenda."}, {"id": 2, "summary": ' "Adjourned." '}, {"id": 3, "summary": ""}]}
    )
    assert _clean(result) == {1: "Approved the agenda.", 2: "Adjourned."}


def test_a_hand_set_decision_line_is_kept(monkeypatch):
    from unittest.mock import MagicMock

    from pipeline.ingestion import motion_summaries

    motions = [
        {"id": 1, "text_content": "That Council direct staff…", "result": "CARRIED", "plain_english_summary": "Fixed by hand.",
         "agenda_item_id": None, "meta": {"manual": {"summary": {"by": "u1"}}}},
        {"id": 2, "text_content": "That Council adjourn.", "result": "CARRIED", "plain_english_summary": None, "agenda_item_id": None, "meta": {}},
    ]
    sb = MagicMock()
    sb.table.return_value.select.return_value.eq.return_value.order.return_value.execute.return_value.data = motions
    monkeypatch.setattr(motion_summaries.ai, "json", lambda *a, **k: MotionSummaries.model_validate(
        {"motions": [{"id": 1, "summary": "Model line."}, {"id": 2, "summary": "Adjourned."}]}))
    motion_summaries.regenerate_meeting_motion_summaries(sb, 5)
    updates = [c.args[0] for c in sb.table.return_value.update.call_args_list]
    assert updates[0] == {"meta": {"manual": {"summary": {"by": "u1", "auto": "Model line."}}}}
    assert updates[1] == {"plain_english_summary": "Adjourned."}
