"""Council roster from the first page of original minutes (pdftotext -layout).

eSCRIBE minutes put PRESENT / ABSENT / ATTENDING in a left column with names in
one or two columns beside them. Plain text extraction interleaves the columns
("PRESENT: ATTENDING: Mayor ... Councillor ..."), which made the AI attendee
list drop the whole council (issue #56). With the layout kept, each line's label
column says which section its names belong to.
"""
from __future__ import annotations

import re
import subprocess

LABEL = re.compile(r"^\s*(PRESENT|ABSENT|REGRETS|ATTENDING|ALSO PRESENT|STAFF)\s*:\s*(.*)$", re.I)
# Initial's period is optional ("Councillor L Szpak") and "Mayors. Goodmanson" is a known scan misread of "Mayor S.".
ROLE = re.compile(r"\b(?:Acting\s+Mayor\s+(?!Councillor)|Mayor\s+(?!Councillor)|Mayors\.\s*|Councillor\s+)((?:[A-Z]\.?\s*)?[A-Z][A-Za-z'’-]+)(\s*\(Acting Mayor\))?(\s*-\s*Remote)?")
END = re.compile(r"^\s*(?:1\.|CALL TO ORDER|TERRITORIAL)", re.I)


def first_page_text(pdf_path: str) -> str:
    return subprocess.run(["pdftotext", "-layout", "-f", "1", "-l", "1", pdf_path, "-"],
                          check=True, capture_output=True, text=True, timeout=40).stdout


def parse_roster(text: str) -> dict:
    """{'present': [(name, remote, line)], 'absent': [...], 'sections': {label: quote}} from the header.

    Names are only taken from PRESENT and ABSENT/REGRETS sections; staff under ATTENDING are ignored."""
    section, quotes = None, {}
    found = {"present": [], "absent": []}
    for line in text.splitlines():
        if END.match(line):
            break
        label = LABEL.match(line)
        if label:
            section = label.group(1).upper()
            rest = label.group(2)
        else:
            rest = line
        if not section or not rest.strip():
            continue
        quotes.setdefault(section, []).append(re.sub(r"\s{2,}", "   ", rest.strip()))
        bucket = "present" if section == "PRESENT" else "absent" if section in ("ABSENT", "REGRETS") else None
        if bucket:
            for m in ROLE.finditer(rest):
                found[bucket].append((m.group(1).replace(" ", ""), bool(m.group(3)), rest.strip()))
    return {**found, "sections": {k: "\n".join(v) for k, v in quotes.items()}}


def surname(name: str) -> str:
    return re.sub(r"^[A-Z]\.?\s*(?=[A-Z])", "", name).lower()
