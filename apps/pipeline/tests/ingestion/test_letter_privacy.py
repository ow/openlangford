from pipeline.ingestion.letter_privacy import scrub

LETTER = """From: Chantelle Lehoux <chantelle.lehoux@gmail.com>
Sent: March 28, 2022 10:54 AM
To: Langford Planning General Mailbox <planning@langford.ca>
Subject: Bylaw 2037

I am writing about the rezoning of 904 to 914 Dunford Ave, which I am not in agreement with.
Please call the city at 250-478-7882 if needed.

Thank you

Chantelle Lehoux
3581 Kelly Dawn Place
#104-2669 Deville Rd,
Victoria, BC
V9C 4J1
Cell: (250) 555-0142
"""


def test_scrub_removes_private_contact_details():
    text, changes = scrub(LETTER)
    assert "gmail" not in text and "555-0142" not in text and "V9C 4J1" not in text
    assert "3581 Kelly Dawn Place" not in text and "2669 Deville" not in text
    assert changes >= 5


def test_scrub_keeps_public_and_subject_matter_details():
    text, _ = scrub(LETTER)
    assert "planning@langford.ca" in text  # city addresses are public
    assert "904 to 914 Dunford Ave" in text  # the property the letter is about
    assert "250-478-7882" in text  # city hall's main line
    assert "Chantelle Lehoux" in text and "Victoria, BC" in text


def test_scrub_is_idempotent():
    once, _ = scrub(LETTER)
    twice, changes = scrub(once)
    assert twice == once and changes == 0


def test_whole_agenda_text_keeps_address_headings():
    text, _ = scrub("Staff report\n904 Dunford Avenue\nContact jo@shaw.ca", address_lines=False)
    assert "904 Dunford Avenue" in text and "shaw.ca" not in text


def test_scrub_emails_keeps_city_addresses_only():
    from pipeline.ingestion.letter_privacy import scrub_emails
    assert scrub_emails("a@gmail.com and planning@langford.ca") == " and planning@langford.ca"
    assert scrub_emails(None) is None
