

def test_a_bare_section_word_is_a_heading_whatever_its_summary_says():
    from pipeline.ingestion.topic_tidy import SECTION_WORD
    for t in ("REPORTS", "10. REPORTS", "BYLAWS", "Correspondence", "STAFF REPORTS"):
        assert SECTION_WORD.match(t)
    for t in ("REPORTS - Show and Shine lane closures", "PUBLIC PARTICIPATION", "Bylaw No. 1646"):
        assert not SECTION_WORD.match(t)
