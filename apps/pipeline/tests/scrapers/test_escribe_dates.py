"""Imported dates follow consistent official calendar dates, not UTC day rollover."""
from datetime import date

import pytest

from pipeline.scrapers.base import MunicipalityConfig
from pipeline.scrapers.escribe import EscribeScraper


@pytest.mark.parametrize(
    ('fields', 'since_date', 'expected_dates'),
    [
        pytest.param(
            {'MeetingDate': 'March 03, 2025', 'DateMedium': 'Mar 3, 2025',
             'DateShort': 'Mar 03, 2025', 'Start': '/Date(1741046400000)/'},
            None, [date(2025, 3, 3)], id='official-date-before-utc-rollover',
        ),
        pytest.param(
            {'MeetingDate': 'March 03, 2025', 'Start': '/Date(1741046400000)/'},
            date(2025, 3, 4), [], id='since-filter-uses-official-date',
        ),
        pytest.param(
            {'DateMedium': 'Mar 3, 2025', 'DateShort': 'March 03, 2025',
             'Start': '/Date(1741046400000)/'},
            None, [date(2025, 3, 3)], id='secondary-official-fields',
        ),
        pytest.param(
            {'MeetingDate': 'March 03, 2025', 'DateMedium': 'Mar 4, 2025',
             'Start': '/Date(1741046400000)/'},
            None, [], id='conflicting-official-fields-held',
        ),
        pytest.param(
            {'MeetingDate': '2025-03-03', 'DateMedium': 'Mar 3, 2025',
             'Start': '/Date(1741046400000)/'},
            None, [], id='unsupported-supplied-format-held',
        ),
        pytest.param(
            {'MeetingDate': 'March 03, 2025', 'DateShort': 20250303,
             'Start': '/Date(1741046400000)/'},
            None, [], id='nonstring-supplied-date-held',
        ),
        pytest.param(
            {'MeetingDate': '', 'DateMedium': None, 'Start': '/Date(1741046400000)/'},
            None, [date(2025, 3, 3)], id='absent-display-fields-epoch-fallback-is-local-date',
        ),
        pytest.param({}, None, [], id='no-date-held'),
    ],
)
def test_discovery_imports_only_consistent_official_calendar_dates(
    monkeypatch, fields, since_date, expected_dates,
):
    scraper = EscribeScraper(MunicipalityConfig(
        1, 'test', 'Test', 'Test', {'base_url': 'https://example.org'},
    ))
    raw = {'Id': 'official-meeting-id', 'MeetingType': 'Council Meeting', **fields}
    monkeypatch.setattr(scraper, '_fetch_meetings_for_type', lambda meeting_type: [raw])

    meetings = scraper.discover_meetings(since_date=since_date)

    assert [meeting.date for meeting in meetings] == expected_dates
    assert [meeting.source_id for meeting in meetings] == ['official-meeting-id'] * len(expected_dates)
