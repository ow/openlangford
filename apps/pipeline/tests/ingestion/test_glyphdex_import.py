from pipeline.ingestion.glyphdex_import import folder_for, group_meetings, matches_existing, split_by_meeting


def test_split_by_meeting_round_robins_by_date_and_balances():
    meetings = [{"date": f"{y}-0{m}-01", "time": "1900", "body": "Council"}
                for y, n in ((2016, 5), (2017, 3), (2018, 2)) for m in range(1, n + 1)]
    shards = split_by_meeting(meetings[::-1], 3)
    assert sorted(len(s) for s in shards) == [3, 3, 4]
    for shard in shards:  # each shard stays in date order, and years are mixed across workers
        assert [m["date"] for m in shard] == sorted(m["date"] for m in shard)
        assert len({m["date"][:4] for m in shard}) > 1


def test_split_by_meeting_more_workers_than_meetings():
    assert len(split_by_meeting([{"date": "2020-01-01", "time": "1900", "body": "Council"}], 4)) == 1


def test_group_and_folder_names():
    docs = [{"doc_type": "council_minutes", "source_kind": "pdf", "id": "abcdef12-0000", "title": t} for t in (
        "Council 2015 02 02 1900 Regular Agenda Package", "Council 2015 02 02 1900 Regular Minutes (Signed)",
        "Planning, Zoning & Affordable Housing Committee 2019 07 08 1730 Regular Minutes (Signed)")]
    meetings = group_meetings(docs)
    assert [(m["body"], len(m["agenda"]), len(m["minutes"])) for m in meetings] == [("Council", 1, 1), ("Planning, Zoning & Affordable Housing Committee", 0, 1)]
    assert folder_for(meetings[0], "/a").endswith("Council/2015/02/2015-02-02 700pm Regular Council [gx-abcdef12]")
    assert folder_for(meetings[1], "/a").endswith("2019-07-08 530pm Planning, Zoning & Affordable Housing Committee [gx-abcdef12]")


# --- already_ingested matching: real 2023-2026 examples (SHA-256-verified, see research/glyphdex/2023-2026-overlap.md) ---

def _gx(body, date, kind="Regular"):
    return {"body": body, "date": date, "kind": kind}


def _ours(date, title, type_, org):
    return {"meeting_date": date, "title": title, "type": type_, "organization": {"name": org}}


COUNCIL_DAY = [_ours("2024-05-06", "Regular Council", "Regular Council", "Council"),
               _ours("2024-05-06", "Special Council", "Special Council", "Council")]


def test_committee_of_the_whole_is_filed_under_council():
    # Glyphdex "Committee of the Whole 2023 08 21 1300" is our CoW row (same day as a Regular Council)
    rows = [_ours("2023-08-21", "Regular Council", "Regular Council", "Council"),
            _ours("2023-08-21", "Committee of the Whole", "Committee of the Whole", "Council")]
    assert matches_existing(_gx("Committee of the Whole", "2023-08-21"), rows)
    assert not matches_existing(_gx("Committee of the Whole", "2023-08-21"), rows[:1])


def test_committee_of_the_whole_date_can_be_a_day_off():
    # Glyphdex 2024-02-08 is our 2024-02-09 meeting
    rows = [_ours("2024-02-09", "Committee of the Whole", "Committee of the Whole", "Council")]
    assert matches_existing(_gx("Committee of the Whole", "2024-02-08"), rows)
    assert not matches_existing(_gx("Committee of the Whole", "2024-02-07"), rows)


def test_council_kind_must_match_regular_vs_special():
    assert matches_existing(_gx("Council", "2024-05-06", "Special"), COUNCIL_DAY[1:])
    assert not matches_existing(_gx("Council", "2024-05-06", "Special"), COUNCIL_DAY[:1])
    assert not matches_existing(_gx("Council", "2024-05-06", "Regular"), COUNCIL_DAY[1:])


def test_council_does_not_match_committee_of_the_whole():
    cow = [_ours("2023-03-27", "Committee of the Whole", "Committee of the Whole", "Council")]
    assert not matches_existing(_gx("Council", "2023-03-27", "Special"), cow)


def test_special_council_a_day_off():
    # Glyphdex 2024-12-16 1900 Special is our 2024-12-17 Special Council
    assert matches_existing(_gx("Council", "2024-12-16", "Special"), [_ours("2024-12-17", "Special Council", "Special Council", "Council")])


def test_community_advisory_committee_is_our_generic_advisory_committee():
    # Glyphdex "Community Advisory Committee 2023 06 27" is our 'Advisory Committee' meeting; 2025-02-25 is our 02-26
    rows = [_ours("2023-06-27", "Advisory Committee", "Advisory Committee", "Advisory Committee")]
    assert matches_existing(_gx("Community Advisory Committee", "2023-06-27"), rows)
    assert matches_existing(_gx("Community Advisory Committee", "2023-06-28"), rows)
    # 2023-07-11 (Special) has no counterpart: our nearest is the 07-25 regular meeting, 14 days away
    assert not matches_existing(_gx("Community Advisory Committee", "2023-07-11", "Special"),
                                [_ours("2023-07-25", "Advisory Committee", "Advisory Committee", "Advisory Committee")])


def test_sustainable_development_and_variance_bodies_never_match_neighbouring_meetings():
    # SDAC 2025-03-10 sits next to our 2025-03-11 Special Council; BoV 2023-07-26 next to our 2023-07-25 Advisory Committee
    assert not matches_existing(_gx("Sustainable Development Advisory Committee", "2025-03-10"),
                                [_ours("2025-03-11", "Special Council", "Special Council", "Council")])
    assert not matches_existing(_gx("Sustainable Development Advisory Committee", "2024-04-08"),
                                [_ours("2024-04-08", "Special Council", "Special Council", "Council")])
    assert not matches_existing(_gx("Board of Variance", "2023-07-26"),
                                [_ours("2023-07-25", "Advisory Committee", "Advisory Committee", "Advisory Committee")])
    # but our own SDAC organization on the same date is a match
    assert matches_existing(_gx("Sustainable Development Advisory Committee", "2026-11-09"),
                            [_ours("2026-11-09", "Sustainable Development Advisory Committee", "Advisory Committee",
                                   "Sustainable Development Advisory Committee")])


def test_pre_2023_standing_committee_same_date_still_matches():
    body = "Planning, Zoning & Affordable Housing Committee"
    rows = [_ours("2019-07-08", body, "Standing Committee", body)]
    assert matches_existing(_gx(body, "2019-07-08"), rows)
    assert not matches_existing(_gx(body, "2019-07-09"), rows)
