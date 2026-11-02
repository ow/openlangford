
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
