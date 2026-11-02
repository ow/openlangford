from datetime import date

from pipeline.ingestion import mention_hygiene as mh


def test_minutes_echoes_are_recognised_but_committee_resolutions_are_council_steps():
    assert mh.is_minutes_echo("ADOPTION OF MINUTES - Minutes of the Regular Meeting of Council - November 19, 2018")
    assert mh.is_minutes_echo("Minutes of the Council Meeting - February 6, 2023")
    assert mh.is_minutes_echo("Regular Council Minutes, December 6, 2021")
    assert mh.is_minutes_echo("4. ADOPTION OF MINUTES - a) Minutes of the Regular Meeting of Council - December 3rd, 2018")
    assert not mh.is_minutes_echo("COMMITTEE RESOLUTIONS - Planning, Zoning and Affordable Housing Committee - Minutes")
    assert not mh.is_minutes_echo('BYLAW NO. 1314 "Langford Zoning Bylaw, Amendment No. 296" (ADOPTION)')


def test_echoed_day_reads_the_title_date():
    assert mh.echoed_day("Minutes of the Regular Meeting of Council - July 16th, 2018 (Adoption of Minutes)") == date(2018, 7, 16)
    assert mh.echoed_day("ADOPTION OF MINUTES") is None


def test_legal_descriptions_only_count_against_omnibus_bylaws():
    quote = "on land legally described as Lot A, Section 81, Esquimalt District, Plan 26335 (911 Jenkins Avenue)"
    assert mh.legal_list_match('BYLAW NO. 1864 "Langford Zoning Bylaw, Amendment No. 574, (Omnibus No. 52 - Residential Zones)"', quote)
    # The property's own bylaw names its legal description too: that is a real step.
    assert not mh.legal_list_match('BYLAW NO. 1603 "Langford OCP Bylaw, Amendment No. 18, (734 Latoria Rd)"', quote)
    assert not mh.candidate_ok("ADOPTION OF MINUTES", "Application to rezone 941 Flatman Avenue")
    assert mh.candidate_ok("Application to rezone 941 Flatman Avenue", "Application to rezone 941 Flatman Avenue")


def test_an_echo_resolves_to_the_item_it_repeats_only_when_clear():
    items = [(1, "Extension of Licensed Area - Western Speedway, 2207 Millstream Road"),
             (2, "Application for a Temporary Use Permit for RV storage at 4373 West Shore Parkway"),
             (3, "ADOPTION OF MINUTES")]
    quote = "#### c) Extension of Licensed Area - Western Speedway, 2207 Millstream Road - Staff Report (Planning) MOVED BY: H."
    assert mh.resolve_echo(quote, items) == 1
    assert mh.resolve_echo("That Council approve the agenda as presented", items) is None


def _topic(bylaws=(), title="", first=date(2016, 1, 1), last=date(2016, 6, 1)):
    return {"bylaws": set(bylaws), "addresses": mh._numbered_addresses(title), "numbers": mh.civic_numbers(title),
            "first": first, "last": last}


def test_address_lists_count_each_number():
    assert mh._numbered_addresses("3690 and 3694 Happy Valley Road rezoning") == {"3690 happy valley road", "3694 happy valley road"}
    assert mh.civic_numbers("875–881 Brock and Strathmore rezoning 2023") == {"875", "881"}


def test_same_project_needs_a_shared_bylaw_or_the_same_lots_close_in_time():
    mh.BUSY_ADDRESSES.clear()
    # The 941 Flatman rezoning and its housing agreement: different bylaws, same lots, months apart.
    rezoning = _topic({"Bylaw 1314"}, "941 Flatman Avenue and 3467 Happy Valley Road", date(2010, 12, 6), date(2011, 1, 17))
    hearing = _topic(set(), "3467 Happy Valley Road and 941 Flatman Avenue", date(2010, 11, 15), date(2010, 11, 15))
    assert mh.same_project(rezoning, hearing)
    # 2945 Jacklin Road: a cinema's variances in 2010, a vehicle showroom permit in 2017.
    assert not mh.same_project(_topic(set(), "2945 Jacklin Road cinema", date(2010, 9, 20), date(2011, 5, 16)),
                               _topic(set(), "2945 Jacklin Road showroom", date(2017, 7, 10), date(2017, 8, 14)))
    # A housing rezoning and, a year later, a daycare rezoning on one lot are two applications.
    assert not mh.same_project(_topic({"Bylaw 1673"}, "616 Goldstream Avenue"), _topic({"Bylaw 1773"}, "616 Goldstream Avenue"))
    # An OCP amendment and its rezoning are numbered together.
    assert mh.same_project(_topic({"Bylaw 1612"}, "3483 Happy Valley Road"), _topic({"Bylaw 1613"}, "3483 Happy Valley Road"))
    # A bundle of hearings is not one property's story.
    assert not mh.same_project(_topic({"Bylaw 1603", "Bylaw 1596", "Bylaw 1597"}, "734 Latoria and 3416 Hazelwood hearings"),
                               _topic({"Bylaw 1603"}, "734 Latoria Road OCP amendment"))
    # Without a shared bylaw only the very same lots count.
    assert not mh.same_project(_topic(set(), "778 Hockley Avenue rezoning"), _topic(set(), "772, 777, 778 and 784 Hockley Avenue"))
    # A busy building's address alone says nothing.
    mh.BUSY_ADDRESSES.add("1047 langford parkway")
    assert not mh.same_project(_topic(set(), "1047 Langford Parkway generator"), _topic(set(), "1047 Langford Parkway patio"))
    mh.BUSY_ADDRESSES.clear()
