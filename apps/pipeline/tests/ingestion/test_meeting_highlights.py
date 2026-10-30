from unittest.mock import MagicMock

from pipeline.ingestion import meeting_highlights as mh
from pipeline.ingestion.meeting_highlights import Bullet, Highlights, Link, problems


def H(bullets, description, links=None):
    links = links or [[] for _ in bullets]
    return Highlights(bullets=[Bullet(text=b, links=[Link(**x) for x in l]) for b, l in zip(bullets, links)],
                      description=description)


def test_clean_strips_markers_adds_periods_caps_bullets_and_prefixes_the_date():
    result = H(
        bullets=["- **Garbage fees** capped at $280", ' "Clinic cleared for Happy Valley Road." ', "  ", "a", "b", "c"],
        description="Council capped garbage fees",
    )
    out = mh.clean(result, "2026-10-05")
    assert out["bullets"][:2] == ["Garbage fees capped at $280.", "Clinic cleared for Happy Valley Road."]
    assert len(out["bullets"]) == 4
    assert out["description"] == "October 5, 2026: Council capped garbage fees."
    assert out["version"] == mh.HIGHLIGHTS_VERSION


def test_overlong_description_is_cut_at_a_clause_within_the_limit():
    long = "Council approved a budget, " + ", ".join(f"rezoned lot {i} on Goldstream Avenue" for i in range(12))
    out = mh.clean(H(["x"], long), "2026-05-19")
    assert len(out["description"]) <= mh.DESCRIPTION_MAX
    assert out["description"].startswith("May 19, 2026: Council approved a budget")
    assert out["description"].endswith(".")


def test_problems_flags_long_bullets_and_repeated_stock_phrases():
    bullets = [
        "Moved the 2026 budget one step from final approval.",
        "Moved parking changes one step from final approval (passed 6–1).",
        "Capped garbage fees at $280 " + "and more " * 12,
        "Met in the city of Langford.",
    ]
    found = problems(bullets)
    assert any("bullet 3 has" in p for p in found)
    assert any('bullets 1 and 2 both say "one step from final"' in p for p in found)
    assert len([p for p in found if "both say" in p and "bullets 1 and 2" in p]) >= 1
    assert problems(["Capped garbage fees at $280.", "Passed new developer charges to pay for future parks."]) == []


def test_build_inputs_keeps_outcomes_and_notes_split_votes_only():
    meeting = {"title": "Regular Council", "type": "Regular Council", "meeting_date": "2026-04-20", "summary": "- x"}
    motions = [
        {"id": 1, "agenda_item_id": 10, "plain_english_summary": "Approved the agenda.", "disposition": "Procedural", "result": "CARRIED"},
        {"id": 2, "agenda_item_id": 11, "plain_english_summary": "Gave 1st-3rd readings to parking.", "disposition": "Substantive",
         "result": "CARRIED", "meta": {"headline": "Parking minimums dropped"}},
        {"id": 3, "agenda_item_id": 11, "plain_english_summary": "Gave 1st-3rd readings to budget.", "disposition": "Substantive", "result": "CARRIED"},
        {"id": 4, "agenda_item_id": 11, "plain_english_summary": "Never voted on.", "disposition": "Substantive", "result": None},
    ]
    votes = {2: [{"vote": "Yes"}] * 6 + [{"vote": "No"}], 3: [{"vote": "Yes"}] * 7}
    items = [{"id": 10, "title": "Agenda"}, {"id": 11, "title": "Bylaws", "plain_english_summary": "Bylaw readings."}]
    inputs = mh.build_inputs(meeting, motions, votes, items)
    decisions = inputs["decisions"]
    assert [d["decision"] for d in decisions] == ["Gave 1st-3rd readings to parking.", "Gave 1st-3rd readings to budget."]
    assert decisions[0]["vote"] == "6–1" and decisions[0]["headline"] == "Parking minimums dropped"
    assert "vote" not in decisions[1]
    assert inputs["agenda_items_for_context_only"] == [
        {"id": 10, "title": "Agenda"}, {"id": 11, "title": "Bylaws", "summary": "Bylaw readings."}]
    assert decisions[0]["agenda_item_id"] == 11


def test_procedural_motions_are_kept_when_they_are_the_only_business():
    motions = [{"id": 1, "plain_english_summary": "Closed the meeting to discuss land.", "disposition": "Procedural", "result": "CARRIED"}]
    inputs = mh.build_inputs({"meeting_date": "2026-04-20"}, motions, {}, [])
    assert [d["decision"] for d in inputs["decisions"]] == ["Closed the meeting to discuss land."]


def test_eligible_skips_unheld_meetings_and_meetings_with_nothing_recorded():
    assert mh.eligible({"status": "Completed", "summary": "- x"}, [])
    assert not mh.eligible({"status": "Cancelled", "summary": "- x"}, [])
    assert not mh.eligible({"status": "Planned", "summary": None}, [])
    assert not mh.eligible({"status": "Completed", "summary": " "}, [])


