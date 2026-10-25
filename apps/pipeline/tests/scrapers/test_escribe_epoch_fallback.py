"""eSCRIBE `Start` is Pacific wall-clock mislabelled as US Eastern, not UTC.

Reading it as UTC dated every evening start at/after 19:00 PST one day late (29 council-type
meetings + 7 advisory ones in production). Epochs below are real `Start` values from
source_meetings.raw for meetings whose minutes print the local date.
"""
from datetime import date

import pytest

from pipeline.scrapers.escribe import EscribeScraper

REAL_STARTS = [
    # (meeting id, Start epoch, MeetingTime, true local date)
    (173, 1669075200000, '7:00 PM', date(2022, 11, 21)),  # PST evening: was stored 11-22
    (162, 1738281600000, '7:00 PM', date(2025, 1, 30)),   # PST evening: was stored 01-31
    (167, 1765238400000, '7:00 PM', date(2025, 12, 8)),   # PST evening: was stored 12-09
    (200, 1671651000000, '2:30 PM', date(2022, 12, 21)),  # afternoon: never affected
    (160, 1765823400000, '1:30 PM', date(2025, 12, 15)),  # afternoon: never affected
]


@pytest.mark.parametrize(('meeting_id', 'epoch', 'time', 'expected'), REAL_STARTS)
def test_epoch_fallback_returns_local_wall_clock_date(meeting_id, epoch, time, expected):
    raw = {'Start': f'/Date({epoch})/', 'MeetingTime': time}
    assert EscribeScraper._parse_meeting_date(raw) == expected


@pytest.mark.parametrize(('epoch', 'expected'), [
    (1750719600000, date(2025, 6, 23)),  # 7 PM PDT -> epoch 23:00 UTC same day
    (1764806400000, date(2025, 12, 3)),  # 7 PM PST -> epoch 00:00 UTC next day
])
def test_epoch_fallback_summer_and_winter_evening(epoch, expected):
    assert EscribeScraper._parse_meeting_date({'Start': f'/Date({epoch})/'}) == expected


def test_isilive_date_key_matches_scraper_folder_date():
    from pipeline.video.isilive import ISILiveClient

    raw = {'MeetingDate': 'December 08, 2025', 'DateMedium': 'Dec 8, 2025',
           'Start': '/Date(1765238400000)/', 'FormattedStart': 'Monday, December 08, 2025 @ 7:00 PM'}
    assert ISILiveClient._meeting_date_key(raw) == '2025-12-08'
    assert ISILiveClient._meeting_date_key({'Start': '/Date(1765238400000)/'}) == '2025-12-08'
