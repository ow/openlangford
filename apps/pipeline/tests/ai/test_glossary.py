from pipeline.ai import glossary


def test_terms_have_unique_ids_and_meanings():
    ids = [t["id"] for t in glossary.terms()]
    assert len(ids) == len(set(ids))
    assert all(len(t["means"]) > 10 for t in glossary.terms())


def test_stage_labels_match_the_web_apps():
    labels = glossary.stage_labels()
    assert labels["adopted"] == "Final approval."
    assert set(labels) == {"rescinded_adoption", "rescinded_reading", "rescinded", "adopted", "second_third", "third", "public_hearing", "second", "first"}


def test_resident_register_uses_we_write():
    block = glossary.prompt_block("resident")
    assert "/how-council-works" in block
    assert "- Tabled:" in block
    assert "one step from final approval" in block
    assert "Motion CARRIED" not in block


def test_record_register_limited_to_requested_terms():
    block = glossary.prompt_block("record", only=["carried", "tabled"])
    assert "Motion CARRIED" in block
    assert "- Tabled:" in block
    assert "- Rezoning:" not in block
