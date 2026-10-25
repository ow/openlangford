from pipeline.ingestion.motion_headlines import MotionHeadlines, _clean


def test_clean_strips_quotes_and_trailing_periods_and_drops_empty_headlines():
    result = MotionHeadlines.model_validate(
        {"motions": [
            {"id": 1, "headline": "Garbage fees capped at $280"},
            {"id": 2, "headline": ' "Clinic cleared for Happy Valley Road." '},
            {"id": 3, "headline": "  "},
        ]}
    )
    assert _clean(result) == {1: "Garbage fees capped at $280", 2: "Clinic cleared for Happy Valley Road"}
