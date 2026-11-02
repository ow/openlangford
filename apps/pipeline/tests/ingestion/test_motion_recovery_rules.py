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


NUMBERED = """10.2 BYLAW NO. 2001

MOVED BY: WADE
SECONDED: BLACKWELL

THAT Council give Bylaw No. 2001 second and third readings.

Motion CARRIED.

10.3 BYLAW NO. 2009 (Background report attached)
"Langford Zoning Bylaw, Amendment No. 640, (Bray Avenue), Bylaw No. 2009, 2021". (ADOPTION)

MOVED BY: WADE
SECONDED: SEATON

THAT Council adopt Bylaw No. 2009.

Motion CARRIED.
"""


def test_numbered_heading_places_on_the_same_numbered_item():
    source = _source(NUMBERED)
    items = [{'item_order': '10.', 'title': 'BYLAWS'},
             {'item_order': '10.2', 'title': 'BYLAW NO. 2001 "Langford Zoning Bylaw, Amendment No. 639" (SECOND AND THIRD READING)'},
             {'item_order': '10.3', 'title': 'BYLAW NO. 2009 "Langford Zoning Bylaw, Amendment No. 640, (Bray Avenue)" (ADOPTION)'}]
    placed = [heading_item(source, b, items)[0]['item_order'] for b in source['blocks']]
    assert placed == ['10.2', '10.3']


def test_a_different_motion_on_the_item_is_not_rebound():
    legacy = {'id': 7, 'meeting_id': 824, 'agenda_item_id': 103, 'text_content': 'THAT staff report back on parking fees.',
              'result': None, 'meta': {}}
    _, report = _plan([legacy])
    assert not report['rebound_legacy'] and report['unmapped_legacy_ids'] == [7]


def test_committee_actor_names_inline_and_split():
    from pipeline.backfill.history_coverage import committee_actor_names, tidy_spacing
    assert committee_actor_names('MOVED BY: A. CREUZOT SECONDED: N. STEWART\nThat ...') == {'mover': 'A. CREUZOT', 'seconder': 'N. STEWART'}
    assert committee_actor_names('MOVED BY: WADE\nSECONDED: HORNER\nTHAT ...') == {'mover': 'WADE', 'seconder': 'HORNER'}
    assert tidy_spacing('minutes of the          meeting\n  held   May 8') == 'minutes of the meeting\nheld May 8'


def test_later_councillor_link_on_an_earlier_committee_is_unproven():
    from pipeline.backfill.history_coverage import unproven_committee_identities
    meeting = {'classification': 'Committee', 'meeting_date': '2017-05-29', 'meta': {'committee_roster': {'members': [
        {'person_id': 136, 'kind': 'member'}, {'person_id': 137, 'kind': 'councillor'}]}}}
    scope = {'council_term_starts': {136: '2018-11-05', 137: '2014-11-03'}}
    assert unproven_committee_identities(meeting, scope) == {136}


def test_confirmed_committee_identity_is_not_unproven():
    from pipeline.backfill.history_coverage import unproven_committee_identities
    meeting = {'classification': 'Committee', 'meeting_date': '2017-05-29', 'meta': {'committee_roster': {'members': [
        {'person_id': 136, 'kind': 'member', 'identity_confirmed': {'basis': 'annual_report_and_owner'}}]}}}
    assert unproven_committee_identities(meeting, {'council_term_starts': {136: '2018-11-05'}}) == set()


def test_page_furniture_is_stripped_from_a_body():
    from pipeline.backfill.history_coverage import strip_page_furniture
    body = ("Minutes cf the Regular Council Meeting\n  July 19, 2021\n  Page 17 of 22\n\n\n"
            "  That Council support the walkway project.")
    assert strip_page_furniture(body) == "That Council support the walkway project."
    assert strip_page_furniture("March 2\", 2020\nPage 12 of 12\n\nThat Council give Bylaw 1890 first reading.") == \
        "That Council give Bylaw 1890 first reading."
    assert strip_page_furniture("Pro. Services Committee January 28^^ 2020 Page 2 of 4\nCARRIED.") == "CARRIED."
    # A body line that merely mentions the minutes stays.
    kept = "That Council approve the\nminutes of the meeting held on July 12, 2021."
    assert strip_page_furniture(kept) == kept


def _scan_case(text, *, result='CARRIED', block=None):
    source = _source(f"MOVED BY: COUNCILLOR WADE SECONDED: COUNCILLOR SEATON\n\n{text}\n\nCARRIED.\n")
    source['source_format'] = 'original_pdf_layout'
    found = source['blocks'][0]
    return source, block or found, {'motion_text': found['motion_text'], 'result': result}


