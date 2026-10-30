"""Closed (in-camera) council sessions, read from the public minutes.

Council may close part of a meeting to the public under section 90 of the Community
Charter. It has to do that in public: the open minutes record a resolution such as
"THAT Council close the meeting at 8:38 pm to the public pursuant to section 90 (1) (e)
and (k) of the Community Charter", and the letters say why. The closed part is not filmed
and its minutes are not published, so its length is estimated from the open record:

- Langford usually closes at the end of the meeting and adjourns afterwards, so the
  public "adjourned the meeting at 11:26 pm" comes after the closed part. Then
  ``closed ≈ adjourned_at − closed_at``.
- ``closed_at`` comes from the resolution ("close the meeting at 8:38 pm"), the line "The
  meeting went in camera at 8:22 pm", or, failing those, from the video: the stream stops
  when the room is cleared, so ``called to order + video length`` (checked against stated
  close times, see tests) or the in-camera agenda item's offset in the transcript.
- When council closes first and reopens later ("reconvened in open meeting at 6:15 pm"),
  ``closed ≈ reconvened_at − closed_at``.
- 2016–2019 minutes often had no resolution at all: the City posted a separate "Notice of
  Council Meeting (In-Camera)" for a closed meeting held before or after the regular one.
  Those count as a closed session with unknown length.

Unknown stays unknown (``None``), never 0. Everything is regex over stored text: no AI.

Stored per meeting in ``meetings.meta.closed_session`` (only meetings with a closed session
get the key; others get ``{"sessions": [], ...}`` so a re-run can tell "checked, none"
from "never checked")::

    {"sessions": [{"closed_at": "20:38", "reconvened_at": null, "reasons": ["1e", "1k"],
                   "reason_labels": ["land", "early talks on a City service"],
                   "source": "minutes", "position": "end"}],
     "called_at": "19:00", "adjourned_at": "21:33",
     "est_closed_minutes": 55, "open_minutes": 98,
     "method": "minutes", "confidence": "high", "version": "1"}

``method`` is how ``est_closed_minutes`` was found: ``minutes`` (stated close time to
adjournment or reopening), ``video`` (video length), ``transcript`` (agenda item offset),
or ``none``. ``confidence`` is ``high`` (times stated in the minutes), ``medium`` (one end
from the video), ``low`` (pre-2021 minutes, where the adjournment time may be when the
open part ended) or ``none``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable

CLOSED_SESSIONS_VERSION = "1"

# Community Charter s.90, in plain words. (1) = council may close; (2) = council must close.
REASON_LABELS: dict[str, str] = {
    "1a": "staff and appointments",
    "1b": "awards and honours",
    "1c": "labour relations",
    "1d": "security of City property",
    "1e": "land",
    "1f": "law enforcement",
    "1g": "lawsuits",
    "1h": "tribunal hearings",
    "1i": "legal advice",
    "1j": "confidential business information",
    "1k": "early talks on a City service",
    "1l": "annual report goals",
    "1m": "matters another law lets Council keep private",
    "1n": "whether to close a meeting",
    "1o": "who may attend a closed meeting",
    "2a": "freedom of information requests",
    "2b": "confidential talks with other governments",
    "2c": "Ombudsperson investigations",
    "2d": "matters another law requires to be private",
    "2e": "auditor general reviews",
}

# Statutory wording (or the old minutes' own summaries) → section letter. Used alongside the
# letters themselves because OCR often garbles "(k)" into "(10" or "I".
REASON_PHRASES: list[tuple[str, str]] = [
    (r"holds or is being considered for a position|personnel|appointments?\b", "1a"),
    (r"municipal award or honou?r|condition of anonymity", "1b"),
    (r"labou?r relations|employee relations", "1c"),
    (r"security of (?:the )?property", "1d"),
    (r"acquisition, disposition or expropriation|property dispos|land (?:negotiations|disposition|acquisition|matters)|\bland\b", "1e"),
    (r"law enforcement", "1f"),
    (r"\blitigation\b", "1g"),
    (r"administrative tribunal", "1h"),
    (r"solicitor.client privilege|legal advice", "1i"),
    (r"section 21 of the freedom of information", "1j"),
    (r"proposed provision of a municipal service|new service", "1k"),
    (r"annual (?:municipal )?report|section 98", "1l"),
    (r"provincial government or the federal government|negotiations between the municipality and a provincial", "2b"),
    (r"ombudsperson", "2c"),
]

_T = r"(\d{1,2})\s*[:.;]\s*(\d{2})\s*([ap])\.?\s*m\b\.?"
TIME = re.compile(_T, re.I)
CALLED = re.compile(r"(?:called|reconvened)\s+the\s+(?:[\w,]+\s+){0,6}?meeting\s+(?:to\s+order\s+)?at\s*" + _T, re.I)
ADJOURNED = re.compile(r"adjourn(?:ed)?\s+(?:the\s+(?:[\w-]+\s+){0,3}?meeting\s+)?at\s*" + _T, re.I)
TEMP_ADJOURN = re.compile(r"temporarily\s+adjourned", re.I)

# Anchors that mark a closing. Each needs nearby evidence (see _anchors) to count.
CLOSE_MEETING = re.compile(r"\bclose\s+(?:the|this)\s+(?:committee\s+)?meeting\b|\bbe\s+closed\s+to\s+the\s+public\b", re.I)
EXCLUDED = re.compile(r"\bbe\s+excluded\s+from\s+the\s+meeting\b|\bexclude\s+the\s+public\b", re.I)
CONTINUE_CLOSED = re.compile(r"continues?\s+the\s+meeting\s+in\s+closed\s+session|proceeded\s+in[\s-]?camera", re.I)
WENT_IN_CAMERA = re.compile(r"(?:went|moved|proceeded)\s+(?:in|into)\s*[\s-]?camera(?:\s+session)?\s+at\s*" + _T, re.I)
SECTION_90 = re.compile(r"\b90\s*\(\s*[12]|section\s+90\b|\b90\s*\(\s*[a-o]\s*\)", re.I)
RECONVENED = re.compile(
    r"(?:reconvened|resumed|returned\s+to\s+(?:the\s+)?open|rose\s+from\s+(?:the\s+)?(?:closed|in[\s-]?camera))"
    r"[^.]{0,60}?\bat\s*" + _T, re.I)
RISE_REPORT = re.compile(r"rise\s*(?:and|&)\s*report", re.I)
ADJOURN_HEADING = re.compile(r"\bADJOURNMENT\b")
MOTION = re.compile(r"\bMOVED\s+BY\b|\bTHAT\s+(?:Council|Committee)\b|\bThat\s+Council\b")

IN_CAMERA_TITLE = re.compile(r"in[\s\-‐]?camera|closed\s+meeting|exclud(?:e|ing)\s+the\s+public", re.I)
NOTICE_DOC = re.compile(r"\(\s*IN[\s-]?CAMERA\s*\)|NOTICE OF (?:SPECIAL )?(?:MEETING OF )?COUNCIL MEETING \(IN|In[\s-]Camera\s+(?:Council\s+)?Meeting|in camera portion of the meeting", re.I)

MAX_MEETING_MINUTES = 10 * 60


def normalise(text: str | None) -> str:
    text = (text or "").replace("‘", "'").replace("’", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", text)


def clock(h: str, m: str, ap: str) -> int:
    """Minutes since midnight for a 12-hour clock time."""
    hour = int(h) % 12 + (12 if ap.lower() == "p" else 0)
    return hour * 60 + int(m)


def fmt(minutes: int | None) -> str | None:
    if minutes is None:
        return None
    minutes %= 24 * 60
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def after(t: int | None, start: int | None) -> int | None:
    """Put clock time ``t`` on the meeting's timeline: past midnight, or a.m. typed for p.m.,
    lands after ``start`` (12-hour steps)."""
    if t is None or start is None:
        return t
    while t < start - 5:
        t += 12 * 60
    return t


def _first_time(match: re.Match) -> int | None:
    g = [x for x in match.groups() if x is not None]
    return clock(*g[:3]) if len(g) >= 3 else None


def reason_codes(text: str) -> list[str]:
    """Section 90 reasons named in a closing resolution or notice, e.g. ["1e", "1k"]."""
    codes: set[str] = set()
    for m in re.finditer(r"\b90\s*((?:[\s(),&]|and|\b[a-o]\b|\(\s*[12]\s*\)|\(\s*[a-o]\s*\)|[12]\b)+)", text, re.I):
        sub = "1"
        for tok in re.finditer(r"\(\s*([12])\s*\)|\(\s*([a-oA-O])\s*\)|\b([a-oA-O])\b|\b([12])\b", m.group(1)):
            num = tok.group(1) or tok.group(4)
            letter = tok.group(2) or tok.group(3)
            if num:
                sub = num
            elif letter:
                low = letter.lower()
                if letter == "I":  # OCR/typing: a lone capital I is (l) or (i); the wording decides below
                    continue
                if low == "a" and tok.group(3) and not tok.group(2):
                    # bare "a" is usually the article ("a, e and k" is rare); keep only in a list
                    if not re.search(r"\b[b-o]\b", m.group(1)):
                        continue
                if sub == "2" and low > "e":
                    continue
                codes.add(f"{sub}{low}")
    lower = text.lower()
    for pattern, code in REASON_PHRASES:
        if re.search(pattern, lower):
            codes.add(code)
    # "land" alone is weak: only trust it when no stronger reason was found.
    return sorted(c for c in codes if c in REASON_LABELS)


@dataclass
class Session:
    start: int  # text offset of the first anchor
    end: int  # text offset after the resolution
    closed_at: int | None = None
    reconvened_at: int | None = None
    reasons: list[str] = field(default_factory=list)
    source: str = "minutes"
    position: str | None = None  # "end" (adjourned after it), "middle" (reopened), None (unknown)

    def as_dict(self) -> dict:
        return {
            "closed_at": fmt(self.closed_at),
            "reconvened_at": fmt(self.reconvened_at),
            "reasons": self.reasons,
            "reason_labels": [REASON_LABELS[c] for c in self.reasons],
            "source": self.source,
            "position": self.position,
        }


def _anchors(text: str) -> list[tuple[int, int, int | None]]:
    """(start, end, stated close time) of every closing mention that has supporting evidence."""
    found = []
    for rx, need_s90 in ((CLOSE_MEETING, True), (EXCLUDED, True), (CONTINUE_CLOSED, False)):
        for m in rx.finditer(text):
            window = text[max(0, m.start() - 300): m.end() + 500]
            if need_s90 and not (SECTION_90.search(window) or re.search(r"in[\s-]?camera|closed session", window, re.I)):
                continue
            if RISE_REPORT.search(text[max(0, m.start() - 120): m.start()]):
                continue
            near = text[max(0, m.start() - 40): m.end() + 30]
            t = TIME.search(near)
            found.append((m.start(), m.end(), clock(*t.groups()) if t else None))
    for m in WENT_IN_CAMERA.finditer(text):
        found.append((m.start(), m.end(), _first_time(m)))
    return sorted(found)


def find_sessions(text: str) -> list[Session]:
    """Closing resolutions in one set of minutes, merged when they describe the same closing."""
    sessions: list[Session] = []
    for start, end, t in _anchors(text):
        if sessions and (start - sessions[-1].end < 1500 or not re.search(r"CARRIED|DEFEATED", text[sessions[-1].end:start])):
            s = sessions[-1]
            s.end = max(s.end, end)
            if s.closed_at is None and t is not None:
                s.closed_at = t
            continue
        sessions.append(Session(start=start, end=end, closed_at=t))
    for s in sessions:
        tail = text[s.end: s.end + 2500]
        adj = re.search(r"\bADJOURNMENT\b|\badjourn", tail, re.I)
        stop = re.search(r"CARRIED|DEFEATED", tail[: adj.start()] if adj else tail)
        if stop:
            s.end = s.end + stop.end()
        window = text[max(0, s.start - 400): s.end]
        s.reasons = reason_codes(window)
        went = WENT_IN_CAMERA.search(text, s.end, s.end + 300)
        if went:
            s.end = went.end()
            if s.closed_at is None:
                s.closed_at = _first_time(went)
    return sessions


def _adjournment(text: str) -> tuple[int | None, int | None]:
    """(time, offset) of the last real adjournment."""
    last = None
    for m in ADJOURNED.finditer(text):
        if TEMP_ADJOURN.search(text[max(0, m.start() - 30): m.end()]):
            continue
        last = m
    if not last:
        return None, None
    return _first_time(last), last.start()


def _business_between(text: str) -> bool:
    """True when ``text`` (between a closing and the adjournment) holds open business other
    than rising and reporting closed-meeting decisions."""
    rr = RISE_REPORT.search(text)
    if rr:
        text = text[: rr.start()]
    adj = ADJOURN_HEADING.search(text)
    if adj:
        text = text[: adj.start()]
    text = re.sub(r"THAT\s+Council\s+adjourn[^.]*", "", text, flags=re.I)
    return bool(MOTION.search(text)) and len(text) > 400


def _opens_with_closing(text: str, called_end: int, session_start: int) -> bool:
    """True when nothing but opening formalities (acknowledgement, conduct rules, approving
    the agenda) comes between the call to order and the closing."""
    seg = text[called_end:max(called_end, session_start)]
    # Drop the closing motion itself (its heading, "MOVED BY" and "THAT Council").
    head = list(re.finditer(r"in[\s-]?camera|closed\s+meeting|exclud", seg, re.I))
    if head and len(seg) - head[-1].start() < 400:
        seg = seg[: head[-1].start()]
    else:
        moved = list(re.finditer(r"MOVED\s+BY", seg))
        if moved and len(seg) - moved[-1].start() < 150:
            seg = seg[: moved[-1].start()]
    if len(seg) > 2500:
        return False
    for m in MOTION.finditer(seg):
        if not re.search(r"agenda", text[called_end + m.start(): called_end + m.start() + 250], re.I):
            return False
    return True


def place_sessions(text: str, sessions: list[Session]) -> int | None:
    """Set each session's position and reopening time. Returns the adjournment offset."""
    _, adj_pos = _adjournment(text)
    for i, s in enumerate(sessions):
        nxt = sessions[i + 1].start if i + 1 < len(sessions) else len(text)
        stop = min(nxt, adj_pos) if adj_pos is not None and adj_pos > s.end else nxt
        between = text[s.end: stop]
        rec = None
        for m in RECONVENED.finditer(between):
            if re.search(r"recess", between[max(0, m.start() - 250): m.start()], re.I):
                continue  # a break, not the end of the closed part
            rec = m
            break
        if rec is not None and _business_between(between[rec.end():]):
            s.reconvened_at = _first_time(rec)
            s.position = "middle"
        elif adj_pos is not None and adj_pos > s.end and not _business_between(between):
            s.position = "end"
        elif rec is not None:
            s.reconvened_at = _first_time(rec)
            s.position = "middle"
        else:
            s.position = None
    return adj_pos


