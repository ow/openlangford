from pipeline.ingestion.participation_person_links import (
    LINKS_VERSION,
    STAMP,
    build_registry,
    full_name,
    letters_of,
    link_item,
    link_letters,
    link_speakers,
    official_ids,
)

PEOPLE = [
    {"id": 1, "name": "Tanya Sunshine"},
    {"id": 2, "name": "N. Joel"},
    {"id": 3, "name": "Pat Smith"},
    {"id": 4, "name": "pat smith"},  # second row with the same name, different case
    {"id": 5, "name": "Lillian Szpak", "is_councillor": True},
    {"id": 6, "name": "Kim Hall"},  # council membership
    {"id": 7, "name": "Dana Ross"},  # staff membership
    {"id": 8, "name": "Robin Lee"},  # documented government staff at a meeting
    {"id": 9, "name": "Joel Nash"},
]
MEMBERSHIPS = [
    {"person_id": 6, "role": "Councillor", "organizations": {"classification": "Council"}},
    {"person_id": 7, "role": "Manager", "organizations": {"classification": "Staff"}},
    {"person_id": 9, "role": "Citizen Representative", "organizations": {"classification": "Committee"}},
]
ROLES = [{"person_id": 8, "classification": "government_staff"}]


def registry():
    return build_registry(PEOPLE, official_ids(PEOPLE, MEMBERSHIPS, ROLES))


def link(who):
    [speaker], _ = link_speakers([{"who": who, "position": "asks", "point": "p", "topic": "t"}], registry())
    return speaker.get("person_id")


def test_unique_full_name_match_links_case_insensitively_and_ignores_street():
    assert link("Tanya Sunshine") == 1
    assert link("TANYA  SUNSHINE (Goldstream Avenue)") == 1


def test_initial_style_names_never_link():
    assert full_name("N. Joel") is None
    assert full_name("W. Bowers (Langford)") is None
    assert full_name("N Joel") is None
    assert link("N. Joel") is None


def test_single_word_and_resident_labels_never_link():
    assert link("Rossander (Langford)") is None
    assert link("A resident") is None


def test_two_people_with_the_same_name_never_link():
    assert link("Pat Smith") is None


def test_councillors_and_staff_never_link():
    assert link("Lillian Szpak") is None  # is_councillor
    assert link("Kim Hall") is None  # council membership
    assert link("Dana Ross") is None  # staff membership
    assert link("Robin Lee") is None  # documented staff role


def test_committee_citizen_representative_is_still_a_public_participant():
    assert link("Joel Nash") == 9


def test_unknown_name_never_links():
    assert link("Somebody Else") is None


def test_stale_person_id_is_removed_and_rerun_is_idempotent():
    speakers = [{"who": "A resident", "person_id": 1}, {"who": "Tanya Sunshine"}]
    once, changed = link_speakers(speakers, registry())
    assert changed
    assert "person_id" not in once[0] and once[1]["person_id"] == 1
    twice, changed_again = link_speakers(once, registry())
    assert not changed_again and twice == once


class FakeQuery:
    def __init__(self, log, data):
        self.log, self.data = log, data

    def update(self, payload):
        self.log.append(("update", payload))
        return self

    def eq(self, column, value):
        self.log.append(("eq", column, value))
        return self

    def execute(self):
        return type("R", (), {"data": self.data})()


class FakeSupabase:
    def __init__(self, data=(1,)):
        self.log, self.data = [], list(data)

    def table(self, name):
        return FakeQuery(self.log, self.data)


def item(**meta):
    return {"id": 10, "updated_at": "2026-10-28T00:00:00", "meta": {"participation": {"speakers": [{"who": "Tanya Sunshine"}]}, **meta}}


def test_link_item_writes_with_compare_and_swap_on_updated_at():
    sb = FakeSupabase()
    result = link_item(sb, item(other="kept"), registry())
    assert result["written"] and result["linked"] == [1]
    payload = sb.log[0][1]["meta"]
    assert payload["other"] == "kept" and payload[STAMP] == LINKS_VERSION
    assert payload["participation"]["speakers"][0]["person_id"] == 1
    assert ("eq", "updated_at", "2026-10-28T00:00:00") in sb.log