def test_scanned_mismatch_is_admitted_as_a_transcription():
    from pipeline.backfill.history_coverage import transcription_text
    text = "July 19, 2021\nPage 19 of 22\n\n\nThat Council adopt Bylaw No. 1944."
    source, block, motion = _scan_case(text)
    holds = [{'reason': 'deferred_source_decision_from_explicit_first20_batch',
              'strict_gate_reasons': ['full_native_body_differs_beyond_whitespace']}]
    assert transcription_text(source, block, motion, {'status': None}, holds) == "That Council adopt Bylaw No. 1944."
    assert transcription_text(source, block, motion, {'status': None}, holds, reviewed=True) == "That Council adopt Bylaw No. 1944."
    assert transcription_text(source, block, motion, {'status': 'native_body_not_uniquely_bound_held'}, []) == \
        "That Council adopt Bylaw No. 1944."
    closing = [{'reason': 'Closing-conflict strict full-body/ownership rule holds otherwise image-reviewed decision: '
                          'native_full_body_differs_from_independently_image_reviewed_operative_body'}]
    assert transcription_text(source, block, motion, {'status': None}, closing) == "That Council adopt Bylaw No. 1944."
    source, block, motion = _scan_case("THATthe Committee approve the agenda as presented.")
    assert transcription_text(source, block, motion, {'status': 'operative_boundary_unknown_held'}, []) == \
        "THATthe Committee approve the agenda as presented."


def test_genuine_ambiguity_stays_held():
    from pipeline.backfill.history_coverage import transcription_text
    ok = "That Council adopt Bylaw No. 1944."
    # No printed outcome.
    assert transcription_text(*_scan_case(ok, result=None), {'status': None}, []) is None
    # Narrative, not a resolution.
    assert transcription_text(*_scan_case("Mayor Young adjourned the meeting at 6:58 pm."), {'status': None}, []) is None
    # A fragment that has lost its opening words.
    assert transcription_text(*_scan_case("1. Direct Staff to draft a Bylaw to amend the zoning."), {'status': None}, []) is None
    # An adjournment (closing conflicts are reviewed separately).
    assert transcription_text(*_scan_case("That the meeting be adjourned."), {'status': None}, []) is None
    # A reviewer hold for anything other than a text/image mismatch.
    lease = [{'reason': 'Distinct printed lease vote has identical full body to another occurrence.'}]
    assert transcription_text(*_scan_case(ok), {'status': None}, lease) is None
    deferred_other = [{'reason': 'deferred_source_decision_from_explicit_first20_batch',
                       'strict_gate_reasons': ['full_native_body_differs_beyond_whitespace', 'heading_conflict']}]
    assert transcription_text(*_scan_case(ok), {'status': None}, deferred_other) is None
    # A body the operative check found twice in its own block, or a documentary event.
    assert transcription_text(*_scan_case(ok), {'status': 'raw_body_not_uniquely_bound_held'}, []) is None
    assert transcription_text(*_scan_case(ok), {'status': 'documentary_event_only_held'}, []) is None
    # An image-reviewed meeting's body the reviewer never held for a mismatch; a reviewed scan; a correction-only review.
    assert transcription_text(*_scan_case(ok), {'status': None}, [], reviewed=True) is None
    source, block, motion = _scan_case(ok)
    for fmt in ('original_pdf_reviewed_local_ocr', 'original_pdf_reviewed_image_corrections'):
        assert transcription_text({**source, 'source_format': fmt}, block, motion, {'status': None}, []) is None
    assert transcription_text(source, block, motion, {'status': 'scan_body_not_independently_reviewed_held'}, []) is None
    # No mover line: not a formal motion.
    source, block, motion = _scan_case(ok)
    assert transcription_text(source, {**block, 'source_block': f'{ok}\n\nCARRIED.'}, motion, {'status': None}, []) is None


def test_duplicate_body_stays_held():
    from pipeline.backfill.history_coverage import transcription_text
    ok = "That Council adopt Bylaw No. 1217."
    one = f"MOVED BY: COUNCILLOR WADE SECONDED: COUNCILLOR SEATON\n\n{ok}\n\nCARRIED.\n\n"
    source = _source("9. BYLAWS\n\na) Bylaw No. 1217\n\n" + one + "b) Bylaw No. 1217 again\n\n" + one)
    source['source_format'] = 'original_pdf_layout'
    assert len(source['blocks']) == 2
    motion = {'motion_text': ok, 'result': 'CARRIED'}
    assert transcription_text(source, source['blocks'][0], motion, {'status': None}, []) is None
