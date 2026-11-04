from pipeline.ingestion.staff_fixes import locked_matter_id, staff_matter


def test_a_staff_move_survives_reprocessing():
    assert staff_matter(None) is None
    assert staff_matter({"key_quotes": []}) is None
    moved = {"staff_matter": {"matter_id": 42, "by": "u", "at": "2026-11-02T00:00:00Z"}}
    assert locked_matter_id(moved, 7) == 42  # the pipeline's own choice loses to the lock
    off = {"staff_matter": {"matter_id": None, "by": "u", "at": "2026-11-02T00:00:00Z"}}
    assert staff_matter(off) is not None and locked_matter_id(off, 7) is None  # taken off every topic stays off
    assert locked_matter_id({}, 7) == 7


class _Q:
    def __init__(self, db, table):
        self.db, self.table, self.op, self.payload = db, table, "select", None

    def select(self, *_):
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def eq(self, *_):
        return self

    def single(self):
        return self

    def maybe_single(self):
        return self

    def execute(self):
        if self.op != "select":
            self.db.writes.append((self.table, self.op, self.payload))
        return type("R", (), {"data": self.db.rows.get(self.table, {})})()


class _DB:
    def __init__(self, rows):
        self.rows, self.writes = rows, []

    def table(self, name):
        return _Q(self, name)


def test_a_move_with_no_destination_is_refiled_and_unfollowed_summary_notes_are_reported(monkeypatch):
    import pipeline.ingestion.staff_fixes as sf
    import pipeline.ingestion.matter_lifecycle as lifecycle
    import pipeline.ingestion.matter_summaries as summaries

    db = _DB({"agenda_items": {"matter_id": 5, "meeting_id": 9, "meta": {}},
              "matters": {"plain_english_summary": "Old text.", "meta": {}},
              "page_reviews": {"ai_flags": [{"key": None, "verdict": "agree"}, {"key": "agenda-1", "verdict": "agree"}]}})
    monkeypatch.setattr(sf, "refile_target", lambda supabase, item_id: 77)
    checks = []
    monkeypatch.setattr(sf, "check_summary_notes", lambda supabase, notes: checks.append(notes) or
                        [{"note": n["note"], "matter_id": 5, "missing": "The adoption."} for n in notes])
    edits = []
    monkeypatch.setattr(sf, "direct_edit", lambda supabase, matter_id, notes: edits.append((matter_id, notes)) or False)
    monkeypatch.setattr(lifecycle, "refresh_meeting_matter_lifecycles", lambda *a, **k: None)
    monkeypatch.setattr(summaries, "refresh_matter_summaries", lambda *a, **k: {5: {}})
    result = sf.run_fix_page(db, {"path": "/matters/x", "moves": [{"item_id": 1, "to_matter_id": None, "refile": True, "reason": "Not this topic."}],
                                  "refresh": [5], "summary_notes": [{"matter_id": 5, "note": "Say it was adopted."}],
                                  "done": ["Summary note. The summary is being rewritten with this note: \"Say it was adopted.\""]})
    item_update = next(p for t, op, p in db.writes if t == "agenda_items" and op == "update")
    assert item_update["matter_id"] == 77 and item_update["meta"]["staff_matter"]["matter_id"] == 77  # re-filed, not dropped
    review = next(p for t, op, p in db.writes if t == "page_reviews")
    assert "doesn't yet say what was asked" in review["agent_note"] and "Still missing: The adoption." in review["agent_note"]
    assert len(checks) == 3  # rewritten once more, then edited directly, before asking a person
    assert edits == [(5, ["Say it was adopted."])]
    notes_update = next(p for t, op, p in db.writes if t == "matters" and op == "update" and "editor_notes" in (p.get("meta") or {}))
    assert notes_update["meta"]["editor_notes"] == ["The last rewrite missed this: The adoption."]
    assert [f.get("fixed") for f in review["ai_flags"]] == [False, True]  # the page-wide flag stays open
    assert result["left"] == 1


def test_a_merge_marks_the_flag_that_asked_for_it_fixed(monkeypatch):
    # 2026-11-04, 2773 Strathmore Road: the duplicate topic was merged, but its "related-3342" flag stayed open, so the
    # page asked a person to finish a merge that had already happened.
    import pipeline.ingestion.staff_fixes as sf
    import pipeline.ingestion.matter_resolver as resolver
    import pipeline.ingestion.matter_summaries as summaries

    db = _DB({"matters": {"plain_english_summary": "Text.", "meta": {}},
              "page_reviews": {"ai_flags": [{"key": "related-3342", "verdict": "agree"}, {"key": "related-9", "verdict": "agree"}]}})
    monkeypatch.setattr(resolver, "merge_flat", lambda supabase, ids, canonical, reason: {"canonical": canonical, "aliases": [i for i in ids if i != canonical]})
    monkeypatch.setattr(sf, "check_summary_notes", lambda supabase, notes: [])
    monkeypatch.setattr(summaries, "refresh_matter_summaries", lambda *a, **k: {1188: {}})
    result = sf.run_fix_page(db, {"path": "/matters/x", "refresh": [1188],
                                  "merges": [{"matter_id": 1188, "with_matter_id": 3342, "reason": "Same daycare.", "key": "related-3342"}]})
    review = next(p for t, op, p in db.writes if t == "page_reviews")
    assert [f.get("fixed") for f in review["ai_flags"]] == [True, None]  # only the merged topic's flag
    assert review["status"] == "fixed" and "Needs a person" not in review["agent_note"]
    assert result["merged"] == 1
