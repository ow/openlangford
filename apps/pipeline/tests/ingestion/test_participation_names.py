"""Public speaker naming: registry, minutes, first-time names and review holds."""
from pipeline.ingestion.participation_names import name_key, parse_minutes_speakers, resolve_public_name

MINUTES = [
    {"section_title": "6. PUBLIC PARTICIPATION", "section_text": (
        "## 6. Public Participation\n\n"
        "L. Plomp, 3592 Whimfield Ter - Item 10.6 - expressed concerns about limiting public participation.\n\n"
        "- J. Harris, Langford Resident - re: Item 11.2 - The speaker offered information.\n"
        "M. Wagner, 104-2669 Deville Rd, - Item 8.1.6 - building is special.\n"
        "Rachael Sansom, on behalf of the Applicant - Clarified the road location.\n"
        "Resident on Goldstream Ave - Addressed Council.\n")},
    {"section_title": "5. PUBLIC HEARINGS", "section_text": "## 5. PUBLIC HEARINGS\n\nT. Cadeau, 958 Glen Willow Pl - expressed concerns about height.\n"},
    {"section_title": "8. COMMITTEE RESOLUTIONS", "section_text": "K. Elsewhere, staff - not a public speaker list.\n"},
]


def resolve(spoken, intro, *, people=(), minutes=None, published=(), decisions=None):
    return resolve_public_name(spoken, intro, people=list(people), statement_names=[],
                               minutes=parse_minutes_speakers(MINUTES) if minutes is None else minutes,
                               published=list(published), decisions=decisions)


def test_parses_public_speaker_lists_only():
    names = [s["name"] for s in parse_minutes_speakers(MINUTES)]
    assert names == ["L. Plomp", "J. Harris", "M. Wagner", "Rachael Sansom", "T. Cadeau"]


def test_minutes_confirm_a_self_introduction_and_keep_the_spoken_first_name():
    r = resolve("Tara Cadeau", "Hello, my name is Tara Cadeau.")
    assert (r["status"], r["basis"], r["display"]) == ("published", "minutes", "Tara Cadeau")


def test_minutes_spelling_wins_over_the_transcript_surname():
    r = resolve("Rachel Sansom", "Hi, I'm Rachel Sansom for the applicant.", minutes=[{"name": "Rachael Sansom"}])
    assert (r["status"], r["display"]) == ("published", "Rachael Sansom")


def test_first_time_name_is_published_as_introduced_when_there_are_no_minutes():
    r = resolve("holly adams", "Hello, I'm Holly Adams.", minutes=[])
    assert (r["status"], r["basis"], r["display"]) == ("published", "introduction", "Holly Adams")


def test_near_miss_against_minutes_goes_to_review():
    # Transcript "Marie Watmo" vs minutes "M. Watmore": same initial, surname one edit away.
    r = resolve("Marie Watmo", "My name is Marie Watmo.", minutes=[{"name": "M. Watmor"}])
    assert r["status"] == "review" and r["display"] is None
    assert r["conflict"]["near"][0] == {"name": "M. Watmor", "source": "minutes", "affiliation": None}


def test_near_miss_against_an_already_published_name_goes_to_review():
    r = resolve("Holly Addams", "Hello, I'm Holly Addams.", minutes=[], published=["Holly Adams"])
    assert r["status"] == "review" and r["conflict"]["near"][0]["name"] == "Holly Adams"


def test_exact_repeat_of_a_published_name_is_published():
    r = resolve("Holly Adams", "Hello, I'm Holly Adams.", minutes=[], published=["Holly Adams"])
    assert (r["status"], r["basis"]) == ("published", "known")


def test_registry_spelling_still_wins():
    r = resolve("Chris Foxhall", "My name is Chris Foxhall.", people=[{"id": 9, "name": "Chris Foxall"}], minutes=[])
    assert (r["status"], r["basis"], r["display"]) == ("published", "registry", "Chris Foxall")


def test_admin_decision_overrides_everything():
    decisions = {name_key("Marie Watmo"): {"status": "published", "display_name": "Marie Watmough"}}
    r = resolve("Marie Watmo", "My name is Marie Watmo.", minutes=[{"name": "M. Watmor"}], decisions=decisions)
    assert (r["status"], r["basis"], r["display"]) == ("published", "admin", "Marie Watmough")
    anonymous = {name_key("Marie Watmo"): {"status": "anonymous"}}
    assert resolve("Marie Watmo", "My name is Marie Watmo.", decisions=anonymous)["status"] == "anonymous"


def test_names_not_literally_introduced_are_ignored():
    assert resolve("Holly Adams", "Hello, I live on Happy Valley Road.") is None
    assert resolve("Holly", "Hi, I'm Holly.") is None  # a single word is not enough to publish


def test_staff_entries_are_not_public_speakers():
    sections = [{"section_title": "5. PUBLIC HEARINGS", "section_text":
                 "Matthew Baldwin, Director of Planning and Subdivision - advised on the application.\n"
                 "B. Armstrong, 2813 Rodney Rd - expressed concerns about building heights.\n"}]
    assert [m["name"] for m in parse_minutes_speakers(sections)] == ["B. Armstrong"]


