"""Tests for pipeline.ingestion.matter_matching module.

Covers: normalize_identifier, parse_compound_identifier, extract_addresses,
        normalize_address, extract_numbers, check_number_mismatch,
        MatterMatcher initialization and matching.
"""

import pytest
from unittest.mock import MagicMock

from pipeline.ingestion.matter_matching import (
    normalize_identifier,
    parse_compound_identifier,
    extract_addresses,
    normalize_address,
    extract_numbers,
    check_number_mismatch,
    _extract_category_keywords,
    clean_matter_title,
    detect_entity_cluster,
    is_generic_or_procedural_matter,
    is_matter_eligible,
    is_valid_matter_identifier,
    matter_aliases_for_cluster,
    MatterMatcher,
)


# --- normalize_identifier ---


class TestNormalizeIdentifier:
    def test_bylaw_with_no(self):
        assert normalize_identifier("Bylaw No. 1160") == "Bylaw 1160"

    def test_bylaw_without_no(self):
        assert normalize_identifier("Bylaw 1160") == "Bylaw 1160"

    def test_amendment_bylaw(self):
        assert normalize_identifier("Amendment Bylaw No. 1101") == "Bylaw 1101"

    def test_rezoning(self):
        assert normalize_identifier("Rezoning Application No. 2025-01") == "REZ 2025-01"

    def test_rez_abbreviation(self):
        assert normalize_identifier("REZ 2025-01") == "REZ 2025-01"

    def test_tup(self):
        assert normalize_identifier("Temporary Use Permit No. 2025-03") == "TUP 2025-03"

    def test_dvp(self):
        assert normalize_identifier("Development Variance Permit No. 2024-01") == "DVP 2024-01"

    def test_dp(self):
        assert normalize_identifier("Development Permit No. 2024-02") == "DP 2024-02"

    def test_empty_string(self):
        assert normalize_identifier("") == ""

    def test_none(self):
        assert normalize_identifier(None) == ""

    def test_fallback_strips_whitespace(self):
        assert normalize_identifier("  Some   Other  Thing  ") == "Some Other Thing"

    def test_rezoning_with_slash(self):
        assert normalize_identifier("Rezoning Application No. 2025/01") == "REZ 2025-01"


# --- parse_compound_identifier ---


class TestParseCompoundIdentifier:
    def test_single_identifier(self):
        assert parse_compound_identifier("Bylaw No. 1160") == ["Bylaw 1160"]

    def test_compound_semicolon(self):
        result = parse_compound_identifier("Bylaw No. 1160; REZ 2025-01")
        assert len(result) == 2
        assert "Bylaw 1160" in result
        assert "REZ 2025-01" in result

    def test_empty_string(self):
        assert parse_compound_identifier("") == []

    def test_none(self):
        assert parse_compound_identifier(None) == []

    def test_short_parts_filtered(self):
        # Parts with <= 2 chars after normalization should be filtered
        assert parse_compound_identifier("AB") == []


class TestMatterEligibility:
    def test_bare_numeric_identifier_is_not_valid(self):
        assert is_valid_matter_identifier("6") is False

    def test_bylaw_identifier_is_valid(self):
        assert is_valid_matter_identifier("Bylaw No. 1843") is True

    def test_public_participation_is_procedural_even_with_number_prefix(self):
        assert clean_matter_title("6. PUBLIC PARTICIPATION") == "PUBLIC PARTICIPATION"
        assert is_generic_or_procedural_matter("6. PUBLIC PARTICIPATION") is True

    def test_public_participation_not_eligible_with_fake_identifier(self):
        eligible, reason = is_matter_eligible(
            identifier="6",
            title="PUBLIC PARTICIPATION",
            category="Public Input",
        )
        assert eligible is False
        assert reason == "generic_or_procedural"

    def test_design_guidelines_alone_is_not_eligible(self):
        eligible, reason = is_matter_eligible(
            identifier=None,
            title="Design Guidelines (approx. 30 min)",
            category="Planning",
        )
        assert eligible is False
        assert reason == "generic_or_procedural"

    def test_ymca_aquatic_centre_title_is_eligible_cluster(self):
        eligible, reason = is_matter_eligible(
            identifier=None,
            title="Langford Aquatic Centre - Supplementary Agreement with YMCA",
            category="Parks & Recreation",
        )
        assert eligible is True
        assert reason == "entity_cluster"

    def test_ymca_nearby_reference_does_not_match_cluster(self):
        assert detect_entity_cluster("1000 metres from Westhills YMCA") is None

    def test_ymca_agreement_matches_cluster(self):
        assert (
            detect_entity_cluster(
                "Langford Aquatic Centre Supplementary Agreement with YMCA"
            )
            == "langford_aquatic_centre_ymca"
        )

    def test_cluster_aliases_include_westhills_y(self):
        aliases = matter_aliases_for_cluster("langford_aquatic_centre_ymca")
        assert "westhills y" in aliases