def pick_minutes(docs: Iterable[dict]) -> str | None:
    """The best minutes text of a meeting: signed over draft, then longest."""
    cands = []
    for d in docs:
        title = (d.get("title") or "").lower()
        text = d.get("full_text") or ""
        if len(text) < 300:
            continue
        if d.get("category") != "Minutes" and "minutes" not in title and not re.search(r"\bsigned\b", title):
            continue
        if "agenda" in title:
            continue
        cands.append(("signed" in title, len(text), text))
    if not cands:
        return None
    return max(cands)[2]


def notice_texts(docs: Iterable[dict]) -> list[str]:
    """Notices of a separate in-camera council meeting posted with this meeting."""
    out = []
    for d in docs:
        title = d.get("title") or ""
        text = normalise(d.get("full_text"))
        if d.get("category") in ("Minutes", "Agenda") and "notice" not in title.lower():
            continue
        if NOTICE_DOC.search(text[:1500]) or re.search(r"\bIC\b|in.?camera", title, re.I):
            if re.search(r"in[\s-]?camera", text, re.I):
                out.append(text)
    return out


def _in_camera_item(items: Iterable[dict]) -> dict | None:
    for it in sorted(items, key=lambda i: (i.get("item_order") is None, str(i.get("item_order")))):
        title = it.get("title") or ""
        if IN_CAMERA_TITLE.search(title) and not RISE_REPORT.search(title) and "circuit" not in title.lower():
            return it
    return None


