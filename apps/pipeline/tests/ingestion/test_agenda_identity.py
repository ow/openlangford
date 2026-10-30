"""A re-ingest must reuse persisted agenda rows despite AI rendering drift.

Cases are taken from the October 2026 transcript backfill, where exact
order/title matching inserted duplicates (593, 622, 631, 875, 888) or failed on
the slug unique index (262, 631, 640, 642).
"""
import pytest

from pipeline.ingestion.agenda_identity import existing_agenda_item, normalize_order, normalize_title
from pipeline.ingestion.canonical_motions import existing_agenda_item as reexported


def rows(*pairs):
    return [{'id': 100 + index, 'item_order': order, 'title': title} for index, (order, title) in enumerate(pairs)]


def match(order, title, existing, claimed=()):
    found = existing_agenda_item({'item_order': order, 'title': title}, existing, claimed)
    return found and found['id']


@pytest.mark.parametrize('raw', ['4(a)', '4a', '4.a', '4 a', '4.A.', '4.a)', 'Item 4a', '04.a'])
def test_item_numbers_normalize_to_one_form(raw):
    assert normalize_order(raw) == '4.a'


def test_numbering_variants_that_are_different_items_stay_different():
    assert normalize_order('4.1') != normalize_order('41')
    assert normalize_order('1.') == normalize_order('1') == '1'
    assert normalize_order('4.c (moved from 4.d)') == '4.c'
    assert normalize_order('4(iii)') == '4.iii'


def test_title_drops_only_its_own_enumerator():
    assert normalize_title('1. CALL TO ORDER', '1') == 'call to order'
    assert normalize_title('a) Planning, Zoning & Affordable Housing', '3.a') == 'planning zoning and affordable housing'
    assert normalize_title('4.1 Minutes of the Committee', '4.1') == 'minutes of the committee'
    # A number that is not the item's own number is part of the title.
    assert normalize_title('820 Hockley Ave Rezoning', '5.2') == '820 hockley ave rezoning'
    assert normalize_title('2022 Funding requests', '8.1.3') == '2022 funding requests'


@pytest.mark.parametrize('old_order,new_order', [('1.', '1'), ('3(a)', '3a'), ('4.a', '4a'), ('4a', '4(a)'), ('4 a', '4.a')])
def test_renumbered_item_reuses_original(old_order, new_order):
    existing = rows(('1', 'CALL TO ORDER'), (old_order, 'TERRITORIAL ACKNOWLEDGEMENT'))
    assert match(new_order, 'Territorial Acknowledgement', existing) == 101


def test_enumerator_prefixed_titles_reuse_original():  # meeting 622
    existing = rows(('1', 'CALL TO ORDER'), ('3.a', 'Planning, Zoning & Affordable Housing Committee Meeting - April 12, 2021'))
    assert match('1', '1. CALL TO ORDER', existing) == 100
    assert match('3.a', 'a) Planning, Zoning & Affordable Housing Committee Meeting - April 12, 2021', existing) == 101


def test_swapped_siblings_follow_their_unique_title():  # meeting 593 / 888
    existing = rows(('5.4', 'Application to Rezone 2822 Jacklin Road'), ('5.5', 'Application to Rezone 902 Walfred Road'))
    assert match('5.4', 'Application to Rezone 902 Walfred Road', existing) == 101
    assert match('5.5', 'Application to Rezone 2822 Jacklin Road', existing) == 100


def test_ocr_typo_with_same_number_reuses_original():  # meeting 875
    existing = rows(('5.1', '3405 Happy Valley Rd Rezoning Application'), ('5.2', '820, 822, 824, and 826 Hocklev Ave Rezoning Application'))
    assert match('5.2', '820, 822, 824, and 826 Hockley Ave Rezoning Application', existing) == 101


def test_header_extended_with_child_title_reuses_header():  # meeting 631
    existing = rows(('3', 'ADOPTION OF THE MINUTES'), ('3.a', 'Planning, Zoning & Affordable Housing Committee Meeting - May 3, 2021'))
    assert match('3', 'ADOPTION OF THE MINUTES — Planning, Zoning & Affordable Housing Committee Meeting - May 3, 2021', existing) == 100


def test_clearly_different_items_never_match():
    existing = rows(('4.a', 'Bylaw No. 1998 - Application to Rezone 2619 Sooke Road'), ('5', 'REPORTS'))
    # Same number, different bylaw: a near-identical string is still another item.
    assert match('4.a', 'Bylaw No. 1999 - Application to Rezone 2619 Sooke Road', existing) is None
    # Same number, unrelated title.
    assert match('4.a', 'Crosswalk Request for Dunford Avenue', existing) is None
    # A genuinely missing child item next to its header.
    assert match('4.1', 'Minutes of the Sustainable Development Advisory Committee - July 10, 2023', existing) is None
    # A short generic header is not a prefix of an unrelated item under the same number.
    assert match('5', 'REPORTS AND CORRESPONDENCE FROM STAFF', existing) is None


def test_repeated_title_needs_the_number_too():
    existing = rows(('6.1', 'Minutes'), ('8.1', 'Minutes'))
    assert match('8.1', 'Minutes', existing) == 101
    assert match('9.1', 'Minutes', existing) is None


def test_fuzzy_match_never_hands_one_row_to_two_items():
    existing = rows(('5', 'REPORTS'))
    assert match('6', 'REPORTS', existing, claimed={100}) is None
    # An exact match is still found even if claimed (unchanged prior behaviour).
    assert match('5', 'REPORTS', existing, claimed={100}) == 100


def test_existing_punctuation_twins_resolve_by_literal_rendering_or_refuse():
    existing = rows(('4a', 'Report'), ('4.a', 'Report'))
    assert match('4a', 'Report', existing) == 100
    with pytest.raises(RuntimeError, match='Ambiguous'):
        match('4(a)', 'Report', existing)


def test_canonical_motions_reexports_the_matcher():
    assert reexported is existing_agenda_item
