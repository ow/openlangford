"""Bulk Langford bylaw ingestion: source selection, resume, citations, and
linking every matter against every bylaw row. Pure functions only."""

import pytest

from pipeline.ingestion.bylaw_matter_links import identifier_numbers, plan_all_links
from pipeline.ingestion.langford_bylaws import (
    SCANNED_NOTE,
    Candidate,
    PlanEntry,
    citation_span,
    is_adopted,
    is_unchanged,
    media_title,
    own_number_from_text,
    plan_problems,
    select_bulk,
    summary_input,
    text_sha256,
)
from pipeline.scrapers.langford_bylaws import BylawSource, loose_title_number, parse_media
from pipeline.stages import StageContext, StageError, bylaw_stage_selection, get_stage


def bylaw_text(number: str, cited: str | None = None, *, adopted: bool = True, amends: str | None = None) -> str:
    cited = cited or f"Example Bylaw No. {number}, 2024"
    body = f"CITY OF LANGFORD\nBYLAW NO. {number}\n"
    if amends:
        body += f"A BYLAW TO AMEND CITY OF LANGFORD EXAMPLE BYLAW NO. {amends}, 1995\n"
    body += "NOW THEREFORE the Council enacts as follows:\n1. Rules.\n"
    body += f'This Bylaw may be cited for all purposes as "{cited}".\n'
    body += "ADOPTED THIS 19TH DAY OF FEBRUARY, 2024.\n" if adopted else "ADOPTED on the day of , 2024\n"
    return body


def cand(number, text, *, source="media", title=None, uploaded=None, unconfirmed=False, consolidated=False, url=None):
    src = BylawSource(
        title=title or f"Bylaw {number}",
        source_url=url or f"https://langford.ca/wp-content/uploads/2024/01/Bylaw-{number}-{uploaded or 'x'}.pdf",
        bylaw_number=number,
        source=source,
        listed_current=source == "directory",
        uploaded=uploaded,
        number_unconfirmed=unconfirmed,
        consolidated=consolidated,
    )
    return Candidate(src=src, path=f"/tmp/{number}.pdf", text=text, own_number=own_number_from_text(text),
                     adopted=is_adopted(text))


# ── citations / numbers ─────────────────────────────────────────────────


def test_own_number_prefers_the_citation_over_the_header():
    text = (
        "CITY OF LANGFORD\nTICKET INFORMATION BYLAW No. 34, 1993,\nAMENDMENT BYLAW No. 1907, 2020\n"
        "This bylaw may be cited as the “Ticket Information Bylaw No. 34, 1993 Amendment Bylaw\nNo. 1907, 2020.”\n"
    )
    assert own_number_from_text(text) == "1907"
    assert own_number_from_text("CITY OF LANGFORD\nBYLAW NO. 2022\nA BYLAW TO IMPOSE CHARGES") == "2022"


def test_citation_span_variants():
    assert citation_span('may be cited for all purposes as, "City of Langford Phased Development Agreement\nBylaw No. 2058, 2022".') \
        == "City of Langford Phased Development Agreement Bylaw No. 2058, 2022"
    # unclosed quote: stop at the readings
    assert citation_span('may be cited for all purposes as "Langford Zoning Bylaw, Amendment No. 489, (731\nStation Ave), 2017 .\nREAD A FIRST TIME') \
        == "Langford Zoning Bylaw, Amendment No. 489, (731 Station Ave), 2017"


def test_media_title():
    assert media_title("Langford Zoning Bylaw, Amendment No. 685, (2936 Irwin Road) Bylaw No. 2090, 2022") \
        == "Langford Zoning Bylaw, Amendment No. 685, (2936 Irwin Road)"
    assert media_title("City of Langford Permissive Tax Exemption Bylaw No. 1718, 2017") \
        == "City of Langford Permissive Tax Exemption Bylaw"
    assert media_title("TRANSIT-ORIENTED AREA Bylaw No. 2160, 2024") == "Transit-oriented Area Bylaw"
    assert media_title("Langford Zoning Bylaw, Amendment No. 704, (820 Hockley Avenue") \
        == "Langford Zoning Bylaw, Amendment No. 704, (820 Hockley Avenue)"


