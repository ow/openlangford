from pipeline.ingestion import participation_mentions as pm


def test_comment_only_items():
    assert pm.comment_only("PUBLIC PARTICIPATION")
    assert pm.comment_only("Correspondence - Re: Hike for Hunger")
    assert not pm.comment_only("PUBLIC HEARING — BYLAW NO. 1833 (790 McCallum Rd)")


def test_a_link_with_no_speaker_about_the_topic_is_hidden_on_comment_only_items():
    link = {"title": "PUBLIC PARTICIPATION", "quote": "names it", "review": None}
    assert pm.to_hide(link, [])
    assert not pm.to_hide(link, [2])
    assert not pm.to_hide(link, None)  # unanswered: judged again next run
    assert not pm.to_hide({**link, "review": "accepted"}, [])  # an editor kept it


def test_a_hearing_found_by_its_own_passage_stays():
    hearing = {"title": "PUBLIC HEARING — BYLAW NO. 1349 (940 and 949 Flatman Avenue)", "quote": "940 and 949 Flatman", "review": None}
    assert not pm.to_hide(hearing, [])
    assert pm.to_hide({**hearing, "quote": None}, [])


def test_speaker_questions_one_per_speaker():
    qs = pm.speaker_questions("Waste collection", "Curbside pickup.", [{"topic": "a"}, {"topic": "b"}])
    assert [q["name"] for q in qs] == ["s0", "s1"]
