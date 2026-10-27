"""Official-minutes header dates: letter-spacing, split/noisy ordinals, weekday gate."""
import pytest

from pipeline.ingestion.native_header_ocr import _candidate_date
from pipeline.ingestion.official_ballots import _native_header_date


@pytest.mark.parametrize(('header', 'expected'), [
    # Letter-spaced text layer, superscript ordinal on the line above.
    ('  r d\n M o n d a y , M a r c h 3 , 2 0 1 4 @ 7:00 p . m .\n', '2014-03-03'),
    ('  t h\n M o n d a y , O c t o b e r 7 , 2 0 1 3 @ 7:00 p.m.\n', '2013-10-07'),
    # Split ordinals inline.
    ('Monday, March 3 r d , 2014', '2014-03-03'),
    ('Monday, October 7 t h , 2013', '2013-10-07'),
    ('Monday, March 3 rd, 2014', '2014-03-03'),
    # Noisy ordinals, weekday verified.
    ('Tuesday, March 11™, 2014 @ 4:30 p.m.', '2014-03-11'),
    ('Monday, December 20t0, 2010 at 7:00 pm', '2010-12-20'),
    ('Tuesday, March 117H, 2014', '2014-03-11'),
    # Weekday does not match: never guess.
    ('Wednesday, March 11™, 2014', None),
    ('Wednesday, December 20t0, 2010', None),
    ('Monday, March 117H, 2014', None),
    # Noisy form without a weekday: never guess.
    ('March 11™, 2014', None),
    ('December 20t0, 2010', None),
    # Digit lost entirely.
    ('Monday, March ed, 2015', None),
])
def test_native_header_date(header, expected):
    assert _native_header_date(header)[0] == expected


def test_candidate_date_noisy_ordinal_needs_weekday():
    assert _candidate_date('Tuesday, March 117H, 2014')[0].isoformat() == '2014-03-11'
    assert _candidate_date('Monday, March 117H, 2014') is None
    assert _candidate_date('March 117H, 2014') is None
    assert _candidate_date('Tuesday, March 11th, 2014')[0].isoformat() == '2014-03-11'
    assert _candidate_date('Monday, March 11st, 2014') is None
