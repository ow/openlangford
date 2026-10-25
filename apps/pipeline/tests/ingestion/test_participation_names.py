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


def test_first_time_name_is_published_as_introduced():
    r = resolve("holly adams", "Hello, I'm Holly Adams.")
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


def test_minutes_matching_is_confident_and_one_to_one():
    from pipeline.ingestion.participation_names import match_unnamed_to_minutes
    minutes = [{"name": "B. Armstrong", "affiliation": "", "said": "concerns about height"},
               {"name": "D. Elizabeth", "affiliation": "", "said": "supports the project"},
               {"name": "C. Harder", "affiliation": "", "said": "asked about parking"}]
    speakers = [
        {"who": "A resident (Rodney Road)", "position": "opposes", "topic": "height", "point": "Opposes the height."},
        {"who": "A resident", "position": "supports", "topic": "project", "point": "Supports it."},
        {"who": "A resident", "position": "supports", "topic": "project", "point": "Also supports it."},
        {"who": "Colby Harder", "position": "asks", "topic": "parking", "point": "Asks about parking."},
        {"who": "A resident", "position": "asks", "topic": "parking", "point": "Asks about parking too."},
    ]
    answers = iter([(0, 0.95), (1, 0.9), (1, 0.9), (1, 0.99)])
    picks = match_unnamed_to_minutes(speakers, minutes, taken_names=["Colby Harder"],
                                     decide=lambda context, entries: next(answers))
    # Speaker 0 matched; speakers 1 and 2 both picked D. Elizabeth so neither is named;
    # C. Harder is already named in this item (as Colby Harder), so it isn't offered; the last
    # speaker's pick of index 1 is D. Elizabeth, now chosen three times, so nobody gets it.
    assert {i: e["name"] for i, (e, _) in picks.items()} == {0: "B. Armstrong"}


def test_low_confidence_minutes_match_is_ignored():
    from pipeline.ingestion.participation_names import match_unnamed_to_minutes
    picks = match_unnamed_to_minutes([{"who": "A resident", "position": "other", "topic": "t", "point": "p"}],
                                     [{"name": "B. Armstrong", "affiliation": "", "said": "x"}], taken_names=[],
                                     decide=lambda context, entries: (0, 0.6))
    assert picks == {}
