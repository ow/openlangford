from pipeline.ingestion.properties import display, parse_addresses, resolve, slug_of


def keys(text, need_type=False):
    return [(a.get("number") or a.get("range"), a["name"], a["type"]) for a in parse_addresses(text, need_type=need_type)]


def test_plain_and_abbreviated_addresses():
    assert keys("2207 Millstream Rd") == [("2207", "Millstream", "Road")]
    assert keys("2181 Bear Mountain Pkwy") == [("2181", "Bear Mountain", "Parkway")]
    assert keys("981 Capella") == [("981", "Capella", None)]
    assert keys("Alexander Mackie — 753 Station Road") == [("753", "Station", "Road")]


def test_several_lots_units_and_ranges():
    assert keys("2848 and 2852 Millstream Rd") == [("2848", "Millstream", "Road"), ("2852", "Millstream", "Road")]
    assert keys("2610/2612 Sooke Road") == [("2610", "Sooke", "Road"), ("2612", "Sooke", "Road")]
    assert keys("105-693 Hoffman Ave") == [("693", "Hoffman", "Avenue")]
    assert keys("105 & 111 - 945 Reunion Avenue") == [("945", "Reunion", "Avenue")]
    assert keys("Unit 106 - 4342 West Shore Parkway") == [("4342", "West Shore", "Parkway")]
    assert keys("1216-1230 Goldstream Ave") == [((1216, 1230), "Goldstream", "Avenue")]
    assert keys("400-500 block Goldstream Avenue") == []


def test_titles_need_a_street_type():
    title = 'BYLAW NO. 1949 "Langford Zoning Bylaw, Amendment No. 611, (2848 and 2852 Millstream Rd), Bylaw No. 1949, 2021."'
    assert keys(title, need_type=True) == [("2848", "Millstream", "Road"), ("2852", "Millstream", "Road")]
    assert keys("2020-2024 Financial Plan and 2020 Tax Rates", need_type=True) == []
    assert keys("Road Closure Bylaw No. 2074 (Strandlund Avenue) - 639 & 641 Strandlund", need_type=True) == []
    assert keys("OCP Amendment — 2929 & 2995 Sooke Rd; 3201 & 3211 Loledo Pl (Bylaw 1873)", need_type=True) == [
        ("2929", "Sooke", "Road"), ("2995", "Sooke", "Road"), ("3201", "Loledo", "Place"), ("3211", "Loledo", "Place")]


def test_resolve_joins_spellings_expands_ranges_and_skips_city_hall():
    sources = [(a, {"id": i}) for i, text in enumerate([
        "2207 Millstream Road", "2207 Millstream Rd", "981 Capella", "981 Capella Ave",
        "1220 Goldstream Ave", "1221 Goldstream Ave", "976 Tayberry Terrace", "977 Tayberry", "1216-1230 Goldstream Ave", "877 Goldstream Avenue"])
        for a in parse_addresses(text, need_type=False)]
    groups = resolve(sources)
    assert len(groups[("2207", "millstream", "Road")]) == 2
    assert len(groups[("981", "capella", "Avenue")]) == 2
    # The range reaches 1216, 1220 and 1230 (even, like its ends), not the odd 1221.
    assert [s["id"] for s in groups[("1220", "goldstream", "Avenue")]] == [4, 8]
    assert ("1216", "goldstream", "Avenue") in groups and [s["id"] for s in groups[("1221", "goldstream", "Avenue")]] == [5]
    assert display(("2730", "trans-canada", "Highway")) == "2730 Trans-Canada Highway"
    assert ("877", "goldstream", "Avenue") not in groups
    assert ("977", "tayberry", "Terrace") in groups  # the street's only type
    assert display(("2750", "leigh", "Road")) == "2750 Leigh Road" and slug_of(("2750", "leigh", "Road")) == "2750-leigh-road"


def test_legal_descriptions_and_run_ons_are_not_addresses():
    assert keys("2730 Trans-Canada Hwy") == [("2730", "Trans-Canada", "Highway")]
    assert keys("Section 114 Esquimalt District Plan VIP1234") == []
    assert keys("PID 87674") == [] and keys("3275 Walfred PP") == []
    assert keys("1121 Bearspaw Plat") == [("1121", "Bearspaw", "Plateau")]
