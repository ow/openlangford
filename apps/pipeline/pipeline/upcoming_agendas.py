"""Agenda watch: get a scheduled meeting's agenda into the database before the meeting happens.

`main.py --upcoming-agendas` (and the launchd agenda watch) runs this. It reads the eSCRIBE calendar from
LOOKBACK_DAYS ago to LOOKAHEAD_DAYS ahead, and for each meeting on or after today whose agenda is posted:

* downloads only the agenda (no minutes, video, audio or attachments) into the meeting's archive folder;
* ingests it with the normal phase-4 ingest (`Archiver._ingest_meetings`, target mode): AI refine, topic matching,
  geocoding. A Planned meeting gets agenda items but no motions, votes or attendance;
* embeds the new rows.

Choosing what to do (`decide`) is kept apart from the database and network reads (`load_held`) so it can be tested.

Idempotency. A meeting is skipped ("unchanged") when the public meeting it belongs to already holds this agenda:
`meetings.agenda_url` equals the posted agenda link and it has agenda items, and the local copy (when present)
still has the `documents.file_hash` recorded for it. eSCRIBE posts a revised agenda under a new DocumentId, so a new
link means a revised agenda ("revised"): the old local copy is set aside and the meeting is re-ingested with
forced refinement, which updates the same agenda_items rows (matched by item number/title in the ingester).

Calendar rows. The web app's calendar sync creates "Planned" meetings with no archive folder and links each to its
eSCRIBE meeting ID in source_meetings (`ingested_meeting_id`). Recording the discovered meeting's folder on that same
source_meetings row (upsert on municipality/source type/source ID) lets the ingester's `find_scheduled_meeting`
update that meeting instead of inserting a second one; a meeting known only from the annual schedule is linked by
the `reconcile_calendar_source` RPC (same date, type and body).

Past meetings in the lookback window are reported but not ingested here: once the date has passed the ingester
treats the meeting as held and expects official minutes, which the full run (or the archive worker) brings.
"""

from __future__ import annotations

import dataclasses
import glob
import hashlib
import os
from datetime import date, datetime
from zoneinfo import ZoneInfo

from pipeline.ops import source_document_status
from pipeline.scrapers.base import ScrapedMeeting

LOOKBACK_DAYS = 14
LOOKAHEAD_DAYS = 60
DEFAULT_TIMEZONE = "America/Vancouver"

# Actions that download and ingest.
INGEST_ACTIONS = ("ingest", "revised")
# Tables the agenda ingest writes rows to that carry embeddings.
EMBED_TABLES = ["agenda_items", "matters", "meetings", "documents", "document_sections"]


@dataclasses.dataclass
class Held:
    """What the database holds for one discovered meeting."""

    meeting: dict | None = None  # meetings row: id, status, has_agenda, agenda_url, archive_path, ...
    via: str | None = None  # how it was found: "source link", "archive path", "calendar match"
    item_count: int = 0
    document_hashes: dict = dataclasses.field(default_factory=dict)  # documents.file_path -> file_hash


@dataclasses.dataclass
class Decision:
    meeting: ScrapedMeeting
    action: str  # ingest | revised | unchanged | no_agenda | cancelled | past | blocked
    reason: str
    agenda_url: str | None = None
    meeting_id: int | None = None  # the public meeting the agenda goes to; None means a new meeting
    archive_root: str | None = None


def civic_today(timezone: str = DEFAULT_TIMEZONE) -> date:
    return datetime.now(ZoneInfo(timezone)).date()


def _agenda_links(meeting: ScrapedMeeting) -> list[dict]:
    from pipeline.scrapers.escribe import EscribeScraper

    raw = (meeting.meta or {}).get("escribe_meeting") or {}
    return [link for link in raw.get("MeetingLinks") or []
            if EscribeScraper._document_category(link) == "Agenda" and link.get("Type") == "Agenda"]


def agenda_link(meeting: ScrapedMeeting, base_url: str = "") -> str | None:
    """The posted agenda: the PDF link, else the official HTML agenda. The cover page doesn't count."""
    if meeting.agenda_url:
        return meeting.agenda_url
    return next(iter(_html_agenda_links(meeting, base_url)), None)


def _html_agenda_links(meeting: ScrapedMeeting, base_url: str = "") -> list[str]:
    from urllib.parse import urljoin

    return [urljoin(f"{base_url.rstrip('/')}/", link["Url"]) if base_url else link["Url"]
            for link in _agenda_links(meeting)
            if (link.get("Format") or "").lower() == "html" and link.get("Url")]


def same_agenda(meeting: ScrapedMeeting, stored_url: str | None, base_url: str = "") -> bool:
    """Is ``stored_url`` (meetings.agenda_url) this posted agenda? The current PDF link, or the official HTML
    page of the same agenda (the ingester stores that link when the PDF was unavailable). eSCRIBE posts a revised
    agenda as a new PDF DocumentId, so another PDF link means a revision."""
    if not stored_url:
        return False
    return stored_url == agenda_link(meeting, base_url) or stored_url in _html_agenda_links(meeting, base_url)


