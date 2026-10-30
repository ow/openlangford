import math
import random

from pipeline.ingestion import speaker_identity as si
from pipeline.ingestion.speaker_names import VoiceBank, recover_labels

ROSTER = [
    {"id": 1, "name": "Scott Goodmanson"},
    {"id": 22, "name": "Mary Wagner"},
    {"id": 23, "name": "Kimberley Guiry"},
    {"id": 21, "name": "Colby Harder"},
    {"id": 4, "name": "M. Watmough"},
    {"id": 80, "name": "Melisa Miles"},
]


def index(extra=None):
    return si.NameIndex(si.candidates_from_people(ROSTER), si.candidates_from_people(extra or [], on_roster=False))


def seg(i, label, start, text):
    return {"id": i, "speaker_name": label, "start_time": start, "end_time": start + 5, "text_content": text}


def test_floor_call_takes_the_closing_name_and_ignores_thanks_and_possessives():
    idx = index()
    assert si.floor_call("I call this meeting to order. Councillor Wagner, can I have our acknowledgement, please?", idx)[0].id == 22
    assert si.floor_call("Thank you, Councillor Harder.", idx) is None
    assert si.floor_call("I want to respond to Councillor Harder's comments.", idx) is None
    # A name mentioned early in a long turn is narration, not a call.
    long = "Councillor Wagner raised this earlier. " + "We will now hear the full staff report on the item " * 3
    assert si.floor_call(long, idx) is None


def test_titled_names_match_asr_misspellings_but_bare_words_do_not():
    idx = index()
    assert si.floor_call("Thank you. Counter Gary.", idx) is None  # "Counter" is not a title
    assert si.floor_call("Anyone else? Councillor Gary.", idx)[0].id == 23
    assert si.floor_call("Anyone else? Councilor Wigner.", idx)[0].id == 22
    assert si.floor_call("Anyone else? Council Bregner.", idx) is None  # too far from any surname
    assert si.floor_call("Anyone else? Gary.", idx) is None


def test_self_introduction_needs_matching_surname_and_given_name():
    idx = index()
    assert si.self_introduction("Good evening. My name is Melissa Miles and I will moderate.", idx)[0].id == 80
    assert si.self_introduction("Hi, I'm Mary Brooke from the Highlands.", idx) is None
    assert si.self_introduction("I'm more concerned about the trail.", idx) is None


def test_ambiguous_surname_resolves_to_nobody():
    idx = si.NameIndex(si.candidates_from_people([{"id": 1, "name": "H. Frederickson"}, {"id": 2, "name": "J. Frederickson"}]))
    assert idx.resolve(["Frederickson"], True) is None


def test_decide_roster_is_supporting_not_required():
    called = [{"kind": "called", "person_id": 22}] * 2
    assert si.decide(called, None, roster={22})["person_id"] == 22
    # Same two calls for someone the minutes don't list: not enough on their own.
    assert si.decide(called, None, roster=set()) is None
    off = called + [{"kind": "moved", "person_id": 22}]
    assert si.decide(off, None, roster=set())["on_roster"] is False


def test_decide_holds_on_conflict():
    events = [{"kind": "called", "person_id": 22}] * 2 + [{"kind": "called", "person_id": 23}] * 2
    assert si.decide(events, None, roster={22, 23}) is None
    voice = {"person_id": 23, "similarity": 0.9, "margin": 0.1}
    assert si.decide([{"kind": "called", "person_id": 22}] * 3, voice, roster={22, 23}) is None
    # A lone call is not enough; chair acts need repetition.
    assert si.decide([{"kind": "called", "person_id": 22}], None, roster={22}) is None
    assert si.decide([{"kind": "chair", "person_id": 1}] * 2, None, roster={1}) is None
    assert si.decide([{"kind": "chair", "person_id": 1}] * 3, None, roster={1})["person_id"] == 1


def test_identify_meeting_names_officials_from_calls_motions_and_chair_but_not_residents():
    segs = [
        seg(1, "Speaker_2", 0, "Good evening. I call this meeting to order. Councillor Wagner, can I have the acknowledgement, please?"),
        seg(2, "Speaker_1", 10, "We acknowledge that we sit on the traditional territories of the Coast Salish peoples."),
        seg(3, "Speaker_2", 20, "Thank you. Could I have a motion to approve the agenda?"),
        seg(4, "Speaker_3", 30, "I'll move that council approve the agenda as presented this evening for the meeting."),
        seg(5, "Speaker_1", 40, "I'll second."),
        seg(6, "Speaker_2", 50, "All those in favour? Opposed? That passes. Public participation. Come on up."),
        seg(7, "Speaker_9", 60, "Hi, my name is Hans Frederickson and I live on Veterans Memorial. I oppose the bylaw."),
        seg(8, "Speaker_2", 70, "Thank you. Anyone else? Councillor Guiry."),
        seg(9, "Speaker_3", 80, "Thank you, Mayor. I wanted to ask about the trail connection through the site."),
        seg(10, "Speaker_2", 90, "Councillor Wagner, go ahead."),
        seg(11, "Speaker_1", 100, "Thanks. I'll be supporting this application tonight for the reasons given."),
        seg(12, "Speaker_2", 110, "I'll call the question. All those in favour? The meeting is adjourned."),
    ]
    motions = [{"id": 9, "mover_id": 23, "seconder_id": 22, "time": 30,
                "text_content": "THAT Council approve the agenda as presented."}]
    res = si.identify_meeting(segs, ROSTER, chair_person_id=1, motions=motions)
    names = {label: e.get("person_id") for label, e in res["labels"].items()}
    assert names["Speaker_2"] == 1
    assert names["Speaker_1"] == 22
    assert names["Speaker_3"] == 23
    assert names["Speaker_9"] is None  # residents are never named from text alone
    kinds = res["labels"]["Speaker_3"]["kinds"]
    assert kinds.get("moved") == 1 and kinds.get("called") == 1


