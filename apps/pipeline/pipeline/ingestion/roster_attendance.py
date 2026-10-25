"""Evidence-backed council attendance from the original signed minutes (issue #56).

Council and Committee of the Whole attendance comes from the page-1 roster of the original minutes
PDF, not the AI attendee list. Conservative: a member is resolved only when the PDF is readable, its
page-1 date equals the meeting date and the member matches exactly one PRESENT/ABSENT roster entry.
Everything else is returned as unresolved so the caller can keep its existing behaviour for them.
Record shape matches `council-attendance/v1` (apps/web/app/lib/attendance-evidence.ts).
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path

from .minutes_roster import first_page_text, parse_roster, surname

MONTH_DATE = re.compile(r"(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, ?\d{4}")


def find_original_minutes_pdf(folder_path: str) -> Path | None:
    """The signed minutes PDF if present, else any minutes PDF in the meeting's Minutes folder."""
    pdfs = sorted(Path(folder_path, "Minutes").glob("*.pdf"))
    return next((p for p in pdfs if "signed" in p.name.lower()), None) or (pdfs[0] if pdfs else None)


def minutes_source_url(pdf_path: Path, fallback: str | None = None) -> str | None:
    sidecar = Path(str(pdf_path) + ".url")
    url = sidecar.read_text().strip() if sidecar.exists() else (fallback or "")
    return url if url.startswith("https://") else None


def roster_attendance(members: list[dict], meeting_id: int, meeting_date: str, pdf_path, source_url: str | None,
                      text: str | None = None) -> dict:
    """{'records': [{person_id, attendance_mode, notes}], 'unresolved': [{person_id, name, reason}], 'status': str}.

    members: sitting council members [{'person_id', 'name'}]. `text` overrides the page-1 read (tests)."""
    unresolved_all = lambda reason: {"records": [], "unresolved": [{**m, "reason": reason} for m in members], "status": reason}
    if not source_url or not source_url.startswith("https://"):
        return unresolved_all("no https source_url")
    try:
        sha = hashlib.sha256(Path(pdf_path).read_bytes()).hexdigest()
        text = first_page_text(str(pdf_path)) if text is None else text
    except Exception:
        return unresolved_all("minutes PDF unreadable")
    date = datetime.fromisoformat(meeting_date)
    flat = re.sub(r",\s*", ", ", re.sub(r"\s+", " ", text))
    if f"{date.strftime('%B')} {date.day}, {date.year}" not in flat:
        return unresolved_all("page-1 date does not match meeting date")
    roster = parse_roster(text)
    if not roster["present"] and not roster["absent"]:
        return unresolved_all("no named roster on page 1")
    records, unresolved = [], []
    for member in members:
        last = surname((member["name"] or "").split()[-1]) if member.get("name") else ""
        hits = [(state, entry) for state in ("present", "absent") for entry in roster[state] if last and surname(entry[0]) == last]
        if len(hits) != 1:
            unresolved.append({**member, "reason": f"{len(hits)} roster matches"}); continue
        state, (_, remote, _line) = hits[0]
        section = "PRESENT" if state == "present" else next(k for k in ("ABSENT", "REGRETS") if k in roster["sections"])
        evidence = {
            "schema": "council-attendance/v1", "method": "original_roster", "state": state, "meeting_id": meeting_id,
            "person_id": member["person_id"], "local_date": meeting_date, "source_url": source_url, "source_sha256": sha,
            "source_page": 1, "source_quote": ("PRESENT:" if state == "present" else "ABSENT:") + "\n" + roster["sections"][section],
            "review": "Original signed minutes, page 1 read with column layout preserved (pdftotext -layout); explicit named roster section"
                      + (", listed as remote" if remote else "") + ". Presence does not assert full-meeting duration or physical modality.",
            "reviewed_meeting_state": state,
        }
        records.append({"person_id": member["person_id"], "attendance_mode": "Unknown" if state == "present" else "Absent",
                        "notes": json.dumps(evidence, sort_keys=True, separators=(",", ":"))})
    return {"records": records, "unresolved": unresolved, "status": "ok"}
