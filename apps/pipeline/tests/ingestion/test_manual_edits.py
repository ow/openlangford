from types import SimpleNamespace

from pipeline.ingestion.manual_edits import keep_image_edit, keep_text_edits


class _Rows:
    """The one stored matter row, as supabase.table("matters").select(...).eq(...).single().execute() returns it."""

    def __init__(self, row):
        self.row = row

    def table(self, _name):
        return self

    def select(self, *_):
        return self

    def eq(self, *_):
        return self

    def single(self):
        return self

    def execute(self):
        return SimpleNamespace(data=self.row)


EDITED = {"by": "u1", "at": "2026-11-04T00:00:00Z", "auto": "old auto"}


def test_text_writers_keep_hand_edited_fields_and_record_their_own_version():
    stored = {"plain_english_summary": "Staff summary.",
              "meta": {"display_title": "Staff title", "status_line": "Auto line", "manual": {"title": EDITED, "summary": EDITED}}}
    update = {"plain_english_summary": "New model summary.",
              "meta": {"display_title": "Model title", "status_line": "New model line", "summary_version": "9"}}
    out = keep_text_edits(_Rows(stored), 1, update)
    assert out["plain_english_summary"] == "Staff summary."
    assert out["meta"]["display_title"] == "Staff title"
    assert out["meta"]["status_line"] == "New model line"  # not edited: the writer's version goes in
    assert out["meta"]["summary_version"] == "9"
    assert out["meta"]["manual"]["title"]["auto"] == "Model title"
    assert out["meta"]["manual"]["summary"]["auto"] == "New model summary."
    assert out["meta"]["manual"]["title"]["by"] == "u1"


def test_text_writers_are_untouched_without_edits():
    update = {"plain_english_summary": "x", "meta": {"display_title": "y"}}
    assert keep_text_edits(_Rows({"plain_english_summary": "a", "meta": {}}), 1, update) == update


def test_an_edit_saved_mid_run_survives_a_stale_meta_snapshot():
    # The writer loaded meta before staff edited the title: the stored row has the edit, the update doesn't.
    stored = {"plain_english_summary": "s", "meta": {"display_title": "Staff title", "manual": {"title": EDITED}}}
    out = keep_text_edits(_Rows(stored), 1, {"plain_english_summary": "s2", "meta": {"display_title": "Model title"}})
    assert out["meta"]["display_title"] == "Staff title"
    assert out["meta"]["manual"]["title"]["auto"] == "Model title"


def test_picture_picker_keeps_a_hand_picked_photo_but_updates_the_layout_plan():
    chosen = {"r2_key": "staff.webp"}
    stored = {"meta": {"images": {"lead": chosen}, "manual": {"image": {**EDITED, "auto": None}}}}
    new_meta = {"images_version": "1", "images": {"lead": {"r2_key": "model.webp"}, "layout": {"r2_key": "plan.webp"}}}
    out = keep_image_edit(_Rows(stored), 1, new_meta)
    assert out["images"] == {"lead": chosen, "layout": {"r2_key": "plan.webp"}}
    assert out["manual"]["image"]["auto"] == {"r2_key": "model.webp"}


def test_no_photo_chosen_by_hand_stays_no_photo():
    stored = {"meta": {"manual": {"image": EDITED}}}
    out = keep_image_edit(_Rows(stored), 1, {"images": {"lead": {"r2_key": "model.webp"}}})
    assert "images" not in out
    assert out["manual"]["image"]["auto"] == {"r2_key": "model.webp"}
