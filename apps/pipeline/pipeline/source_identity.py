"""Source identity for discovery and media sync: match by eSCRIBE meeting ID, never by date alone.

Three guarantees used by the orchestrator, the worker and the update detector:

* A discovered meeting whose ID is already linked (source_meetings.ingested_meeting_id) syncs into the
  linked folder. If that folder came from another source (a Glyphdex import, ``[gx-…]``), only missing
  official categories are filled in, so the folder never gains a second agenda or minutes copy.
* An unlinked discovered meeting is blocked (no folder, no archive_path) when we already hold an unlinked
  meeting of the same body, kind and date: that meeting needs its eSCRIBE ID recorded first.
* Video goes to a folder only when the folder's own eSCRIBE ID (folder suffix, Video/player.url or the
  source inventory) names it; an ID-less folder takes an eSCRIBE video only if nothing else on that day
  claims it and it is the same body.
"""

from __future__ import annotations

import dataclasses
import glob
import os
import re
from collections import defaultdict

from pipeline import utils
from pipeline.scrapers.escribe_bodies import escribe_body

GUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
_SUFFIX = re.compile(r"\[([0-9a-f]{8})\]\s*$", re.IGNORECASE)
OFFICIAL_CATEGORIES = ("Agenda", "Minutes")


# --- folders -------------------------------------------------------------------------------------


def is_foreign_folder(folder: str, source_id: str | None) -> bool:
    """True when ``folder`` was not created for this eSCRIBE meeting (e.g. a ``[gx-…]`` import)."""
    if not source_id:
        return False
    return not os.path.basename(folder.rstrip(os.sep)).lower().endswith(f"[{source_id[:8].lower()}]")


def _category_files(folder: str, category: str) -> list[str]:
    base = glob.escape(os.path.join(folder, category))
    return sorted(glob.glob(os.path.join(base, "*.pdf")) + glob.glob(os.path.join(base, "*.html")))


def gap_fill_documents(meeting, folder: str):
    """(meeting limited to official categories the folder lacks, files already present for the rest)."""
    present = {c: _category_files(folder, c) for c in OFFICIAL_CATEGORIES}
    missing = {c for c, files in present.items() if not files}
    documents = [d for d in meeting.documents if d.category in missing]
    meta = dict(meeting.meta or {})
    raw = meta.get("escribe_meeting")
    if isinstance(raw, dict):
        from pipeline.scrapers.escribe import EscribeScraper

        links = [l for l in raw.get("MeetingLinks") or [] if EscribeScraper._document_category(l) in missing]
        meta["escribe_meeting"] = {**raw, "MeetingLinks": links}
    existing = [path for c, files in present.items() if files for path in files]
    return dataclasses.replace(meeting, documents=documents, meta=meta), existing


def folder_source_ids(folder: str, known: dict[str, set[str]] | None = None) -> set[str]:
    """eSCRIBE IDs (full GUIDs or 8-char prefixes, lower case) that identify an archive folder."""
    ids: set[str] = set()
    match = _SUFFIX.search(os.path.basename(folder.rstrip(os.sep)))
    if match:
        ids.add(match.group(1).lower())
    player = os.path.join(folder, "Video", "player.url")
    if os.path.exists(player):
        with open(player, encoding="utf-8") as handle:
            ids.update(g.lower() for g in GUID.findall(handle.read()))
    if known:
        ids.update(i.lower() for i in known.get(os.path.normpath(folder), set()))
    return ids


def _video_id(video: dict) -> str | None:
    uri = str(video.get("uri") or "")
    match = GUID.search(uri)
    return match.group(0).lower() if match else None


def _id_matches(video_id: str, ids: set[str]) -> bool:
    return any(video_id == i or video_id.startswith(i) for i in ids)


def _same_body(folder_name: str, video_title: str) -> bool:
    folder_body, video_body = escribe_body(folder_name), escribe_body(video_title)
    if folder_body or video_body:
        return bool(folder_body and video_body and folder_body == video_body)
    return utils.infer_meeting_type(folder_name) == utils.infer_meeting_type(video_title)


def select_video(folder: str, videos: list[dict], folder_ids: set[str], claimed: set[str]) -> dict | None:
    """The one video for this folder, or None. ``claimed`` = video IDs some other folder identifies."""
    if folder_ids:
        hits = [v for v in videos if _video_id(v) and _id_matches(_video_id(v), folder_ids)]
        return hits[0] if len(hits) == 1 else None
    if any(_video_id(v) for v in videos):
        # ID-bearing source but an ID-less folder: never take a video another folder owns or a
        # different body's recording held the same day.
        name = os.path.basename(folder.rstrip(os.sep))
        free = [v for v in videos if not (_video_id(v) and _id_matches(_video_id(v), claimed))]
        same = [v for v in free if _same_body(name, v.get("title") or "")]
        return same[0] if len(same) == 1 else None
    return legacy_title_match(os.path.basename(folder.rstrip(os.sep)), videos)


