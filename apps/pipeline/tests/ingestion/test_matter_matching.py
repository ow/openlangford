
def test_section_headings_are_not_topics():
    from pipeline.ingestion.matter_matching import is_matter_eligible
    for heading in ["DEVELOPMENT VARIANCE PERMIT (block)", "DEVELOPMENT VARIANCE PERMIT", "TEMPORARY USE PERMITS", "Rezoning"]:
        assert is_matter_eligible(identifier=None, title=heading, related_addresses=["123 Main St"])[0] is False
    assert is_matter_eligible(identifier=None, title="Development Variance Permit - 797 Revilo Road (DVP24-0008)",
                              related_addresses=["797 Revilo Road"])[0] is True


def test_a_named_application_is_not_a_heading():
    from pipeline.ingestion.matter_matching import is_generic_or_procedural_matter
    assert not is_generic_or_procedural_matter("Zoning Amendment Adoption — Meaford Ave & Millstream Rd (1638)")
    assert is_generic_or_procedural_matter("Zoning bylaw amendments")


def _matcher(*matters):
    from unittest.mock import MagicMock
    from pipeline.ingestion.matter_matching import MatterMatcher, normalize_address

    matcher = MatterMatcher(MagicMock())
    matcher._loaded = True
    matcher.matters = [{"status": "Active", "category": "Development", "meta": {}, **m,
                        "_addresses": {normalize_address(a) for a in m.get("addresses", [])}} for m in matters]
    matcher._build_identifier_index()
    matcher._build_address_index()
    return matcher


def test_city_wide_bylaws_never_identify_a_topic():
    # Katie's Pond (DVP13-0020) cited Zoning Bylaw No. 300 and attracted variances on Selwyn Road and Jeanine Drive.
    matcher = _matcher({"id": 2527, "title": "Development variance permit for proposed lots in phases 2 and 3",
                        "identifier": "DVP13-0020; Zoning Bylaw No. 300", "addresses": ["3467 Happy Valley Road"]},
                       {"id": 1823, "title": "628 Kestrel Ridge rear-yard variance", "identifier": "Zoning Bylaw No. 300",
                        "addresses": ["628 Kestrel Ridge"]})
    for identifier, title, addresses in [
        ("DVP11-0026; Zoning Bylaw No. 300", "DVP11-0026 - 2585 Selwyn Road", ["2585 Selwyn Road"]),
        ("Zoning Bylaw No. 300", "Application to vary the minimum lot width at 2566 Jeanine Drive", ["2566 Jeanine Drive"]),
        ("Subdivision and Development Servicing Bylaw No. 1000", "Frontage variance at 671 Hoylake Avenue", ["671 Hoylake Avenue"]),
    ]:
        assert matcher.find_match(identifier, title, addresses)[0] is None, title


def test_a_citing_item_still_finds_its_own_topic():
    matcher = _matcher({"id": 2527, "title": "Development variance permit for proposed lots in phases 2 and 3",
                        "identifier": "DVP13-0020; Zoning Bylaw No. 300", "addresses": ["3467 Happy Valley Road"]})
    match = matcher.find_match("DVP13-0020; Zoning Bylaw No. 300", "DVP13-0020 - 927 & 931 Lobo Vale & 3467 Happy Valley Road",
                               ["3467 Happy Valley Road"])
    assert match[0] == 2527 and match[1].startswith("identifier_exact")


def test_amendment_bylaws_keep_their_own_identity():
    from pipeline.ingestion.matter_matching import bylaw_identifiers, identifying, identifying_identifier

    title = 'BYLAW NO. 1927 "Langford Zoning Bylaw, Amendment No. 706, (957 Walfred Road), Bylaw No. 1927"'
    assert identifying(bylaw_identifiers(title + " amends Zoning Bylaw No. 300")) == {"Bylaw 1927"}
    assert identifying_identifier("Zoning Bylaw No. 300; DVP13-0020") == "DVP13-0020"
    assert identifying_identifier("Zoning Bylaw No. 300") is None
    matcher = _matcher({"id": 9, "title": "957 Walfred Road rezoning", "identifier": "Bylaw No. 1927; Zoning Bylaw No. 300"})
    assert matcher.find_match("Bylaw No. 1927", title)[0] == 9


def test_regroup_finds_topics_spanning_unrelated_streets():
    from pipeline.ingestion.topic_regroup import street_groups

    entries = [{"id": 1, "addresses": ["927 Lobo Vale", "3467 Happy Valley Road"]},
               {"id": 2, "addresses": ["3467 Happy Valley Rd"]},
               {"id": 3, "addresses": ["2585 Selwyn Road"]},
               {"id": 4, "addresses": []}]
    assert sorted(map(sorted, street_groups(entries))) == [[1, 2], [3]]
