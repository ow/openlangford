from pipeline.ingestion.matter_names import central_name, excerpt, file_numbers, keep_name, name_pattern, tsquery_variants

SALE = "Disposition of the North Langford Recreation Centre at 1997 Country Club Way, as per the purchase agreement."


def test_names_must_be_specific_and_verbatim():
    assert keep_name("North Langford Recreation Centre", SALE)
    assert keep_name("1997 Country Club Way", SALE)
    assert not keep_name("Recreation", SALE)  # one word
    assert not keep_name("City of Langford", "The City of Langford owns it")  # generic
    assert not keep_name("Westhills Stadium", SALE)  # not in the matter's own text
    assert not keep_name("purchase agreement", SALE)  # no proper name


def test_pattern_spans_line_breaks_and_both_spellings():
    pat = name_pattern("North Langford Recreation Centre")
    assert pat.search("the North Langford\nRecreation  Centre was acquired")
    assert pat.search("the quiet sale of the North Langford Recreation Center in 2020")  # speech-to-text spelling
    assert not pat.search("North Langford Recreation Centres")  # whole words only
    assert tsquery_variants("North Langford Recreation Centre") == ["North Langford Recreation Centre", "North Langford Recreation center"]
    assert tsquery_variants("1997 Country Club Way") == ["1997 Country Club Way"]


def test_excerpt_is_the_sentence_with_the_name():
    page = ("Parks and Recreation Department. The North Langford Recreation Centre was acquired and renovated. "
            "Danbrook Dog Park was constructed.")
    assert excerpt(page, "North Langford Recreation Centre") == "The North Langford Recreation Centre was acquired and renovated."
    assert len(excerpt("word " * 400 + "North Langford Recreation Centre " + "word " * 400, "North Langford Recreation Centre")) <= 320


def test_only_what_the_matter_is_about_counts():
    giveaway = {"title": "Olympic event ticket giveaway", "raw_title": "Olympic Dream Give Away"}
    assert not central_name("Goldstream Avenue", giveaway)  # a street, no civic number
    assert central_name("1997 Country Club Way", giveaway)  # an address is a place's name
    plan = {"title": "Development, review, and design of the accessibility plan", "raw_title": ""}
    assert not central_name("Capital West Accessibility Advisory Committee", plan)  # the body that discussed it
    terms = {"title": "Capital West Accessibility Advisory Committee Terms of Reference", "raw_title": ""}
    assert central_name("Capital West Accessibility Advisory Committee", terms)
    assert central_name("North Langford Recreation Centre", {"title": "Disposition of the North Langford Recreation Centre", "raw_title": ""})


def test_excerpt_keeps_whole_words():
    # The name in the first sentence: nothing is cut ("his was the case" lost its T).
    assert excerpt("This was the case with the North Langford Recreation Center, now private.", "North Langford Recreation Centre") \
        == "This was the case with the North Langford Recreation Center, now private."
    long = "Members raised " + "many different points about parks and fields " * 6 + "and the North Langford Recreation Centre sale."
    quote = excerpt(long, "North Langford Recreation Centre")
    assert quote.startswith("…") and quote[1] != " " and quote.split()[0][1:] in long.split()


def test_addresses_match_abbreviated_street_types():
    pat = name_pattern("977 Langford Parkway")
    assert pat.search("TUP20-0002 - Flight Cannabis Co. - 101-977 Langford Pkwy")
    assert pat.search("at 977 Langford Pkwy. on Monday")
    assert not pat.search("977 Langford Parkways")
    assert tsquery_variants("977 Langford Parkway") == ["977 Langford parkway", "977 Langford pkwy"]
    assert tsquery_variants("Goldstream Avenue Park") == ["Goldstream Avenue Park"]  # not an address


def test_file_numbers_from_identifier():
    assert file_numbers("TUP20-0002") == ["TUP20-0002"]
    assert file_numbers("Bylaw No. 1981; Z21-0006; DVP21-0006") == ["Z21-0006", "DVP21-0006"]
    assert file_numbers("File No. 3910-02; RZ-01-11") == ["RZ-01-11"]
    assert file_numbers("Bylaw No. 1289; File No. 3900-1289") == []
    assert file_numbers(None) == []


def test_table_rows_are_not_mentions():
    from pipeline.ingestion.matter_names import table_row
    assert table_row("…| DVP-17-20 | 8-Aug-17 | 2-Oct-17 | 2207 Millstream Rd | Waive of Fee |")
    assert not table_row("TUP20-0002 - Flight Cannabis Co. - 101-977 Langford Pkwy")


def test_same_application_is_the_permit_number_not_the_address():
    from pipeline.ingestion.matter_names import same_application
    flight = {"file_numbers": ["TUP20-0002"]}
    assert same_application("TUP20-0002 - Flight Cannabis Co. - 101-977 Langford Pkwy", flight)
    assert not same_application("Application to add retail sales at Unit 28 #103 977 Langford Parkway", flight)
    assert not same_application(None, flight)
    assert not same_application("TUP20-0002", {})
