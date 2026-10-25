"""Evidence-backed council attendance from the original minutes roster (issue #56)."""
import json
from types import SimpleNamespace

from pipeline.ingestion.ingester import MeetingIngester
from pipeline.ingestion.minutes_roster import parse_roster, surname
from pipeline.ingestion.roster_attendance import find_original_minutes_pdf, roster_attendance

URL = "https://langford.escribemeetings.com/Minutes.pdf"
MEMBERS = [{"person_id": 1, "name": "Scott Goodmanson"}, {"person_id": 2, "name": "Kimberley Guiry"},
           {"person_id": 3, "name": "Colby Harder"}, {"person_id": 4, "name": "Lillian Szpak"}]

TWO_COLUMN = """\
City of Langford
Council Minutes
March 20, 2023, 7:00 p.m.
Council Chambers & Electronic Meeting

PRESENT:              Mayor S. Goodmanson                       Councillor L Szpak - Remote
                      Councillor K. Guiry                       Councillor C. Harder

ATTENDING:            B. Hutchins, Director of Corporate        K. Dube, Senior Manager of Information
                      Services                                  Technology and GIS

1.     CALL TO ORDER
       Councillor Harder called the meeting to order.
"""

WITH_ABSENT = """\
City of Langford
Council Minutes
April 8, 2024, 7:00 p.m.

PRESENT:              Councillor L. Szpak - Acting Mayor        Councillor C. Harder
                      Mayor S. Goodmanson

ABSENT:               Councillor K. Guiry

ATTENDING:            D. Kiedyk, Chief Administrative Officer
"""

NO_ROSTER = """\
City of Langford
Council Minutes
March 20, 2023, 7:00 p.m.

ATTENDING:            D. Kiedyk, Chief Administrative Officer
"""


def run(tmp_path, text, date, members=MEMBERS, url=URL):
    pdf = tmp_path / "Minutes.pdf"
    pdf.write_bytes(b"%PDF-fake")
    return roster_attendance(members, 7, date, pdf, url, text=text)


def test_parser_handles_missing_period_acting_mayor_and_staff_ignored():
    roster = parse_roster(TWO_COLUMN)
    assert sorted(surname(n) for n, _, _ in roster["present"]) == ["goodmanson", "guiry", "harder", "szpak"]
    assert [r for _, r, _ in roster["present"] if r] == [True]
    acting = parse_roster(WITH_ABSENT)
    assert sorted(surname(n) for n, _, _ in acting["present"]) == ["goodmanson", "harder", "szpak"]
    assert [surname(n) for n, _, _ in acting["absent"]] == ["guiry"]


def test_two_column_roster_resolves_every_member_with_evidence(tmp_path):
    result = run(tmp_path, TWO_COLUMN, "2023-03-20")
    assert result["status"] == "ok" and result["unresolved"] == []
    assert {r["person_id"] for r in result["records"]} == {1, 2, 3, 4}
    for rec in result["records"]:
        assert rec["attendance_mode"] == "Unknown"
        ev = json.loads(rec["notes"])
        assert (ev["schema"], ev["method"], ev["state"], ev["source_page"], ev["local_date"]) == ("council-attendance/v1", "original_roster", "present", 1, "2023-03-20")
        assert ev["person_id"] == rec["person_id"] and ev["meeting_id"] == 7 and ev["source_url"] == URL
        assert len(ev["source_sha256"]) == 64 and ev["source_quote"].startswith("PRESENT:\n")
    assert "listed as remote" in json.loads(next(r for r in result["records"] if r["person_id"] == 4)["notes"])["review"]


def test_absent_section_records_absent_mode(tmp_path):
    result = run(tmp_path, WITH_ABSENT, "2024-04-08")
    by_person = {r["person_id"]: r for r in result["records"]}
    assert by_person[2]["attendance_mode"] == "Absent"
    ev = json.loads(by_person[2]["notes"])
    assert ev["state"] == "absent" and ev["source_quote"] == "ABSENT:\nCouncillor K. Guiry"
    assert all(by_person[p]["attendance_mode"] == "Unknown" for p in (1, 3, 4))
    assert result["unresolved"] == []


def test_member_missing_from_roster_is_unresolved_others_kept(tmp_path):
    members = MEMBERS + [{"person_id": 9, "name": "Mark Morley"}]
    result = run(tmp_path, TWO_COLUMN, "2023-03-20", members)
    assert [u["person_id"] for u in result["unresolved"]] == [9] and result["unresolved"][0]["reason"] == "0 roster matches"
    assert {r["person_id"] for r in result["records"]} == {1, 2, 3, 4}