# --- extract_addresses ---


class TestExtractAddresses:
    def test_simple_address(self):
        result = extract_addresses("Discussion about 258 Helmcken Road")
        assert len(result) == 1
        assert "258 helmcken road" in result[0]

    def test_multiple_addresses(self):
        result = extract_addresses("Properties at 100 View Royal Avenue and 200 Helmcken Road")
        assert len(result) == 2

    def test_no_address(self):
        assert extract_addresses("No addresses here") == []

    def test_empty_string(self):
        assert extract_addresses("") == []

    def test_none(self):
        assert extract_addresses(None) == []


# --- normalize_address ---


class TestNormalizeAddress:
    def test_expands_abbreviations(self):
        assert normalize_address("258 Helmcken Rd") == "258 helmcken road"

    def test_lowercases(self):
        assert normalize_address("100 VIEW ROYAL AVENUE") == "100 view royal avenue"

    def test_empty(self):
        assert normalize_address("") == ""

    def test_none(self):
        assert normalize_address(None) == ""


# --- extract_numbers ---


class TestExtractNumbers:
    def test_extracts_numbers(self):
        assert extract_numbers("Bylaw 1160 and REZ 2025-01") == {"1160", "2025", "01"}

    def test_empty_string(self):
        assert extract_numbers("") == set()

    def test_none(self):
        assert extract_numbers(None) == set()

    def test_no_numbers(self):
        assert extract_numbers("no numbers here") == set()


# --- check_number_mismatch ---


class TestCheckNumberMismatch:
    def test_matching_numbers(self):
        assert check_number_mismatch("Bylaw 258", "Bylaw 258") is False

    def test_disjoint_numbers(self):
        assert check_number_mismatch("Bylaw 1156", "Bylaw 1157") is True

    def test_subset_numbers(self):
        assert check_number_mismatch("Bylaw 258", "Bylaw 258 REZ 2025") is False

    def test_partial_overlap_mismatch(self):
        assert check_number_mismatch("Bylaw 2016 Section 7", "Bylaw 2016 Section 9") is True

    def test_no_numbers_either_side(self):
        assert check_number_mismatch("No numbers", "Also none") is False


# --- _extract_category_keywords ---


class TestExtractCategoryKeywords:
    def test_rezoning(self):
        assert "rezoning" in _extract_category_keywords("Rezoning Application for 100 Main St")

    def test_bylaw(self):
        assert "bylaw" in _extract_category_keywords("Amendment Bylaw No. 1101")

    def test_multiple_categories(self):
        cats = _extract_category_keywords("Rezoning and Bylaw Amendment")
        assert "rezoning" in cats
        assert "bylaw" in cats

    def test_empty(self):
        assert _extract_category_keywords("") == set()

    def test_none(self):
        assert _extract_category_keywords(None) == set()


# --- MatterMatcher ---


