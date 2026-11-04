from pipeline.ingestion.bylaw_matter_links import plan_links
from pipeline.ingestion.langford_bylaws import STATUS_AMENDED, STATUS_IN_FORCE, derive_status, display_title
from pipeline.scrapers.langford_bylaws import (
    BylawSource,
    is_bylaw_document,
    merge_sources,
    number_from_filename,
    parse_directory,
    parse_media,
)

DIRECTORY_HTML = """
<a href="https://langford.ca/wp-content/uploads/2020/10/Board-of-Variance-Bylaw-No.-1413.pdf" target="_blank"><div class="bylaw-cell body2 " categories="administration, "><span class="bylaw-title">Board of Variance (Bylaw No. 1413)</span></div></a>
<a href="https://langford.ca/wp-content/uploads/2022/05/Bylaw-1819-Elections-CONSOLIDATED-to-May-19-2026.pdf" target="_blank"><div class="bylaw-cell body2 " categories="administration, "><span class="bylaw-title">Elections (Bylaw No. 1819) &#8211; Consolidated</span></div></a>
<a href="https://langford.ca/wp-content/uploads/2024/11/Tree-Protection-Bylaw-No.-2269.pdf" target="_blank"><div class="bylaw-cell body2 " categories="land-use, services, "><span class="bylaw-title">Tree Protection Bylaw</span></div></a>
<a href="https://langford.ca/wp-content/uploads/2020/10/BYLAW-1234-SIGNED.pdf" target="_blank"><div class="bylaw-cell body2 " categories="finance, "><span class="bylaw-title">Tax Rate Bylaw 2009</span></div></a>
<a href="https://langford.ca/wp-content/uploads/Tree-Application.pdf" target="_blank"><div class="bylaw-cell body2 " categories="land-use, "><span class="bylaw-title">Tree Permit Application Form</span></div></a>
<a href="https://langford.ca/wp-content/uploads/POL-0186.pdf" target="_blank"><div class="bylaw-cell body2 " categories="community-standards, "><span class="bylaw-title">Good Neighbour Policy</span></div></a>
"""


def test_parse_directory():
    rows = parse_directory(DIRECTORY_HTML)
    assert [(r.bylaw_number, r.title) for r in rows] == [
        ("1413", "Board of Variance (Bylaw No. 1413)"),
        ("1819", "Elections (Bylaw No. 1819) – Consolidated"),
        ("2269", "Tree Protection Bylaw"),  # number from the filename
        ("1234", "Tax Rate Bylaw 2009"),  # "2009" is the year; number from the filename
    ]
    assert rows[1].consolidated and rows[1].listed_current
    assert rows[2].category == "Land use, Services"


def test_media_filters_notices_and_addresses():
    items = [
        {"date": "2026-02-13T00:00:00", "title": {"rendered": "Notice of Rezoning Bylaw &#8211; 1234 Goldstream Avenue &#8211; Z25-0008"},
         "source_url": "https://langford.ca/wp-content/uploads/2026/02/Notice-of-Rezoning-Bylaw-1234-Goldstream-Avenue-Z25-0008.pdf"},
        {"date": "2026-02-13T00:00:00", "title": {"rendered": "Bylaw 2248"},
         "source_url": "https://langford.ca/wp-content/uploads/2026/02/Bylaw-2248.pdf"},
        {"date": "2021-05-01T00:00:00", "title": {"rendered": "Bylaw 1761 Gazette Ad"},
         "source_url": "https://langford.ca/wp-content/uploads/2021/05/20210419-Bylaw-1761-Gazette-Ad.pdf"},
        {"date": "2026-04-30T00:00:00", "title": {"rendered": "Bylaw No 2233 Patio Permit Application"},
         "source_url": "https://langford.ca/wp-content/uploads/2026/04/Bylaw-No-2233-Patio-Permit-Application.pdf"},
        {"date": "2025-06-04T00:00:00", "title": {"rendered": "20250616 &#8211; Bylaw No. 2227"},
         "source_url": "https://langford.ca/wp-content/uploads/2025/03/20250616-Bylaw-No.-2227.pdf"},
    ]
    assert [(r.bylaw_number, r.title) for r in parse_media(items)] == [("2248", "Bylaw 2248"), ("2227", "Bylaw No. 2227")]


def test_is_bylaw_document():
    assert is_bylaw_document("Development Applications Fees and Procedures Bylaw – Consolidated")
    assert not is_bylaw_document("Fireworks Permit Application")
    assert not is_bylaw_document("Tree-Bylaw-FAQs")
    assert not is_bylaw_document("Design Guidelines and Development Permit Areas")


