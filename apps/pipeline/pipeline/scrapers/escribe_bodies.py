"""Which body an eSCRIBE meeting type belongs to, named the way our database files it.

eSCRIBE spells the same committee several ways over the years ("Planning Zoning and Affordable
Housing Committee", "Planning, Zoning and Affordable Housing Committee Meeting", "Special Planning,
Zoning and Affordable Housing Committee"). Our organizations, archive folders and meeting titles use
one canonical name per body (matching the Glyphdex-imported history), with special meetings titled
"<body> – Special". Council-family types (Council, Special Council, Committee of the Whole,
Inaugural, Public Hearing) are not listed here: they keep their established handling.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class EscribeBody:
    name: str  # organizations.name, also the archive top-level folder
    meeting_type: str  # meetings.type
    special: bool

    @property
    def title(self) -> str:
        """Meeting title and archive folder label."""
        return f"{self.name} – Special" if self.special else self.name


_BODIES = (
    (r"administration (?:and|&) finance", "Administration & Finance Committee", "Standing Committee"),
    (r"parks, recreation\b", "Parks, Recreation, Culture & Beautification Committee", "Standing Committee"),
    (r"planning,? zoning (?:and|&) affordable housing", "Planning, Zoning & Affordable Housing Committee", "Standing Committee"),
    (r"protective services", "Protective Services Committee", "Standing Committee"),
    (r"transportation (?:and|&) public works", "Transportation & Public Works Committee", "Standing Committee"),
    (r"sustainable development advisory", "Sustainable Development Advisory Committee", "Advisory Committee"),
    (r"community advisory", "Community Advisory Committee", "Advisory Committee"),
    (r"capital west accessibility advisory", "Capital West Accessibility Advisory Committee", "Advisory Committee"),
    (r"board of variance", "Board of Variance", "Board of Variance"),
)


def escribe_body(label: str | None) -> EscribeBody | None:
    """Canonical body for an eSCRIBE MeetingType (or one of our own meeting titles), else None."""
    lower = " ".join((label or "").lower().split())
    if not lower:
        return None
    special = lower.startswith("special ") or bool(re.search(r"[–-]\s*special$", lower))
    for pattern, name, meeting_type in _BODIES:
        if re.search(pattern, lower):
            return EscribeBody(name=name, meeting_type=meeting_type, special=special)
    return None
