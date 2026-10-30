"""Closed (in-camera) sessions read from minutes text. Texts are trimmed from real Langford minutes."""
from pipeline.ingestion.closed_sessions import analyse_meeting, find_sessions, normalise, reason_codes


def minutes(text: str) -> list[dict]:
    return [{"title": "Minutes - SIGNED", "category": "Minutes", "full_text": text + " " * 300}]


def meeting(date="2025-06-16", **kw):
    return {"id": 1, "meeting_date": date, **kw}


MODERN = """1. CALL TO ORDER Mayor Goodmanson called the meeting to order at 7:00 pm.
4. APPROVAL OF THE AGENDA MOVED BY: MORLEY SECONDED: GUIRY THAT Council approve the agenda as presented. Motion CARRIED.
5. BYLAWS MOVED BY: WAGNER SECONDED: HARDER THAT Council give first reading to Bylaw No. 2200. Motion CARRIED.
13. IN CAMERA RESOLUTION MOVED BY: GUIRY SECONDED: HARDER
THAT Council close the meeting at 8:38 pm to the public pursuant to section 90 (1) (e) and (k) of the Community
Charter to consider: * the acquisition, disposition or expropriation of land or improvements; Motion CARRIED.
14. RISE and REPORT 14.1 Appointment MOVED BY: YACUCHA SECONDED: HARDER THAT Council rise and report the in camera
resolution from February 6, 2023: THAT Council appoint Councillor Wagner. Motion CARRIED.
15. ADJOURNMENT MOVED BY: GUIRY SECONDED: HARDER THAT Council adjourn the meeting.
Mayor Goodmanson adjourned the meeting at 9:33 pm. Motion CARRIED."""


def test_close_time_to_adjournment():
    r = analyse_meeting(meeting(), minutes(MODERN), [], [])
    assert len(r["sessions"]) == 1
    s = r["sessions"][0]
    assert (s["closed_at"], s["position"], s["reasons"]) == ("20:38", "end", ["1e", "1k"])
    assert s["reason_labels"] == ["land", "early talks on a City service"]
    assert (r["called_at"], r["adjourned_at"]) == ("19:00", "21:33")
    assert (r["est_closed_minutes"], r["open_minutes"]) == (55, 98)
    assert (r["method"], r["confidence"]) == ("minutes", "high")


def test_went_in_camera_and_past_midnight():
    text = """Mayor Goodmanson called the meeting to order at 7:06 pm. 12. IN CAMERA RESOLUTION MOVED BY: A SECONDED: B
    THAT Council close the meeting to the public pursuant to section 90 (1) (e) and (k) of the Community Charter.
    Motion CARRIED. The meeting went in camera at 11:39 pm. 13. ADJOURNMENT Mayor Goodmanson adjourned the meeting at 12:34 am."""
    r = analyse_meeting(meeting("2023-04-03"), minutes(text), [], [])
    assert r["sessions"][0]["closed_at"] == "23:39"
    assert r["est_closed_minutes"] == 55
    assert r["open_minutes"] == 273


def test_closed_right_after_opening():
    text = """1. CALL TO ORDER Mayor Goodmanson called the meeting to order at 1:05 pm. 2. TERRITORIAL ACKNOWLEDGEMENT
    Councillor Harder read the Territorial Acknowledgment. 3. APPROVAL OF THE AGENDA MOVED BY: GUIRY SECONDED: WAGNER
    THAT Council approve the agenda as presented. Motion CARRIED. 4. IN CAMERA RESOLUTION MOVED BY: HARDER SECONDED: WAGNER
    THAT Council close the meeting to the public pursuant to section 90 (1) c, e, and 2 (b) of the Community Charter
    to consider: * labour relations or other employee relations; Motion CARRIED. 5. ADJOURNMENT MOVED BY: HARDER
    SECONDED: WAGNER THAT Council adjourn the meeting. Mayor Goodmanson adjourned the meeting at 2:20 pm. Motion CARRIED."""
    r = analyse_meeting(meeting("2024-11-18", type="Special Council"), minutes(text), [], [])
    assert r["sessions"][0]["reasons"] == ["1c", "1e", "2b"]
    assert (r["est_closed_minutes"], r["open_minutes"], r["method"]) == (74, 1, "opening")


OLD = """CALL TO ORDER The Mayor called the meeting to order at 7:00 p.m. 9. BYLAWS MOVED BY: COUNCILLOR WADE SECONDED:
COUNCILLOR SAHLSTROM That Council give First, Second and Third Reading to Bylaw No. 1321. CARRIED. 10. 'IN CAMERA' RESOLUTION MOVED BY: COUNCILLOR
BLACKWELL SECONDED: COUNCILLOR SIFERT a) That it is the opinion of Council that the public interest requires that persons
other than members of Council and Officers be excluded from the meeting to consider confidential information regarding
Negotiations, Property Disposal and Litigation under section 90 (1)(g), (1)(e) & (2)(b) of the Community Charter.
b) That Council continues the meeting in closed session. CARRIED. 11. ADJOURNMENT The Mayor adjourned the meeting at 7:10 p.m."""


