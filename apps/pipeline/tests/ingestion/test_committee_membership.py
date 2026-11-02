from datetime import date

from pipeline.ingestion import committee_membership as cm


PROSE_2016 = """CITY OF LANGFORD
MINUTES OF THE PLANNING, ZONING AND AFFORDABLE HOUSING COMMITTEE
PRESENT
Councillors: D. Blackwell (Chair), L. Seaton (Acting Vice-Chair); Members: A. Creuzot, K. She!drake and N.
Stewart.
ATTENDING
Matthew Baldwin, Director of Planning; Michelle Mahovlich, Director of Engineering.
ABSENT
Councillor: R. Wade; Members: M. Hall, D. Homer, and S. Harvey.
1. CALL TO ORDER
"""

ESCRIBE_COLUMNS = """Sustainable Development Advisory Committee
PRESENT:                  Councillor L Szpak - Chair               J. Keefer
                          Councillor M. Wagner - Vice Chair        M. McNaughton
                          Councillor K. Guiry                      K. Nentwig
                          V. Dumitru                               M. Turner

ATTENDING:                M. Watmough, Deputy Director of          L Stohmann, Deputy Director of
                          Corporate Services                       Planning and Subdivision
Meeting available by teleconference.
"""

COLONLESS_GROUPS = """PRESENT
Councillors: L. Seaton (A/Chair), Members T. Cox, H. Frederiksen, and E. Wilson
ATTENDING
Chief Administrative Officer J. Bowden, Deputy Chief Administrative Officer D. Kiedyk
ABSENT
Councillor: L. Szpak, Members: D. Darche, M. Dean and M. Wignall, Staff: Manager of Building Department
J. Worobec, and Fire Chief B. Beckett.
1. CALL TO ORDER
"""


def names(entries):
    return [(e["initial"], e["surname"], e["kind"]) for e in entries]


def test_prose_roster_groups_councillors_and_members_and_ignores_staff():
    r = cm.parse_roster(PROSE_2016)
    assert names(r["present"]) == [("D", "Blackwell", "councillor"), ("L", "Seaton", "councillor"),
                                   ("A", "Creuzot", "member"), ("K", "Sheldrake", "member"), ("N", "Stewart", "member")]
    assert r["present"][0]["chair"] and not r["present"][1]["chair"] and r["present"][1]["acting_chair"]
    assert names(r["absent"]) == [("R", "Wade", "councillor"), ("M", "Hall", "member"), ("D", "Homer", "member"), ("S", "Harvey", "member")]
    assert not r["unparsed"]


def test_column_roster_keeps_staff_titles_out():
    r = cm.parse_roster(ESCRIBE_COLUMNS)
    got = {(e["initial"], e["surname"]) for e in r["present"]}
    assert got == {("L", "Szpak"), ("J", "Keefer"), ("M", "Wagner"), ("M", "McNaughton"), ("K", "Guiry"),
                   ("K", "Nentwig"), ("V", "Dumitru"), ("M", "Turner")}
    szpak = next(e for e in r["present"] if e["surname"] == "Szpak")
    assert szpak["kind"] == "councillor" and szpak["chair"]
    assert next(e for e in r["present"] if e["surname"] == "Wagner")["vice"]


def test_group_label_without_colon_and_staff_group_skipped():
    r = cm.parse_roster(COLONLESS_GROUPS)
    assert names(r["present"]) == [("L", "Seaton", "councillor"), ("T", "Cox", "member"),
                                   ("H", "Frederiksen", "member"), ("E", "Wilson", "member")]
    assert ("J", "Worobec") not in {(e["initial"], e["surname"]) for e in r["absent"]}
    assert {e["surname"] for e in r["absent"]} == {"Szpak", "Darche", "Dean", "Wignall"}


def test_staff_in_finds_titles_on_either_side_of_the_name():
    found = cm.staff_in("Chief Administrative Officer J. Bowden, M. Watmough, Deputy Director of Corporate Services\n"
                        "Members: D. Horner, S. Harvey; Director of Engineering, Michelle Mahovlich")
    assert {("J", "bowden"), ("M", "watmough"), ("M", "mahovlich")} <= found
    assert ("S", "harvey") not in found and ("D", "horner") not in found


