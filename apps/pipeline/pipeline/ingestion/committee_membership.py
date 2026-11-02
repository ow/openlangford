"""Who sat on each committee, from the committees' own minutes (stage ``committee-membership``).

Committee motions are held at ingest until the body's voting membership is known (ingester.motion_hold_applies).
This builds that membership the way the Community Advisory Committee's was validated (committee_ballots.py):

- Each meeting's original minutes list who was PRESENT and ABSENT (members) apart from ATTENDING (staff). That
  dated roster is the evidence: it records who sat on the committee on that date, nothing more. No member is
  carried across meetings they aren't listed at.
- Council's own appointment resolutions ("That Council appoint Cheryl Brown to the Planning, Zoning and
  Affordable Housing Committee for a term ending December 2022") give terms where Council recorded them, and
  full names for members the rosters list by initial.
- A councillor is identified from Council's own membership on the meeting date; a citizen member by initial and
  surname against existing people, never by surname alone. Anything ambiguous is left unresolved and reported.

Output, per meeting: ``meetings.meta.committee_roster`` (members present/absent with person ids and the quoted
roster, plus whether every present member is identified, i.e. whether per-member votes can be recorded); per
committee: ``memberships`` rows only for terms Council recorded. Citizen members without a people record get one.
Dry run by default; applying backs up what it replaces.
"""
from __future__ import annotations

import glob
import json
import os
import re
import subprocess
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from typing import Any

ROSTER_VERSION = 2
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

LABEL = re.compile(r"^\s*#*\s*\**(PRESENT|ABSENT|REGRETS|AT[TI]ENDING|ALSO\s+PRESENT|STAFF(?:\s+PRESENT)?|GUESTS?)\b\s*:?\s*(.*)$", re.I)
END = re.compile(r"^\s*#*\s*(?:1\s*\.|1\)|CALL\s+TO\s+ORDER|TERRITORIAL|Meeting\s+available|_{5,}|CHAIR\s+AND\s+VICE|CHAIR\s+APPOINTMENT)", re.I)
MEMBER_SECTIONS = {"PRESENT": "present", "ABSENT": "absent", "REGRETS": "absent"}
GROUP = re.compile(r"\b(Councillors(?=\s*:|\s+[A-Z]\.)|Citizen\s+Members?(?=\s*:|\s+[A-Z]\.)|(?:[Cc]ommittee\s*)?[Mm]em[eb]*ers(?=\s*:|\s+[A-Z]\.)|"
                   r"Councillor(?=\s*:)|Council\s+Members?(?=\s*:)|Member(?=\s*:)|Staff(?=\s*:)|Guests?(?=\s*:))\s*:?")
# Annotations around a name: "(Chair)", "- Vice Chair", "— Acting Chair", "(A/Chair)", "- Remote", "Joined meeting at 7:11 pm".
ROLE_WORDS = r"Alternate(?!\s+Vice)(?!\s+Chair)|(?:Alternate\s+|Acting\s+|A/)?(?:Vice[- ]?)?Chair(?:person)?|Remote|Electronic(?:ally)?|via\s+\w+|By\s*Telephone|In\s+Person"
MUNICIPALITY = re.compile(r"^(?:(?:District|City|Town|Township)\s+of\s+)?(Esquimalt|Langford|Colwood|Metchosin|Highlands|Sooke|View\s+Royal|"
                          r"Saanich|Victoria|Oak\s+Bay|Sidney|Central\s+Saanich|North\s+Saanich|Juan\s+de\s+Fuca)(?:\s*\(?Remote\)?)?$", re.I)
SUBLABEL = re.compile(r"^(?:Acting\s+Chair|Alternate|In\s+Person|Remote(?:ly)?|By\s*(?:Tele)?phone|Electronic(?:ally)?|Members?|Chair|Committee|Councillors?|Municipal|"
                      r"Enforcement|Facilities(?:\s*-\s*Remote)?|ATTENDING|Staff)\s*:?$", re.I)
ROLE_NOTE = re.compile(r"\(([^)]*)\)|\s-\s*((?:(?:" + ROLE_WORDS + r")\s*-?\s*)+)|\s*-?\s*\b((?:Joined|Left|Arrived|Departed)\b.*)$|\s((?:Vice[- ]?)?Chair)$", re.I)
TITLE_WORDS = re.compile(r"\b(Services|Safety|Legislative|Corporate|Deputy|R\.?\s?CMP|CMP|Department|Representative|Director|Officer|Manager|Coordinator|Clerk|Planner|Engineer|Administrator|Assistant|Analyst|"
                         r"Technologist|Supervisor|Chief|Inspector|Secretary|Technician|Specialist|Recorder|Superintendent)\b", re.I)
REP = re.compile(r"\b([A-Z]{2,}\s+)?Rep(?:resentative)?\.?\s+", re.I)


def _clean(s: str) -> str:
    s = re.sub(r"\s*[—–]\s*", " - ", s).replace("[", "l")
    s = s.replace("!", "l").replace("{", "(").replace("}", ")")
    s = re.sub(r"(^|\s)5\.\s+(?=[A-Z][a-z])", r"\1S. ", s)          # "5. Harvey": a scanned "S."
    s = re.sub(r"\b([A-Z]\.\s*[A-Z][a-z]{2,}) ([a-z]{3,})\b", r"\1\2", s)  # "K. Sheld rake": a scanned break inside a surname
    s = s.replace("l<", "k").replace("IVl", "M")                       # "Szpal<", "IVlember"
    s = re.sub(r"\b([A-Z])\s+\.", r"\1.", s)                           # "L . Seaton"
    s = re.sub(r"(?<=[a-z])-(?=(?:Remote|Alternate)\b)", " - ", s)
    s = re.sub(r"\bVice\s*-\s*Chair", "Vice-Chair", s, flags=re.I)
    s = re.sub(r"\bMe(?:nn|rn)bers?\b", "Members", s).replace("MemberT.", "Member T.")
    s = re.sub(r"(?<=\w)(?=(?:Remote|Alternate)[a-z])", " ", s).replace("’", "'").replace("“", "").replace("”", "")
    s = re.sub(r"(?<=[a-z])1(?=[a-z])", "l", s)
    s = re.sub(r"(?<=[A-Za-z])0(?=[a-z])", "o", s)
    return re.sub(r"\s+", " ", s).strip(" ,;.")