def test_loose_title_numbers_need_confirmation():
    assert loose_title_number("Bylaw 2019 Z22-0025") == "2019"
    assert loose_title_number("Notice Bylaw 1234 Goldstream Avenue") is None
    items = [
        {"date": "2024-02-02T00:00:00", "title": {"rendered": "Bylaw 2019 Z22-0025"},
         "source_url": "https://langford.ca/wp-content/uploads/2024/02/Bylaw-2019-Z22-0025.pdf"},
        {"date": "2023-11-09T00:00:00", "title": {"rendered": "Tax Rate Bylaw 2023"},
         "source_url": "https://langford.ca/wp-content/uploads/2023/11/Tax-Rate-Bylaw-2023.pdf"},
        {"date": "2025-01-28T00:00:00", "title": {"rendered": "BYLAW &#8211; Community Patrol Officer JD 2024"},
         "source_url": "https://langford.ca/wp-content/uploads/2025/01/BYLAW-Community-Patrol-Officer-JD-2024.pdf"},
    ]
    got = parse_media(items)
    assert [(s.bylaw_number, s.number_unconfirmed) for s in got] == [("2019", True)]


# ── selection ────────────────────────────────────────────────────────────


def test_directory_first_then_one_media_upload_per_number():
    directory = [cand("1413", bylaw_text("1413"), source="directory", title="Board of Variance (Bylaw No. 1413)")]
    media = [
        cand("1413", bylaw_text("1413") + " older copy", uploaded="2020-10-07"),  # directory has it
        cand("2135", bylaw_text("2135", adopted=False), uploaded="2023-09-22"),  # newer but a draft
        cand("2135", bylaw_text("2135"), uploaded="2023-08-04"),  # adopted -> preferred
        cand("2248", bylaw_text("2248", "Langford Zoning Bylaw No. 300, Amendment No. 750 (1 Main St), Bylaw No. 2248, 2026")),
    ]
    entries, skipped = select_bulk(directory, media)
    assert [(e.number, e.source) for e in entries] == [("1413", "directory"), ("2135", "media"), ("2248", "media")]
    assert entries[1].cand.src.uploaded == "2023-08-04"
    assert entries[2].title == "Langford Zoning Bylaw No. 300, Amendment No. 750 (1 Main St)"
    assert entries[1].status is None  # media: status unknown
    reasons = sorted(s.reason for s in skipped)
    assert reasons == ["Bylaw 1413 comes from the directory", "another upload of Bylaw 2135 was preferred"]
    assert plan_problems(entries) == []


def test_same_pdf_as_directory_entry_is_skipped_even_under_another_number():
    # The City links amending Bylaw 2125 as "the" Sign Bylaw 1250; the media copy is the same PDF.
    text = bylaw_text("2125", "City of Langford Sign Bylaw, Amendment No. 3, Bylaw No. 2125, 2025", amends="1250")
    text = text.replace("EXAMPLE BYLAW NO. 1250", "SIGN BYLAW NO. 1250")
    directory = [cand("1250", text, source="directory", title="Sign Bylaw (Bylaw No. 1250)")]
    media = [cand("1250", text, title="Sign-Bylaw-1250-Consolidated-to-20260316")]
    entries, skipped = select_bulk(directory, media)
    assert [(e.number, e.source) for e in entries] == [("1250", "directory")]
    assert "amending Bylaw 2125" in entries[0].note
    assert skipped[0].reason == "same document as directory Bylaw 1250"


def test_directory_pdf_that_is_another_bylaw_takes_the_pdf_number():
    # "South Langford Storm DCC Bylaw" (listed 1700) links Bylaw 2022, which repeals 1700.
    text = bylaw_text("2022", "City of Langford Stormwater Development Cost Charge Bylaw No. 2022, 2022")
    entries, _ = select_bulk([cand("1700", text, source="directory", title="South Langford Storm DCC Bylaw")], [])
    assert entries[0].number == "2022" and entries[0].title == "South Langford Storm DCC Bylaw"


def test_unnumbered_and_unconfirmed_numbers_come_from_the_pdf():
    directory = [cand(None, bylaw_text("2282"), source="directory", title="Tax Rate Bylaw 2026")]
    media = [
        cand("2019", bylaw_text("2019"), unconfirmed=True),  # PDF agrees
        cand("2027", "Notice of Public Hearing ... application to amend Zoning Bylaw No. 300", unconfirmed=True),
    ]
    entries, skipped = select_bulk(directory, media)
    assert [e.number for e in entries] == ["2282", "2019"]
    assert entries[0].note == "number from the PDF"
    assert skipped[0].reason.startswith("does not read as a bylaw")


def test_scanned_directory_bylaw_is_planned_for_transcription_but_scanned_media_is_skipped():
    directory = [cand("2269", "", source="directory", title="Tree Protection Bylaw")]
    media = [cand("2269", "")]
    entries, skipped = select_bulk(directory, media)
    assert [(e.number, e.note) for e in entries] == [("2269", SCANNED_NOTE)]
    assert skipped[0].reason == "no text layer (scanned PDF)"


