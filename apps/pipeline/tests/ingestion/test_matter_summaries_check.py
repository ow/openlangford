import pipeline.ingestion.matter_summaries as ms


def _update(text):
    return {"plain_english_summary": text, "meta": {"status_line": "Adopted."}}


def test_a_text_with_problems_is_rewritten_once_and_the_better_version_kept(monkeypatch):
    batch = [{"id": 1}, {"id": 2}]
    checks = []

    def fake_check(b, updates):
        checks.append(sorted(updates))
        return {mid: [{"statement": "$67"}] for mid, u in updates.items() if "$67" in u["plain_english_summary"]}

    def fake_generate(b, context_only=False):
        assert b[0]["fix_these"] == [{"statement": "$67"}]  # told what was wrong
        return {1: _update("Costs $4,408,940.67.")}

    monkeypatch.setattr(ms, "_check", fake_check)
    monkeypatch.setattr(ms, "_generate", fake_generate)
    out = ms._checked(batch, {1: _update("Costs $67."), 2: _update("Fine.")})
    assert out[1]["plain_english_summary"] == "Costs $4,408,940.67."
    assert out[1]["meta"]["summary_check"]["rewritten"] and out[1]["meta"]["summary_check"]["problems"] == 0
    assert out[2]["meta"]["summary_check"] == {**out[2]["meta"]["summary_check"], "problems": 0, "rewritten": False}
    assert checks == [[1, 2], [1]]


def test_a_rewrite_that_is_no_better_keeps_the_first_text(monkeypatch):
    monkeypatch.setattr(ms, "_check", lambda b, u: {1: [{"statement": "x"}]})
    monkeypatch.setattr(ms, "_generate", lambda b, context_only=False: {1: _update("Second.")})
    out = ms._checked([{"id": 1}], {1: _update("First.")})
    assert out[1]["plain_english_summary"] == "First."
    assert out[1]["meta"]["summary_check"]["problems"] == 1 and out[1]["meta"]["summary_check"]["unresolved"]


def test_a_failed_check_leaves_the_text_unchecked_not_unwritten(monkeypatch):
    def boom(b, u):
        raise RuntimeError("down")
    monkeypatch.setattr(ms, "_check", boom)
    out = ms._checked([{"id": 1}], {1: _update("Text.")})
    assert out[1]["plain_english_summary"] == "Text." and "summary_check" not in out[1]["meta"]