def norm_surname(s: str) -> str:
    return re.sub(r"[^a-z]", "", (s or "").lower())


# --- roster text -----------------------------------------------------------------------------------------------

def minutes_pdf(archive_path: str | None) -> str | None:
    if not archive_path:
        return None
    folder = os.path.join(PROJECT_ROOT, archive_path)
    pdfs = glob.glob(os.path.join(glob.escape(folder), "Minutes", "*.pdf"))
    # The signed copy is the record; a draft only when that's all there is.
    return sorted(pdfs, key=lambda p: ("Signed" not in p, "Draft" in p, p))[0] if pdfs else None


def pdf_header(path: str) -> str:
    try:
        return subprocess.run(["pdftotext", "-layout", "-f", "1", "-l", "1", path, "-"],
                              check=True, capture_output=True, text=True, timeout=40).stdout
    except (subprocess.SubprocessError, OSError):
        return ""


def header_lines(text: str) -> list[str]:
    """The lines from the first roster label to the start of business."""
    lines = text.splitlines()
    start = next((i for i, l in enumerate(lines) if LABEL.match(l) and re.match(r"\s*#*\s*\**PRESENT", l, re.I)), None)
    if start is None:
        return []
    out = []
    for line in lines[start:start + 60]:
        if END.match(line) and out:
            break
        out.append(line)
    return out


# --- parsing ---------------------------------------------------------------------------------------------------

def _split_names(text: str) -> list[str]:
    text = re.sub(r"\band\b", ",", text)
    text = re.sub(r"(?<=[a-z\)])\.\s+(?=[A-Z])", ",", text)
    text = re.sub(r"\b(?:By\s*Telephone|In\s+Person|Remote(?:ly)?|Electronically)\s*:", ",", text, flags=re.I)
    return [p for p in (_clean(x) for x in re.split(r"[,;]", text)) if p]


COMPANY = re.compile(r"\b(?:Contracting|Consulting|Consultants?|Construction|Engineering|Ltd|Inc|Corp|Corporation|Company|Group|Services|Associates)\b\.?", re.I)


def parse_entry(raw: str, group: str | None = None) -> dict | None:
    """'Councillor L Szpak - Chair' / 'D. Blackwell (Chair)' / 'VCMMC Rep. M. Gibbins' / 'D. Hopkins, Corporate
    Officer, Esquimalt' → {name, initial, surname, kind, chair, vice, note}."""
    raw = _clean(raw)
    if not raw or len(raw) < 3:
        return None
    notes = [n for pair in ROLE_NOTE.findall(raw) for n in pair if n]
    core = ROLE_NOTE.sub(" ", raw)
    affiliation = None
    if "," in core:
        core, affiliation = core.split(",", 1)
        affiliation = affiliation.strip()
    kind, kind_from = None, "prefix"
    if re.match(r"\s*(Acting\s+)?Mayor\b", core, re.I):
        kind = "mayor"
    elif re.match(r"\s*Council+or?s?\b", core, re.I):
        kind = "councillor"
    rep = REP.search(core)
    if rep:
        kind = "representative"
        notes.append(rep.group(0).strip())
        core = core[rep.end():]
    core = re.sub(r"^\s*(?:Acting\s+)?(?:Mayor|Council+or?s?|Members?|Citizen\s+Members?)\b\.?:?\s*", "", core, flags=re.I).strip()
    if group and re.match(r"Staff|Guest", group, re.I):
        return {"skip": True}
    if TITLE_WORDS.search(core) or MUNICIPALITY.match(core.strip()):
        return None  # a job title or a municipality, not a person
    if COMPANY.search(core):
        return None  # a firm ("Victoria Contracting") printed in the roster, not a member
    core = core.strip().rstrip(" -.")
    m = re.match(r"^(?:([A-Z])\.?\s*(?:[A-Z]\.\s*)?|([A-Z][a-z]+(?:-[A-Z][a-z]+)?)\s+)((?:[A-Z][a-z]*'?)?(?:Mc|Mac|O')?[A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+)?)$", core)
    if m:
        initial, first, surname = (m.group(1) or m.group(2)[0]).upper(), m.group(2), m.group(3)
        if re.search(r"\bReps?\b", surname) or re.fullmatch(r"[A-Z]{2,6}", surname):
            return None  # "V. CMMC Rep" (the VCMMC representative's title), "C. AD": an acronym, not a surname
    elif kind in ("councillor", "mayor") and re.match(r"^[A-Z][A-Za-z'\-]+$", core):
        initial, first, surname = None, None, core  # "Councillor Blackwell (Chair)": Council's own roll identifies the office holder
    else:
        return None
    if group and not kind:
        kind_from = "group"
        kind = "councillor" if re.match(r"Council", group, re.I) else "mayor" if re.match(r"Mayor", group, re.I) else "member"
    note_text = " ".join(notes)
    return {"raw": raw, "kind_from": kind_from if kind else None, "alternate": bool(re.search(r"Alternate", note_text, re.I)), "initial": initial, "first": first, "surname": surname, "kind": kind or "member",
            "chair": bool(re.search(r"(?<![-/ ])(?<!Vice)\bChair", note_text, re.I)) and not re.search(r"Acting|A/|Alternate", note_text, re.I),
            "vice": bool(re.search(r"Vice[- ]?Chair", note_text, re.I)) and not re.search(r"Alternate", note_text, re.I),
            "acting_chair": bool(re.search(r"(?:Acting\s+|A/)(?:Vice[- ]?)?Chair", note_text, re.I)),
            "remote": bool(re.search(r"Remote|Electronic|via", note_text, re.I)),
            "non_voting": bool(re.search(r"non[- ]?voting", raw, re.I)),
            "affiliation": affiliation, "note": note_text or None}