def test_old_minutes_count_but_stay_untimed():
    r = analyse_meeting(meeting("2011-02-07"), minutes(OLD), [], [])
    assert len(r["sessions"]) == 1  # resolution + "continues in closed session" are one closing
    assert r["sessions"][0]["reasons"] == ["1e", "1g", "2b"]
    assert r["est_closed_minutes"] is None and r["open_minutes"] is None
    assert (r["method"], r["confidence"]) == ("none", "none")


def test_video_length_gives_the_close_time():
    text = MODERN.replace("close the meeting at 8:38 pm to the public", "close the meeting to the public")
    r = analyse_meeting(meeting(video_duration_seconds=98 * 60 + 20), minutes(text), [], [])
    assert r["sessions"][0]["closed_at"] == "20:38"
    assert (r["est_closed_minutes"], r["method"], r["confidence"]) == (55, "video", "medium")


def test_impossible_span_stays_unknown():
    # "11:30 p.m." typed for a.m. on a 9 a.m. special meeting: never guessed.
    text = """Mayor Goodmanson called the meeting to order at 9:00 a.m. 3. APPROVAL OF THE AGENDA MOVED BY: A SECONDED: B
    THAT Council approve the agenda as presented. Motion CARRIED. IN CAMERA RESOLUTION MOVED BY: A SECONDED: B THAT Council
    close the meeting to the public pursuant to section 90 (1) (a) of the Community Charter. Motion CARRIED.
    5. ADJOURNMENT Mayor Goodmanson adjourned the meeting at 11:30 p.m. Motion CARRIED."""
    r = analyse_meeting(meeting("2023-04-17"), minutes(text), [], [])
    assert len(r["sessions"]) == 1
    assert r["est_closed_minutes"] is None and r["open_minutes"] is None


def test_reopened_in_the_middle():
    text = """The Chair called the meeting to order at 5:30 pm. 2. IN-CAMERA RESOLUTION MOVED BY: A SECONDED: B a) That the public
    be excluded from the meeting under 90 (1) e) of the Community Charter. b) That Council continues the meeting in closed session.
    CARRIED. The meeting reconvened in Open Meeting at 6:15 pm in order to allow a presentation.
    5. PRESENTATION MOVED BY: C SECONDED: D That Council receive the presentation about the casino expansion and refer it to staff for a report on the
    traffic impacts, parking and the effect on neighbouring businesses along Goldstream Avenue and Peatt Road. CARRIED.
    That Council give Bylaw No. 1700 first reading. CARRIED. 12. ADJOURNMENT The Chair adjourned the meeting at 7:05 pm."""
    s = find_sessions(normalise(text))
    assert len(s) == 1
    r = analyse_meeting(meeting("2021-10-17"), minutes(text), [], [])
    assert r["sessions"][0]["position"] == "middle" and r["sessions"][0]["reconvened_at"] == "18:15"


def test_rise_and_report_alone_is_not_a_closing():
    text = """Mayor Goodmanson called the meeting to order at 7:00 pm. 14. RISE and REPORT THAT Council rise and report the in camera
    resolution from February 6, 2023: THAT Council appoint Councillor Wagner. Motion CARRIED.
    15. ADJOURNMENT Mayor Goodmanson adjourned the meeting at 8:30 pm."""
    r = analyse_meeting(meeting(), minutes(text), [], [])
    assert r["sessions"] == []
    assert (r["est_closed_minutes"], r["open_minutes"]) == (0, 90)  # checked and fully open: a known 0


def test_separate_in_camera_notice():
    notice = {"title": "20160118-Notice-IC-Council", "category": "Other", "full_text":
              "CITY OF LANGFORD COUNCIL MEETING (IN-CAMERA) Monday, January 18th, 2016 after the Regular Council Meeting "
              "NOTICE OF COUNCIL MEETING (IN-CAMERA) In accordance with Section 90 (1) (e) & (k) of the Community Charter"}
    text = "The Mayor called the meeting to order at 7:00 pm. 3. BYLAWS That Council adopt Bylaw 1600. CARRIED. The Mayor adjourned the meeting at 7:20 pm."
    r = analyse_meeting(meeting("2016-01-18"), minutes(text) + [notice], [], [])
    assert [(s["source"], s["reasons"]) for s in r["sessions"]] == [("notice", ["1e", "1k"])]
    assert r["est_closed_minutes"] is None


def test_reason_codes():
    assert reason_codes("pursuant to section 90 (1) d, e, f, and k of the Community Charter") == ["1d", "1e", "1f", "1k"]
    assert reason_codes("section 90 (2) (b) of the Community Charter") == ["2b"]
    assert reason_codes("under Section 90 (1) (c) (e) (k) and (i) of the Community Charter") == ["1c", "1e", "1i", "1k"]
    assert reason_codes("90 (1) I of the Community Charter to consider: annual report under section 98") == ["1l"]
