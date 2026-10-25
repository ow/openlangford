import datetime as dt
import json

import fitz
import pytest

from pipeline.ingestion.recovered_minutes import (
    choose_best, extract_dates, extract_pages, ingest_recovered_minutes, match_heading, parse_heading,
    recover_pdf, recovered_filename, target_kinds,
)

D = dt.date


@pytest.mark.parametrize("text,expected", [
    ("Minutes of the Meeting of Council (Regular) – February 3, 2020", [D(2020, 2, 3)]),
    ("Minutes of the Regular Council Meeting — February 3rd, 2020", [D(2020, 2, 3)]),
    ("MINUTES OF THE MEETING OF COUNCIL - Monday, April 6th, 2020 @ 5:30", [D(2020, 4, 6)]),
    ("Minutes (Feb 18, 2020) and (Sept. 8, 2020)", [D(2020, 2, 18), D(2020, 9, 8)]),
    ("Minutes - March 32, 2020", []),
    ("MINUTES OF THE SPECIAL MEETING OF COUNCIL", []),
])
def test_extract_dates(text, expected):
    assert extract_dates(text) == expected


@pytest.mark.parametrize("title", [
    "Minutes of the Planning, Zoning and Affordable Housing Committee – February 10, 2020",
    "West Shore Parks and Recreation Society – Minutes (January 16th, 2020)",
    "Minutes of the Protective Services Committee (July 28, 2020)",
    "Agenda for the Meeting of Council – February 3, 2020",
    "Rise and Report In Camera Decisions",
])
def test_non_council_minutes_rejected(title):
    assert parse_heading(title) is None


def test_exact_date_and_kind_match():
    heading = parse_heading("Minutes of the Meeting of Council (Regular) – February 3, 2020")
    assert match_heading(heading, D(2020, 2, 3), {"regular"}) == "high"


def test_other_date_never_matches():
    heading = parse_heading("Minutes of the Regular Council Meeting – February 18, 2020")
    assert match_heading(heading, D(2020, 2, 3), {"regular"}) is None
    assert match_heading(heading, D(2020, 2, 19), {"regular"}) is None


def test_heading_with_two_dates_is_not_a_match():
    heading = parse_heading("Minutes of the Council Meeting – February 3, 2020 and February 18, 2020")
    assert match_heading(heading, D(2020, 2, 3), {"regular"}) is None


@pytest.mark.parametrize("title", [
    "Minutes of the Regular Council Meeting - February 18, 2020 (excerpt)",
    "Minutes of the Council Meeting – October 21st, 2019 (extracts referencing Bylaw 1869)",
    "Minutes of the Council Meeting – March 2, 2020 (opening page)",
])
def test_partial_headings_never_match(title):
    assert match_heading(parse_heading(title), D(2019, 10, 21), {"regular"}) is None
    assert match_heading(parse_heading(title), D(2020, 2, 18), {"regular"}) is None
    assert match_heading(parse_heading(title), D(2020, 3, 2), {"regular"}) is None


def test_special_vs_regular_same_date():
    special = parse_heading("MINUTES OF THE SPECIAL MEETING OF COUNCIL - March 19th, 2020")
    regular = parse_heading("MINUTES OF THE MEETING OF COUNCIL - March 19th, 2020 (Regular Meeting)")
    assert special["kind"] == "special" and regular["kind"] == "regular"
    assert match_heading(special, D(2020, 3, 19), target_kinds("Special Council")) == "high"
    assert match_heading(regular, D(2020, 3, 19), target_kinds("Special Council")) == "low"
    assert match_heading(special, D(2020, 3, 19), target_kinds("Regular Council")) == "low"
    assert match_heading(regular, D(2020, 3, 19), target_kinds("Regular Council")) == "high"


def test_public_hearing_and_mistyped_special_row():
    hearing = parse_heading("MINUTES OF THE PUBLIC HEARING - May 25, 2020")
    assert hearing["kind"] == "public_hearing"
    assert match_heading(hearing, D(2020, 5, 25), target_kinds("Public Hearing", "Public Hearing")) == "high"
    # a row typed 'Special Council' but titled 'Public Hearing' accepts either heading
    assert target_kinds("Special Council", "Public Hearing") == {"special", "public_hearing"}


def test_date_falls_back_to_section_text_only_when_title_has_none():
    heading = parse_heading("MINUTES OF THE SPECIAL MEETING OF COUNCIL",
                            "CITY OF LANGFORD MINUTES OF THE SPECIAL MEETING OF COUNCIL Thursday, May 21, 2020 @ 5:30")
    assert heading["date_source"] == "text"
    assert match_heading(heading, D(2020, 5, 21), {"special"}) == "high"
    titled = parse_heading("Minutes of the Council Meeting - June 1, 2020", "Monday, July 6, 2020")
    assert titled["dates"] == [D(2020, 6, 1)] and titled["date_source"] == "title"


def test_choose_best_prefers_high_then_earliest_then_longest():
    def cand(conf, day, p0, p1):
        return {"confidence": conf, "source_meeting_date": D(2020, 3, day), "page_start": p0, "page_end": p1}
    low_early = cand("low", 2, 1, 20)
    high_late = cand("high", 16, 17, 18)
    high_early_short = cand("high", 2, 5, 6)
    high_early_long = cand("high", 2, 5, 15)
    assert choose_best([low_early, high_late]) is high_late
    assert choose_best([high_late, high_early_short]) is high_early_short
    assert choose_best([high_early_short, high_early_long]) is high_early_long
    assert choose_best([]) is None