def parse_roster(text: str) -> dict:
    """{'present': [entry], 'absent': [entry], 'unparsed': [cell], 'quote': str} from a minutes header.

    Two layouts: older minutes write each section as prose with groups ("Councillors: D. Blackwell (Chair),
    L. Seaton; Members: A. Creuzot and N. Stewart."); eSCRIBE minutes put the label in a left column and names in
    one or two columns beside it. Staff are listed under ATTENDING and are never members."""
    lines = header_lines(text)
    sections: dict[str, list[str]] = defaultdict(list)
    current = None
    for line in lines:
        label = LABEL.match(line)
        if label:
            current = re.sub(r"\s+", " ", label.group(1).upper()).replace("ATIENDING", "ATTENDING")
            rest = label.group(2)
        else:
            rest = line
        if current and rest.strip():
            sections[current].append(rest.rstrip())
    out: dict[str, Any] = {"present": [], "absent": [], "unparsed": [], "quote": "\n".join(l.rstrip() for l in lines).strip()}
    for label, body in sections.items():
        bucket = MEMBER_SECTIONS.get(label)
        if not bucket:
            continue
        joined = " ".join(b.strip() for b in body)
        if GROUP.search(joined):
            # Prose: split into groups, then names.
            parts = GROUP.split(joined)
            chunks = [(None, parts[0])] + [(parts[i], parts[i + 1]) for i in range(1, len(parts) - 1, 2)]
            for group, chunk in chunks:
                for cell in _split_names(chunk):
                    if SUBLABEL.match(cell) or MUNICIPALITY.match(cell) or (TITLE_WORDS.search(cell) and not parse_entry(cell, group)):
                        continue
                    if len(cell.split()) >= 5 and not parse_entry(cell, group):
                        continue  # a sentence the header ran into ("Quorum was not met ..."), reported separately
                    entry = parse_entry(cell, group)
                    if entry and entry.get("skip"):
                        continue
                    (out[bucket].append(entry) if entry else out["unparsed"].append(cell))
        else:
            cells = [c.strip() for line in body for c in re.split(r"\s{2,}", line.strip()) if c.strip()]
            joined_cells = []
            for cell in cells:
                # A name broken over two lines in scanned text: "Councillor M" then "Wagner - Vice-Chair".
                if joined_cells and re.match(r"^(?:Councillor\s+)?[A-Z]\.?$", joined_cells[-1]):
                    joined_cells[-1] += " " + cell
                else:
                    joined_cells.append(cell)
            for cell in joined_cells:
                if SUBLABEL.match(_clean(cell)) or MUNICIPALITY.match(_clean(cell)):
                    continue
                entries, unparsed = _cell_entries(cell)
                out[bucket] += [e for e in entries if not e.get("skip")]
                out["unparsed"] += [u for u in unparsed if not (SUBLABEL.match(u) or MUNICIPALITY.match(u))]
    return out


def _cell_entries(cell: str) -> tuple[list[dict], list[str]]:
    """One column cell: a single name (possibly with a title and municipality after a comma) or a run of names."""
    entry = parse_entry(cell)
    if entry and not (entry["affiliation"] and parse_entry(entry["affiliation"].split(",")[0])):
        return [entry], []
    entries, unparsed = [], []
    for part in _split_names(cell):
        e = parse_entry(part)
        if e:
            entries.append(e)
        elif not TITLE_WORDS.search(part):
            unparsed.append(part)
    return entries, unparsed


# --- appointments ----------------------------------------------------------------------------------------------

MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                       "september", "october", "november", "december"], 1)}


def _term_end(text: str, start: date) -> str | None:
    m = re.search(r"(?:terms?|effective[^.;]{0,40}?)\s+ending\s+(?:on\s+)?(?:(January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:(\d{1,2}),?\s+)?)?(\d{4})", text, re.I)
    if m:
        month = MONTHS[m.group(1).lower()] if m.group(1) else 12
        day = int(m.group(2)) if m.group(2) else (31 if month in (1, 3, 5, 7, 8, 10, 12) else 30 if month != 2 else 28)
        return date(int(m.group(3)), month, day).isoformat()
    if re.search(r"\bone[- ]year\s+term\b", text, re.I):
        return date(start.year + 1, start.month, start.day).isoformat()
    return None


OTHER_REPORT_HEADINGS = re.compile(
    r"Board of Variance|MAYOR AND COUNCIL|Beautification (?:&|and) Festival Committee|Parks and Recreation Committee"
    r"|Planning and Zoning Committee|Accessibility Advisory Committee|Advisory Design Panel|Heritage Commission", re.I)


