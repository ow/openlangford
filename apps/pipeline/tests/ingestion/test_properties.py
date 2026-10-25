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


def test_spellings_with_the_same_slug_are_one_property():
    sources = [(a, {"id": i}) for i, text in enumerate(["2730 Trans-Canada Hwy", "2730 Trans Canada Highway", "2730 Trans-Canada Highway"])
               for a in parse_addresses(text, need_type=False)]
    assert list(resolve(sources)) == [("2730", "trans-canada", "Highway")]


def test_street_only_mentions():
    from pipeline.ingestion.properties import parse_street
    assert parse_street("Leigh Road") == {"number": "", "name": "Leigh", "type": "Road"}
    assert parse_street("Portion of McCallum Road")["name"] == "McCallum"
    assert parse_street("Veterans Memorial Park") is None and parse_street("2750 Leigh Road") is None
    assert display(("", "leigh", "Road")) == "Leigh Road" and slug_of(("", "leigh", "Road")) == "leigh-road"


def test_geocode_reports_precision():
    from pipeline.ingestion.properties import geocode

    class Response:
        def __init__(self, data): self.data = data
        def raise_for_status(self): pass
        def json(self): return self.data

    house = geocode("2750 Leigh Road", get=lambda *a, **k: Response([{"lat": "48.45", "lon": "-123.5", "addresstype": "house"}]))
    road = geocode("2751 Leigh Road", get=lambda *a, **k: Response([{"lat": "48.45", "lon": "-123.5", "addresstype": "road"}]))
    assert house["precision"] == "address" and road["precision"] == "street"
    assert geocode("nowhere", get=lambda *a, **k: Response([])) is None


def test_pins_shared_by_several_lots_are_not_exact():
    from pipeline.ingestion.properties import shared_points
    rows = [{"id": 1, "geo": {"lat": 48.47059271, "lng": -123.5038207}}, {"id": 2, "geo": {"lat": 48.4705927, "lng": -123.5038207}},
            {"id": 3, "geo": {"lat": 48.4703, "lng": -123.5036}}]
    assert shared_points(rows) == {1, 2}


def test_bc_geocoder_accepts_parcels_and_blocks_only():
    from pipeline.ingestion.properties import bc_geocode

    class Response:
        def __init__(self, data): self.data = data
        def raise_for_status(self): pass
        def json(self): return self.data

    def answer(precision, score=99, where="2750 Leigh Rd, Langford, BC"):
        feature = {"geometry": {"coordinates": [-123.51, 48.45]},
                   "properties": {"matchPrecision": precision, "score": score, "fullAddress": where}}
        return lambda *a, **k: Response({"features": [feature]})

    assert bc_geocode("1234 Goldstream Avenue", get=answer("CIVIC_NUMBER"))["precision"] == "address"
    assert bc_geocode("2750 Leigh Road", get=answer("BLOCK")) == {"lat": 48.45, "lng": -123.51, "precision": "block", "source": "bc"}
    assert bc_geocode("2750 Leigh Road", get=answer("STREET")) is None
    assert bc_geocode("2750 Leigh Road", get=answer("BLOCK", score=70)) is None
    assert bc_geocode("2750 Leigh Road", get=answer("BLOCK", where="2750 Leigh Rd, Colwood, BC")) is None


def test_years_and_spacing_variants():
    assert keys("Contract 2019-2024 Eagle Ridge Centre") == []
    assert keys("2019 Eagle Ridge") == [] and keys("2016 Apple Day Fund-Raising Drive") == []
    assert keys("2000 Hannington Road") == [("2000", "Hannington", "Road")]
    sources = [(a, {"id": i}) for i, text in enumerate(["4342 West Shore Parkway", "4342 West Shore Pkwy", "4342 Westshore Parkway"])
               for a in parse_addresses(text, need_type=False)]
    assert list(resolve(sources)) == [("4342", "west shore", "Parkway")]
    assert display(("116", "mccallum", "Road")) == "116 McCallum Road"
