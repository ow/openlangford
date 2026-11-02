from pipeline.ingestion.staff_fixes import locked_matter_id, staff_matter


def test_a_staff_move_survives_reprocessing():
    assert staff_matter(None) is None
    assert staff_matter({"key_quotes": []}) is None
    moved = {"staff_matter": {"matter_id": 42, "by": "u", "at": "2026-11-02T00:00:00Z"}}
    assert locked_matter_id(moved, 7) == 42  # the pipeline's own choice loses to the lock
    off = {"staff_matter": {"matter_id": None, "by": "u", "at": "2026-11-02T00:00:00Z"}}
    assert staff_matter(off) is not None and locked_matter_id(off, 7) is None  # taken off every topic stays off
    assert locked_matter_id({}, 7) == 7