class ReportRosters:
    """Committee member lists printed in the City's annual reports ("Protective Services Committee Councillor Lillian
    Szpak, Chair … Ms. Deborah Wilson Mr. Hans Frederiksen …"): an independent, published record of who sat on each
    committee in a year. A roster name found there (same initial and surname, that year or the next report) is
    corroborated, and the report supplies the full name."""

    def __init__(self, cur, committees: dict[int, str]):
        cur.execute("""select r.year, string_agg(p.content, ' ' order by p.page) from public_report_pages p
                       join public_reports r on r.id = p.report_id where r.kind = 'annual_report'
                       and p.content ~* 'committee' and p.content ~* 'councillor' group by r.year""")
        pages = {y: re.sub(r"\s+", " ", t or "") for y, t in cur.fetchall()}
        heads = {org: committee_pattern(re.sub(r"\s*Committee$", "", name) + " Committee") for org, name in committees.items()}
        self.sections: dict[tuple[int, int], str] = {}
        for year, text in pages.items():
            spots = sorted((m.start(), m.end(), org) for org, pat in heads.items() for m in pat.finditer(text))
            # A section ends at the next committee heading. Only known headings count: member names run straight
            # into the next heading, so a generic "Words … Committee" pattern would swallow them.
            stops = sorted({m.start() for pat in [*heads.values(), OTHER_REPORT_HEADINGS] for m in pat.finditer(text)})
            for start, end, org in spots:
                nxt = next((x for x in stops if x > end), end + 900)
                self.sections[(org, year)] = self.sections.get((org, year), "") + " " + text[end:min(nxt, end + 900)]

    def corroborate(self, org: int, day, entry: dict) -> dict | None:
        if not entry.get("surname"):
            return None
        for year in (day.year, day.year + 1, day.year - 1):
            section = self.sections.get((org, year))
            if not section:
                continue
            initial = entry.get("initial") or ""
            m = re.search(rf"(?:Councillor|Mayor|Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Lt\.?)?\s*({initial}[a-z’'\-]+)?\s+{re.escape(entry['surname'])}\b", section)
            if m and (m.group(1) or not initial):
                return {"report_year": year, "quote": section[max(0, m.start() - 40):m.end() + 40].strip(),
                        "full_name": f"{m.group(1)} {entry['surname']}" if m.group(1) else None}
        return None


def committee_pattern(name: str) -> re.Pattern:
    """'Parks, Recreation, Culture & Beautification Committee' matching 'Parks, Recreation, Culture and
    Beautification Committee' and the like."""
    words = [w for w in re.findall(r"[A-Za-z]+", name) if w.lower() != "and"]
    return re.compile(r"\b" + r"\W+(?:and\W+)?".join(re.escape(w) for w in words), re.I)


def find_appointments(cur, committees: dict[int, str]) -> list[dict]:
    """Council resolutions appointing named people to these committees, quoted from Council minutes."""
    cur.execute("""select distinct on (mt.id) mt.id, mt.meeting_date, d.full_text from documents d join meetings mt on mt.id = d.meeting_id
                   join organizations o on o.id = mt.organization_id
                   where o.classification = 'Council' and d.title ilike '%%minutes%%' and d.full_text ~* 'appoint'
                   order by mt.id, (d.title ilike '%%signed%%') desc""")
    names = {cid: committee_pattern(n) for cid, n in committees.items()}
    found = []
    name = r"(?:Councillor\s+[A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+)?|[A-Z][a-z]+(?:\s+[A-Z]\.)?\s+[A-Z][A-Za-z'\-]+)"
    names_run = name + r"(?:\s*(?:,|and|,\s*and)\s*" + name + r")*"
    target = r"\s+(?:to|as\s+(?:the\s+)?(?:Chair|Vice[- ]Chair|alternate|an?\s+alternate)\s+(?:of|to|on))\s+the\s+"
    for meeting_id, day, text in cur.fetchall():
        flat = re.sub(r"\s+", " ", text or "")
        for clause in re.finditer(r"THAT\s+Council\s+(?:re-?)?appoints?\s+([^;]{3,700}?)(?=;|\.\s|\s+(?:AND\s+)?THAT\b|$)", flat, re.I):
            # One resolution can appoint several people to several bodies: "X and Y to the Transportation and
            # Public Works Committee and Z to the Planning, Zoning and Affordable Housing Committee".
            body_text = clause.group(1)
            if re.search(r"\bin\s+place\s+of\b|\brescind", body_text, re.I):
                continue  # a replacement or rescission: who holds the seat isn't a plain appointment; left to the rosters
            for part in re.finditer(r"(" + names_run + r")" + target + r"(.+?)(?=\s+and\s+" + name + r"(?:\s*(?:,|and)\s*" + name + r")*" + target + r"|$)", body_text):
                who, body = part.group(1), part.group(2)
                cid = next((cid for cid, rx in names.items() if rx.search(body)), None)
                if not cid:
                    continue
                role_text = part.group(0)[len(who):len(who) + 40]
                role = ("chair" if re.search(r"as\s+(?:the\s+)?Chair", role_text, re.I) else "vice_chair" if re.search(r"Vice[- ]Chair", role_text, re.I)
                        else "alternate" if re.search(r"alternate", role_text, re.I) else "member")
                for person in re.findall(name, who):
                    councillor = person.startswith("Councillor")
                    person = re.sub(r"^Councillor\s+", "", person)
                    if len(person.split()) < 2 and not councillor:
                        continue
                    found.append({"organization_id": cid, "name": person, "councillor": councillor, "role": role,
                                  "start_date": str(day), "end_date": _term_end(part.group(0) + " " + body_text[part.end():part.end() + 120], day),
                                  "council_meeting_id": meeting_id, "quote": clause.group(0)[:700]})
    return found


# --- identity --------------------------------------------------------------------------------------------------