def test_link_item_dry_run_and_up_to_date_items_do_not_write():
    sb = FakeSupabase()
    assert not link_item(sb, item(), registry(), dry_run=True)["written"]
    current = item(**{STAMP: LINKS_VERSION})
    current["meta"]["participation"]["speakers"][0]["person_id"] = 1
    assert not link_item(sb, current, registry())["written"]
    assert sb.log == []


def test_link_item_reports_a_lost_race():
    result = link_item(FakeSupabase(data=()), item(), registry())
    assert not result["written"] and result["conflict"]


def letter(who, **extra):
    return {"who": who, "position": "opposes", "topic": "t", "point": "p", "sent": "", **extra}


def written(*letters):
    return {"version": "3", "documents": [
        {"extracted_document_id": 5, "document_id": 6, "title": "Correspondence", "letters": list(letters)},
        {"extracted_document_id": 7, "document_id": 8, "letters": []},
    ]}


def test_letter_authors_follow_the_same_rule():
    out, changed = link_letters(written(
        letter("Tanya Sunshine (Langvista Drive)"),
        letter("A resident"),
        letter("T. Sunshine"),
        letter("Pat Smith"),
        letter("Dana Ross"),
        letter("Kim Hall, Westhills Land Corporation"),
        letter("John Redacted Sunshine"),
    ), registry())
    assert changed
    ids = [l.get("person_id") for l in letters_of(out)]
    assert ids == [1, None, None, None, None, None, None]
    assert out["version"] == "3" and out["documents"][1] == {"extracted_document_id": 7, "document_id": 8, "letters": []}
    assert out["documents"][0]["title"] == "Correspondence"
    assert out["documents"][0]["letters"][0]["who"] == "Tanya Sunshine (Langvista Drive)"  # stored text untouched


def test_legacy_flat_letters_and_idempotent_rerun():
    out, changed = link_letters({"letters": [letter("Joel Nash")]}, registry())
    assert changed and out["letters"][0]["person_id"] == 9
    again, changed_again = link_letters(out, registry())
    assert not changed_again and again is out


def test_stale_letter_link_is_removed():
    out, changed = link_letters(written(letter("A resident", person_id=1)), registry())
    assert changed and "person_id" not in letters_of(out)[0]


def test_link_item_links_letters_without_inventing_a_participation_block():
    sb = FakeSupabase()
    result = link_item(sb, {"id": 11, "updated_at": "t", "meta": {"written_participation": written(letter("Tanya Sunshine"))}},
                       registry())
    assert result["written"] and result["linked"] == [] and result["letters_linked"] == [1]
    payload = sb.log[0][1]["meta"]
    assert "participation" not in payload and payload[STAMP] == LINKS_VERSION
    assert payload["written_participation"]["documents"][0]["letters"][0]["person_id"] == 1


def test_link_item_links_speakers_and_letters_together():
    sb = FakeSupabase()
    meta = {"participation": {"speakers": [{"who": "Tanya Sunshine"}]}, "written_participation": written(letter("Joel Nash"))}
    result = link_item(sb, {"id": 12, "updated_at": "t", "meta": meta}, registry())
    assert result["linked"] == [1] and result["letters_linked"] == [9]
    assert "person_id" not in meta["written_participation"]["documents"][0]["letters"][0]  # input not mutated


def test_an_older_stamp_is_rewritten_even_when_nothing_changes():
    sb = FakeSupabase()
    current = {"id": 13, "updated_at": "t", "meta": {STAMP: "1", "participation": {"speakers": [{"who": "A resident"}]}}}
    result = link_item(sb, current, registry())
    assert not result["changed"] and result["would_write"] and result["written"]
    assert sb.log[0][1]["meta"][STAMP] == LINKS_VERSION == "2"