def test_empty_roster_resolves_nobody(tmp_path):
    result = run(tmp_path, NO_ROSTER, "2023-03-20")
    assert result["records"] == [] and result["status"] == "no named roster on page 1"
    assert len(result["unresolved"]) == len(MEMBERS)


def test_date_mismatch_and_missing_source_url_hold_everything(tmp_path):
    assert run(tmp_path, TWO_COLUMN, "2023-03-21")["status"] == "page-1 date does not match meeting date"
    assert run(tmp_path, TWO_COLUMN, "2023-03-20", url=None)["records"] == []
    assert run(tmp_path, TWO_COLUMN, "2023-03-20", url="http://insecure/x.pdf")["records"] == []


def test_unreadable_pdf_holds_everything(tmp_path):
    result = roster_attendance(MEMBERS, 7, "2023-03-20", tmp_path / "missing.pdf", URL)
    assert result["records"] == [] and result["status"] == "minutes PDF unreadable"


def test_find_original_minutes_pdf_prefers_signed(tmp_path):
    (tmp_path / "Minutes").mkdir()
    (tmp_path / "Minutes" / "Minutes.pdf").write_bytes(b"a")
    assert find_original_minutes_pdf(str(tmp_path)).name == "Minutes.pdf"
    (tmp_path / "Minutes" / "Minutes - SIGNED.pdf").write_bytes(b"b")
    assert find_original_minutes_pdf(str(tmp_path)).name == "Minutes - SIGNED.pdf"
    assert find_original_minutes_pdf(str(tmp_path / "nope")) is None


class FakeTable:
    def __init__(self, db, name):
        self.db, self.name, self.op = db, name, None

    def select(self, *a): return self
    def eq(self, *a): return self
    def lte(self, *a): return self
    def or_(self, *a): return self
    def single(self): return self
    def upsert(self, row, on_conflict=None):
        self.db.upserts.append((self.name, row, on_conflict)); return self

    def execute(self):
        if self.name == "memberships":
            return SimpleNamespace(data=[{"person_id": m["person_id"], "person": {"name": m["name"]}} for m in self.db.members])
        if self.name == "meetings":
            return SimpleNamespace(data={"minutes_url": URL})
        return SimpleNamespace(data=[])


class FakeDb:
    def __init__(self, members):
        self.members, self.upserts = members, []

    def table(self, name): return FakeTable(self, name)


def make_ingester(members):
    ing = MeetingIngester.__new__(MeetingIngester)
    ing.supabase = FakeDb(members)
    return ing


def meeting_folder(tmp_path, monkeypatch, text):
    (tmp_path / "Minutes").mkdir()
    (tmp_path / "Minutes" / "Minutes - SIGNED.pdf").write_bytes(b"%PDF-fake")
    monkeypatch.setattr("pipeline.ingestion.roster_attendance.first_page_text", lambda path: text)


def test_ingester_writes_roster_rows_and_reports_resolved(tmp_path, monkeypatch):
    meeting_folder(tmp_path, monkeypatch, WITH_ABSENT)
    ing = make_ingester(MEMBERS + [{"person_id": 9, "name": "Mark Morley"}])
    resolved = ing._write_roster_attendance(7, 1, "2024-04-08", str(tmp_path))
    assert resolved == {1, 2, 3, 4}  # Morley is not in the roster: left to the AI list
    rows = [r for t, r, c in ing.supabase.upserts if t == "attendance"]
    assert {r["person_id"] for r in rows} == {1, 2, 3, 4} and all(r["meeting_id"] == 7 for r in rows)
    assert next(r for r in rows if r["person_id"] == 2)["attendance_mode"] == "Absent"
    assert all(c == "meeting_id,person_id" for t, r, c in ing.supabase.upserts)


def test_ingester_dry_run_and_empty_roster_write_nothing(tmp_path, monkeypatch):
    meeting_folder(tmp_path, monkeypatch, WITH_ABSENT)
    ing = make_ingester(MEMBERS)
    assert ing._write_roster_attendance(7, 1, "2024-04-08", str(tmp_path), dry_run=True) == {1, 2, 3, 4}
    assert ing.supabase.upserts == []
    monkeypatch.setattr("pipeline.ingestion.roster_attendance.first_page_text", lambda path: NO_ROSTER)
    assert ing._write_roster_attendance(7, 1, "2023-03-20", str(tmp_path)) == set()
    assert ing.supabase.upserts == []


def test_ingester_without_minutes_pdf_falls_back(tmp_path):
    assert make_ingester(MEMBERS)._write_roster_attendance(7, 1, "2024-04-08", str(tmp_path)) == set()