class People:
    def __init__(self, cur):
        cur.execute("select id, name, is_councillor, coalesce(meta, '{}'::jsonb) from people")
        self.rows = [{"id": i, "name": n, "is_councillor": c, "meta": m} for i, n, c, m in cur.fetchall()]
        cur.execute("""select ms.person_id, ms.role, ms.start_date, ms.end_date from memberships ms
                       join organizations o on o.id = ms.organization_id where o.classification = 'Council'""")
        self.council = [{"person_id": p, "role": r, "start": s, "end": e} for p, r, s, e in cur.fetchall()]
        self.by_surname: dict[str, list[dict]] = defaultdict(list)
        for p in self.rows:
            # "Lt. Dan Darche", "S/Sgt. Paul Reshaur": the rank isn't the first name.
            p["bare"] = re.sub(r"^(?:(?:Lt|Sgt|S/Sgt|Cpl|Cst|Insp|Supt|Capt|Dr|Mr|Mrs|Ms|Chief)\.?\s+)+", "", p["name"] or "").strip()
            parts = re.findall(r"[A-Za-z'\-]+", p["bare"])
            if parts:
                self.by_surname[norm_surname(parts[-1])].append(p)
        self.by_id = {p["id"]: p for p in self.rows}
        cur.execute("""select a.person_id, mt.organization_id, count(*) from attendance a join meetings mt on mt.id = a.meeting_id group by 1, 2""")
        self.attended: dict[int, set[int]] = defaultdict(set)
        self.attendance_count: dict[tuple[int, int], int] = {}
        for pid, org, n in cur.fetchall():
            self.attended[pid].add(org)
            self.attendance_count[(pid, org)] = n

    def gone_on(self, pid: int) -> str | None:
        meta = self.by_id[pid]["meta"] or {}
        return meta.get("died_on") or meta.get("in_memoriam_on")

    def council_on(self, day: date) -> list[dict]:
        return [m for m in self.council if m["start"] and m["start"] <= day and (not m["end"] or m["end"] >= day)]

    def councillor(self, entry: dict, day: date) -> tuple[int | None, str]:
        want = norm_surname(entry["surname"].split()[-1])
        on = self.council_on(day)
        sitting = [m for m in on if norm_surname(self.by_id[m["person_id"]]["name"].split()[-1]) == want]
        if not sitting:
            # A scanned misread of a sitting councillor's name ("Sahlstronn"): one edit from exactly one of them.
            near = [m for m in on if len(want) >= 5 and (
                _edit1(norm_surname(self.by_id[m["person_id"]]["name"].split()[-1]), want)
                or _scan_equal(norm_surname(self.by_id[m["person_id"]]["name"].split()[-1]), want))]
            if len({m["person_id"] for m in near}) == 1:
                sitting = near
        ids = {m["person_id"] for m in sitting
               if not entry["initial"] or self.by_id[m["person_id"]]["name"][:1].upper() == entry["initial"]}
        if len(ids) == 1:
            return ids.pop(), "sitting_council_member_on_date"
        return None, "councillor_not_unique_on_date" if ids else "councillor_not_on_council_on_date"

    def citizen(self, entry: dict, full_names: dict[tuple[str, str], set[str]], org: int | None = None) -> tuple[int | None, str, str | None]:
        """(person id, how, proposed name for a new record).

        An existing person counts only when tied to this committee: named in full by Council's appointment or
        by the roster itself, or already recorded at this committee's meetings. A same-initial, same-surname
        person known only from elsewhere (a speaker at Council, say) is not assumed to be this member."""
        key = (entry["initial"], norm_surname(entry["surname"]))
        candidates = [p for p in self.by_surname.get(key[1], []) if p["bare"][:1].upper() == entry["initial"]]
        if org is not None:
            here = [p for p in candidates if org in self.attended.get(p["id"], set())]
            elsewhere_only = [p for p in candidates if p not in here]
        else:
            here, elsewhere_only = candidates, []
        named = full_names.get(key, set())
        if entry["first"]:
            named = named | {f"{entry['first']} {entry['surname']}"}
        if len(named) == 1:
            full = next(iter(named))
            exact = [p for p in candidates if p["bare"].lower() == full.lower()]
            if len(exact) == 1:
                return exact[0]["id"], "full_name_from_appointment_or_roster", None
            # The initial-only record the attendance step made ("A. Creuzot") is the same entry.
            initial_only = [p for p in candidates if re.match(r"^[A-Z]\.\s", p["bare"])]
            if not exact and len(candidates) == len(initial_only) == 1:
                return initial_only[0]["id"], "initial_record_named_by_appointment", full
            variant = [p for p in candidates if _same_first_name(p["bare"].split()[0], full.split()[0])]
            if not exact and len(candidates) == len(variant) == 1:
                return variant[0]["id"], "first_name_spelling_variant", None
            if not candidates:
                return None, "new_person", full
            # Council named someone else ("Cheryl Brown") than the existing same-initial record ("Carol Brown",
            # an earlier guess from the initial): Council's resolution is the record.
            return None, "named_by_council_existing_record_conflicts", full
        if len(named) > 1:
            return None, "conflicting_full_names", None
        if len(here) == 1:
            return here[0]["id"], "recorded_at_this_committee", None
        if len(here) > 1:
            return None, "ambiguous_existing_people", None
        if elsewhere_only:
            return None, "same_initial_and_surname_elsewhere_only", None
        return None, "new_person", f"{entry['initial']}. {entry['surname']}"


# --- plan ------------------------------------------------------------------------------------------------------

def _fold_surnames(observations: list[dict], recorded: dict[tuple[str, str], int] | None = None) -> dict[tuple[str, str], tuple[str, str]]:
    """Map scan misreads to the committee's usual spelling ('Sheld rake' → 'Sheldrake', 'Homer' → 'Horner'):
    same initial, one edit or one merged/split letter pair apart. The usual spelling is the one this committee's
    existing records use far more (recorded: meetings per spelling), else the one the rosters print at least twice
    as often. When neither is clear the two stay apart and are reported."""
    counts = Counter((e["initial"], norm_surname(e["surname"])) for e in observations)
    recorded = recorded or {}
    fold = {}
    for key, n in counts.items():
        for other, m in counts.items():
            if other == key or other[0] != key[0] or len(other[1]) < 5:
                continue
            if not (_edit1(key[1], other[1]) or _scan_equal(key[1], other[1])):
                continue
            r_key, r_other = recorded.get(key, 0), recorded.get(other, 0)
            if r_other >= 5 * max(r_key, 1) or (r_other == r_key == 0 and m >= 2 * n) or (m >= 2 * n and r_other >= r_key):
                fold[key] = other
    return fold


def _scan_equal(a: str, b: str) -> bool:
    """'Homer'/'Horner', 'Steams'/'Stearns', 'Sahlstronn'/'Sahlstrom': letters a scanner merges or splits."""
    f = lambda x: x.replace("rn", "m").replace("nn", "m")
    return a != b and f(a) == f(b)