def analyse_meeting(meeting: dict, docs: list[dict], items: list[dict], motions: list[dict]) -> dict:
    """The ``meta.closed_session`` value for one meeting (sessions may be empty)."""
    year = int(str(meeting.get("meeting_date") or "0")[:4] or 0)
    raw = pick_minutes(docs)
    text = normalise(raw)
    sessions = find_sessions(text) if text else []
    adj_pos = place_sessions(text, sessions) if sessions else None

    called = CALLED.search(text) if text else None
    start = _first_time(called) if called else None
    adjourned, _ = _adjournment(text) if text else (None, None)
    adjourned = after(adjourned, start)
    for s in sessions:
        s.closed_at = after(s.closed_at, start)
        s.reconvened_at = after(s.reconvened_at, start)

    # No closing in the minutes text: the decision rows, then a separate in-camera notice,
    # then (no minutes at all) the agenda.
    if not sessions:
        for mo in motions:
            body = normalise(mo.get("text_content"))
            if CLOSE_MEETING.search(body) or EXCLUDED.search(body) or (SECTION_90.search(body) and re.search(r"close|exclud", body, re.I)):
                t = TIME.search(body[:200])
                sessions.append(Session(0, 0, closed_at=after(clock(*t.groups()), start) if t else None,
                                        reasons=reason_codes(body), source="decision"))
                break
    if not sessions:
        for notice in notice_texts(docs):
            sessions.append(Session(0, 0, reasons=reason_codes(notice), source="notice"))
            break
    if not sessions:
        it = _in_camera_item(items)
        if it:
            sessions.append(Session(0, 0, reasons=reason_codes(normalise(it.get("title"))), source="agenda"))

    result: dict[str, Any] = {
        "sessions": [s.as_dict() for s in sessions],
        "called_at": fmt(start),
        "adjourned_at": fmt(adjourned),
        "est_closed_minutes": None,
        "open_minutes": None,
        "method": "none",
        "confidence": "none",
        "version": CLOSED_SESSIONS_VERSION,
    }
    if not sessions:
        if text and start is not None and adjourned is not None and 0 < adjourned - start <= MAX_MEETING_MINUTES:
            # Minutes with no closing: the whole meeting was open (a known 0, not a guess).
            result.update(est_closed_minutes=0, open_minutes=adjourned - start, method="minutes",
                          confidence="high" if year >= 2021 else "low")
        return result

    # Fallback close time for a closing at the end: the video stops when the room is cleared.
    item = _in_camera_item(items)
    total_closed = 0
    methods: set[str] = set()
    for s in sessions:
        if s.position == "end" and s.closed_at is None and start is not None:
            if s.source == "minutes" and called and _opens_with_closing(text, called.end(), s.start):
                # Closed straight after opening: Langford's minutes show 1-2 minutes when timed.
                s.closed_at = start + 1
                methods.add("opening")
            elif meeting.get("video_duration_seconds"):
                s.closed_at = start + round(meeting["video_duration_seconds"] / 60)
                methods.add("video")
            elif item and (item.get("discussion_start_time") or item.get("discussion_end_time")):
                offset = item.get("discussion_end_time") or item.get("discussion_start_time")
                s.closed_at = start + round(float(offset) / 60)
                methods.add("transcript")
        if s.position == "end" and s.closed_at is not None and adjourned is not None:
            dur = adjourned - s.closed_at
        elif s.position == "middle" and s.closed_at is not None and s.reconvened_at is not None:
            dur = s.reconvened_at - s.closed_at
        else:
            dur = None
        if dur is None or dur < 0 or dur > MAX_MEETING_MINUTES or (start is not None and s.closed_at is not None and s.closed_at < start - 5):
            total_closed = None
            break
        total_closed += dur
        methods.add("minutes")
    result["sessions"] = [s.as_dict() for s in sessions]
    if total_closed is None:
        return result

    if start is not None and adjourned is not None:
        span = adjourned - start
        open_minutes = span - total_closed
        if span <= 0 or span > MAX_MEETING_MINUTES or open_minutes < 0:
            return result
        result["open_minutes"] = open_minutes
    result["est_closed_minutes"] = total_closed
    result["method"] = next((m for m in ("video", "transcript", "opening") if m in methods), "minutes")
    if year and year < 2021:
        result["confidence"] = "low"
    else:
        result["confidence"] = "high" if result["method"] in ("minutes", "opening") else "medium"
    return result