def agenda_only(meeting: ScrapedMeeting) -> ScrapedMeeting:
    """The meeting with only its agenda documents: no minutes, video or other attachments to download."""
    raw = dict((meeting.meta or {}).get("escribe_meeting") or {})
    if raw:
        raw["MeetingLinks"] = _agenda_links(meeting)
    return dataclasses.replace(
        meeting,
        documents=[d for d in meeting.documents if d.category == "Agenda"],
        minutes_url=None,
        video_url=None,
        meta={**(meeting.meta or {}), "escribe_meeting": raw} if raw else dict(meeting.meta or {}),
    )


def local_agenda(folder: str | None, url: str | None) -> dict:
    """Local agenda copies downloaded from ``url``: {"Agenda/<file>": sha256}."""
    if not folder or not url:
        return {}
    found = {}
    agenda_dir = glob.escape(os.path.join(folder, "Agenda"))
    for path in sorted(glob.glob(os.path.join(agenda_dir, "*.pdf")) + glob.glob(os.path.join(agenda_dir, "*.html"))):
        if _sidecar_url(path) != url:
            continue
        with open(path, "rb") as handle:
            found[os.path.join("Agenda", os.path.basename(path))] = hashlib.sha256(handle.read()).hexdigest()
    return found


def _sidecar_url(path: str) -> str | None:
    try:
        with open(f"{path}.url", encoding="utf-8") as handle:
            return handle.read().strip() or None
    except OSError:
        return None