def _same_first_name(a: str, b: str) -> bool:
    """'Jacqui' / 'Jacquie': one letter apart and at least five letters long."""
    a, b = a.lower().strip("."), b.lower().strip(".")
    return len(a) >= 5 and len(b) >= 5 and (_edit1(a, b) or a == b)


def _edit1(a: str, b: str) -> bool:
    if abs(len(a) - len(b)) > 1 or a == b:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    s, l = (a, b) if len(a) < len(b) else (b, a)
    return any(l[:i] + l[i + 1:] == s for i in range(len(l)))


def build_plan(cur, organization_ids: list[int] | None = None, log=print) -> dict:
    cur.execute("""select o.id, o.name from organizations o where o.classification in ('Committee', 'Board')
                   and exists (select 1 from meetings mt where mt.organization_id = o.id) order by o.id""")
    committees = {i: n for i, n in cur.fetchall() if not organization_ids or i in organization_ids}
    people = People(cur)
    report_rosters = ReportRosters(cur, committees)
    appointments = find_appointments(cur, committees)
    full_names: dict[int, dict[tuple[str, str], set[str]]] = defaultdict(lambda: defaultdict(set))
    for a in appointments:
        parts = a["name"].split()
        if len(parts) < 2:
            continue
        full_names[a["organization_id"]][(parts[0][0].upper(), norm_surname(parts[-1]))].add(a["name"])

    cur.execute("""select mt.id, mt.organization_id, mt.meeting_date, mt.archive_path, coalesce(mt.meta, '{}'::jsonb)
                   from meetings mt where mt.organization_id = any(%s) order by mt.meeting_date""", (list(committees),))
    meetings = cur.fetchall()
    plan: dict[str, Any] = {"version": ROSTER_VERSION, "built_at": datetime.now(timezone.utc).isoformat(),
                            "committees": {}, "meetings": [], "appointments": appointments, "new_people": {}}
    parsed: dict[int, dict] = {}
    for mid, org, day, archive_path, meta in meetings:
        pdf = minutes_pdf(archive_path)
        text, source = (pdf_header(pdf), {"kind": "minutes_pdf", "file": os.path.relpath(pdf, PROJECT_ROOT)}) if pdf else ("", None)
        if not header_lines(text):
            cur.execute("""select id, title, full_text from documents where meeting_id = %s and title ilike '%%minutes%%'
                           order by (title ilike '%%signed%%') desc, id""", (mid,))
            for doc_id, title, full in cur.fetchall():
                if header_lines(full or ""):
                    text, source = full, {"kind": "minutes_text", "document_id": doc_id, "title": title}
                    break
        parsed[mid] = {"roster": parse_roster(text) if text else None, "source": source}

    for org in committees:
        org_meetings = [m for m in meetings if m[1] == org]
        observations = [e for m in org_meetings if parsed[m[0]]["roster"] for b in ("present", "absent") for e in parsed[m[0]]["roster"][b]]
        recorded = Counter()
        for pid, orgs in people.attended.items():
            if org in orgs and people.by_id.get(pid):
                parts = re.findall(r"[A-Za-z'\-]+", people.by_id[pid]["name"])
                if parts:
                    recorded[(parts[0][0].upper(), norm_surname(parts[-1]))] += people.attendance_count.get((pid, org), 0)
        fold = _fold_surnames([e for e in observations if e["kind"] in ("member", "representative")], recorded)
        summary = {"name": committees[org], "meetings": len(org_meetings), "with_roster": 0, "fully_identified": 0,
                   "members": {}, "gaps": Counter()}
        for mid, _, day, _, meta in org_meetings:
            roster, source = parsed[mid]["roster"], parsed[mid]["source"]
            record: dict[str, Any] = {"meeting_id": mid, "organization_id": org, "date": str(day), "source": source}
            if not roster or not (roster["present"] or roster["absent"]):
                record.update(status="no_roster", gaps=["no_roster_in_minutes"])
                summary["gaps"]["no_roster_in_minutes"] += 1
                plan["meetings"].append(record)
                continue
            summary["with_roster"] += 1
            gaps, members = [], []
            staff_names = staff_in(roster["quote"])
            for bucket in ("present", "absent"):
                for e in roster[bucket]:
                    key = fold.get((e["initial"], norm_surname(e["surname"])), (e["initial"], norm_surname(e["surname"])))
                    pid, how, new_name = None, None, None
                    is_council = e["kind"] in ("councillor", "mayor")
                    staff = (e["initial"], norm_surname(e["surname"])) in staff_names and org not in STAFF_MEMBER_BODIES and not is_council_entry(e)
                    if staff:
                        gaps.append(f"staff_listed_as_member:{e['raw']}")
                        continue
                    if not is_council and e["kind"] == "member":
                        # Unlabelled names (eSCRIBE columns) may still be councillors: the roster prints "Councillor"
                        # for them, so an unlabelled name that is a sitting councillor's is checked, not assumed.
                        cpid, _ = people.councillor(e, day)
                        if cpid and not roster_has_group_labels(roster):
                            is_council = True
                    if is_council:
                        pid, how = people.councillor(e, day)
                        if not pid and e.get("kind_from") == "group":
                            is_council = False  # listed under "Councillors" in a run-on roster but not on Council that day
                    if not is_council:
                        entry = {**e, "surname": e["surname"] if key == (e["initial"], norm_surname(e["surname"])) else _spelling(observations, key)}
                        pid, how, new_name = people.citizen(entry, full_names[org], org)
                        if how == "new_person":
                            pid = None
                    if pid and people.gone_on(pid) and str(day) > people.gone_on(pid):
                        pid, how = None, "identity_after_death_refused"
                    m = {"name": e["raw"], "person_id": pid, "how": how, "attendance": bucket,
                         "kind": "councillor" if is_council and e["kind"] != "mayor" else e["kind"],
                         "chair": e["chair"], "vice_chair": e["vice"], "acting_chair": e["acting_chair"], "alternate": e["alternate"],
                         "remote": e["remote"], "affiliation": e["affiliation"],
                         # "(non-voting)" in the roster: present, but never counted as a voter or toward quorum.
                         "voting": not e.get("non_voting")}
                    report = report_rosters.corroborate(org, day, e)
                    if report:
                        m["corroborated_by"] = report
                        if new_name and report.get("full_name") and re.match(r"^[A-Z]\.?\s", new_name):
                            new_name = report["full_name"]  # "E. Wilson" → "Edward Wilson", as the annual report lists
                    if new_name:
                        m["new_person"] = new_name
                        plan["new_people"].setdefault(f"{org}:{key[0]}:{key[1]}", {"name": new_name, "organization_id": org,
                                                                                    "first_seen": str(day), "meetings": []})["meetings"].append(mid)
                    if not pid and not new_name:
                        gaps.append(f"unidentified:{e['raw']}:{how}")
                    if e["kind"] == "representative":
                        gaps.append(f"representative_voting_status_unknown:{e['raw']}")
                    members.append(m)
                    label = pid or new_name or e["raw"]
                    s = summary["members"].setdefault(str(label), {"name": new_name or (people.by_id[pid]["name"] if pid else e["raw"]),
                                                                    "person_id": pid, "kind": m["kind"], "how": how, "present": 0, "absent": 0,
                                                                    "first": str(day), "last": str(day)})
                    s["present" if bucket == "present" else "absent"] += 1
                    s["last"] = str(day)
            for cell in roster["unparsed"]:
                gaps.append(f"unparsed:{cell}")
            if re.search(r"quorum\s*was\s*not\s*met|no\s+quorum|lack\s+of\s+(?:a\s+)?quorum", roster["quote"], re.I):
                gaps.append("quorum_not_met")
            if not roster["absent"]:
                gaps.append("absent_members_not_listed")  # the full membership, so quorum, isn't stated
            present = [m for m in members if m["attendance"] == "present"]
            identified = all(m["person_id"] or m.get("new_person") for m in present) and not any(
                g.startswith(("unparsed:", "representative_", "staff_listed_as_member", "unidentified:")) for g in gaps)
            record.update(status="votes_recordable" if identified and present else "motion_and_outcome_only",
                          members=members, gaps=gaps, roster_quote=roster["quote"][:3000])
            if record["status"] == "votes_recordable":
                summary["fully_identified"] += 1
            for g in gaps:
                summary["gaps"][g.split(":")[0]] += 1
            plan["meetings"].append(record)
        # A citizen "member" seen at just one meeting of a committee that met often is more likely a misread or a
        # staff name in the wrong column than a member: that meeting is held for review.
        rostered = summary["with_roster"]
        once = {k for k, v in summary["members"].items() if v["kind"] == "member" and v["present"] + v["absent"] == 1 and rostered >= 8}
        for record in plan["meetings"]:
            if record["organization_id"] != org or not record.get("members"):
                continue
            for m in record["members"]:
                label = str(m["person_id"] or m.get("new_person") or m["name"])
                if label in once and m["attendance"] == "present":
                    record["gaps"].append(f"single_observation:{m['name']}")
                    summary["gaps"]["single_observation"] += 1
                    if record["status"] == "votes_recordable":
                        record["status"] = "motion_and_outcome_only"
                        summary["fully_identified"] -= 1
        summary["gaps"] = dict(summary["gaps"])
        plan["committees"][str(org)] = summary
        log(f"  [committee-membership] {committees[org]}: {summary['meetings']} meetings, {summary['with_roster']} with a roster, "
            f"{summary['fully_identified']} with every present member identified, {len(summary['members'])} people")
    return plan