class TestMatterMatcher:
    def test_init_defaults(self, mock_supabase):
        matcher = MatterMatcher(mock_supabase)
        assert matcher.municipality_id == 1
        assert matcher._loaded is False
        assert matcher.matters == []

    def test_find_match_triggers_load(self, mock_supabase):
        matcher = MatterMatcher(mock_supabase)
        # find_match should trigger load if not loaded
        result = matcher.find_match("Bylaw 123", "Test Title")
        assert matcher._loaded is True
        # With no matters loaded, should return no match
        assert result == (None, "no_match", 0.0)

    def test_find_match_exact_identifier(self, mock_supabase):
        matcher = MatterMatcher(mock_supabase)
        # Pre-load a matter
        matcher._loaded = True
        matter = {
            "id": 42,
            "title": "Noise Control Bylaw",
            "identifier": "Bylaw 1450",
            "status": "Active",
            "category": "Bylaw",
            "_addresses": set(),
        }
        matcher.matters = [matter]
        matcher._build_identifier_index()
        matcher._build_address_index()

        result = matcher.find_match("Bylaw No. 1450", "Noise Control")
        assert result[0] == 42
        assert "identifier_exact" in result[1]
        assert result[2] == 1.0

    def test_find_match_no_match(self, mock_supabase):
        matcher = MatterMatcher(mock_supabase)
        matcher._loaded = True
        matcher.matters = []
        matcher._build_identifier_index()
        matcher._build_address_index()

        result = matcher.find_match(None, "Random Title")
        assert result == (None, "no_match", 0.0)

    def test_add_matter_to_indices(self, mock_supabase):
        matcher = MatterMatcher(mock_supabase)
        matcher._loaded = True
        matcher._build_identifier_index()
        matcher._build_address_index()
        matcher._build_entity_cluster_index()

        new_matter = {
            "id": 99,
            "title": "Test Matter",
            "identifier": "Bylaw 999",
            "status": "Active",
            "category": "Bylaw",
            "_addresses": {"100 test road"},
        }
        matcher._add_matter_to_indices(new_matter)

        assert len(matcher.matters) == 1
        assert "bylaw 999" in matcher.identifier_index
        assert "100 test road" in matcher.address_index

    def test_find_match_by_entity_cluster(self, mock_supabase):
        matcher = MatterMatcher(mock_supabase)
        matcher._loaded = True
        matter = {
            "id": 214,
            "title": "Langford Aquatic Centre / YMCA Operating Agreement",
            "identifier": None,
            "status": "Active",
            "category": "Parks & Recreation",
            "meta": {
                "entity_cluster": "langford_aquatic_centre_ymca",
                "matter_quality": "canonical",
            },
            "_addresses": set(),
        }
        matcher.matters = [matter]
        matcher._build_identifier_index()
        matcher._build_address_index()
        matcher._build_entity_cluster_index()

        result = matcher.find_match(
            None,
            "Westhills Aquatic Centre Supplementary Agreement for 2025-2027",
        )

        assert result[0] == 214
        assert "entity_cluster" in result[1]

class TestBylawBundleIdentity:
    def test_plural_bundle_matches_existing_semicolon_bundle(self, mock_supabase):
        matcher = MatterMatcher(mock_supabase)
        matcher._loaded = True
        matcher._add_matter_to_indices({"id": 205, "title": "Amenity Cost Charge and related bylaws",
            "identifier": "Bylaw No. 2275; Bylaw No. 2270; Bylaw No. 2271"})
        assert matcher.find_match("Bylaw Nos. 2275, 2270 & 2271", "Amenity Cost Charge, Inclusionary Zoning, and Reserve Funds Establishment Bylaws")[0] == 205

    def test_title_only_bylaw_is_matched_by_identity(self, mock_supabase):
        matcher = MatterMatcher(mock_supabase)
        matcher._loaded = True
        matcher._add_matter_to_indices({"id": 10, "title": "Noise Control Bylaw No. 2275", "identifier": None})
        assert matcher.find_match("Bylaw 2275", "Adoption")[0] == 10

    def test_shared_parent_bylaw_does_not_merge_different_variances(self, mock_supabase):
        matcher = MatterMatcher(mock_supabase)
        matcher._loaded = True
        matcher._add_matter_to_indices({"id": 1607, "title": "Prepare notices to vary Bylaw No. 1000 for Centre Mountain BP8", "identifier": "Bylaw No. 1000; Centre Mountain"})
        assert matcher.find_match("Bylaw 1000", "Development Variance Permit to vary Bylaw No. 1000 at 2181 Bear Mountain Parkway")[0] is None

    def test_single_bylaw_does_not_collapse_into_similar_bundle(self, mock_supabase):
        matcher = MatterMatcher(mock_supabase)
        matcher._loaded = True
        matcher._add_matter_to_indices({"id": 205, "title": "Amenity Cost Charge and related bylaws", "identifier": "Bylaw 2275; Bylaw 2270; Bylaw 2271"})
        assert matcher.find_match("Bylaw 2275", "Amenity Cost Charge and related bylaws")[0] is None