def set_aside_superseded_agenda(folder: str, url: str) -> list[str]:
    """Rename local agenda copies that came from another link (a superseded agenda) so the revised one is
    downloaded and the ingester reads only it. Names end ``.superseded-<sha12>``, which no ingest glob matches."""
    moved = []
    agenda_dir = glob.escape(os.path.join(folder, "Agenda"))
    for path in glob.glob(os.path.join(agenda_dir, "*.pdf")) + glob.glob(os.path.join(agenda_dir, "*.html")):
        previous = _sidecar_url(path)
        if previous is None or previous == url:
            continue
        with open(path, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()[:12]
        target = f"{path}.superseded-{digest}"
        os.replace(path, target)
        for suffix in (".url", ".sha256"):
            if os.path.exists(path + suffix):
                os.replace(path + suffix, target + suffix)
        moved.append(target)
    for cache in ("agenda.md",):
        # The ingester re-reads the agenda with skip_cache on a forced refine; drop the cache anyway so a
        # later unforced run can't read the old text back.
        cached = os.path.join(folder, cache)
        if moved and os.path.exists(cached):
            os.remove(cached)
    return moved


def decide(meeting: ScrapedMeeting, *, today: date, held: Held, plan_entry: dict | None = None,
           local_hashes: dict | None = None, base_url: str = "") -> Decision:
    """What the agenda watch does with one discovered meeting. No I/O."""
    plan_entry = plan_entry or {}
    url = agenda_link(meeting, base_url)
    row = held.meeting or {}

    def made(action, reason):
        return Decision(meeting, action, reason, agenda_url=url, meeting_id=row.get("id"),
                        archive_root=plan_entry.get("archive_root"))

    if meeting.date < today:
        return made("past", "meeting date has passed; the full run ingests it with its minutes and video")
    if row.get("status") == "Cancelled":
        return made("cancelled", f"meeting {row['id']} is cancelled")
    if not url:
        status = source_document_status(meeting, "scheduled")
        if status in ("cancelled", "postponed"):
            notice = {"cancelled": "cancellation", "postponed": "postponement"}[status]
            return made("cancelled", f"the City lists only a {notice} notice")
        return made("no_agenda", "no agenda posted yet")
    if plan_entry.get("action") == "blocked":
        return made("blocked", f"already hold meeting(s) {plan_entry.get('conflicts')} without this eSCRIBE ID; "
                               "link it before ingesting")

    has_items = bool(row) and held.item_count > 0
    if has_items and row.get("has_agenda") and same_agenda(meeting, row.get("agenda_url"), base_url):
        stale = {path: digest for path, digest in (local_hashes or {}).items()
                 if held.document_hashes.get(path) not in (None, digest)}
        if stale:
            return made("revised", f"local agenda differs from the stored copy ({', '.join(sorted(stale))})")
        return made("unchanged", f"meeting {row['id']} already has this agenda ({held.item_count} items)")
    if has_items:
        return made("revised", f"agenda link changed (was {row.get('agenda_url') or 'none'}); "
                               f"refreshing {held.item_count} items")
    if row:
        how = {"source link": "calendar meeting", "calendar match": "calendar meeting (linked at ingest)"}.get(
            held.via, "meeting")
        return made("ingest", f"add agenda items to {how} {row['id']} ({row.get('status') or 'no status'})")
    return made("ingest", "new meeting")


def load_held(supabase, municipality_id: int, meetings: list[ScrapedMeeting],
              archive_paths: dict[str, str]) -> dict[str, Held]:
    """source_id -> what the database holds for it. Read-only.

    ``archive_paths`` maps source_id -> the folder the meeting would be archived in, relative to the repo
    (the form stored in meetings.archive_path).
    """
    held = {m.source_id: Held() for m in meetings if m.source_id}
    if not held:
        return {}
    ids = list(held)
    columns = "id,status,has_agenda,agenda_url,archive_path,calendar_source_id,meeting_date,type,title"

    linked = {}
    for start in range(0, len(ids), 100):
        for row in (supabase.table("source_meetings").select("source_id,ingested_meeting_id")
                    .eq("municipality_id", municipality_id).eq("source_type", "escribe")
                    .in_("source_id", ids[start:start + 100]).execute().data or []):
            if row.get("ingested_meeting_id"):
                linked[row["source_id"]] = row["ingested_meeting_id"]
    if linked:
        rows = (supabase.table("meetings").select(columns).eq("municipality_id", municipality_id)
                .in_("id", sorted(set(linked.values()))).execute().data or [])
        by_id = {row["id"]: row for row in rows}
        for source_id, meeting_id in linked.items():
            if meeting_id in by_id:
                held[source_id].meeting, held[source_id].via = by_id[meeting_id], "source link"

    paths = {archive_paths[s]: s for s, h in held.items() if h.meeting is None and archive_paths.get(s)}
    path_list = sorted(paths)
    for start in range(0, len(path_list), 20):
        for row in (supabase.table("meetings").select(columns).eq("municipality_id", municipality_id)
                    .in_("archive_path", path_list[start:start + 20]).execute().data or []):
            held[paths[row["archive_path"]]].meeting, held[paths[row["archive_path"]]].via = row, "archive path"

    # A calendar meeting not yet linked to this eSCRIBE ID: the ingester links it through the
    # reconcile_calendar_source RPC. Reported here only when exactly one matches, as that RPC requires.
    by_source = {m.source_id: m for m in meetings if m.source_id}
    unmatched = [s for s, h in held.items() if h.meeting is None]
    dates = sorted({by_source[s].date.isoformat() for s in unmatched})
    if dates:
        rows = (supabase.table("meetings").select(columns).eq("municipality_id", municipality_id)
                .in_("meeting_date", dates).is_("archive_path", "null")
                .not_.is_("calendar_source_id", "null").execute().data or [])
        claimed = set(linked.values())
        candidate_ids = [row["id"] for row in rows]
        for start in range(0, len(candidate_ids), 100):
            # The RPC never takes a calendar meeting another eSCRIBE meeting already owns.
            for alias in (supabase.table("source_meetings").select("ingested_meeting_id")
                          .eq("source_type", "escribe")
                          .in_("ingested_meeting_id", candidate_ids[start:start + 100]).execute().data or []):
                claimed.add(alias["ingested_meeting_id"])
        for source_id in unmatched:
            meeting = by_source[source_id]
            matches = [row for row in rows if row["meeting_date"] == meeting.date.isoformat()
                       and row.get("type") == meeting.meeting_type and row["id"] not in claimed]
            if len(matches) == 1:
                held[source_id].meeting, held[source_id].via = matches[0], "calendar match"

    meeting_ids = sorted({h.meeting["id"] for h in held.values() if h.meeting})
    counts: dict[int, int] = {}
    hashes: dict[int, dict] = {}
    for start in range(0, len(meeting_ids), 50):
        chunk = meeting_ids[start:start + 50]
        for row in supabase.table("agenda_items").select("meeting_id").in_("meeting_id", chunk).execute().data or []:
            counts[row["meeting_id"]] = counts.get(row["meeting_id"], 0) + 1
        for row in (supabase.table("documents").select("meeting_id,file_path,file_hash")
                    .in_("meeting_id", chunk).execute().data or []):
            if (row.get("file_path") or "").startswith("Agenda"):
                hashes.setdefault(row["meeting_id"], {})[row["file_path"]] = row.get("file_hash")
    for h in held.values():
        if h.meeting:
            h.item_count = counts.get(h.meeting["id"], 0)
            h.document_hashes = hashes.get(h.meeting["id"], {})
    return held


def describe(decision: Decision) -> str:
    m = decision.meeting
    target = f"meeting {decision.meeting_id}" if decision.meeting_id else "new meeting"
    line = f"  {decision.action:<9} {m.date} {m.title} [{(m.source_id or '')[:8]}] -> {target}: {decision.reason}"
    if decision.agenda_url and decision.action in INGEST_ACTIONS + ("unchanged",):
        line += f"\n            agenda: {decision.agenda_url}"
    return line