def test_scan_misreads_fold_to_the_recorded_spelling():
    obs = [{"initial": "D", "surname": "Homer"}] * 40 + [{"initial": "D", "surname": "Horner"}] * 41
    # Rosters split evenly; the committee's records use Horner far more.
    assert cm._fold_surnames(obs, {("D", "horner"): 66, ("D", "homer"): 4}) == {("D", "homer"): ("D", "horner")}
    # Without a clear majority either way, the two stay apart.
    assert cm._fold_surnames(obs, {}) == {}
    assert cm._scan_equal("sahlstronn", "sahlstrom") and not cm._scan_equal("glenn", "glenn")


def test_term_end():
    assert cm._term_end("for terms ending December 2022", date(2019, 2, 4)) == "2022-12-31"
    assert cm._term_end("for a term ending on December 31, 2026", date(2024, 7, 15)) == "2026-12-31"
    assert cm._term_end("for a one year term", date(2010, 12, 6)) == "2011-12-06"
    assert cm._term_end("to the committee", date(2010, 12, 6)) is None


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows

    def execute(self, *_):
        pass

    def fetchall(self):
        return self.rows


def test_appointments_split_one_resolution_across_bodies_and_skip_replacements():
    text = ("That Council appoint Nicholas Johal and Brad Sifert to the Transportation and Public Works Committee and "
            "Cheryl Brown to the Planning, Zoning and Affordable Housing Committee for terms ending December 2022; "
            "THAT Council appoint Councillor Wade in place of Councillor Szpak as Chair of the Protective Services Committee.")
    committees = {32: "Planning, Zoning & Affordable Housing Committee", 35: "Protective Services Committee",
                  36: "Transportation & Public Works Committee"}
    found = cm.find_appointments(FakeCursor([(1, date(2019, 2, 4), text)]), committees)
    got = {(a["organization_id"], a["name"]) for a in found}
    assert got == {(36, "Nicholas Johal"), (36, "Brad Sifert"), (32, "Cheryl Brown")}
    assert next(a for a in found if a["name"] == "Cheryl Brown")["end_date"] == "2022-12-31"


class FakePeople(cm.People):
    def __init__(self, rows, attended=None, council=()):
        self.rows = [{"id": i, "name": n, "is_councillor": False, "meta": {}} for i, n in rows]
        self.council = list(council)
        self.by_id = {p["id"]: p for p in self.rows}
        self.by_surname = {}
        for p in self.rows:
            p["bare"] = p["name"].replace("Lt. ", "")
            self.by_surname.setdefault(cm.norm_surname(p["bare"].split()[-1]), []).append(p)
        self.attended = attended or {}
        self.attendance_count = {}


def test_citizen_identity_needs_a_tie_to_the_committee():
    people = FakePeople([(1, "Carol Brown"), (2, "Jessica Harvey"), (3, "Lt. Dan Darche")],
                        attended={1: {32}, 2: {32}, 3: {35}})
    entry = lambda i, s: {"initial": i, "first": None, "surname": s}
    # Council named Cheryl; the existing same-initial record (Carol) is not assumed to be her.
    pid, how, new = people.citizen(entry("C", "Brown"), {("C", "brown"): {"Cheryl Brown"}}, 32)
    assert (pid, how, new) == (None, "named_by_council_existing_record_conflicts", "Cheryl Brown")
    # A different initial is never the same person.
    assert people.citizen(entry("S", "Harvey"), {}, 32) == (None, "new_person", "S. Harvey")
    # A rank isn't a first name; recorded at this committee, so it's the member.
    assert people.citizen(entry("D", "Darche"), {}, 35)[0] == 3
    # Known only from another body: not assumed.
    assert people.citizen(entry("D", "Darche"), {}, 32)[1] == "same_initial_and_surname_elsewhere_only"


def test_councillor_identified_from_council_on_the_date_with_scan_tolerance():
    council = [{"person_id": 7, "role": "Councillor", "start": date(2018, 11, 5), "end": date(2022, 11, 6)}]
    people = FakePeople([(7, "Matt Sahlstrom")], council=council)
    e = {"initial": "M", "surname": "Sahlstronn"}
    assert people.councillor(e, date(2022, 1, 25)) == (7, "sitting_council_member_on_date")
    assert people.councillor(e, date(2023, 1, 25))[0] is None
