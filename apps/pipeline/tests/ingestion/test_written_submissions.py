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


def test_petition_signers_collapse_into_one_entry():
    from pipeline.ingestion.written_submissions import collapse_petitions
    signers = [{"who": n, "position": "opposes", "topic": "Southglen", "point": "Opposes allowing through traffic on Southglen Drive."}
               for n in ("Darin Ferrill", "Karen Hatch", "Bryan Wilton")]
    other = {"who": "Jo Smith", "position": "supports", "topic": "x", "point": "Supports something else."}
    out = collapse_petitions([signers[0], other, *signers[1:]])
    assert [o["who"] for o in out] == ["Petition (3 signatures)", "Jo Smith"]
    assert out[0]["signatures"] == 3 and out[0]["point"].startswith("Opposes")
    assert collapse_petitions(signers[:2]) == signers[:2]  # two matching letters aren't a petition


def test_forwarded_copies_of_one_letter_are_kept_once():
    from pipeline.ingestion.written_submissions import collapse_petitions
    copy = {"who": "A resident", "position": "opposes", "topic": "Latoria", "point": "Urges Council to delay first reading."}
    assert collapse_petitions([copy, dict(copy), dict(copy)]) == [copy]
    two = [{**copy, "who": "Jo Smith"}, {**copy, "who": "Sam Lee"}]
    assert collapse_petitions(two) == two


def test_display_name_casing():
    from pipeline.ingestion.written_submissions import display_name
    assert display_name("ELIZABETH MARKUS") == "Elizabeth Markus"
    assert display_name("Kirk And Stephanie Lewis, Langford Triathlon") == "Kirk and Stephanie Lewis, Langford Triathlon"
    assert display_name("Constable Kyle Ross, West Shore RCMP") == "Constable Kyle Ross, West Shore RCMP"
    assert display_name("BC Hydro") == "BC Hydro"


def test_item_description_includes_contents():
    from pipeline.ingestion.written_submissions import _item_description
    text = _item_description({"item_order": "9", "title": "BYLAWS", "plain_english_summary": "Council adopted bylaws.",
                              "context_documents": ["Bylaw No. 2000 — Westhills CD3 zone"], "context_decisions": ["Gave readings to Bylaw 2000"]})
    assert "9 BYLAWS" in text and "Westhills CD3" in text and "Decided: Gave readings" in text


def test_specific_terms():
    from pipeline.ingestion.written_submissions import specific_terms
    text = ("Speedway lands proposed for Business Park (BP9) zoning and an OCP amendment for RS1; see Bylaw No. 1951, "
            "file Z21-0040 at 2207 Millstream Road.")
    assert {"BP9", "RS1", "Bylaw 1951", "Z21-0040", "2207 Millstream Rd"} <= specific_terms(text)


def test_shared_terms_reach_the_model():
    items = [{"id": 1, "title": "Bylaw 1953 Business Park 3 Amy Rd"},
             {"id": 2, "title": "Bylaw 1951 zoning 2207 Millstream", "context_summaries": ["create a new Business Park zone (BP9)"]}]
    seen = []

    def decide(context, choices):
        seen.append((context, [c.get("shared_terms") for c in choices]))
        return [(1, 0.9)]

    letter = {"who": "A resident", "topic": "Speedway", "point": "Asks about plans.",
              "excerpt": "the Speedway lands proposed for Business Park (BP9) zoning"}
    placed, held = place_letters([letter], items, linked_item_id=None, decide=decide, document_title="Re: Western speedway rezoning")
    assert placed == {2: [letter]}
    context, shared = seen[0]
    assert "Letter text: the Speedway lands" in context and shared == [[], ["BP9"]]


def test_letter_excerpt_starts_at_the_writers_header():
    from pipeline.ingestion.written_submissions import letter_excerpt
    text = "From: Ben Moreau\nI oppose.\n\nSubmission: Chris Burdge\nFrom: Chris Burdge\nTraffic is bad."
    assert letter_excerpt(text, "Chris Burdge").startswith("Submission: Chris Burdge")


def test_letters_already_placed_describe_an_item():
    from pipeline.ingestion.written_submissions import _item_description
    item = {"item_order": "3.c", "title": "Bylaw 1955 OCP amendment 2207 Millstream Rd",
            "context_letters": ["Western Speedway Rezoning", "Goldie Road connections"]}
    assert "Letters already placed here are about: Western Speedway Rezoning; Goldie Road connections" in _item_description(item)


def test_decision_records_old_and_new():
    from pipeline.ingestion.written_submissions import decision_record
    assert decision_record(365) == {"item": 365, "by": "unknown"}
    assert decision_record(None) == {"item": None, "by": "admin"}  # only admins ever dismissed
    assert decision_record({"item": 5, "by": "admin"})["by"] == "admin"


def test_old_and_new_decisions_are_both_honoured():
    items = [{"id": 2, "title": "Bylaw 2037"}, {"id": 3, "title": "Bylaw 2040"}]
    a = {"who": "A", "topic": "t", "point": "p"}
    b = {"who": "B", "topic": "u", "point": "q"}
    from pipeline.ingestion.written_submissions import letter_key
    decisions = {letter_key(a): 3, letter_key(b): {"item": 2, "by": "admin"}}
    placed, held = place_letters([a, b], items, linked_item_id=None, decide=lambda c, o: 1 / 0, decisions=decisions)
    assert placed == {3: [a], 2: [b]} and held == []


def test_similar_admin_decisions_are_shown_as_examples():
    from pipeline.ingestion.written_submissions import similar_examples
    examples = [
        {"meeting_id": 1, "extracted_id": "9", "key": "k1", "item": 7, "item_title": "Bylaw 1951 hearing",
         "letter": {"topic": "Western Speedway rezoning", "point": "Opposes the speedway towers."}},
        {"meeting_id": 1, "extracted_id": "9", "key": "k2", "item": None,
         "letter": {"topic": "Tennis courts", "point": "Wants more tennis courts."}},
    ]
    letter = {"who": "X", "topic": "Speedway traffic", "point": "Worried about speedway rezoning traffic."}
    assert [e["key"] for e in similar_examples(letter, examples)] == ["k1"]
    assert similar_examples(letter, examples, exclude=("1", "9", "k1")) == []
    seen = []
    place_letters([letter], [{"id": 7, "title": "Bylaw 1951"}], linked_item_id=None,
                  decide=lambda c, o: seen.append(c) or [(0, 0.9)], examples=examples)
    assert 'How a reviewer placed similar letters' in seen[0] and "-> Bylaw 1951 hearing" in seen[0]


def test_city_hall_address_is_not_an_identifier():
    from pipeline.ingestion.written_submissions import specific_terms
    assert specific_terms("Mayor and Council, 877 Goldstream Avenue; re 2207 Millstream Road") == {"2207 Millstream Rd"}