def _supabase(meta, updated_ats, write_results):
    sb = MagicMock()
    table = sb.table.return_value
    reads = iter([MagicMock(data=[{"meta": meta, "updated_at": u}]) for u in updated_ats])
    table.select.return_value.eq.return_value.execute.side_effect = lambda: next(reads)
    writes = iter([MagicMock(data=d) for d in write_results])
    table.update.return_value.eq.return_value.eq.return_value.execute.side_effect = lambda: next(writes)
    return sb, table


def test_write_merges_only_the_highlights_key_guarded_by_updated_at():
    sb, table = _supabase({"poster": {"url": "p.png"}, "highlights": {"version": "0"}}, ["t1"], [[{"id": 7}]])
    assert mh.write_highlights(sb, 7, {"bullets": ["a."], "description": "d", "version": "1"})
    payload = table.update.call_args.args[0]
    assert payload == {"meta": {"poster": {"url": "p.png"}, "highlights": {"bullets": ["a."], "description": "d", "version": "1"}}}
    table.update.return_value.eq.return_value.eq.assert_called_with("updated_at", "t1")


def test_clean_drops_nothing_happened_bullets():
    out = mh.clean(H(["No decisions were recorded."], ""), "2021-02-09")
    assert out["bullets"] == [] and out["description"] == ""


def test_links_must_be_exact_substrings_of_items_in_the_meeting_and_not_overlap():
    bullets = ["Asked staff to bring rezonings for 2609 Sooke Road and Jacklin Road back for a vote.", "Capped garbage fees at $280."]
    links = [[
        {"text": "Jacklin Road", "agenda_item_id": 2},
        {"text": "2609 Sooke Road", "agenda_item_id": 1},
        {"text": "Sooke Road", "agenda_item_id": 3},          # overlaps the first link
        {"text": "Strathmore Road", "agenda_item_id": 4},     # not in the bullet
        {"text": "a vote", "agenda_item_id": 99},             # item from another meeting
    ], [{"text": "garbage fees", "agenda_item_id": 5}]]
    out = mh.clean(H(bullets, "d", links), "2026-04-20", {1, 2, 3, 4, 5})
    assert out["links"] == [
        [{"text": "2609 Sooke Road", "agenda_item_id": 1}, {"text": "Jacklin Road", "agenda_item_id": 2}],
        [{"text": "garbage fees", "agenda_item_id": 5}],
    ]
    assert out["links_dropped"] == 3
    assert len(out["links"]) == len(out["bullets"])


def test_an_item_is_linked_once_per_meeting():
    out = mh.clean(H(["Cut the budget.", "Raised the budget for parks."], "d",
                     [[{"text": "budget", "agenda_item_id": 7}], [{"text": "parks", "agenda_item_id": 7}]]), "2026-03-23", {7})
    assert out["links"] == [[{"text": "budget", "agenda_item_id": 7}], []]
    assert out["links_dropped"] == 0


def test_links_stay_aligned_when_a_bullet_is_dropped():
    out = mh.clean(H(["No decisions were recorded.", "Capped garbage fees."], "d",
                     [[], [{"text": "garbage fees", "agenda_item_id": 5}]]), "2026-04-20", {5})
    assert out["bullets"] == ["Capped garbage fees."]
    assert out["links"] == [[{"text": "garbage fees", "agenda_item_id": 5}]]


def test_write_none_removes_only_the_highlights_key():
    sb, table = _supabase({"poster": {"url": "p.png"}, "highlights": {"bullets": ["x."]}}, ["t1"], [[{"id": 7}]])
    assert mh.write_highlights(sb, 7, None)
    assert table.update.call_args.args[0] == {"meta": {"poster": {"url": "p.png"}}}


def test_an_empty_revision_never_replaces_a_draft_with_bullets(monkeypatch):
    meeting = {"id": 1, "status": "Completed", "summary": "- Approved X.", "meeting_date": "2009-07-20"}
    monkeypatch.setattr(mh, "_load", lambda sb, mid: (meeting, [], {}, [{"id": 5, "title": "X"}]))
    long_draft = H(["Approved " + "x " * 30 + "for Desmond Drive."], "Council approved X.")
    drafts = iter([long_draft, H([], ""), H([], "")])
    monkeypatch.setattr(mh.ai, "json", lambda *a, **k: next(drafts))
    out = mh.generate(MagicMock(), 1)
    assert out and out["bullets"][0].startswith("Approved")


def test_write_retries_when_meta_changed_underneath():
    sb, table = _supabase({}, ["t1", "t2"], [[], [{"id": 7}]])
    assert mh.write_highlights(sb, 7, {"bullets": ["a."]})
    assert table.update.call_count == 2
