from pipeline.ingestion import public_speakers as ps
from pipeline.ingestion import speaker_identity as si


def seg(i, label, start, text, end=None):
    return {"id": i, "speaker_name": label, "start_time": start, "end_time": end or start + 5, "text_content": text}


ITEM = {"id": 7, "title": "BYLAW NO. 2028 - Public Hearing", "discussion_start_time": 0, "discussion_end_time": 1000}


def test_answers_to_a_name_request_and_my_name_is():
    turns = si.build_turns([
        seg(1, "Speaker_6", 10, "App user Bernadette, please unmute yourself, state your name and address for the record."),
        seg(2, "Speaker_4", 20, "Bernadette Armstrong, 2813 Rodney Road. My concern is the traffic and the noise for everyone."),
        seg(3, "Speaker_6", 60, "Thank you. Next caller, please state your name for the record."),
        seg(4, "Speaker_4", 70, "Hi there, can you hear me? Okay."),  # same diarization label, a different caller: no name
        seg(5, "Speaker_9", 90, "Hello. My name is Jay Scott. And I live at Fairway Avenue."),
    ])
    found = [(i["label"], i["spoken"]) for i in ps.introductions(turns, [ITEM])]
    assert found == [("Speaker_4", "Bernadette Armstrong"), ("Speaker_9", "Jay Scott")]
    # The name covers the caller's own turns only: the next caller on the same label starts a new span.
    assert ps.span(turns, 1, "Speaker_4", ITEM) == [1]


def test_guest_introduced_by_the_chair():
    turns = si.build_turns([
        seg(1, "Speaker_2", 10, "Next on the agenda is a presentation on the community safety working groups update with James Bridge. Welcome."),
        seg(2, "Speaker_1", 20, "Thank you very much, Council. " + "I'd like to walk you through the work of three working groups. " * 5),
    ])
    assert [(i["label"], i["spoken"]) for i in ps.introductions(turns, [ITEM])] == [("Speaker_1", "James Bridge")]


def test_spelling_settles_on_the_known_person_and_garbles_wait_for_review():
    pool = ["Jacqueline Gintaut", "J. Gowing", "L. Plomp", "Lori Plomp"]
    stated = {"key": "x", "transcribed": "", "conflict": {}, "status": "published", "basis": "introduction", "display": None}
    gintow = ps._settle({**stated, "transcribed": "Jacqueline Gintow"}, "Jacqueline Gintow", pool)
    assert (gintow["status"], gintow["display"]) == ("published", "Jacqueline Gintaut")  # not "J. Gowing"
    assert ps._settle({**stated, "transcribed": "Lori Pump"}, "Lori Pump", pool)["display"] == "Lori Plomp"
    new = ps._settle({**stated, "transcribed": "Darlene Tate"}, "Darlene Tate", pool)
    assert (new["status"], new["display"]) == ("published", "Darlene Tate")  # stated for the record
    assert ps._settle({**stated, "transcribed": "Ron Coutrey"}, "ron coutrey", pool)["status"] == "review"
    assert not ps._same_name("James Bridge", "James Ridge")


def test_officials_are_left_to_speaker_identity():
    officials = si.candidates_from_people([{"id": 1, "name": "B. Hutchins"}, {"id": 4, "name": "M. Watmough"}])
    assert ps.is_official("Brayden Hutchins", officials)
    assert ps.is_official("Marie Watmo", officials)
    assert not ps.is_official("Bernadette Armstrong", officials)


def test_turns_of_a_merged_label_are_named_one_by_one():
    # 2023-04-03: Speaker_1 is the finance director presenting, then other staff answering questions.
    turns = si.build_turns([
        seg(1, "Speaker_3", 140, "Uh Mr. Dilable, you have a presentation for us."),
        seg(2, "Speaker_1", 147, "Thank you. The budget process and timelines are now complete.", end=400),
        seg(3, "Speaker_7", 400, "A question on the repairs line, through the chair. Mr. Double, did you want to answer that?"),
        seg(4, "Speaker_1", 420, "Yes, the contract covers general repairs and maintenance.", end=480),
        seg(5, "Speaker_7", 480, "Thank you. Ms. Murrell, go ahead."),
        seg(6, "Speaker_1", 490, "I live on Langford Lake and I have a question.", end=520),
    ])
    labels = {"Speaker_1": {"all_evidence": [
        {"kind": "called", "person_id": 55, "at": 147.0, "quote": "Mr. Dilable"},
        {"kind": "called", "person_id": 10, "at": 420.0, "quote": "Mr. Double"},
        {"kind": "called", "person_id": 20, "at": 490.0, "quote": "Ms. Murrell"},  # sounds like Councillor Morley
    ]}}
    named = {(n["person_id"], tuple(n["turns"])) for n in si.turn_names(turns, labels, {55, 10, 20}, council={20})}
    assert named == {(55, (1,)), (10, (3,))}


def test_fillers_and_common_words_are_not_names():
    assert ps._name(ps.ANSWER.search("Um Joanne, can you speak out, please?")) is None  # one word once "Um" goes
    assert ps._name(ps.ANSWER.search("Here Lavac, 926 Greystone Place.")) is None
    assert ps._name(ps.ANSWER.search("Uh Wendy Haas, 3442 Luxton Road.")) == "Wendy Haas"


def test_budget_meeting_introductions():
    # 2023-04-03 Committee of the Whole: the name comes a turn after the request, or with no request at all.
    turns = si.build_turns([
        seg(1, "Speaker_2", 10, "App user S. Perry, please unmute yourself, provide your first initial last name and street name for the record."),
        seg(2, "Speaker_5", 20, "Hi, can you hear me?"),
        seg(3, "Speaker_2", 25, "Yes, we can. Go ahead, please."),
        seg(4, "Speaker_5", 30, "Hi, I'm S. Perry from Glen Lake Road. I'm speaking to the budget and report."),
        seg(5, "Speaker_3", 90, "Is there anyone from the gallery that would like to come forward?"),
        seg(6, "Speaker_4", 100, "S. Costello, Roboli Place. Um, I sent an email this morning about the budget."),
    ])
    assert [(i["label"], i["spoken"]) for i in ps.introductions(turns, [ITEM])] == [("Speaker_5", "S. Perry"), ("Speaker_4", "S. Costello")]