def test_short_surname_near_miss_goes_to_review():
    r = resolve("Lori Pomp", "My name is Lori Pomp.", minutes=[{"name": "L. Plomp"}])
    assert r["status"] == "review" and r["conflict"]["near"][0]["name"] == "L. Plomp"


def _entries(*names):
    return [{"name": n, "affiliation": "", "said": f"{n} spoke.", "section": 0, "order": i} for i, n in enumerate(names)]


def test_minutes_order_limits_each_unnamed_speaker_to_the_gap_between_named_neighbours():
    from pipeline.ingestion.participation_names import match_unnamed_to_minutes
    minutes = _entries("R. Sansom", "B. Armstrong", "D. Elizabeth", "L. Bjola", "M. Wagner", "N. Kalmet")
    speakers = [
        {"who": "A resident", "position": "opposes", "topic": "height", "point": "Opposes the height."},
        {"who": "D Elizabeth", "position": "supports", "topic": "x", "point": "x"},
        {"who": "A resident", "position": "supports", "topic": "x", "point": "x"},
        {"who": "A resident", "position": "concerned", "topic": "x", "point": "x"},
        {"who": "Natalie Kalmet", "position": "concerned", "topic": "x", "point": "x"},
    ]
    offered = []

    def decide(context, options):
        offered.append([o["name"] for o in options])
        return {"R. Sansom": 1}.get(options[0]["name"], len(offered) - 2), 0.8

    picks = match_unnamed_to_minutes(speakers, minutes, taken_names=["D Elizabeth", "Natalie Kalmet"], decide=decide)
    assert offered == [["R. Sansom", "B. Armstrong"], ["L. Bjola", "M. Wagner"], ["L. Bjola", "M. Wagner"]]
    assert {i: e["name"] for i, (e, _) in picks.items()} == {0: "B. Armstrong", 2: "L. Bjola", 3: "M. Wagner"}


def test_minutes_matching_drops_repeated_and_crossed_picks():
    from pipeline.ingestion.participation_names import match_unnamed_to_minutes
    minutes = _entries("A. One", "B. Two", "C. Three", "D. Four", "E. Five")
    speakers = [{"who": "A resident", "position": "other", "topic": "t", "point": "p"} for _ in range(4)]
    answers = iter([(1, 0.9), (1, 0.9), (4, 0.9), (3, 0.9)])
    picks = match_unnamed_to_minutes(speakers, minutes, taken_names=[], decide=lambda c, o: next(answers))
    # 0 and 1 both chose "B. Two"; 2 chose "E. Five" but 3 chose "D. Four", which crosses it.
    assert picks == {}


def test_low_confidence_minutes_match_is_ignored():
    from pipeline.ingestion.participation_names import match_unnamed_to_minutes
    picks = match_unnamed_to_minutes([{"who": "A resident", "position": "other", "topic": "t", "point": "p"}],
                                     _entries("B. Armstrong", "C. Two", "D. Three", "E. Four"), taken_names=[],
                                     decide=lambda context, entries: (0, 0.6))
    assert picks == {}


def test_name_missing_from_the_meetings_minutes_goes_to_review_with_listed_suggestions():
    # "Tara Code" is a mishearing; the minutes list T. Cadeau.
    r = resolve("Tara Code", "My name is Tara Code.")
    assert r["status"] == "review" and r["conflict"]["reason"] == "not_in_minutes"
    assert [n["name"] for n in r["conflict"]["near"]] == ["T. Cadeau"]


def test_minutes_affiliations_never_keep_house_or_unit_numbers():
    entries = {m["name"]: m["affiliation"] for m in parse_minutes_speakers(MINUTES)}
    assert entries["M. Wagner"] == "Deville Rd" and entries["T. Cadeau"] == "Glen Willow Pl"


def test_minutes_summary_can_continue_on_following_lines():
    sections = [{"section_title": "6. PUBLIC PARTICIPATION", "section_text":
                 "## 6. Public Participation\n\nL. Plomp, 3592 Whimfield Ter\nre: Item 5 - asked about the splash park.\n"
                 "W. Hobbs, Luxton Rd - concerned about traffic.\n\n## 7. REPORTS\nnot part of it"}]
    entries = parse_minutes_speakers(sections)
    assert [(e["name"], e["said"]) for e in entries] == [("L. Plomp", "asked about the splash park."),
                                                          ("W. Hobbs", "concerned about traffic.")]


def test_entries_without_a_summary_need_an_unambiguous_slot():
    from pipeline.ingestion.participation_names import match_unnamed_to_minutes
    minutes = [{"name": "A. One", "affiliation": "", "said": "", "section": 0, "order": 0},
               {"name": "B. Two", "affiliation": "", "said": "", "section": 0, "order": 1}]
    two = [{"who": "A resident", "position": "other", "topic": "t", "point": "p"} for _ in range(2)]
    assert match_unnamed_to_minutes(two, minutes, taken_names=[], decide=lambda c, o: (0, 0.99)) == {}
    one = two[:1]
    picks = match_unnamed_to_minutes(one, minutes[:1], taken_names=[], decide=lambda c, o: (0, 0.99))
    assert picks[0][0]["name"] == "A. One"
