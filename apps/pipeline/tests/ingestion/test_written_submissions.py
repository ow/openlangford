"""Written submissions: admission, placement and storage merging."""
from pipeline.ingestion.written_submissions import admit_letters, is_correspondence, merge_written, place_letters

SECTIONS = [{"id": 1, "section_text": "### Submission: Chantelle Lehoux\nI am not in agreement with Bylaw 2037.\n"
             "Chantelle Lehoux\n3581 Kelly Dawn Place\nVictoria, BC V9C 4J1\nchantelle@example.com 250-555-1234"}]


def raw(**over):
    return {"author": "chantelle lehoux", "street": "3581 Kelly Dawn Place", "organization": "", "position": "opposes",
            "topic": "Bylaw 2037", "point": "Opposes Bylaw 2037.", "sent": "March 28, 2022",
            "support_quote": "I am not in agreement with Bylaw 2037.", **over}


STREETS = {"streets": ["Kelly Dawn Place"]}


def test_admits_verified_letters_with_street_only():
    [letter] = admit_letters([raw()], SECTIONS, STREETS)
    assert letter["who"] == "Chantelle Lehoux (Kelly Dawn Place)"
    assert "3581" not in str(letter) and "@" not in str(letter) and "555" not in str(letter)


def test_rejects_unquoted_letters_and_unseen_authors():
    assert admit_letters([raw(support_quote="I love the towers.")], SECTIONS, STREETS) == []
    [letter] = admit_letters([raw(author="Someone Else")], SECTIONS, STREETS)
    assert letter["who"].startswith("A resident")


def test_correspondence_titles():
    assert is_correspondence("Public submissions / correspondence re Bylaw No. 2037")
    assert is_correspondence("Correspondence - Email from Dale R. Douglas re: Zoning")
    assert not is_correspondence("GIA Package — Remaining funding request letters")
    assert not is_correspondence("Staff Report: Rezoning")


def test_linked_documents_keep_all_letters_on_their_item():
    letters = [{"topic": "a", "point": "x"}, {"topic": "b", "point": "y"}]
    assert place_letters(letters, [], linked_item_id=7, decide=None) == ({7: letters}, [])


def test_unlinked_letters_are_placed_when_confident_and_held_with_candidates_otherwise():
    items = [{"id": 1, "title": "Adoption of the minutes"}, {"id": 2, "title": "Bylaw 2037"}, {"id": 3, "title": "Bylaw 2040"}]
    letters = [{"who": "A", "topic": "2037", "point": "x"}, {"who": "B", "topic": "2040", "point": "y"},
               {"who": "C", "topic": "?", "point": "z"}]
    answers = iter([[(0, 0.9), (1, 0.1)], [(1, 0.8)], [(1, 0.4), (0, 0.35)]])
    seen = []

    def decide(context, choices):
        seen.append([c["id"] for c in choices])
        return next(answers)

    placed, held = place_letters(letters, items, linked_item_id=None, decide=decide)
    assert seen[0] == [2, 3]  # procedural items aren't offered
    assert {k: [l["topic"] for l in v] for k, v in placed.items()} == {2: ["2037"], 3: ["2040"]}
    assert [(h["who"], [(c["item_id"], c["probability"]) for c in h["candidates"]]) for h in held] == [("C", [(3, 0.4), (2, 0.35)])]


def test_admin_placements_are_honoured_without_asking_the_model():
    from pipeline.ingestion.written_submissions import letter_key
    items = [{"id": 2, "title": "Bylaw 2037"}, {"id": 3, "title": "Bylaw 2040"}]
    letters = [{"who": "C", "topic": "?", "point": "z"}, {"who": "D", "topic": "spam", "point": "w"}]
    decisions = {letter_key(letters[0]): 3, letter_key(letters[1]): None}

    def decide(context, choices):
        raise AssertionError("decided letters must not be re-asked")

    placed, held = place_letters(letters, items, linked_item_id=None, decide=decide, decisions=decisions)
    assert placed == {3: [letters[0]]} and held == []