def _package(path, pages=6):
    with fitz.open() as doc:
        for number in range(1, pages + 1):
            doc.new_page().insert_text((72, 72), f"page {number} of package")
        doc.save(str(path))


def test_extract_pages_is_one_based_inclusive_and_bounds_checked(tmp_path):
    src = tmp_path / "pkg.pdf"
    _package(src)
    dst = tmp_path / "out" / "cut.pdf"
    assert extract_pages(str(src), 3, 5, str(dst)) == 3
    with fitz.open(dst) as doc:
        assert [p.get_text().strip() for p in doc] == ["page 3 of package", "page 4 of package", "page 5 of package"]
    with pytest.raises(ValueError):
        extract_pages(str(src), 5, 7, str(dst))
    with pytest.raises(ValueError):
        extract_pages(str(src), 0, 2, str(dst))


def test_recovered_filename():
    assert recovered_filename("Agenda/20200504-Agenda-Package.pdf", 5, 10) == \
        "recovered-from-20200504-Agenda-Package-p5-10.pdf"


def _candidate(tmp_path):
    source = tmp_path / "repo" / "archive" / "source meeting"
    (source / "Agenda").mkdir(parents=True)
    _package(source / "Agenda" / "pkg.pdf")
    return {"source_archive_path": "archive/source meeting", "source_file_path": "Agenda/pkg.pdf",
            "page_start": 2, "page_end": 4, "source_url": "https://example.test/pkg.pdf",
            "source_document_id": 440, "source_meeting_id": 142, "heading": "Minutes ... April 6th, 2020",
            "confidence": "high"}


def test_recover_pdf_writes_pdf_url_and_provenance(tmp_path):
    candidate = _candidate(tmp_path)
    target = tmp_path / "repo" / "archive" / "target meeting"
    result = recover_pdf(str(target), candidate, str(tmp_path / "repo"))
    pdf = target / "Minutes" / "recovered-from-pkg-p2-4.pdf"
    assert result["path"] == str(pdf) and pdf.exists()
    assert (target / "Minutes" / (pdf.name + ".url")).read_text().strip() == "https://example.test/pkg.pdf"
    provenance = json.loads((target / "Minutes" / (pdf.name + ".provenance.json")).read_text())
    assert provenance["source_pages"] == [2, 4] and provenance["source_document_id"] == 440
    assert provenance["pages_written"] == 3 and len(provenance["sha256"]) == 64


class _Query:
    def __init__(self, store, table):
        self.store, self.table, self.op, self.payload = store, table, None, None

    def select(self, *a, **k):
        self.op = "select"; return self

    def eq(self, *a): return self
    def limit(self, *a): return self

    def upsert(self, payload, **k):
        self.op, self.payload = "upsert", payload; return self

    def update(self, payload):
        self.op, self.payload = "update", payload; return self

    def execute(self):
        class R: data = []; count = 0
        result = R()
        if self.op == "upsert":
            self.store["upserts"].append((self.table, self.payload)); result.data = [{"id": 900}]
        elif self.op == "update":
            self.store["updates"].append((self.table, self.payload))
        elif self.table == "extracted_documents":
            result.count = self.store["extracted_rows"]
        else:
            result.data = self.store["existing_docs"]
        return result


class _Fake:
    def __init__(self, existing_docs=(), extracted_rows=0):
        self.store = {"upserts": [], "updates": [], "existing_docs": list(existing_docs),
                      "extracted_rows": extracted_rows}

    def table(self, name): return _Query(self.store, name)


def test_ingest_adds_minutes_row_extracts_and_sets_flag(tmp_path):
    candidate = _candidate(tmp_path)
    target = tmp_path / "repo" / "archive" / "target meeting"
    path = recover_pdf(str(target), candidate, str(tmp_path / "repo"))["path"]
    fake, calls = _Fake(), []
    stats = ingest_recovered_minutes(fake, {"id": 119}, path,
                                     extract=lambda *args: calls.append(args))
    table, record = fake.store["upserts"][0]
    assert table == "documents" and record["category"] == "Minutes" and record["meeting_id"] == 119
    assert record["file_path"] == "Minutes/recovered-from-pkg-p2-4.pdf"
    assert record["source_url"] == "https://example.test/pkg.pdf" and record["page_count"] == 3
    assert "page 2 of package" in record["full_text"]
    assert calls and calls[0][1:3] == (900, 119)
    assert ("meetings", {"has_minutes": True}) in fake.store["updates"]
    assert stats == {"document_id": 900, "created": True, "extracted": True}


def test_ingest_is_idempotent_and_dry_run_writes_nothing(tmp_path):
    candidate = _candidate(tmp_path)
    target = tmp_path / "repo" / "archive" / "target meeting"
    path = recover_pdf(str(target), candidate, str(tmp_path / "repo"))["path"]
    from pipeline.ingestion.recovered_minutes import sha256_file
    fake = _Fake(existing_docs=[{"id": 7, "file_hash": sha256_file(path)}], extracted_rows=3)
    calls = []
    stats = ingest_recovered_minutes(fake, {"id": 119}, path, extract=lambda *a: calls.append(a))
    assert not fake.store["upserts"] and not calls and stats["document_id"] == 7 and not stats["extracted"]
    dry = _Fake()
    ingest_recovered_minutes(dry, {"id": 119}, path, dry_run=True, extract=lambda *a: calls.append(a))
    assert not dry.store["upserts"] and not dry.store["updates"] and not calls
