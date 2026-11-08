from pipeline.ingestion.property_summaries import address_patterns, excerpt


def test_address_patterns_match_the_records_spellings():
    p = address_patterns("3680", "Trans-Canada Highway")
    assert "%3680 Trans%Canada%highway%" in p
    assert "%3680 Trans%Canada%hwy%" in p
    assert "%3680 Trans%Canada%" in p
    assert "%3680 TCH%" in p  # budget tables
    assert "%3094 JR%" not in address_patterns("3094", "Jacklin Road")
    assert address_patterns("", "Jacklin Road") == []
    assert address_patterns("3094", "Road") == []


def test_excerpt_windows_on_the_address_and_scores_what_it_tells():
    text = "| PD02 - 3680 TCH | 825,000 |\n| PD03 - JLBP Clubhouse | 3,000,000 |"
    window, score = excerpt(text, "3680")
    assert window.startswith("PD02 - 3680 TCH 825,000")
    assert score >= 1
    dull, dull_score = excerpt("Facilities include 3680 Trans Canada Highway property and the bike park.", "3680")
    assert dull_score == 0
    long = "x" * 500 + " 3680 Trans Canada Highway: explore the sale of the parcel " + "y" * 500
    window, score = excerpt(long, "3680")
    assert window.startswith("…") and window.endswith("…") and "explore the sale" in window and score >= 1


def test_spoken_patterns_allow_filler_words_after_the_number():
    assert "%3680%Trans%Canada%" in address_patterns("3680", "Trans-Canada Highway", spoken=True)
    assert "%3680%Trans%Canada%" not in address_patterns("3680", "Trans-Canada Highway")