def test_source_filter():
    directory = [cand("1413", bylaw_text("1413"), source="directory")]
    media = [cand("1413", bylaw_text("1413") + "x"), cand("2248", bylaw_text("2248"))]
    assert [e.number for e in select_bulk(directory, media, source="directory")[0]] == ["1413"]
    # media-only still defers to directory numbers
    assert [e.number for e in select_bulk(directory, media, source="media")[0]] == ["2248"]


# ── resume ───────────────────────────────────────────────────────────────


def _entry(number="1819", text="text"):
    return PlanEntry(number, "Elections Bylaw", "directory", None, cand(number, text, source="directory"))


def test_resume_skips_unchanged_file():
    e = _entry()
    existing = {"1819": {"id": 2, "has_summary": True}}
    manifest = {"1819": {"sha256": "abc", "bylaw_id": 2}}
    assert is_unchanged(e, manifest=manifest, existing=existing, file_hash="abc")
    assert not is_unchanged(e, manifest=manifest, existing=existing, file_hash="new")  # PDF changed
    assert not is_unchanged(e, manifest=manifest, existing={}, file_hash="abc")  # row deleted
    assert not is_unchanged(e, manifest=manifest, existing={"1819": {"id": 2, "has_summary": False}}, file_hash="abc")


def test_resume_without_manifest_compares_stored_text():
    e = _entry(text="full text")
    existing = {"1819": {"id": 2, "has_summary": True}}
    assert is_unchanged(e, manifest={}, existing=existing, file_hash="x", stored_text_hash=text_sha256("full text"))
    assert not is_unchanged(e, manifest={}, existing=existing, file_hash="x", stored_text_hash=text_sha256("other"))


def test_plan_problems_flags_duplicates():
    a, b = _entry("300"), _entry("300")
    assert plan_problems([a, b]) == ["duplicate number 300 (2x)"]


# ── long bylaws ──────────────────────────────────────────────────────────


def test_summary_input_digests_long_bylaws():
    short = "BYLAW NO. 1\n" + "word " * 100
    assert summary_input(short) == (short, False)
    toc = "Table of Contents\nPart 1 – Interpretation ........ 1-1\nPart 6 – Zone Regulations ........ 6-1\n"
    prose = "the rules in this section apply to land, buildings and structures in every zone of the city of langford\n"
    body = "PART 1 – INTERPRETATION\nPurpose\nThis bylaw regulates land use.\n" + prose * 800
    tail = "PART 6 – ZONE REGULATIONS\n6.10 RS1 Zone\n2418 Millstream Road\n"
    digest, digested = summary_input("CITY OF LANGFORD\n" + toc + body + tail, limit=20000)
    assert digested and len(digest) <= 20000
    assert "Part 6 – Zone Regulations" in digest  # from the TOC
    assert "PART 6 – ZONE REGULATIONS" in digest  # a heading from the end of the document
    assert "2418 Millstream Road" not in digest.split("SECTION HEADINGS")[1]  # addresses are not headings


# ── stage ────────────────────────────────────────────────────────────────


def test_bylaws_stage_registered_backfill_only():
    stage = get_stage("bylaws")
    assert stage.when == "backfill_only" and stage.scope == "global"


def test_bylaws_stage_selection():
    assert bylaw_stage_selection(StageContext(supabase=None, options={"all": True})) == ("all", None)
    assert bylaw_stage_selection(StageContext(supabase=None, options={"all": True, "source": "media"})) == ("media", None)
    assert bylaw_stage_selection(StageContext(supabase=None, target="1819")) == ("all", ["1819"])
    with pytest.raises(StageError):
        bylaw_stage_selection(StageContext(supabase=None))
    with pytest.raises(StageError):
        bylaw_stage_selection(StageContext(supabase=None, options={"all": True, "source": "bogus"}))


# ── linking ──────────────────────────────────────────────────────────────


def test_identifier_numbers():
    assert identifier_numbers("BYLAW NO. 1612") == ["1612"]
    assert identifier_numbers("Bylaw No. 2253; Bylaw No. 2254") == ["2253", "2254"]
    assert identifier_numbers("BYLAW NOS. 1634; 1635; 1636") == ["1634", "1635", "1636"]
    assert identifier_numbers("BYLAW 2019") == ["2019"]  # structured field: not a year
    assert identifier_numbers("BYLAW NO. 1825; 1234 Goldstream Avenue") == ["1825"]
    assert identifier_numbers("REZ 982-988 Bray Avenue; Bylaw No. 2019") == ["2019"]
    assert identifier_numbers(None) == []