class TestLangfordMatchingRegressions:
    """Duplicates found in Langford data (Oct 2026)."""

    def test_bare_and_plural_bylaw_numbers(self):
        assert parse_compound_identifier("1852; 1853") == ["Bylaw 1852", "Bylaw 1853"]
        assert parse_compound_identifier("BYLAW NOS. 1634; 1635; 1636") == ["Bylaw 1634", "Bylaw 1635", "Bylaw 1636"]
        assert parse_compound_identifier("2021; 1990") == ["2021", "Bylaw 1990"] or "Bylaw 2021" not in parse_compound_identifier("2021; 1990")

    def test_langford_permit_codes(self):
        assert parse_compound_identifier("TUP16-0006 (Renewal)") == ["TUP 16-0006"]
        assert parse_compound_identifier("TUP26-0001 - 2899 Sooke Lake Rd") == ["TUP 26-0001"]
        assert normalize_identifier("Planning Z17-0002") == "Z 17-0002"

    def test_stage_is_not_identity(self):
        from pipeline.ingestion.matter_matching import strip_stage
        assert strip_stage("Solid Waste Collection Bylaw No. 2299, 2026 (FIRST, SECOND AND THIRD READINGS)") == "Solid Waste Collection Bylaw No. 2299, 2026"
        assert strip_stage("Tax Rates Bylaw (Adoption)") == "Tax Rates Bylaw"
        assert strip_stage("OCP Amendment for 734 Latoria Road - First Reading") == "OCP Amendment for 734 Latoria Road"

    def _matcher(self, matters):
        m = MatterMatcher(MagicMock(), municipality_id=1)
        m.matters = matters
        for x in matters:
            x.setdefault("_addresses", set())
        m._build_identifier_index()
        m._build_address_index()
        m._build_entity_cluster_index()
        m._loaded = True
        return m

    def test_combined_site_bylaws_match_single(self):
        matcher = self._matcher([
            {"id": 661, "title": "Second & Third Readings — Happy Valley Rd rezoning", "identifier": "BYLAW 1694", "meta": {}},
        ])
        mid, reason, _ = matcher.find_match("BYLAW 1694; BYLAW 1703", "Rezoning 3690 & 3694 Happy Valley Rd to RS4")
        assert mid == 661

    def test_parent_bylaw_citation_does_not_match_unrelated(self):
        matcher = self._matcher([
            {"id": 1, "title": "Langford Building Bylaw No. 1160", "identifier": "Bylaw 1160", "meta": {}},
        ])
        mid, _, _ = matcher.find_match("Bylaw No. 1160; Bylaw No. 2283", "Zero Carbon Step Code amendment")
        assert mid is None

    def test_omnibus_never_matches_by_overlap(self):
        matcher = self._matcher([
            {"id": 5, "title": "Fees and Charges Amendment No. 10", "identifier": "Bylaw No. 1636", "meta": {}},
        ])
        mid, _, _ = matcher.find_match("BYLAW NOS. 1634; 1635; 1636", "Amendments to Building, Servicing and Fees bylaws")
        assert mid is None


def test_container_items_are_not_matters():
    from pipeline.ingestion.matter_matching import is_generic_or_procedural_matter
    for t in ["NOTICE OF MOTION", "Community Advisory Committee Meeting Resolutions - April 28, 2026",
              "Receipt of committee minutes", "Multiple bylaws for consideration (see agenda)", "Bylaw adoptions"]:
        assert is_generic_or_procedural_matter(t), t
    for t in ["Solid Waste Collection Bylaw No. 2299", "Rezoning 734 Latoria Road", "Parking Bylaw Modernization"]:
        assert not is_generic_or_procedural_matter(t), t


def test_more_container_titles():
    from pipeline.ingestion.matter_matching import is_generic_or_procedural_matter
    for t in ["Resolutions from March Committee of the Whole meetings", "Notices of Intent (block)",
              "Committee of the Whole resolutions", "Planning notices of intent"]:
        assert is_generic_or_procedural_matter(t), t