def test_merge_replaces_only_this_documents_group():
    meta = {"other": 1, "written_participation": {"documents": [
        {"extracted_document_id": 5, "letters": [{"who": "old"}]},
        {"extracted_document_id": 9, "letters": [{"who": "keep"}]}]}}
    out = merge_written(meta, {"extracted_document_id": 5, "letters": [{"who": "new"}]})
    assert out["other"] == 1
    assert [d["letters"][0]["who"] for d in out["written_participation"]["documents"]] == ["new", "keep"]
    out = merge_written(out, {"extracted_document_id": 5, "letters": []})
    out = merge_written(out, {"extracted_document_id": 9, "letters": []})
    assert "written_participation" not in out


def test_probability_split_across_one_matters_items_still_places_the_letter():
    items = [{"id": 365, "title": "Bylaw 2037 hearing", "matter_id": 126, "item_order": "5.1"},
             {"id": 395, "title": "Bylaw 2037 readings", "matter_id": 126, "item_order": "12.3"},
             {"id": 389, "title": "Correspondence"}]
    letters = [{"who": "Chris Burdge", "topic": "Dunford", "point": "Opposes"}]
    contexts = []

    def decide(context, choices):
        contexts.append(context)
        return [(1, 0.55), (0, 0.3), (2, 0.03)]

    placed, held = place_letters(letters, items, linked_item_id=None, decide=decide,
                                 document_title="Public submissions re Bylaw No. 2037")
    assert placed == {365: letters} and held == []  # the matter's first item in the meeting
    assert "Public submissions re Bylaw No. 2037" in contexts[0]


def test_long_documents_are_read_in_chunks_without_losing_text():
    from pipeline.ingestion.written_submissions import _chunks
    sections = [{"section_text": "a" * 30000}, {"section_text": "b" * 30000}, {"section_text": "c" * 120000}]
    chunks = _chunks(sections, limit=50000)
    assert all(len(c) <= 50000 for c in chunks)
    assert "".join(chunks).replace("\n", "") == "a" * 30000 + "b" * 30000 + "c" * 120000


def test_author_uses_the_letters_own_spelling():
    from pipeline.ingestion.written_submissions import _source_spelling
    text = "From: Debbie FitzGerald\nSent: ...\n### Submission: Deb (Deborah) Wormald"
    assert _source_spelling("Debbie Fitzgerald", text) == "Debbie FitzGerald"
    assert _source_spelling("Deborah Wormald", text) == "Deborah Wormald"
    assert _source_spelling("Someone Else", text) == ""


def test_section_headings_are_not_offered():
    from pipeline.ingestion.written_submissions import _is_heading
    items = [{"id": 1, "item_order": "6", "title": "REPORTS"}, {"id": 2, "item_order": "6.1", "title": "Rezoning"},
             {"id": 3, "item_order": "7", "title": "Correspondence"}]
    assert [_is_heading(it, items) for it in items] == [True, False, False]
    seen = []
    place_letters([{"who": "A", "topic": "t", "point": "p"}], items, linked_item_id=None,
                  decide=lambda c, choices: seen.append([x["id"] for x in choices]) or [])
    assert seen == [[2, 3]]


def test_author_titles_and_credentials_are_dropped():
    from pipeline.ingestion.written_submissions import clean_author
    assert clean_author("Dr Sara Nikoofard PhD PENG LEED Green Associate CMVP Dr Omid Aghaei PhD PGEO") == "Sara Nikoofard and Omid Aghaei"
    assert clean_author("Braden Hutchins, MPA") == "Braden Hutchins"
    assert clean_author("Mary Wagner") == "Mary Wagner"
    assert clean_author("Jo & Sam Smith") == "Jo and Sam Smith"
    assert clean_author("Mr Kim Boyd") == "Kim Boyd"
    # Never truncate long names or touch organisations; keep short surnames.
    assert clean_author("Colette Aaron Miller Annie Hardy Schultz") == "Colette Aaron Miller Annie Hardy Schultz"
    assert clean_author("L Hedl Y Cu Lien") == "L Hedl Y Cu Lien"
    org = "BC Restaurant and Foodservices Association; Alliance of Beverage Licensees; BC Craft Brewers Guild"
    assert clean_author(org) == org
    assert clean_author("Jane Ma") == "Jane Ma"