def _vec(seed, noise=0.0, base=None):
    rnd = random.Random(seed)
    v = base[:] if base else [rnd.gauss(0, 1) for _ in range(192)]
    if noise:
        v = [x + rnd.gauss(0, noise) for x in v]
    return v


def test_voice_match_needs_several_meetings_and_a_clear_margin():
    alice, bob = _vec(1), _vec(2)
    fps = [{"person_id": 1, "source_meeting_id": m, "embedding": _vec(10 + m, 0.2, alice)} for m in range(3)]
    fps += [{"person_id": 2, "source_meeting_id": m, "embedding": _vec(20 + m, 0.2, bob)} for m in range(3)]
    match = si.voice_match(_vec(99, 0.2, alice), fps)
    assert match["person_id"] == 1 and match["similarity"] > 0.9
    # Excluding one of Alice's meetings leaves only two: no match.
    assert si.voice_match(_vec(99, 0.2, alice), fps[1:], exclude_meeting=None) is None


def test_voice_bank_drift_check_rejects_another_voice():
    alice, bob = _vec(1), _vec(2)
    rows = [{"person_id": 1, "meeting_id": m, "speaker_label": "Speaker_1", "source": "evidence",
             "embedding": _vec(10 + m, 0.2, alice)} for m in range(4)]
    rows += [{"person_id": 2, "meeting_id": 10 + m, "speaker_label": "Speaker_2", "source": "evidence",
              "embedding": _vec(20 + m, 0.2, bob)} for m in range(4)]
    bank = VoiceBank(rows)
    assert bank.drift_check(1, _vec(50, 0.2, alice))[0] is True
    ok, info = bank.drift_check(1, _vec(51, 0.2, bob))
    assert ok is False and info["reason"] == "drift"
    # No stable reference yet: accepted (text evidence is the safeguard then).
    assert bank.drift_check(3, _vec(52))[0] is True


def test_manual_exemplars_are_the_drift_reference():
    alice, other = _vec(1), _vec(3)
    rows = [{"person_id": 1, "meeting_id": m, "speaker_label": "Speaker_1", "source": "evidence",
             "embedding": _vec(10 + m, 0.2, other)} for m in range(4)]
    rows.append({"person_id": 1, "meeting_id": 99, "speaker_label": "manual:1", "source": "manual", "embedding": alice})
    means = VoiceBank(rows).reference_means()
    assert si._dot(means[1], si._unit(alice)) > 0.99


def test_recover_labels_maps_legacy_named_rows_back_to_their_label():
    rows = [{"id": 1, "speaker_name": "Mary Wagner", "start_time": 1.0, "end_time": 2.0},
            {"id": 2, "speaker_name": "Speaker_3", "start_time": 2.0, "end_time": 3.0}]
    transcript = {"segments": [{"start": 1.0, "end": 2.0, "speaker": "Speaker_1"}, {"start": 2.0, "end": 3.0, "speaker": "Speaker_3"}]}
    assert recover_labels(rows, transcript) == {1: "Speaker_1"}


def test_unit_rejects_bad_vectors():
    assert si._unit([0.0] * 192) is None
    assert si._unit([1.0] * 10) is None
    assert si._unit([math.nan] + [1.0] * 191) is None


def test_a_namesake_in_the_room_shadows_a_bare_surname():
    roster = [{"id": 186, "name": "Nadine King"}, {"id": 2, "name": "Brandy Gordon"}]
    segs = [
        seg(1, "Speaker_9", 0, "App user Shelley King, please unmute yourself and provide your name."),
        seg(2, "Speaker_10", 10, "S. King, Fire Hall Creek Road. Can you hear me?"),
        seg(3, "Speaker_2", 20, "We apologize for that, Miss King."),
        seg(4, "Speaker_10", 30, "I'm just wondering about the zero setback for the parkade behind our homes."),
        seg(5, "Speaker_2", 40, "Is that adequate, Miss King?"),
        seg(6, "Speaker_10", 50, "Yeah, I guess what I'm asking is whether the parkade goes right up to the fence."),
    ]
    res = si.identify_meeting(segs, roster)
    assert res["labels"]["Speaker_10"].get("person_id") is None
    idx = si.NameIndex(si.candidates_from_people(roster))
    idx.shadow_namesakes("App user Shelley King, please unmute.")
    assert idx.resolve(["King"], True) is None
    assert idx.resolve(["Nadine", "King"], True).id == 186


def test_strong_voice_names_staff_the_minutes_roster_omits():
    voice = {"person_id": 6, "similarity": 0.96, "margin": 0.17}
    assert si.decide([], voice, roster={1, 22})["person_id"] == 6
    weak = {"person_id": 6, "similarity": 0.84, "margin": 0.09}
    assert si.decide([], weak, roster={1, 22}) is None
    assert si.decide([], weak, roster={6})["person_id"] == 6