# Bodies whose members are municipal staff (the intermunicipal accessibility committee of corporate officers).
STAFF_MEMBER_BODIES = {31}


def staff_in(quote: str) -> set[tuple[str, str]]:
    """Names this roster prints with a job title ("M. Watmough, Deputy Director of Corporate Services", "Chief
    Administrative Officer J. Bowden", "Director of Engineering, Michelle Mahovlich"). Per meeting: the same
    initial and surname can be a citizen member one year and a staff member another."""
    found = set()
    for line in (quote or "").splitlines():
        for cell in re.split(r"\s{2,}", line):
            for m in re.finditer(r"\b([A-Z])(?:\.|[a-z]+)\s*([A-Z][A-Za-z'\-]+)", cell):
                if TITLE_WORDS.fullmatch(m.group(2)) or TITLE_WORDS.match(cell[m.start():m.end()]):
                    continue  # "Administrative Officer" is the title, not a name
                after = cell[m.end():m.end() + 45]
                before = cell[max(0, m.start() - 45):m.start()]
                if re.match(r"\s*,\s*[A-Za-z&/ ]{0,40}?" + TITLE_WORDS.pattern, after) or re.search(
                        TITLE_WORDS.pattern + r"[A-Za-z&/ ]{0,40}?,?\s*$", before):
                    found.add((m.group(1), norm_surname(m.group(2))))
    return found


def is_council_entry(e: dict) -> bool:
    return e["kind"] in ("councillor", "mayor") and e.get("kind_from") == "prefix"


def roster_has_group_labels(roster: dict) -> bool:
    return bool(GROUP.search(roster.get("quote") or ""))


def _spelling(observations: list[dict], key: tuple[str, str]) -> str:
    spellings = Counter(e["surname"] for e in observations if (e["initial"], norm_surname(e["surname"])) == key)
    return spellings.most_common(1)[0][0] if spellings else key[1].title()


# --- apply -----------------------------------------------------------------------------------------------------

