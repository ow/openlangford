"""Remove residents' private contact details from correspondence text.

Agenda packages reproduce letters with the writer's email, phone number,
home address and postal code. Our copies are public (the site and the public
API read document_sections and documents.full_text), so before letters are
shown or linked we strip:

- email addresses, except the city's own domains;
- phone numbers, except institutional numbers that recur across many documents
  (city hall, Zoom dial-ins, agencies);
- postal codes;
- lines that are only a street address (signature blocks). Addresses inside
  sentences ("the rezoning of 904 to 914 Dunford Ave") are the subject of the
  letter and stay.

Original PDFs are untouched in the archive.
"""
from __future__ import annotations

import re

CITY_EMAIL = re.compile(r"@(?:[\w-]+\.)*(?:langford\.ca|cityoflangford\.ca)\b", re.I)
EMAIL = re.compile(r"<?\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b>?")
PHONE = re.compile(r"(?<!\d)(?:\+?1[ .-]?)?\(?(\d{3})\)?[ .-]?(\d{3})[ .-](\d{4})(?!\d)")
# Numbers found in eight or more documents (October 2026): institutional, not personal.
PUBLIC_PHONES = {
    "7789072071", "8557038985", "2504787882", "2504787864", "2504746919", "2503913436",
    "2504781828", "2504796800", "2504781870", "2504785999", "2504744119", "2504743031",
}
POSTAL = re.compile(r"\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b", re.I)
SUFFIX = (r"(?:Road|Rd|Street|St|Avenue|Ave|Crescent|Cres|Drive|Dr|Court|Ct|Lane|Ln|Way|Place|Pl|Terrace|Terr?|"
          r"Boulevard|Blvd|Highway|Hwy|Close|Trail|Circle|Ridge|Heights|Parkway|Gardens|View|Rise|Walk)")
ADDRESS_LINE = re.compile(
    r"^[ \t]*(?:(?:unit|suite|apt\.?)\s*)?#?\d{1,6}[A-Za-z]?(?:\s*[-–]\s*\d{1,6}[A-Za-z]?)?\s+"
    r"(?:[A-Za-z’'.-]+\s+){1,4}" + SUFFIX + r"\.?,?[ \t]*$",
    re.I | re.M,
)


def scrub_emails(text: str | None) -> str | None:
    """Remove non-city email addresses only; safe for any document text at ingest."""
    if not text:
        return text
    return EMAIL.sub(lambda m: m[0] if CITY_EMAIL.search(m[0]) else "", text)


def scrub(text: str, *, address_lines: bool = True) -> tuple[str, int]:
    """Return (scrubbed text, number of details removed). Idempotent.

    ``address_lines=False`` is for whole agenda text, where a line holding only
    an address is usually a report heading about a property, not a signature.
    """
    if not text:
        return text, 0
    changes = 0

    def email(match):
        nonlocal changes
        if CITY_EMAIL.search(match[0]):
            return match[0]
        changes += 1
        return ""

    def phone(match):
        nonlocal changes
        if "".join(match.groups()) in PUBLIC_PHONES:
            return match[0]
        changes += 1
        return ""

    def removed(match):
        nonlocal changes
        changes += 1
        return ""

    text = EMAIL.sub(email, text)
    text = PHONE.sub(phone, text)
    text = POSTAL.sub(removed, text)
    if address_lines:
        text = ADDRESS_LINE.sub(removed, text)
    # Tidy what removal leaves behind: empty "Cell:" labels, "<>" and blank runs.
    text = re.sub(r"(?im)^[ \t]*(?:cell|phone|tel|mobile|home|email|e-mail)\s*:?[ \t]*$\n?", "", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text, changes


def scrub_correspondence(supabase, extracted_document_id: int, document_id: int) -> int:
    """Scrub one correspondence document's sections (re-embedding changed ones) and its
    parent document's full text. Returns the number of details removed."""
    removed = 0
    sections = (supabase.table("document_sections").select("id,section_text")
                .eq("extracted_document_id", extracted_document_id).execute().data or [])
    for section in sections:
        clean, changes = scrub(section.get("section_text") or "")
        if changes:
            removed += changes
            supabase.table("document_sections").update({"section_text": clean, "embedding": None}).eq("id", section["id"]).execute()
    parent = supabase.table("documents").select("id,full_text").eq("id", document_id).single().execute().data
    clean, changes = scrub(parent.get("full_text") or "", address_lines=False)
    if changes:
        removed += changes
        supabase.table("documents").update({"full_text": clean}).eq("id", document_id).execute()
    return removed
