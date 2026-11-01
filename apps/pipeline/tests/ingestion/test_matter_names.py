from pipeline.ingestion.matter_names import central_name, excerpt, keep_name, name_pattern, tsquery_variants

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
