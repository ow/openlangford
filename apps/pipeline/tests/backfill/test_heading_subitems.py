from pipeline.backfill.heading_subitems import check_plan, norm_order, numbers

MINUTES = """7. REPORTS a) CRD Regional Housing First Program Staff report
MOVED BY: X That Council consent to the Capital Regional District adopting Bylaw No. 4326. CARRIED.
b) Access to 2400 and 2420 Millstream Road Verbal Report
MOVED BY: Y BE IT RESOLVED that the City enter 2400 and 2420 Millstream Rd working area. CARRIED.
8. BYLAWS a) BYLAW NO. 1678 Claude Rd (FIRST READING) That Council give Bylaw No. 1678 first reading. CARRIED."""

HEADINGS = {"7": {"id": 1, "title": "REPORTS"}, "8": {"id": 2, "title": "BYLAWS"}}
EXISTING = [{"id": 1, "item_order": "7", "title": "REPORTS"}, {"id": 2, "item_order": "8", "title": "BYLAWS"}]


def sub(order, parent, title, motions=()):
    return {"item_order": order, "parent_order": parent, "title": title, "category": "Housing", "summary": "", "motion_ids": list(motions)}


def test_orders_normalise():
    assert norm_order("7.") == "7" and norm_order("7a") == "7.a" and norm_order("7(a)") == "7.a" and norm_order("5.a.2") == "5.a.2"


def test_numbers_skip_years():
    assert numbers("Bylaw No. 1678, 2020 at 2400 Millstream") == {"1678", "2400"}
    assert numbers("That Council adopt Bylaw No. 1975 and issue DVP21-0002") == {"1975", "DVP21-0002"}


def test_only_printed_items_under_stored_headings_are_added():
    plan = check_plan([sub("7.a", "7", "CRD Regional Housing First Program"), sub("7.c", "7", "Invented report"),
                       sub("9.a", "9", "Something under no heading"), sub("7", "7", "REPORTS")],
                      HEADINGS, EXISTING, MINUTES, "", [])
    assert [s["item_order"] for s in plan["add"]] == ["7.a"]
    assert {s["why"] for s in plan["held"]} == {"title not found in the minutes or agenda", "not under a stored heading"}


def test_motions_move_only_where_the_minutes_put_them():
    motions = [{"id": 10, "text": "That Council consent to the Capital Regional District adopting Bylaw No. 4326.", "item_order": "7", "on_container": False},
               {"id": 11, "text": "BE IT RESOLVED that pursuant to section 32 the City enter 2400 and 2420 Millstream Road", "item_order": "7", "on_container": False},
               {"id": 12, "text": "That Council give Bylaw No. 1678 first reading.", "item_order": "5", "on_container": False}]
    plan = check_plan([sub("7.a", "7", "CRD Regional Housing First Program", [10]),
                       sub("7.b", "7", "Access to 2400 and 2420 Millstream Road", [11]),
                       sub("8.a", "8", "BYLAW NO. 1678 Claude Rd", [12])], HEADINGS, EXISTING, MINUTES, "", motions)
    assert {(m["motion_id"], m["to_order"]) for m in plan["moves"]} == {(10, "7.a"), (11, "7.b")}  # 11 by its address
    assert plan["motions_held"] == [{"motion_id": 12, "why": "not on heading 8 or the catch-all"}]


def test_a_headings_only_sub_item_takes_its_motions():
    minutes = "7. REPORTS 7.1 2025 Budget Follow Up Report"
    motions = [{"id": 20, "text": "THAT Committee recommend amending the plan", "item_order": "7.", "on_container": False}]
    plan = check_plan([sub("7.1", "7", "2025 Budget Follow Up Report", [20])], HEADINGS, EXISTING, minutes, "", motions)
    assert plan["moves"] == [{"motion_id": 20, "to_order": "7.1"}]


def test_documents_go_to_the_one_sub_item_they_match():
    from pipeline.backfill.heading_subitems import doc_match
    subs = [{"title": "CRD Regional Housing First Program"}, {"title": "Access to 2400 and 2420 Millstream Road"},
            {"title": 'BYLAW NO. 1678 "Langford Zoning Bylaw, Amendment No. 474, (2681 Claude Rd)'}]
    assert doc_match("Staff report: Regional Housing First Program borrowing", subs)["title"].startswith("CRD")
    assert doc_match("Bylaw No. 1678 (2681 Claude Rd)", subs)["title"].startswith("BYLAW NO. 1678")
    assert doc_match("Remaining Agenda Package Attachments", subs) is None
