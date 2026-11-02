"""Older-minutes shapes, heading placement, legacy rebind and the OCR catch-up path."""
from pipeline.backfill.history_coverage import _explicit, ocr_display_text
from pipeline.ingestion.canonical_motions import canonical_motion_plan, heading_item
from pipeline.ingestion.source_occurrences import original_formal_inventory, text_occurrence_unique
from pipeline.ingestion.vote_evidence import minutes_motion_blocks

OLDER = """6. DEVELOPMENT VARIANCE PERMIT

a) DVP10-0020 - Lakewood and Happy Valley Schools

MOVED BY: COUNCILLOR BLACKWELL SECONDED: COUNCILLOR SZPAK

> That Council issue Development Variance Permit No. DVP-10-0020 to School District No. 62.

> > CARRIED.

8. REPORTS

a) Affordable Housing, Park and Amenity Contribution Policy - Staff Report (File No. 0340-50/AME)

MOVED BY: COUNCILLOR SZPAK SEGONDED: COUNCILLOR SAHLSTROM

1. That Council amend its Affordable Housing, Park and Amenity Contribution policy.

CARRIED.

12. ADJOURNMENT

MOVED BY: COUNCILLOR SEATON SECONDED: COUNCILLOR SIFERT

That Council adjourn the meeting.

CARRIED.
"""

CURRENT = """MOVED BY: HARDER
SECONDED: MORLEY

THAT Council give Bylaw No. 2154 first reading.

Motion CARRIED.
"""


def _source(text):
    blocks = list(minutes_motion_blocks(text))
    return {'text': text, 'blocks': blocks, 'formal_occurrence_inventory': original_formal_inventory(text),
            'source_sha256': 'x', 'local_date': '2010-12-20', 'source_classification': 'Council', 'present': [],
            'source_file': 'minutes.pdf', 'source_format': 'ocr_marker'}


def test_older_minutes_shapes_are_read():
    source = _source(OLDER)
    texts = [b['motion_text'] for b in source['blocks']]
    assert len(texts) == 3
    assert texts[0].startswith('> That Council issue') and source['blocks'][0]['result'] == 'CARRIED'
    assert texts[1].startswith('1. That Council amend')  # SEGONDED line is the seconder, not part of the body
    assert all(text_occurrence_unique(source, b) for b in source['blocks'])


def test_current_minutes_unchanged():
    blocks = list(minutes_motion_blocks(CURRENT))
    assert len(blocks) == 1 and blocks[0]['motion_text'] == 'THAT Council give Bylaw No. 2154 first reading.'
    assert blocks[0]['source_order'] == 0 and blocks[0]['outcome_quote'] == 'Motion CARRIED.'


ITEMS = [
    {'item_order': '6', 'title': 'DEVELOPMENT VARIANCE PERMIT — DVP10-0020 - Lakewood and Happy Valley Schools'},
    {'item_order': '8.a', 'title': 'REPORTS — Affordable Housing, Park and Amenity Contribution Policy - Staff Report (File No. 0340-50/AME)'},
    {'item_order': '8.b', 'title': 'Sportsplex Agreements with Planex Development Corp'},
    {'item_order': '12', 'title': 'ADJOURNMENT'},
]


def test_heading_places_motion_on_its_item():
    source = _source(OLDER)
    placed = [heading_item(source, b, ITEMS)[0] for b in source['blocks']]
    assert [p['item_order'] for p in placed] == ['6', '8.a', '12']


def test_heading_never_guesses_between_two_fits():
    source = _source(OLDER)
    twins = ITEMS + [{'item_order': '9.a', 'title': 'Affordable Housing, Park and Amenity Contribution Policy - Letter'}]
    assert heading_item(source, source['blocks'][1], twins) == (None, None)


def _plan(existing, rebind=True):
    source = _source(OLDER)
    meeting = {'id': 824, 'meeting_date': '2010-12-20', 'title': 'Regular Council', 'archive_path': '', 'classification': 'Council'}
    agenda = [{'id': 100 + i, 'item_order': it['item_order'], 'title': it['title']} for i, it in enumerate(ITEMS)]
    context = {'status': 'available', 'meeting': meeting, 'source': source, 'agenda_items': agenda,
               'allow_legacy_rebind': rebind}
    return canonical_motion_plan([dict(it) for it in ITEMS], context, existing)


def test_unmatched_ai_row_rebinds_to_the_recorded_motion_on_its_item():
    legacy = {'id': 7, 'meeting_id': 824, 'agenda_item_id': 103, 'text_content': 'THAT the meeting be adjourned.',
              'result': None, 'meta': {}}
    planned, report = _plan([legacy])
    assert [r['motion_id'] for r in report['rebound_legacy']] == [7]
    assert report['unmapped_legacy_ids'] == []
    added = [m for item in planned for m in item['motions'] if not m.get('_existing_motion')]
    assert len(added) == 2  # the other two recorded motions are no longer blocked


def test_without_the_catch_up_flag_an_unmatched_row_still_blocks():
    legacy = {'id': 7, 'meeting_id': 824, 'agenda_item_id': 103, 'text_content': 'THAT the meeting be adjourned.',
              'result': None, 'meta': {}}
    planned, report = _plan([legacy], rebind=False)
    assert not report['rebound_legacy'] and report['unmapped_legacy_ids'] == [7]
    assert not [m for item in planned for m in item['motions']]


def test_a_different_recorded_outcome_is_not_rebound():
    legacy = {'id': 7, 'meeting_id': 824, 'agenda_item_id': 103, 'text_content': 'THAT the meeting be adjourned.',
              'result': 'DEFEATED', 'meta': {}}
    _, report = _plan([legacy])
    assert not report['rebound_legacy'] and report['unmapped_legacy_ids'] == [7]


def test_ocr_path_needs_the_resolution_words():
    block = {'motion_text': '> That Council issue Development Variance Permit No. DVP-10-0020.'}
    assert _explicit({'source_format': 'ocr_marker'}, {}, block)
    assert _explicit({'source_format': 'ocr_marker'}, {}, {'motion_text': '1. That Council amend its policy.'})
    assert not _explicit({'source_format': 'ocr_marker'}, {}, {'motion_text': 'Mayor Young adjourned the meeting.'})
    assert not _explicit({'source_format': 'original_pdf_layout'}, {}, block)
    assert ocr_display_text('> That Council issue\n> the permit.') == 'That Council issue\nthe permit.'