BYLAWS = [
    {"id": 2, "bylaw_number": "1819", "title": "Elections Bylaw", "year": 2019, "status": "Amended", "amendments": ["2057"]},
    {"id": 4, "bylaw_number": "300", "title": "Zoning Bylaw", "year": 1999, "status": "In force", "amendments": []},
    {"id": 7, "bylaw_number": "2200", "title": "Official Community Plan Bylaw", "year": 2025, "status": "In force", "amendments": []},
    {"id": 9, "bylaw_number": "2236", "title": "Langford Zoning Bylaw, Amendment No. 752", "year": 2026, "status": None, "amendments": []},
    {"id": 10, "bylaw_number": "2270", "title": "Inclusionary Zoning Bylaw", "year": 2026, "status": "In force", "amendments": []},
]


def M(id, title, identifier=None, *, meta=None, bylaw_id=None, first_seen="2022-01-01", merged_into=None):
    return {"id": id, "title": title, "identifier": identifier, "meta": meta, "bylaw_id": bylaw_id, "first_seen": first_seen,
            "merged_into": merged_into}


def test_plan_all_links_rules():
    matters = [
        # own amendment bylaw has a row -> that row, not the parent
        M(1, "Langford Zoning Bylaw No. 300, Amendment No. 752 (709 Massie Drive), Bylaw No. 2236, 2026", "Bylaw No. 2236"),
        # own amendment has no row, title names the parent by number
        M(2, "Elections Bylaw No. 1819, Amendment No. 2, Bylaw No. 2267, 2026", "Bylaw No. 2267"),
        # own amendment is listed in the parent's consolidation
        M(3, "Election Bylaw Amendment No. 1", "BYLAW 2057"),
        # amends the zoning bylaw by name
        M(4, "Langford Zoning Bylaw, Amendment No. 592 (925 Bray Ave)", "BYLAW 1912"),
        # names the inclusionary zoning bylaw (longest name wins)
        M(5, "Inclusionary Zoning Bylaw Amendment", None, first_seen="2026-05-01"),
        # OCP amendment from before OCP 2200 was enacted -> not linked by name
        M(6, "Langford Official Community Plan Bylaw, Amendment No. 19 (3483 Happy Valley Rd)", "BYLAW NO. 1612",
          first_seen="2015-01-01"),
        # no start date, but amendment 1887 is numbered below OCP 2200 -> cannot amend it
        M(13, "Langford Official Community Plan Bylaw, Amendment No. 35 (1324 Langshire Rd)", "BYLAW NO. 1887",
          first_seen=None),
        # not an amendment, no row -> nothing
        M(7, "Rezoning 898 and 914 Klahanie Drive", "BYLAW NO. 2093"),
        # street number that happens to match a bylaw row
        M(8, "Rezoning 300 Goldstream Avenue", "REZ 300 Goldstream Avenue"),
        # regional bylaw
        M(9, "Capital Regional District Bylaw No. 300 amendment", "Bylaw No. 300"),
        # merged into 1 -> resolves to the canonical
        M(10, "Zoning amendment 709 Massie Drive (adoption)", "Bylaw No. 2236", merged_into=1),
        # already linked to something else
        M(11, "Review of Elections Bylaw No. 1819", "Bylaw No. 1819", bylaw_id=99),
        # already linked to the same row
        M(12, "Elections Bylaw No. 1819", "Bylaw No. 1819", bylaw_id=2),
    ]
    links, ambiguous = plan_all_links(matters, BYLAWS)
    got = {l.matter_id: (l.bylaw_number, l.via) for l in links}
    assert got == {
        1: ("2236", "own"),
        2: ("1819", "amends"),
        3: ("1819", "consolidated"),
        4: ("300", "amends-name"),
        5: ("2270", "amends-name"),
        11: ("1819", "own"),
        12: ("1819", "own"),
    }
    by_id = {l.matter_id: l for l in links}
    assert by_id[1].matched_matter_ids == [1, 10]
    assert by_id[11].conflict and not by_id[11].unchanged
    assert by_id[12].unchanged and not by_id[12].conflict
    assert ambiguous == []


def test_plan_all_links_ambiguous_aliases():
    matters = [
        M(1, "Something", None),
        M(2, "Elections Bylaw No. 1819 review", "Bylaw No. 1819", merged_into=1),
        M(3, "Zoning Bylaw No. 300 review", "Bylaw No. 300", merged_into=1),
    ]
    links, ambiguous = plan_all_links(matters, BYLAWS)
    assert links == [] and ambiguous[0]["numbers"] == ["300", "1819"]