# ── database ─────────────────────────────────────────────────────────────

MEETING_SELECT = "id, meeting_date, type, status, video_duration_seconds, stamp:meta->closed_session->>version"


def load_inputs(supabase, meeting_id: int) -> tuple[list[dict], list[dict], list[dict]]:
    """(documents, agenda items, motions) of one meeting, as ``analyse_meeting`` wants them."""
    docs = (supabase.table("documents").select("title, category, full_text")
            .eq("meeting_id", meeting_id).execute().data or [])
    items = (supabase.table("agenda_items")
             .select("title, item_order, discussion_start_time, discussion_end_time")
             .eq("meeting_id", meeting_id).execute().data or [])
    motions = (supabase.table("motions").select("text_content")
               .eq("meeting_id", meeting_id).execute().data or [])
    return docs, items, motions


def save(meeting_id: int, value: dict, conn: Any = None) -> None:
    """Replace only ``meta.closed_session`` (through ``db.run_write``)."""
    from pipeline.video.posters import save_meta_key

    save_meta_key(meeting_id, "closed_session", value, conn)


def describe(value: dict) -> str:
    """One log line per meeting."""
    if not value["sessions"]:
        return "no closed session"
    reasons = sorted({c for s in value["sessions"] for c in s["reasons"]})
    mins = value["est_closed_minutes"]
    return (f"{len(value['sessions'])} closed session(s) [{', '.join(reasons) or 'reason not stated'}], "
            f"~{mins if mins is not None else '?'} min ({value['method']}, {value['confidence']})")


def run(supabase, meetings: list[dict], *, dry_run: bool = False) -> dict:
    """Analyse each meeting row (``MEETING_SELECT``) and write the result unless ``dry_run``."""
    written = closed = timed = 0
    for m in meetings:
        if (m.get("status") or "") in ("Planned", "Cancelled"):
            continue
        docs, items, motions = load_inputs(supabase, m["id"])
        value = analyse_meeting(m, docs, items, motions)
        if value["sessions"]:
            closed += 1
            timed += value["est_closed_minutes"] is not None
        print(f"  [Closed] {m['meeting_date']} meeting {m['id']}: {describe(value)}")
        if not dry_run:
            save(m["id"], value)
            written += 1
    return {"meetings": len(meetings), "with_closed_session": closed, "timed": timed, "written": written}