def test_number_from_filename():
    assert number_from_filename("https://x/1160-Building-Bylaw-2008-Consolidated-to-20260601-1.pdf") == "1160"
    assert number_from_filename("https://x/Tax-Rate-Bylaw-2026.pdf") is None
    assert number_from_filename("https://x/Frontage-Improvement-Delegation-Bylaw-497-2000.pdf") == "497"


def test_merge_prefers_directory():
    d = [BylawSource(title="Elections (Bylaw No. 1819)", source_url="https://x/a.pdf", bylaw_number="1819", listed_current=True)]
    m = [BylawSource(title="Bylaw 1819", source_url="https://x/b.pdf", bylaw_number="1819", source="media"),
         BylawSource(title="Bylaw 2248", source_url="https://x/c.pdf", bylaw_number="2248", source="media")]
    merged = merge_sources(d, m)
    assert [(s.bylaw_number, s.source_url) for s in merged] == [("1819", "https://x/a.pdf"), ("2248", "https://x/c.pdf")]


def test_display_title():
    assert display_title("Elections (Bylaw No. 1819) – Consolidated") == "Elections Bylaw"
    assert display_title("Board of Variance (Bylaw No. 1413)") == "Board of Variance Bylaw"
    assert display_title("Freedom of Information Bylaw No. 1925, 2020") == "Freedom of Information Bylaw"
    assert display_title("Tree Protection Bylaw") == "Tree Protection Bylaw"


def test_derive_status():
    current = BylawSource(title="Board of Variance (Bylaw No. 1413)", source_url="u", listed_current=True)
    assert derive_status(current, "BYLAW NO. 1413", []) == STATUS_IN_FORCE
    assert derive_status(current, "", [{"bylaw_number": "2057", "adopted": "May 16, 2022"}]) == STATUS_AMENDED
    annual = BylawSource(title="Tax Rate Bylaw 2009", source_url="u", listed_current=True)
    assert derive_status(annual, "", []) is None
    media = BylawSource(title="Bylaw 2248", source_url="u", source="media")
    assert derive_status(media, "", []) is None


MATTERS = [
    {"id": 72, "title": "Review of Elections Bylaw No. 1819", "identifier": "Bylaw No. 1819", "meta": None, "bylaw_id": None},
    {"id": 504, "title": "Elections Bylaw No. 1819, Amendment No. 2, Bylaw No. 2267, 2026 (Adoption)", "identifier": "Bylaw No. 2267", "meta": {}, "bylaw_id": None},
    {"id": 903, "title": "Election Bylaw Amendment No. 1", "identifier": "BYLAW 2057", "meta": None, "bylaw_id": None},
    # merged into 72 -> resolves to the canonical
    {"id": 9001, "title": "Elections Bylaw No. 1819 (adoption)", "identifier": None, "meta": {}, "merged_into": 72, "bylaw_id": None},
    # an address that happens to be 1819, not the bylaw
    {"id": 9002, "title": "Rezoning Bylaw 1819 Island Highway", "identifier": "REZ 1819 Island Hwy", "meta": None, "bylaw_id": None},
    # mentions 1819 but is principally about another bylaw
    {"id": 9003, "title": "Council Procedure Bylaw No. 1971 (refers to Bylaw No. 1819)", "identifier": None, "meta": None, "bylaw_id": None},
    # already linked elsewhere
    {"id": 9004, "title": "Elections Bylaw No. 1819 notes", "identifier": None, "meta": None, "bylaw_id": 55},
]


def test_plan_links():
    links = plan_links(MATTERS, bylaw_id=7, bylaw_number="1819", amendment_numbers=["2057", "2267"])
    got = {l.matter_id: (l.via, l.matched_matter_ids, l.conflict) for l in links}
    assert got == {
        72: ("direct", [72, 9001], False),
        504: ("direct", [504], False),
        903: ("amendment 2057", [903], False),
        9004: ("direct", [9004], True),
    }


def test_format_summary():
    from pipeline.ingestion.langford_bylaws import BylawSummary, format_summary

    s = BylawSummary(summary="Sets how  elections run.", key_rules=["Rule one.", " ", "Rule two."], who_it_affects="Voters.")
    assert format_summary(s) == "Sets how elections run.\n\nKey rules:\n- Rule one.\n- Rule two.\n\nWho it affects: Voters."


def test_plan_links_amendment_with_own_row_is_not_claimed():
    links = plan_links(MATTERS, bylaw_id=7, bylaw_number="1819", amendment_numbers=["2057"], numbers_with_rows={"2057"})
    assert 903 not in {l.matter_id for l in links}


def test_summary_meta():
    from pipeline.ingestion.langford_bylaws import BylawSummary, summary_meta
    s = BylawSummary(summary="Sets how elections run.", key_rules=["Rule  one.", " "], who_it_affects="Voters.")
    m = summary_meta(s)
    assert m["key_rules"] == ["Rule one."]
    assert m["who_it_affects"] == "Voters."
    assert m["summary_version"]