def apply_plan(supabase, plan: dict, *, backup_dir: str, log=print) -> dict:
    """Write the plan: new people for unidentified-by-record citizen members, each meeting's roster to
    meetings.meta.committee_roster, and Council-recorded terms to memberships. Backs up what it replaces first."""
    os.makedirs(backup_dir, exist_ok=True)
    meeting_ids = [m["meeting_id"] for m in plan["meetings"]]
    before = []
    for i in range(0, len(meeting_ids), 200):
        before += supabase.table("meetings").select("id, meta").in_("id", meeting_ids[i:i + 200]).execute().data or []
    orgs = sorted({int(o) for o in plan["committees"]})
    memberships_before = supabase.table("memberships").select("*").in_("organization_id", orgs).execute().data or []
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = os.path.join(backup_dir, f"committee-membership-before-{stamp}.json")
    with open(path, "w") as f:
        json.dump({"meetings": before, "memberships": memberships_before}, f, default=str)
    log(f"  [committee-membership] backup: {path}")

    created: dict[str, int] = {}
    for key, person in plan["new_people"].items():
        row = supabase.table("people").insert({"name": person["name"], "is_councillor": False,
                                               "meta": {"source": "committee_roster", "committee_id": person["organization_id"],
                                                        "first_seen": person["first_seen"]}}).execute().data
        created[key] = row[0]["id"]
    metas = {m["id"]: m.get("meta") or {} for m in before}
    for record in plan["meetings"]:
        members = []
        for m in record.get("members", []):
            pid = m["person_id"]
            if not pid and m.get("new_person"):
                key = next((k for k, p in plan["new_people"].items() if p["name"] == m["new_person"] and p["organization_id"] == record["organization_id"]), None)
                pid = created.get(key)
            members.append({**m, "person_id": pid})
        roster = {"version": plan["version"], "status": record["status"], "source": record.get("source"),
                  "members": members, "gaps": record.get("gaps", []), "quote": record.get("roster_quote"), "built_at": plan["built_at"]}
        supabase.table("meetings").update({"meta": {**metas.get(record["meeting_id"], {}), "committee_roster": roster}}).eq("id", record["meeting_id"]).execute()
    existing = {(m["person_id"], m["organization_id"], str(m["start_date"])) for m in memberships_before}
    written = 0
    created_by_name = {(p["organization_id"], p["name"].lower()): created[k] for k, p in plan["new_people"].items() if k in created}
    for a in plan["appointments"]:
        pid = a.get("person_id") or created_by_name.get((a["organization_id"], a["name"].lower()))
        if not pid or (pid, a["organization_id"], a["start_date"]) in existing:
            continue
        supabase.table("memberships").insert({"person_id": pid, "organization_id": a["organization_id"], "role": a["role"],
                                              "start_date": a["start_date"], "end_date": a["end_date"],
                                              "meta": {"source": "council_resolution", "council_meeting_id": a["council_meeting_id"],
                                                       "quote": a["quote"], "end_stated": bool(a["end_date"])}}).execute()
        written += 1
    return {"backup": path, "people_created": len(created), "meetings": len(plan["meetings"]), "memberships": written}


def resolve_appointments(plan: dict, cur) -> None:
    """Attach person ids to appointment rows where the name resolves to exactly one person."""
    people = People(cur)
    for a in plan["appointments"]:
        parts = a["name"].split()
        entry = {"initial": parts[0][0].upper() if len(parts) > 1 else None, "first": parts[0] if len(parts) > 1 else None, "surname": parts[-1]}
        if a["councillor"]:
            pid, how = people.councillor(entry, date.fromisoformat(a["start_date"]))
        else:
            pid, how, _ = people.citizen(entry, {}, a["organization_id"])
        a["person_id"], a["how"] = pid, how


def describe(plan: dict) -> str:
    """Readable plan: per committee, members with their meetings, gaps, and the Council appointments found."""
    out = [f"# Committee membership plan (v{plan['version']}, built {plan['built_at'][:16]})", ""]
    for org, s in plan["committees"].items():
        out.append(f"## {s['name']}")
        pct = round(100 * s["fully_identified"] / s["meetings"]) if s["meetings"] else 0
        out.append(f"{s['meetings']} meetings · {s['with_roster']} with a roster · {s['fully_identified']} ({pct}%) with every present member identified")
        out.append("")
        out.append("| Member | Kind | Person | Identified by | Present | Absent | First | Last |")
        out.append("|---|---|---|---|---|---|---|---|")
        for m in sorted(s["members"].values(), key=lambda m: (m["kind"], -m["present"])):
            out.append(f"| {m['name']} | {m['kind']} | {m['person_id'] or 'new'} | {(m.get('how') or '').replace('_', ' ')} | {m['present']} | {m['absent']} | {m['first']} | {m['last']} |")
        if s["gaps"]:
            out.append("")
            out.append("Gaps: " + ", ".join(f"{k} ×{v}" for k, v in sorted(s["gaps"].items(), key=lambda kv: -kv[1])))
        apps = [a for a in plan["appointments"] if str(a["organization_id"]) == org]
        if apps:
            out.append("")
            out.append("Council appointments:")
            for a in apps:
                out.append(f"- {a['start_date']}: {a['name']} ({a['role']}{', to ' + a['end_date'] if a['end_date'] else ', no end stated'})"
                           f" → {a.get('person_id') or 'unresolved: ' + str(a.get('how'))}. “{a['quote'][:220]}”")
        out.append("")
    gaps = [m for m in plan["meetings"] if m["status"] != "votes_recordable"]
    out.append(f"## Meetings where per-member votes can't be recorded yet ({len(gaps)})")
    out.append("")
    for m in gaps:
        name = plan["committees"][str(m["organization_id"])]["name"]
        out.append(f"- {m['date']} {name} (meeting {m['meeting_id']}): {m['status']}; " + "; ".join(m.get("gaps", [])[:6]))
    return "\n".join(out)