def legacy_title_match(folder_name: str, videos: list[dict]) -> dict | None:
    """Keyword matching for sources without meeting IDs (Vimeo)."""
    if len(videos) == 1:
        return videos[0]
    folder_lower = folder_name.lower()
    if "public hearing" in folder_lower:
        return next((v for v in videos if "public hearing" in v["title"].lower()), None)
    if "committee of the whole" in folder_lower or "cow" in folder_lower:
        return next((v for v in videos if "committee of the whole" in v["title"].lower()
                     or "cow" in v["title"].lower()), None)
    if "council" in folder_lower:
        return next((v for v in videos if "council" in v["title"].lower()
                     and "public hearing" not in v["title"].lower()), None) or next(
            (v for v in videos if "council" in v["title"].lower()), None)
    return None


def known_folder_ids(supabase, municipality_id: int, base_dir: str) -> dict[str, set[str]]:
    """Absolute archive folder -> eSCRIBE IDs recorded for it in source_meetings."""
    known: dict[str, set[str]] = defaultdict(set)
    start = 0
    while True:
        rows = (supabase.table("source_meetings").select("source_id,archive_path")
                .eq("municipality_id", municipality_id).eq("source_type", "escribe")
                .not_.is_("archive_path", "null").range(start, start + 999).execute().data or [])
        for row in rows:
            path = row["archive_path"]
            folder = path if os.path.isabs(path) else os.path.join(base_dir, path)
            known[os.path.normpath(folder)].add(row["source_id"].lower())
        if len(rows) < 1000:
            return known
        start += 1000


def source_body(supabase, municipality_id: int, archive_path: str):
    """EscribeBody of the eSCRIBE meeting(s) recorded for an archive folder, if they agree on one."""
    try:
        rows = (supabase.table("source_meetings").select("title,raw")
                .eq("municipality_id", municipality_id).eq("source_type", "escribe")
                .eq("archive_path", archive_path).execute().data or [])
    except Exception:
        return None
    if not isinstance(rows, list):
        return None
    bodies = {escribe_body(((row.get("raw") or {}).get("escribe_meeting") or {}).get("MeetingType")
                           or row.get("title")) for row in rows}
    return next(iter(bodies)) if len(bodies) == 1 else None


# --- duplicate guard -----------------------------------------------------------------------------


def _scraped_body(meeting) -> tuple[str, str | None, bool | None]:
    raw = (meeting.meta or {}).get("escribe_meeting") or {}
    body = escribe_body(raw.get("MeetingType") or meeting.title)
    if body:
        return body.name, body.meeting_type, body.special
    return "Council", meeting.meeting_type or utils.infer_meeting_type(meeting.title), None


def same_body(meeting, row: dict) -> bool:
    """Could DB meeting ``row`` (with ``organization.name``) be the same meeting as scraped ``meeting``?

    Deliberately generous: a false positive only blocks a folder for review, a false negative
    creates a duplicate.
    """
    name, meeting_type, special = _scraped_body(meeting)
    org = ((row.get("organization") or {}).get("name") or "")
    title = row.get("title") or ""
    if special is None:  # Council family: same organization and kind
        return org == "Council" and escribe_body(title) is None and row.get("type") == meeting_type
    row_body = escribe_body(title) or escribe_body(org)
    if row_body:
        return row_body.name == name and row_body.special == special
    # Generic buckets ("Advisory Committee" org/title) may hold any committee of that kind.
    return row.get("type") == meeting_type


class DuplicateGuard:
    """Finds meetings we already hold that an unlinked discovered meeting would duplicate."""

    def __init__(self, supabase, municipality_id: int):
        self.supabase = supabase
        self.municipality_id = municipality_id
        self.by_date: dict[str, list[dict]] = {}
        self.linked: dict[int, set[str]] = defaultdict(set)

    def load(self, dates) -> "DuplicateGuard":
        dates = sorted({d for d in dates if d} - set(self.by_date))
        for start in range(0, len(dates), 50):
            chunk = dates[start:start + 50]
            rows = (self.supabase.table("meetings")
                    .select("id,meeting_date,title,type,archive_path,organization:organizations(name)")
                    .eq("municipality_id", self.municipality_id).in_("meeting_date", chunk)
                    .not_.is_("archive_path", "null").execute().data or [])
            for day in chunk:
                self.by_date[day] = []
            for row in rows:
                self.by_date[row["meeting_date"]].append(row)
            ids = [row["id"] for row in rows]
            for i in range(0, len(ids), 100):
                for link in (self.supabase.table("source_meetings").select("source_id,ingested_meeting_id")
                             .eq("municipality_id", self.municipality_id).eq("source_type", "escribe")
                             .in_("ingested_meeting_id", ids[i:i + 100]).execute().data or []):
                    self.linked[link["ingested_meeting_id"]].add(link["source_id"].lower())
        return self

    def conflicts(self, meeting) -> list[dict]:
        source_id = (meeting.source_id or "").lower()
        return [row for row in self.by_date.get(meeting.date.isoformat(), [])
                if not (self.linked.get(row["id"], set()) - {source_id})
                and same_body(meeting, row)]
