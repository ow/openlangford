from pipeline.ingestion.glyphdex_import import folder_for, group_meetings, split_by_year


def test_split_by_year_keeps_years_together_and_balances():
    meetings = [{"date": f"{y}-0{m}-01", "time": "1900"} for y, n in ((2016, 5), (2017, 3), (2018, 2)) for m in range(1, n + 1)]
    shards = split_by_year(meetings, 2)
    years = [{m["date"][:4] for m in shard} for shard in shards]
    assert all(not (a & b) for i, a in enumerate(years) for b in years[i + 1:])
    assert sorted(len(s) for s in shards) == [5, 5]


def test_group_and_folder_names():
    docs = [{"doc_type": "council_minutes", "source_kind": "pdf", "id": "abcdef12-0000", "title": t} for t in (
        "Council 2015 02 02 1900 Regular Agenda Package", "Council 2015 02 02 1900 Regular Minutes (Signed)",
        "Planning, Zoning & Affordable Housing Committee 2019 07 08 1730 Regular Minutes (Signed)")]
    meetings = group_meetings(docs)
    assert [(m["body"], len(m["agenda"]), len(m["minutes"])) for m in meetings] == [("Council", 1, 1), ("Planning, Zoning & Affordable Housing Committee", 0, 1)]
    assert folder_for(meetings[0], "/a").endswith("Council/2015/02/2015-02-02 700pm Regular Council [gx-abcdef12]")
    assert folder_for(meetings[1], "/a").endswith("2019-07-08 530pm Planning, Zoning & Affordable Housing Committee [gx-abcdef12]")
