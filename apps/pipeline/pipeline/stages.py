"""Registry of post-ingest and enrichment stages.

Every stage that runs after a meeting is ingested (or as a backfill) is
declared once in ``STAGES``, in execution order. The orchestrator runs the
``post_ingest`` stages from here after ingestion; ``main.py --stage <name>``
runs any one of them on demand and ``main.py --stages`` lists them.

Each stage takes a ``StageContext`` and picks its own targets:

- ``meeting_ids``: post-ingest run, only what those meetings touched
- ``target``: one id (a meeting, matter or person id, depending on scope)
- ``since``: a date lower bound for backfills
- ``stale``: only items whose version stamp is older than ``stage.version``
- ``dry_run``: print the selection; no model calls and no writes
  (agenda-alignment computes its proposal, which is free, and prints it)

Version stamps live next to what a stage writes (``matters.meta.summary_version``,
``matters.meta.images_version``, ``agenda_items.meta.participation_version``,
``motions.meta.headline_version``, ``properties.meta.summary_version``,
``agenda_items.meta.participation_links_version``);
bump the module's ``*_VERSION`` constant when a prompt changes, then run
``--stage <name> --stale``.
"""

from __future__ import annotations

import json

import os
import re
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Callable, Iterable, Literal

from pipeline.ai.usage import usage_context
from pipeline.ingestion.closed_sessions import CLOSED_SESSIONS_VERSION
from pipeline.ingestion.matter_images import IMAGES_VERSION
from pipeline.ingestion.matter_summaries import SUMMARY_VERSION
from pipeline.ingestion.meeting_highlights import HIGHLIGHTS_VERSION
from pipeline.ingestion.motion_headlines import HEADLINE_VERSION
from pipeline.ingestion.participation_minutes import MINUTES_VERSION as MINUTES_PARTICIPATION_VERSION
from pipeline.ingestion.participation_person_links import LINKS_VERSION as PARTICIPATION_LINKS_VERSION
from pipeline.ingestion.participation_summaries import PARTICIPATION_VERSION
from pipeline.ingestion.property_summaries import PROPERTY_SUMMARY_VERSION
from pipeline.ingestion.speaker_identity import IDENTITY_VERSION as SPEAKER_IDENTITY_VERSION
from pipeline.video.posters import POSTER_VERSION
from pipeline.video.share_cards import CARD_VERSION as SHARE_CARD_VERSION, TITLE_CARD_VERSION

When = Literal["post_ingest", "backfill_only"]
Scope = Literal["meeting", "matter", "global"]


# ── context ──────────────────────────────────────────────────────────────


@dataclass
class StageContext:
    supabase: Any
    meeting_ids: list[int] | None = None
    target: str | None = None
    since: str | None = None
    dry_run: bool = False
    stale: bool = False
    force: bool = False
    archiver: Any = None
    options: dict = field(default_factory=dict)
    cache: dict = field(default_factory=dict)

    @property
    def post_ingest(self) -> bool:
        return self.meeting_ids is not None

    def target_id(self) -> int | None:
        return int(self.target) if self.target not in (None, "") else None

    def matters_for_meetings(self) -> list[int]:
        """Matters touched by ``meeting_ids`` (cached so later stages share one query)."""
        if "matter_ids" not in self.cache:
            from pipeline.ingestion.matter_summaries import matters_for_meetings

            self.cache["matter_ids"] = matters_for_meetings(self.supabase, self.meeting_ids) if self.meeting_ids else []
        return self.cache["matter_ids"]

    def meetings(self) -> list[dict]:
        if "meetings" not in self.cache:
            if not self.meeting_ids:
                self.cache["meetings"] = []
            else:
                self.cache["meetings"] = (
                    self.supabase.table("meetings")
                    .select("id, meeting_date, archive_path, agenda_url")
                    .in_("id", self.meeting_ids)
                    .execute()
                    .data
                    or []
                )
        return self.cache["meetings"]


@dataclass(frozen=True)
class Stage:
    name: str
    description: str
    run: Callable[[StageContext], Any]
    when: When
    scope: Scope
    version: str
    depends_on: tuple[str, ...] = ()
    # Returns target ids whose stamp is older than ``version`` (enables --stale).
    stale: Callable[[StageContext], list[int]] | None = None


class StageError(ValueError):
    pass


# ── version stamps ───────────────────────────────────────────────────────


def _version_key(v: str) -> tuple:
    return tuple(int(p) if p.isdigit() else p for p in re.split(r"[.\-]", str(v)) if p != "")


def is_stale(stamp: Any, current: str) -> bool:
    """True when ``stamp`` is missing or older than ``current`` ("2" > "1.9", "1.10" > "1.9")."""
    if stamp in (None, ""):
        return True
    try:
        return _version_key(str(stamp)) < _version_key(current)
    except TypeError:  # mixed numeric/text parts: fall back to inequality
        return str(stamp) != current


def select_stale(rows: Iterable[dict], stamp_key: str, current: str) -> list[int]:
    return sorted(r["id"] for r in rows if is_stale(r.get(stamp_key), current))


def _paginate(build: Callable[[], Any], page: int = 1000) -> list[dict]:
    rows: list[dict] = []
    start = 0
    while True:
        chunk = build().range(start, start + page - 1).execute().data or []
        rows.extend(chunk)
        if len(chunk) < page:
            return rows
        start += page


def _matter_stamps(ctx: StageContext, key: str) -> list[dict]:
    def q():
        query = (
            ctx.supabase.table("matters")
            .select(f"id, stamp:meta->>{key}")
            .is_("meta->>canonical_matter_id", "null")
            .order("id")
        )
        if ctx.since:
            query = query.gte("last_seen", ctx.since)
        return query

    return [{"id": r["id"], key: r.get("stamp")} for r in _paginate(q)]


def stale_matter_summaries(ctx: StageContext) -> list[int]:
    return select_stale(_matter_stamps(ctx, "summary_version"), "summary_version", SUMMARY_VERSION)


def stale_matter_images(ctx: StageContext) -> list[int]:
    return select_stale(_matter_stamps(ctx, "images_version"), "images_version", IMAGES_VERSION)


PARTICIPATION_ILIKE = ",".join(
    f"title.ilike.*{p}*" for p in ("public participation", "delegation", "public input", "question period", "public hearing")
)


def participation_items(ctx: StageContext, meeting_ids: list[int] | None = None) -> list[dict]:
    """Public participation / delegation items (with stamp), optionally limited to meetings or a date."""
    from pipeline.ingestion.participation_summaries import PARTICIPATION_TITLE

    select = ("id, meeting_id, title, discussion_start_time, stamp:meta->>participation_version, "
              "has_summary:meta->participation->>overview")
    if ctx.since:
        select += ", meetings!inner(meeting_date)"

    def q():
        query = ctx.supabase.table("agenda_items").select(select).or_(PARTICIPATION_ILIKE).order("id")
        if meeting_ids is not None:
            query = query.in_("meeting_id", meeting_ids)
        if ctx.since:
            query = query.gte("meetings.meeting_date", ctx.since)
        return query

    if meeting_ids is not None and not meeting_ids:
        return []
    rows = _paginate(q)
    return [
        {"id": r["id"], "meeting_id": r["meeting_id"], "participation_version": r.get("stamp"),
         "has_summary": bool(r.get("has_summary")), "has_times": r.get("discussion_start_time") is not None}
        for r in rows
        if PARTICIPATION_TITLE.search(r.get("title") or "")
    ]


def stale_participation(ctx: StageContext) -> list[int]:
    # Items without discussion times can't be summarized yet; they aren't stale, just unaligned.
    rows = [r for r in participation_items(ctx) if r["has_times"]]
    return select_stale(rows, "participation_version", PARTICIPATION_VERSION)


def minutes_participation_items(ctx: StageContext, meeting_ids: list[int] | None = None) -> list[dict]:
    """Participation-titled items in meetings without video, with their minutes stamp.

    Items already summarized from a transcript are excluded; the stage function re-checks for transcripts."""
    from pipeline.ingestion.participation_summaries import PARTICIPATION_TITLE

    select = ("id, meeting_id, title, stamp:meta->>participation_minutes_version, source:meta->participation->>source, "
              "has_summary:meta->participation->>overview, meetings!inner(video_url, meeting_date)")

    def q():
        query = (ctx.supabase.table("agenda_items").select(select).or_(PARTICIPATION_ILIKE)
                 .is_("meetings.video_url", "null").order("id"))
        if meeting_ids is not None:
            query = query.in_("meeting_id", meeting_ids)
        if ctx.since:
            query = query.gte("meetings.meeting_date", ctx.since)
        return query

    if meeting_ids is not None and not meeting_ids:
        return []
    return [{"id": r["id"], "meeting_id": r["meeting_id"], "participation_minutes_version": r.get("stamp")}
            for r in _paginate(q)
            if PARTICIPATION_TITLE.search(r.get("title") or "") and (not r.get("has_summary") or r.get("source") == "minutes")]


def speaker_items(ctx: StageContext, meeting_ids: list[int] | None = None) -> list[dict]:
    """Agenda items with participation speakers or written submissions (meta and updated_at for guarded writes)."""
    from pipeline.ingestion.participation_person_links import STAMP

    select = f"id, meeting_id, meta, updated_at, stamp:meta->>{STAMP}"
    if ctx.since:
        select += ", meetings!inner(meeting_date)"

    def q():
        query = (ctx.supabase.table("agenda_items").select(select)
                 .or_("meta->participation->speakers.not.is.null,meta->written_participation.not.is.null").order("id"))
        if meeting_ids is not None:
            query = query.in_("meeting_id", meeting_ids)
        if ctx.since:
            query = query.gte("meetings.meeting_date", ctx.since)
        return query

    if meeting_ids is not None and not meeting_ids:
        return []
    return _paginate(q, page=200)


def stale_participation_links(ctx: StageContext) -> list[int]:
    return select_stale(speaker_items(ctx), "stamp", PARTICIPATION_LINKS_VERSION)


def stale_minutes_participation(ctx: StageContext) -> list[int]:
    from pipeline.ingestion.participation_minutes import MINUTES_VERSION

    return select_stale(minutes_participation_items(ctx), "participation_minutes_version", MINUTES_VERSION)


# ── helpers ──────────────────────────────────────────────────────────────


def _preview(label: str, ids: list, limit: int = 30) -> None:
    shown = ", ".join(str(i) for i in ids[:limit])
    more = f" … (+{len(ids) - limit})" if len(ids) > limit else ""
    print(f"  [dry-run] {label}: {len(ids)}{': ' + shown + more if ids else ''}")


def _choose(ctx: StageContext, stage_name: str, *, from_meetings: Callable[[], list[int]], backfill: Callable[[], list[int]]) -> list[int]:
    """Standard target selection: --target, post-ingest meetings, --stale, else the backfill set."""
    if ctx.target_id() is not None:
        return [ctx.target_id()]
    if ctx.post_ingest:
        return from_meetings()
    if ctx.stale:
        stale = get_stage(stage_name).stale
        if stale is None:
            raise StageError(f"Stage '{stage_name}' does not support --stale")
        return stale(ctx)
    return backfill()


def _meeting_folder(m: dict) -> str:
    from pipeline.paths import BASE_DIR

    return m["archive_path"] if os.path.isabs(m["archive_path"]) else os.path.join(BASE_DIR, m["archive_path"])


def _new_client():
    from pipeline.supabase_client import create_client

    from pipeline import config

    return create_client(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY)


# ── stage functions ──────────────────────────────────────────────────────


def embed_tables(*, force: bool = False, tables: list[str] | None = None, dry_run: bool = False) -> None:
    from pipeline.ingestion.embed import TABLE_CONFIG, embed_table

    for table in tables or list(TABLE_CONFIG.keys()):
        if table not in TABLE_CONFIG:
            print(f"  [!] Unknown embedding table: {table}")
            continue
        if dry_run:
            print(f"  [dry-run] would embed rows missing embeddings in {table}")
            continue
        try:
            embed_table(table, force=force)
        except Exception as e:
            print(f"  [!] Embedding failed for {table}: {e}")


def run_embeddings(ctx: StageContext):
    # --target is a table name here (e.g. --target matters).
    embed_tables(force=ctx.force, tables=[ctx.target] if ctx.target else None, dry_run=ctx.dry_run)


def run_escribe_attachments(ctx: StageContext):
    from pipeline.ingestion.escribe_attachments import (
        AttachmentFetcher,
        download_meeting_attachments,
        ingest_meeting_attachments,
    )

    if ctx.post_ingest:
        meetings = ctx.meetings()
    else:
        q = ctx.supabase.table("meetings").select("id, meeting_date, archive_path, agenda_url").order("meeting_date", desc=True)
        if ctx.target_id() is not None:
            q = q.eq("id", ctx.target_id())
        elif ctx.since:
            q = q.gte("meeting_date", ctx.since)
        meetings = q.execute().data or []
    meetings = [m for m in meetings if m.get("archive_path") and "escribemeetings" in (m.get("agenda_url") or "")]
    if ctx.dry_run:
        _preview("eSCRIBE meetings to fetch attachments for", [m["id"] for m in meetings])
        return {"meetings": len(meetings)}
    if not meetings:
        return {"meetings": 0}
    print(f"  [Attachments] {len(meetings)} meeting(s)")

    # Downloads share one browser per eSCRIBE host and are quick; extraction is the slow part.
    by_base: dict[str, list[dict]] = {}
    for m in meetings:
        by_base.setdefault(m["agenda_url"].split("/Meeting.aspx")[0], []).append(m)
    for base, group in by_base.items():
        with AttachmentFetcher(base) as fetcher:
            for m in group:
                try:
                    download_meeting_attachments(fetcher, _meeting_folder(m), m["agenda_url"])
                except Exception as exc:
                    print(f"  [!] Attachment download for meeting {m['id']}: {exc}")

    def ingest(m: dict, client) -> None:
        try:
            with usage_context(meeting_id=m["id"]):
                print(f"  [Attachments] {m['meeting_date']} (meeting {m['id']}): {ingest_meeting_attachments(client, m, _meeting_folder(m))}", flush=True)
        except Exception as exc:
            print(f"  [!] Attachments for meeting {m['id']}: {exc}", flush=True)

    if len(meetings) == 1 or ctx.post_ingest:
        for m in meetings:
            ingest(m, ctx.supabase)
    else:
        # supabase-py's sync client isn't thread-safe; one per meeting thread.
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda m: ingest(m, _new_client()), meetings))
    return {"meetings": len(meetings)}


def run_document_relink(ctx: StageContext):
    from pipeline.ingestion.relink_documents import relink, unlinked_documents

    if ctx.post_ingest:
        meeting_ids = ctx.meeting_ids
    elif ctx.target_id() is not None:
        meeting_ids = [ctx.target_id()]
    elif ctx.since:
        rows = ctx.supabase.table("meetings").select("id").gte("meeting_date", ctx.since).execute().data or []
        meeting_ids = [r["id"] for r in rows]
    else:
        meeting_ids = None  # every unlinked document
    if ctx.dry_run:
        _preview("unlinked extracted documents", [d["id"] for d in unlinked_documents(ctx.supabase, meeting_ids)])
        return None
    if meeting_ids is not None and not meeting_ids:
        return {"documents": 0}
    result = relink(ctx.supabase, meeting_ids=meeting_ids)
    print(f"  [Relink] {result}")
    return result


def run_matter_history(ctx: StageContext):
    from pipeline.ingestion.matter_history import reconcile_history, review_missing_decisions

    focus = ctx.matters_for_meetings() if ctx.post_ingest else ([ctx.target_id()] if ctx.target_id() is not None else None)
    cities = None
    since = ctx.since
    if ctx.post_ingest:
        rows = ctx.supabase.table("meetings").select("municipality_id,meeting_date").in_("id", ctx.meeting_ids).execute().data or []
        cities = sorted({row["municipality_id"] for row in rows})
        earliest = min((date.fromisoformat(str(row["meeting_date"])[:10]) for row in rows), default=date.today())
        since = (earliest - timedelta(days=365 * 4)).isoformat()
    result = reconcile_history(ctx.supabase, municipality_ids=cities, focus_ids=focus,
                               meeting_ids=ctx.meeting_ids if ctx.post_ingest and not focus else None,
                               review_meeting_ids=ctx.meeting_ids if ctx.post_ingest else None,
                               since=since, dry_run=ctx.dry_run)
    if ctx.post_ingest:
        result["decision_review"] = review_missing_decisions(ctx.supabase, ctx.meeting_ids)
    changed = {row["matter_id"] for row in result["applied"]}
    if ctx.post_ingest and changed:
        ctx.cache["matter_ids"] = sorted(set(ctx.matters_for_meetings()) | changed)
    print("  [History] " + json.dumps(result, default=str))
    return result


def run_matter_summaries(ctx: StageContext):
    from pipeline.ingestion.matter_summaries import all_matter_ids, refresh_matter_summaries

    ids = _choose(
        ctx,
        "matter-summaries",
        from_meetings=ctx.matters_for_meetings,
        backfill=lambda: all_matter_ids(ctx.supabase, only_missing=not ctx.force, since=ctx.since),
    )
    if ctx.dry_run:
        _preview("matters to summarize", ids)
        return None
    if ids:
        print(f"  [Matters] Refreshing {len(ids)} matter summary(ies)")
        refresh_matter_summaries(ctx.supabase, ids)
    return {"matters": len(ids)}


def run_agenda_alignment(ctx: StageContext):
    from pipeline.ingestion.agenda_alignment import align_meetings

    if ctx.post_ingest:
        ids = ctx.meeting_ids
    elif ctx.target_id() is not None:
        ids = [ctx.target_id()]
    else:
        ids = None
    results = align_meetings(
        ctx.supabase, ids, since=ctx.since, dry_run=ctx.dry_run, use_ai=bool(ctx.options.get("align_ai"))
    )
    n = sum(len(v) for v in results.values())
    print(f"  {'Would set' if ctx.dry_run else 'Set'} times on {n} item(s) across {len(results)} meeting(s)")
    return results


def _speaker_targets(ctx: StageContext) -> list[int]:
    """--target is one meeting id or a comma-separated list; post-ingest: those meetings;
    --since DATE: meetings from then; otherwise (or --stale) every meeting not at the current version.
    Oldest first, so fingerprints learned from earlier meetings help later ones."""
    from pipeline.ingestion.speaker_names import stale_meetings

    if ctx.target not in (None, ""):
        return [int(x) for x in str(ctx.target).split(",") if x.strip()]
    if ctx.post_ingest:
        ids = list(ctx.meeting_ids or [])
    else:
        wanted = set(stale_meetings(ctx.supabase)) if (ctx.stale or not ctx.force) else None

        def query():
            q = ctx.supabase.table("meetings").select("id, meeting_date").eq("has_transcript", True)
            if ctx.since:
                q = q.gte("meeting_date", ctx.since)
            return q.order("meeting_date").order("id")

        return [r["id"] for r in _paginate(query) if wanted is None or r["id"] in wanted]
    if not ids:
        return []
    rows = ctx.supabase.table("meetings").select("id, meeting_date").in_("id", ids).execute().data or []
    return [r["id"] for r in sorted(rows, key=lambda r: (r["meeting_date"] or "", r["id"]))]


def run_speaker_names(ctx: StageContext):
    from pipeline.ingestion.speaker_names import name_meetings

    ids = _speaker_targets(ctx)
    if not ids:
        return {"meetings": 0}
    # Post-ingest runs always re-evaluate: the transcript is new.
    summary = name_meetings(ctx.supabase, ids, dry_run=ctx.dry_run, force=ctx.force or ctx.post_ingest)
    done = [r for r in summary["results"] if r["status"] in ("named", "dry_run")]
    print(f"  [Speakers] {'would name' if ctx.dry_run else 'named'} {sum(r['rows_named'] for r in done)} row(s) "
          f"across {len(done)}/{len(ids)} meeting(s); fingerprints refreshed: {summary['fingerprints_refreshed']}")
    return summary


def run_voice_fingerprints(ctx: StageContext):
    from pipeline.ingestion.speaker_names import rebuild_exemplars

    people = [int(x) for x in str(ctx.target).split(",")] if ctx.target not in (None, "") else None
    return rebuild_exemplars(ctx.supabase, people, dry_run=ctx.dry_run)


def _stale_speaker_names(ctx: StageContext) -> list[int]:
    from pipeline.ingestion.speaker_names import stale_meetings

    return stale_meetings(ctx.supabase)


def run_participation_summaries(ctx: StageContext):
    from pipeline.ingestion.participation_summaries import summarize_participation

    if ctx.post_ingest:
        ids = [r["id"] for r in participation_items(ctx, ctx.meeting_ids)]
    elif ctx.target_id() is not None:  # a meeting id
        ids = [r["id"] for r in participation_items(ctx, [ctx.target_id()])]
    elif ctx.stale:
        ids = stale_participation(ctx)
    else:
        ids = [r["id"] for r in participation_items(ctx) if ctx.force or not r["has_summary"]]
    if ctx.dry_run:
        _preview("participation items to summarize", ids)
        return None
    done = 0
    for item_id in ids:
        try:  # one item failing shouldn't skip the rest
            if summarize_participation(ctx.supabase, item_id) is not None:
                done += 1
        except Exception as e:
            print(f"  [!] Participation summary for item {item_id} failed: {e}")
    if ids:
        print(f"  [Participation] {done}/{len(ids)} item(s) summarized")
    return {"items": len(ids), "summarized": done}


def run_participation_from_minutes(ctx: StageContext):
    from pipeline.ingestion.participation_minutes import summarize_from_minutes

    if ctx.post_ingest:
        rows = minutes_participation_items(ctx, ctx.meeting_ids)
    elif ctx.target_id() is not None:  # a meeting id
        rows = minutes_participation_items(ctx, [ctx.target_id()])
    else:
        rows = minutes_participation_items(ctx)
    if ctx.stale:
        stale = set(stale_minutes_participation(ctx))
        rows = [r for r in rows if r["id"] in stale]
    elif not ctx.force:  # already checked at this version (even if the minutes listed no speakers)
        from pipeline.ingestion.participation_minutes import MINUTES_VERSION
        rows = [r for r in rows if r["participation_minutes_version"] != MINUTES_VERSION]
    ids = [r["id"] for r in rows]
    if ctx.dry_run:
        _preview("minutes participation items", ids)
        return None
    done = 0
    for item_id in ids:
        try:
            if summarize_from_minutes(ctx.supabase, item_id) is not None:
                done += 1
        except Exception as e:
            print(f"  [!] Minutes participation for item {item_id} failed: {e}")
    if ids:
        print(f"  [Participation/minutes] {done}/{len(ids)} item(s) with speakers")
    return {"items": len(ids), "summarized": done}


def run_participation_names(ctx: StageContext):
    from pipeline.ingestion.participation_summaries import name_speakers_from_minutes

    if ctx.post_ingest:
        meetings = ctx.meeting_ids
    elif ctx.target_id() is not None:
        meetings = [ctx.target_id()]
    else:
        meetings = None
    ids = [r["id"] for r in participation_items(ctx, meetings) if r["has_summary"]]
    named = 0
    for item_id in ids:
        try:
            named += name_speakers_from_minutes(ctx.supabase, item_id, dry_run=ctx.dry_run)
        except Exception as e:
            print(f"  [!] Naming speakers for item {item_id} failed: {e}")
    verb = "would name" if ctx.dry_run else "named"
    print(f"  [Participation] {verb} {named} speaker(s) from minutes across {len(ids)} item(s)")
    return {"items": len(ids), "named": named}


def run_participation_person_links(ctx: StageContext):
    """Stamp person_id on speakers and letter authors whose full name matches exactly one non-official person. No AI."""
    from pipeline.ingestion.participation_person_links import letters_of, link_item, load_registry

    if ctx.post_ingest:
        items = speaker_items(ctx, ctx.meeting_ids)
    elif ctx.target_id() is not None:  # a meeting id
        items = speaker_items(ctx, [ctx.target_id()])
    else:
        items = speaker_items(ctx)
    if ctx.stale:
        items = [r for r in items if is_stale(r.get("stamp"), PARTICIPATION_LINKS_VERSION)]
    if not items:
        return {"items": 0}
    registry, excluded = load_registry(ctx.supabase)
    results = [link_item(ctx.supabase, item, registry, dry_run=ctx.dry_run, force=ctx.force) for item in items]
    linked = [pid for r in results for pid in r["linked"]]
    letters_linked = [pid for r in results for pid in r["letters_linked"]]
    summary = {
        "items": len(items),
        "items_changed": sum(r["changed"] for r in results),
        "items_to_write": sum(r["would_write"] for r in results),
        "items_with_links": sum(bool(r["linked"] or r["letters_linked"]) for r in results),
        "speakers": sum(len((i.get("meta") or {}).get("participation", {}).get("speakers") or []) for i in items),
        "speakers_linked": len(linked),
        "letters": sum(len(letters_of((i.get("meta") or {}).get("written_participation"))) for i in items),
        "letters_linked": len(letters_linked),
        "distinct_people": len(set(linked) | set(letters_linked)),
        "distinct_letter_people": len(set(letters_linked)),
        "officials_linked": len((set(linked) | set(letters_linked)) & excluded),
        "written": sum(r["written"] for r in results),
        "conflicts": sum(bool(r.get("conflict")) for r in results),
    }
    verb = "would link" if ctx.dry_run else "linked"
    print(f"  [Participation links] {verb} {summary['speakers_linked']}/{summary['speakers']} speaker(s) and "
          f"{summary['letters_linked']}/{summary['letters']} letter(s) ({summary['distinct_letter_people']} letter writers), "
          f"{summary['distinct_people']} distinct people, across {summary['items_with_links']} item(s); "
          f"{summary['items_changed']}/{summary['items']} item(s) change, {summary['items_to_write']} to write; "
          f"officials linked: {summary['officials_linked']}"
          + ("" if ctx.dry_run else f"; written {summary['written']}, conflicts {summary['conflicts']}"))
    return summary


def _motion_headline_stamps(ctx: StageContext) -> list[dict]:
    """One row per meeting with decided, non-procedural motions: the oldest headline stamp among them."""
    rows = _paginate(
        lambda: ctx.supabase.table("motions")
        .select("meeting_id, headline_version:meta->>headline_version")
        .neq("disposition", "Procedural")
        .not_.is_("result", "null")
        .order("id")
    )
    stamps: dict[int, list] = {}
    for r in rows:
        stamps.setdefault(r["meeting_id"], []).append(r["headline_version"])
    out = []
    for meeting_id, versions in stamps.items():
        missing = any(v is None for v in versions)
        oldest = None if missing else min(versions, key=_version_key)
        out.append({"id": meeting_id, "headline_version": oldest, "missing": missing})
    return out


def stale_motion_headlines(ctx: StageContext) -> list[int]:
    return select_stale(_motion_headline_stamps(ctx), "headline_version", HEADLINE_VERSION)


def run_motion_headlines(ctx: StageContext):
    from pipeline.ingestion.motion_headlines import headline_meeting_motions

    def missing() -> list[int]:
        return sorted(r["id"] for r in _motion_headline_stamps(ctx) if ctx.force or r["missing"])

    ids = _choose(ctx, "motion-headlines", from_meetings=lambda: list(ctx.meeting_ids or []), backfill=missing)
    if ctx.dry_run:
        _preview("meetings to write decision headlines for", ids)
        return None
    done = 0
    for meeting_id in ids:
        try:  # one meeting failing shouldn't skip the rest
            done += len(headline_meeting_motions(ctx.supabase, meeting_id))
        except Exception as e:
            print(f"  [!] Decision headlines for meeting {meeting_id} failed: {e}")
    if ids:
        print(f"  [Headlines] {done} decision headline(s) across {len(ids)} meeting(s)")
    return {"meetings": len(ids), "headlines": done}


def _closed_session_rows(ctx: StageContext, meeting_ids: list[int] | None = None) -> list[dict]:
    from pipeline.ingestion.closed_sessions import MEETING_SELECT

    if meeting_ids is not None and not meeting_ids:
        return []

    def q():
        query = ctx.supabase.table("meetings").select(MEETING_SELECT).order("id")
        if meeting_ids is not None:
            query = query.in_("id", meeting_ids)
        if ctx.since:
            query = query.gte("meeting_date", ctx.since)
        return query

    return _paginate(q)


def stale_closed_sessions(ctx: StageContext) -> list[int]:
    return select_stale(_closed_session_rows(ctx), "stamp", CLOSED_SESSIONS_VERSION)


def run_closed_sessions(ctx: StageContext):
    """Deterministic (regex over minutes, notices and decisions; no AI)."""
    from pipeline.ingestion.closed_sessions import run

    ids = _choose(ctx, "closed-sessions", from_meetings=lambda: list(ctx.meeting_ids or []),
                  backfill=lambda: [r["id"] for r in _closed_session_rows(ctx)
                                    if ctx.force or r.get("stamp") is None])
    rows = _closed_session_rows(ctx, ids)
    result = run(ctx.supabase, rows, dry_run=ctx.dry_run)
    print(f"  [Closed] {'Would write' if ctx.dry_run else 'Wrote'} {len(rows)} meeting(s): "
          f"{result['with_closed_session']} with a closed session, {result['timed']} of them timed")
    return result


def _meeting_highlight_stamps(ctx: StageContext) -> list[dict]:
    """Held meetings with a summary, with their highlights stamp."""
    from pipeline.ingestion.meeting_highlights import SKIP_STATUSES

    def q():
        query = (ctx.supabase.table("meetings")
                 .select("id, status, stamp:meta->highlights->>version")
                 .not_.is_("summary", "null")
                 .order("id"))
        if ctx.since:
            query = query.gte("meeting_date", ctx.since)
        return query

    return [{"id": r["id"], "highlights_version": r.get("stamp")}
            for r in _paginate(q) if (r.get("status") or "") not in SKIP_STATUSES]


def stale_meeting_highlights(ctx: StageContext) -> list[int]:
    return select_stale(_meeting_highlight_stamps(ctx), "highlights_version", HIGHLIGHTS_VERSION)


def run_meeting_highlights(ctx: StageContext):
    from pipeline.ingestion.meeting_highlights import highlight_meeting

    def missing() -> list[int]:
        return sorted(r["id"] for r in _meeting_highlight_stamps(ctx) if ctx.force or r["highlights_version"] is None)

    ids = _choose(ctx, "meeting-highlights", from_meetings=lambda: list(ctx.meeting_ids or []), backfill=missing)
    if ctx.dry_run:
        _preview("meetings to write plain-language highlights for", ids)
        return None

    def one(meeting_id: int) -> bool:
        with usage_context(job="meeting-highlights", meeting_id=meeting_id):
            try:
                return bool(highlight_meeting(ctx.supabase, meeting_id))
            except OSError:  # transient socket errors (EAGAIN) under concurrency: one retry
                time.sleep(2)
                return bool(highlight_meeting(ctx.supabase, meeting_id))

    done = failed = 0
    with ThreadPoolExecutor(max_workers=4 if len(ids) > 1 else 1) as pool:
        futures = {meeting_id: pool.submit(one, meeting_id) for meeting_id in ids}
        for meeting_id, future in futures.items():
            try:  # one meeting failing shouldn't skip the rest
                done += future.result()
            except Exception as e:
                failed += 1
                print(f"  [!] Highlights for meeting {meeting_id} failed: {e}")
    if ids:
        print(f"  [Highlights] {done} meeting(s) written, {failed} failed, {len(ids) - done - failed} with nothing to highlight")
    return {"meetings": len(ids), "written": done, "failed": failed}


def run_other_documents(ctx: StageContext):
    import os
    from pipeline.paths import BASE_DIR
    from pipeline.ingestion.other_documents import ingest_meeting_letters

    if ctx.post_ingest:
        ids = list(ctx.meeting_ids or [])
    elif ctx.target_id() is not None:
        ids = [ctx.target_id()]
    else:
        ids = None
    query = ctx.supabase.table("meetings").select("id,archive_path,meeting_date").not_.is_("archive_path", "null")
    meetings = [m for m in (query.limit(5000).execute().data or [])
                if (ids is None or m["id"] in ids) and (not ctx.since or (m.get("meeting_date") or "") >= ctx.since)]
    totals = {"meetings": len(meetings), "files": 0, "new": 0, "extracted": 0}
    for meeting in meetings:
        try:
            stats = ingest_meeting_letters(ctx.supabase, meeting, BASE_DIR, dry_run=ctx.dry_run)
        except Exception as e:
            print(f"  [!] Other documents for meeting {meeting['id']} failed: {e}")
            continue
        for key in ("files", "new", "extracted"):
            totals[key] += stats[key]
    print(f"  [Other documents] {totals['files']} letter file(s) across {totals['meetings']} meeting(s): "
          f"{totals['new']} new, {totals['extracted']} extracted")
    return totals


def run_written_submissions(ctx: StageContext):
    from pipeline.ingestion.participation_validation import load_streets
    from pipeline.ingestion.written_submissions import correspondence_documents, load_examples, summarize_document

    if ctx.post_ingest:
        docs = correspondence_documents(ctx.supabase, meeting_ids=list(ctx.meeting_ids or []))
    elif ctx.target_id() is not None:
        docs = correspondence_documents(ctx.supabase, meeting_ids=[ctx.target_id()])
    else:
        docs = correspondence_documents(ctx.supabase, since=ctx.since)
    streets = load_streets()
    examples = load_examples(ctx.supabase)  # admin decisions, shown to the model as worked examples
    totals = {"documents": len(docs), "letters": 0, "placed": 0, "held": 0, "unchanged": 0, "skipped": 0}
    for doc in docs:
        try:
            result = summarize_document(ctx.supabase, doc, streets=streets, dry_run=ctx.dry_run, examples=examples)
        except Exception as e:
            print(f"  [!] Written submissions for document {doc['id']} failed: {e}")
            continue
        if result["status"] in ("unchanged", "skipped"):
            totals[result["status"]] += 1
            continue
        for key in ("letters", "placed", "held"):
            totals[key] += result.get(key, 0)
    verb = "would place" if ctx.dry_run else "placed"
    print(f"  [Written] {totals['documents']} correspondence document(s): {totals['letters']} letter(s), {verb} "
          f"{totals['placed']}, {totals['held']} held for review, {totals['unchanged']} unchanged, {totals['skipped']} skipped")
    return totals


def run_properties(ctx: StageContext):
    from pipeline.ingestion.properties import build_properties

    stats = build_properties(ctx.supabase, dry_run=ctx.dry_run)
    print(f"  [Properties] {stats['properties']} properties, {stats['links']} links, {stats['matters']} matters; "
          f"{stats['multi_matter_properties']} properties with 2+ matters; {stats.get('hidden', 0)} residents' homes hidden; "
          f"geocoded {stats.get('geocoded', 0)}")
    for key in stats.get("sample", []):
        print(f"    {key}")
    return stats


def _property_targets(ctx: StageContext) -> list[int]:
    """--target for property-summaries: one property id or several, comma-separated."""
    try:
        return [int(t) for t in str(ctx.target).split(",") if t.strip()]
    except ValueError:
        raise StageError(f"property-summaries: --target must be property ids (e.g. 12 or 12,34), got {ctx.target!r}")


def stale_property_summaries(ctx: StageContext) -> list[int]:
    from pipeline.ingestion.property_summaries import is_property_stale, load_properties

    props = ctx.cache.get("properties") or load_properties(ctx.supabase)
    ctx.cache["properties"] = props
    return [p["id"] for p in props if is_property_stale(p, PROPERTY_SUMMARY_VERSION)]


def run_property_summaries(ctx: StageContext):
    """Plain-language lead per eligible property (see property_summaries.eligible). Post-ingest and --stale: only properties
    whose records changed (or prompt version). Default: those without a summary; --force: every one."""
    from pipeline.ingestion.property_summaries import (
        clear_summaries, eligible, load_properties, needs_clearing, summarize_properties,
    )

    props = load_properties(ctx.supabase)
    ctx.cache["properties"] = props
    by_id = {p["id"]: p for p in props}
    clear = []
    if ctx.target not in (None, ""):
        wanted = _property_targets(ctx)
        unknown = [i for i in wanted if i not in by_id]
        if unknown:
            print(f"  [!] Unknown property id(s): {unknown}")
        chosen = [by_id[i] for i in wanted if i in by_id and eligible(by_id[i])]
        skipped = [i for i in wanted if i in by_id and not eligible(by_id[i])]
        if skipped:
            print(f"  [Properties] Skipping {skipped}: not eligible (too few records, or a resident's home)")
    else:
        if ctx.post_ingest or ctx.stale:
            ids = set(stale_property_summaries(ctx))
            chosen = [p for p in props if p["id"] in ids]
        else:
            chosen = [p for p in props if eligible(p) and (ctx.force or not p["meta"].get("summary"))]
        clear = [p for p in props if needs_clearing(p)]
    if ctx.dry_run:
        _preview("properties to summarize", [p["id"] for p in chosen])
        _preview("properties to clear (no longer eligible)", [p["id"] for p in clear])
        print(f"  [dry-run] {sum(1 for p in props if eligible(p))} of {len(props)} properties are eligible")
        return {"properties": len(chosen), "clear": len(clear)}
    cleared = clear_summaries(ctx.supabase, clear) if clear else 0
    done = summarize_properties(ctx.supabase, chosen) if chosen else {}
    print(f"  [Properties] {len(done)}/{len(chosen)} summarized, {cleared} cleared")
    return {"properties": len(chosen), "summarized": len(done), "cleared": cleared}


def run_letter_placement_eval(ctx: StageContext):
    import json
    from pipeline.ingestion.written_submissions import evaluate_placement

    report = evaluate_placement(ctx.supabase, limit=ctx.limit if hasattr(ctx, "limit") else None)
    n = report["decisions"]
    if not n:
        print("  [Eval] No admin decisions with letter copies yet. Make some in /admin/letters first.")
        return report
    pct = lambda a, b: f"{a}/{b} ({round(100 * a / b)}%)" if b else "0/0"
    print(f"  [Eval] {n} admin decision(s) replayed ({report['admin_dismissed']} were 'not about an item')")
    print(f"  [Eval] Model would auto-place: {pct(report['auto_correct'], report['auto_placed'])} match the admin")
    print(f"  [Eval] Model would hold: {report['held']}; its top pick was still the admin's for {pct(report['held_top_correct'], report['held'])}")
    for band, stats in sorted(report["by_confidence"].items()):
        print(f"  [Eval]   top confidence {band:>7}: top pick = admin {pct(stats['top_matches_admin'], stats['n'])}, "
              f"admin said none {stats['admin_said_none']}")
    out = "/tmp/letter-placement-eval.json"
    with open(out, "w") as handle:
        json.dump(report, handle, indent=1)
    print(f"  [Eval] Full results: {out}")
    return {k: v for k, v in report.items() if k != "results"}


def run_matter_images(ctx: StageContext):
    from pipeline.ingestion.matter_images import pick_matter_images

    def missing() -> list[int]:
        return [r["id"] for r in _matter_stamps(ctx, "images_version") if ctx.force or r.get("images_version") is None]

    ids = _choose(ctx, "matter-images", from_meetings=ctx.matters_for_meetings, backfill=missing)
    if ctx.dry_run:
        _preview("matters to pick images for", ids)
        return None
    for mid in ids:
        try:
            pick_matter_images(ctx.supabase, mid)
        except Exception as e:
            print(f"  [!] Matter images for matter {mid} failed: {e}")
    return {"matters": len(ids)}


def run_matter_links(ctx: StageContext):
    from pipeline.ingestion.matter_links import build_links

    if ctx.post_ingest:
        meetings = ctx.meetings()
        earliest = min(date.fromisoformat(str(m["meeting_date"])[:10]) for m in meetings) if meetings else date.today()
        since = (earliest - timedelta(days=365 * 4)).isoformat()
        focus = ctx.matters_for_meetings() or None
        meeting_ids = ctx.meeting_ids
    else:
        since = ctx.since
        focus = [ctx.target_id()] if ctx.target_id() is not None else None
        meeting_ids = None
    if ctx.dry_run:
        print(f"  [dry-run] would link matters since {since or 'the beginning'}"
              f"{f', focused on {len(focus)} matter(s)' if focus else ''}")
        return None
    res = build_links(ctx.supabase, since=since, focus_matter_ids=focus, meeting_ids=meeting_ids,
                      new_matter_dates={str(m["meeting_date"])[:10] for m in meetings} if ctx.post_ingest else None)
    # Only newly persisted mentions need a second context pass. Existing links
    # do not repeatedly regenerate summaries on every import.
    changed = sorted({link["matter_id"] for link in res.get("mentions", [])}) if isinstance(res.get("mentions"), list) else []
    if changed:
        from pipeline.ingestion.matter_summaries import refresh_matter_summaries
        refresh_matter_summaries(ctx.supabase, changed, context_only=True)
    print(f"  [Links] related: {len(res['related']) if isinstance(res['related'], list) else res['related']}, "
          f"mentions: {len(res['mentions']) if isinstance(res['mentions'], list) else res['mentions']}")
    return res


def bylaw_stage_selection(ctx: StageContext) -> tuple[str, list[str] | None]:
    """(source, only) for the bylaws stage: ``--all`` (optionally ``--source
    directory|media``) or ``--target <bylaw number>``; one of them is required."""
    source = ctx.options.get("source") or "all"
    if source not in ("all", "directory", "media"):
        raise StageError(f"--source must be all, directory or media (got {source!r})")
    if ctx.target not in (None, ""):
        return source, [str(ctx.target)]
    if not ctx.options.get("all"):
        raise StageError("bylaws: pass --all (every bylaw; --source directory|media to narrow) or --target <bylaw number>")
    return source, None


def run_bylaws(ctx: StageContext):
    """Bulk Langford bylaw ingestion, then matters.bylaw_id linking. Dry run:
    downloads and plans (no AI, no writes). Unchanged PDFs are skipped unless --force."""
    from pipeline.ingestion.langford_bylaws import _client, default_archive_root, link_all, municipality_id_for, run_bulk

    source, only = bylaw_stage_selection(ctx)
    sb = ctx.supabase or _client()
    result = run_bulk(
        sb,
        archive_root=ctx.options.get("archive_root") or default_archive_root(),
        source=source,
        write=not ctx.dry_run,
        force=ctx.force,
        use_ai=not ctx.dry_run,
        plan_md=ctx.options.get("plan_md"),
        only=only,
    )
    result["links"] = link_all(sb, municipality_id=municipality_id_for(sb), write=not ctx.dry_run,
                               sample_md=ctx.options.get("links_md"))
    return result


def run_matter_resolver_audit(ctx: StageContext):
    from pipeline.ingestion.matter_resolver import audit, candidate_pairs, load_records, save_proposals

    if ctx.dry_run:
        records = load_records(ctx.supabase)
        print(f"  [dry-run] would audit {len(records)} matters ({len(candidate_pairs(records))} candidate pairs)")
        return None
    result = audit(ctx.supabase)
    clusters = result["auto"] + result["review"]
    queued = save_proposals(ctx.supabase, clusters, result["decisions"])
    print(f"  [Resolver] {len(clusters)} cluster(s) found, {queued} new merge proposal(s) queued for review")
    return {"clusters": len(clusters), "queued": queued}


def _poster_rows(ctx: StageContext, meeting_ids: list[int] | None = None) -> list[dict]:
    """Meetings with video, with their poster stamp."""
    def q():
        query = (ctx.supabase.table("meetings")
                 .select("id, video_url, video_duration_seconds, meeting_date, stamp:meta->poster->>version, "
                         "poster_url:meta->poster->>url")
                 .not_.is_("video_url", "null").order("id"))
        if meeting_ids is not None:
            query = query.in_("id", meeting_ids)
        if ctx.since:
            query = query.gte("meeting_date", ctx.since)
        return query

    if meeting_ids is not None and not meeting_ids:
        return []
    return [{**r, "poster_version": r.get("stamp")} for r in _paginate(q)]


def stale_video_posters(ctx: StageContext) -> list[int]:
    return select_stale(_poster_rows(ctx), "poster_version", POSTER_VERSION)


def _video_source_config(ctx: StageContext) -> dict | None:
    """The municipality's source_config, for picking its video provider (None: detect from URL)."""
    municipality = getattr(ctx.archiver, "municipality", None)
    if municipality is not None:
        return municipality.source_config or {}
    try:
        rows = ctx.supabase.table("municipalities").select("source_config").limit(2).execute().data or []
    except Exception:
        return None
    return (rows[0].get("source_config") or {}) if len(rows) == 1 else None


def run_video_posters(ctx: StageContext):
    from pipeline.video.posters import make_poster, save_poster
    from pipeline.video.providers import resolve_media_url

    def from_meetings() -> list[int]:
        return [r["id"] for r in _poster_rows(ctx, ctx.meeting_ids) if ctx.force or not r.get("poster_url")]

    def missing() -> list[int]:
        return [r["id"] for r in _poster_rows(ctx) if ctx.force or not r.get("poster_url")]

    ids = _choose(ctx, "video-posters", from_meetings=from_meetings, backfill=missing)
    if ctx.dry_run:
        _preview("meetings to make poster frames for", ids)
        return None
    rows = {r["id"]: r for r in _poster_rows(ctx, ids)}
    workers = int(ctx.options.get("workers") or 4)
    source_config = _video_source_config(ctx)

    def one(mid: int):
        row = rows.get(mid)
        if row is None:
            return mid, None, "no video_url"
        try:
            with usage_context(job="video-posters", meeting_id=mid):
                res = make_poster(row, resolve=lambda url: resolve_media_url(url, source_config))
            if res.poster:
                save_poster(mid, res.poster)
            return mid, res.poster, res.error
        except Exception as e:
            return mid, None, f"{type(e).__name__}: {e}"

    made, failed = 0, []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for mid, poster, err in pool.map(one, ids):
            if poster:
                made += 1
                print(f"  [Poster] meeting {mid}: {poster['offset_s']}s {poster.get('shot', '')} "
                      f"({poster['usable']}/{poster['candidates']} usable) {poster['url']}")
            else:
                failed.append(mid)
                print(f"  [!] Poster for meeting {mid} failed: {err}")
    return {"meetings": len(ids), "made": made, "failed": failed}


CARD_SELECT = ("id, title, meeting_date, summary, video_url, video_duration_seconds, poster:meta->poster, "
               "highlights:meta->highlights, card_key:meta->share_card->>key, organization:organizations(name)")


def _card_rows(ctx: StageContext, meeting_ids: list[int] | None = None, *, highlights_only: bool = True) -> list[dict]:
    """Meetings for share cards. Cards use plain-language highlights, so only meetings that have them
    are selected unless an explicit --target asks for a summary-based card."""
    def q():
        query = ctx.supabase.table("meetings").select(CARD_SELECT).order("id")
        if highlights_only:
            query = query.not_.is_("meta->highlights", "null")
        if meeting_ids is not None:
            query = query.in_("id", meeting_ids)
        if ctx.since:
            query = query.gte("meeting_date", ctx.since)
        return query

    if meeting_ids is not None and not meeting_ids:
        return []
    return _paginate(q)


def stale_share_cards(ctx: StageContext) -> list[int]:
    from pipeline.video.share_cards import card_key

    return sorted(r["id"] for r in _card_rows(ctx) if r.get("card_key") != card_key(r))


def run_share_cards(ctx: StageContext):
    from pipeline.video.posters import save_meta_key
    from pipeline.video.share_cards import CardRenderer, card_key, make_card

    def from_meetings() -> list[int]:
        return [r["id"] for r in _card_rows(ctx, ctx.meeting_ids) if ctx.force or r.get("card_key") != card_key(r)]

    def missing() -> list[int]:
        return [r["id"] for r in _card_rows(ctx) if ctx.force or not r.get("card_key")]

    ids = _choose(ctx, "share-cards", from_meetings=from_meetings, backfill=missing)
    if ctx.dry_run:
        _preview("meetings to render share cards for", ids)
        return None
    if not ids:
        return {"meetings": 0, "made": 0, "failed": []}
    rows = {r["id"]: r for r in _card_rows(ctx, ids, highlights_only=ctx.target_id() is None)}
    made, failed = 0, []
    with CardRenderer() as renderer:
        for mid in ids:
            row = rows.get(mid)
            if row is None:
                failed.append(mid)
                print(f"  [!] Share card for meeting {mid}: not found or no highlights")
                continue
            try:
                card = make_card(row, renderer)
                save_meta_key(mid, "share_card", card)
                made += 1
                print(f"  [Card] meeting {mid}: {card['source']} {card['url']}")
            except Exception as e:  # CardError or upload/DB failure; one bad card never stops the rest
                failed.append(mid)
                print(f"  [!] Share card for meeting {mid} failed: {e}")
    return {"meetings": len(ids), "made": made, "failed": failed}


TITLE_CARD_SELECT = ("id, title, meeting_date, poster:meta->poster, title_key:meta->title_card->>key, "
                     "organization:organizations(name)")


def _title_card_rows(ctx: StageContext, meeting_ids: list[int] | None = None) -> list[dict]:
    """Meetings with a poster frame (title cards need one)."""
    def q():
        query = (ctx.supabase.table("meetings").select(TITLE_CARD_SELECT)
                 .not_.is_("meta->poster->>url", "null").order("id"))
        if meeting_ids is not None:
            query = query.in_("id", meeting_ids)
        if ctx.since:
            query = query.gte("meeting_date", ctx.since)
        return query

    if meeting_ids is not None and not meeting_ids:
        return []
    return _paginate(q)


def stale_title_cards(ctx: StageContext) -> list[int]:
    from pipeline.video.share_cards import title_card_key

    return sorted(r["id"] for r in _title_card_rows(ctx) if r.get("title_key") != title_card_key(r))


def run_title_cards(ctx: StageContext):
    from pipeline.video.posters import save_meta_key
    from pipeline.video.share_cards import make_title_card, title_card_key, title_renderer

    def changed(rows: list[dict]) -> list[int]:
        return [r["id"] for r in rows if ctx.force or r.get("title_key") != title_card_key(r)]

    ids = _choose(ctx, "title-cards", from_meetings=lambda: changed(_title_card_rows(ctx, ctx.meeting_ids)),
                  backfill=lambda: changed(_title_card_rows(ctx)))
    if ctx.dry_run:
        _preview("meetings to render title cards for", ids)
        return None
    if not ids:
        return {"meetings": 0, "made": 0, "failed": []}
    rows = {r["id"]: r for r in _title_card_rows(ctx, ids)}
    made, failed = 0, []
    with title_renderer() as renderer:
        for mid in ids:
            row = rows.get(mid)
            try:
                if row is None:
                    raise ValueError("not found or no poster")
                card = make_title_card(row, renderer)
                save_meta_key(mid, "title_card", card)
                made += 1
                print(f"  [Title card] meeting {mid}: {card['url']}")
            except Exception as e:  # CardError or upload/DB failure; one bad card never stops the rest
                failed.append(mid)
                print(f"  [!] Title card for meeting {mid} failed: {e}")
    return {"meetings": len(ids), "made": made, "failed": failed}


def councillors_for_meetings(supabase, meeting_ids: list[int]) -> list[int]:
    people: set[int] = set()
    for table in ("attendance", "key_statements"):
        rows = supabase.table(table).select("person_id").in_("meeting_id", meeting_ids).execute().data or []
        people.update(r["person_id"] for r in rows if r.get("person_id"))
    if not people:
        return []
    rows = supabase.table("people").select("id").in_("id", sorted(people)).eq("is_councillor", True).execute().data or []
    return [r["id"] for r in rows]


def run_profile_refresh(ctx: StageContext):
    if ctx.post_ingest:
        person_ids = councillors_for_meetings(ctx.supabase, ctx.meeting_ids) if ctx.meeting_ids else []
    elif ctx.target_id() is not None:  # a person id
        person_ids = [ctx.target_id()]
    elif ctx.since:
        rows = ctx.supabase.table("meetings").select("id").gte("meeting_date", ctx.since).execute().data or []
        person_ids = councillors_for_meetings(ctx.supabase, [r["id"] for r in rows]) if rows else []
    else:
        raise StageError("profile-refresh needs --target PERSON_ID or --since DATE")
    if ctx.dry_run:
        _preview("councillors to refresh", person_ids)
        return None
    if not person_ids:
        return {"people": 0}
    print(f"  [Profiles] Refreshing {len(person_ids)} councillor profile(s)")

    from pipeline.profiling.key_vote_detector import detect_all_key_votes
    from pipeline.profiling.profile_agent import generate_profile
    from pipeline.profiling.stance_generator import generate_all_stances

    for pid in person_ids:
        for label, fn in (
            ("key votes", lambda: detect_all_key_votes(ctx.supabase, person_id=pid)),
            ("stances", lambda: generate_all_stances(ctx.supabase, person_id=pid)),
            ("overview draft", lambda: generate_profile(ctx.supabase, pid, force=True)),
        ):
            try:
                fn()
            except Exception as e:
                print(f"  [!] Profile refresh ({label}) failed for person {pid}: {e}")
    return {"people": len(person_ids)}


# ── registry ─────────────────────────────────────────────────────────────

STAGES: list[Stage] = [
    Stage(
        name="embeddings",
        description="Embed rows missing a vector (text-embedding-3-small @384). --target TABLE, --force re-embeds.",
        run=run_embeddings, when="post_ingest", scope="global", version="1",
    ),
    Stage(
        name="escribe-attachments",
        description="Download eSCRIBE agenda attachments (staff reports, bylaws) and extract them, linked to agenda items.",
        run=run_escribe_attachments, when="post_ingest", scope="meeting", version="1",
    ),
    Stage(
        name="document-relink",
        description="Link extracted documents with no agenda item to one via the Decisions API (post-ingest: those meetings only).",
        run=run_document_relink, when="post_ingest", scope="meeting", version="1",
        depends_on=("escribe-attachments",),
    ),
    Stage(
        name="other-documents",
        description="Ingest late submissions and addendum correspondence from a meeting's Other Documents folder. --target is a meeting id; --since DATE.",
        run=run_other_documents, when="post_ingest", scope="meeting", version="1",
        depends_on=("escribe-attachments",),
    ),
    Stage(
        name="written-submissions",
        description="Residents' letters in agenda packages as written participation; unsure placements wait in /admin/letters. --target is a meeting id; --since DATE.",
        run=run_written_submissions, when="post_ingest", scope="meeting", version="1",
        depends_on=("document-relink",),
    ),
    Stage(
        name="matter-history",
        description="Reconcile exact titles and policy stages; report missing proceedings and adoption outcomes. --dry-run reads only.",
        run=run_matter_history, when="post_ingest", scope="matter", version="2",
        depends_on=("document-relink",),
    ),
    Stage(
        name="matter-summaries",
        description="Plain-English summary, status line, display title, topic and timeline headlines per matter.",
        run=run_matter_summaries, when="post_ingest", scope="matter", version=SUMMARY_VERSION,
        depends_on=("matter-history",), stale=stale_matter_summaries,
    ),
    Stage(
        name="agenda-alignment",
        description="Fill missing agenda item discussion start/end times from transcripts (never overwrites). --align-ai for gaps.",
        run=run_agenda_alignment, when="post_ingest", scope="meeting", version="1",
    ),
    Stage(
        name="speaker-names",
        description="Name diarized transcript speakers from evidence: chair call-outs, self-introductions, minutes "
                    "motions (mover/seconder), the chair, and voice fingerprints; grows fingerprints from what it names "
                    "(no AI; --target is a meeting id or comma list; --force re-evaluates named meetings).",
        run=run_speaker_names, when="post_ingest", scope="meeting", version=SPEAKER_IDENTITY_VERSION,
        stale=_stale_speaker_names,
    ),
    Stage(
        name="participation-summaries",
        description="Per-speaker bullets for public participation / delegation items (--target is a meeting id).",
        run=run_participation_summaries, when="post_ingest", scope="meeting", version=PARTICIPATION_VERSION,
        depends_on=("agenda-alignment",), stale=stale_participation,
    ),
    Stage(
        name="participation-from-minutes",
        description="Who-spoke bullets from the minutes for transcript-less meetings (hearings, public participation, delegations; --target is a meeting id).",
        run=run_participation_from_minutes, when="post_ingest", scope="meeting", version=MINUTES_PARTICIPATION_VERSION,
        stale=stale_minutes_participation,
    ),
    Stage(
        name="participation-names",
        description="Name resident-labelled speakers in existing summaries from the meeting minutes (no redraft; --target is a meeting id).",
        run=run_participation_names, when="post_ingest", scope="meeting", version="1",
        depends_on=("participation-summaries",),
    ),
    Stage(
        name="participation-person-links",
        description="Link named public speakers and letter writers to people by unique full-name match, never council or staff "
                    "(deterministic, no AI; --target is a meeting id).",
        run=run_participation_person_links, when="post_ingest", scope="meeting", version=PARTICIPATION_LINKS_VERSION,
        depends_on=("written-submissions", "participation-from-minutes", "participation-names"),
        stale=stale_participation_links,
    ),
    Stage(
        name="motion-headlines",
        description="Short newspaper-style headline per decided, non-procedural motion (home page lead). --target is a meeting id.",
        run=run_motion_headlines, when="post_ingest", scope="meeting", version=HEADLINE_VERSION,
        stale=stale_motion_headlines,
    ),
    Stage(
        name="meeting-highlights",
        description="2-4 plain-language outcome bullets and a <=155-char description per meeting (meetings.meta.highlights; "
                    "never touches meetings.summary). --target is a meeting id; --since DATE.",
        run=run_meeting_highlights, when="post_ingest", scope="meeting", version=HIGHLIGHTS_VERSION,
        depends_on=("motion-headlines",), stale=stale_meeting_highlights,
    ),
    Stage(
        name="closed-sessions",
        description="Closed (in-camera) sessions per meeting from the minutes: section 90 reasons, close and adjournment "
                    "times, estimated closed and open minutes (meetings.meta.closed_session; regex, no AI). "
                    "--target is a meeting id; --since DATE; --stale after a version bump.",
        run=run_closed_sessions, when="post_ingest", scope="meeting", version=CLOSED_SESSIONS_VERSION,
        stale=stale_closed_sessions,
    ),
    Stage(
        name="matter-images",
        description="Pick a lead picture and site-plan layout per matter from its staff report images.",
        run=run_matter_images, when="post_ingest", scope="matter", version=IMAGES_VERSION,
        depends_on=("matter-summaries",), stale=stale_matter_images,
    ),
    Stage(
        name="matter-links",
        description="Link related matters (same initiative) and mentions in mixed-topic items.",
        run=run_matter_links, when="post_ingest", scope="matter", version="1",
        depends_on=("matter-summaries",),
    ),
    Stage(
        name="properties",
        description="Link every matter and agenda item to the properties (civic addresses) it names.",
        run=run_properties, when="post_ingest", scope="global", version="1",
    ),
    Stage(
        name="property-summaries",
        description="Plain-language lead per address with 2+ records and per street (the road and its busiest addresses), ending in a mention count (properties.meta.summary; also the page description). "
                    "--target PROPERTY_ID[,ID...]; --stale re-runs changed record sets.",
        run=run_property_summaries, when="post_ingest", scope="global", version=PROPERTY_SUMMARY_VERSION,
        depends_on=("properties",), stale=stale_property_summaries,
    ),
    Stage(
        name="video-posters",
        description="Poster frame per meeting video (meetings.meta.poster): a few ffmpeg frames from the stream, "
                    "skip dark/uniform ones, pick one seeded by meeting id, WebP to R2. --stale re-picks old versions.",
        run=run_video_posters, when="post_ingest", scope="meeting", version=POSTER_VERSION,
        stale=stale_video_posters,
    ),
    Stage(
        name="share-cards",
        description="1200x630 og:image per meeting (meetings.meta.share_card): poster frame + title, date and "
                    "plain-language highlights, rendered with Playwright to R2. Only meetings with meta.highlights "
                    "(any meeting via --target); --stale re-renders when highlights, poster or template change.",
        run=run_share_cards, when="post_ingest", scope="meeting", version=SHARE_CARD_VERSION,
        depends_on=("video-posters",), stale=stale_share_cards,
    ),
    Stage(
        name="title-cards",
        description="1280x720 title card per meeting with a poster (meetings.meta.title_card): the poster frame "
                    "with the player's label/title/date overlay, no summary (Discord embeds). --stale re-renders "
                    "when the poster, title, date, label or template change.",
        run=run_title_cards, when="post_ingest", scope="meeting", version=TITLE_CARD_VERSION,
        depends_on=("video-posters",), stale=stale_title_cards,
    ),
    Stage(
        name="profile-refresh",
        description="Councillor key votes, stances and a new overview draft for review (--target is a person id).",
        run=run_profile_refresh, when="post_ingest", scope="meeting", version="1",
    ),
    Stage(
        name="voice-fingerprints",
        description="Rebuild voice exemplars and fingerprints from stored text-evidenced speaker names only "
                    "(--target PERSON_ID[,..] for one person after a correction; manual mappings are kept).",
        run=run_voice_fingerprints, when="backfill_only", scope="global", version="1",
    ),
    Stage(
        name="bylaws",
        description="Langford bylaws: download, summarize and embed every directory + media-library bylaw, then link "
                    "matters. --all [--source directory|media] or --target NUMBER; --force re-ingests unchanged PDFs.",
        run=run_bylaws, when="backfill_only", scope="global", version="1",
    ),
    Stage(
        name="letter-placement-eval",
        description="Replay admin letter placements: how often the model agrees with them, by confidence. Read-only.",
        run=run_letter_placement_eval, when="backfill_only", scope="global", version="1",
    ),
    Stage(
        name="matter-resolver-audit",
        description="Find duplicate matters and queue merge proposals for admin review (never merges by itself).",
        run=run_matter_resolver_audit, when="backfill_only", scope="global", version="1",
    ),
]

STAGES_BY_NAME = {s.name: s for s in STAGES}


def get_stage(name: str) -> Stage:
    key = name.strip().lower().replace("_", "-")
    if key not in STAGES_BY_NAME:
        raise StageError(f"Unknown stage '{name}'. Known: {', '.join(STAGES_BY_NAME)}")
    return STAGES_BY_NAME[key]


def validate_registry(stages: list[Stage] = STAGES) -> None:
    """Names are unique and every dependency is declared earlier in the list."""
    seen: set[str] = set()
    for s in stages:
        if s.name in seen:
            raise StageError(f"Duplicate stage '{s.name}'")
        for dep in s.depends_on:
            if dep not in seen:
                raise StageError(f"Stage '{s.name}' depends on '{dep}', which must come earlier")
        seen.add(s.name)


validate_registry()


def post_ingest_stages(include: Iterable[str] | None = None, exclude: Iterable[str] = ()) -> list[Stage]:
    inc = set(include) if include is not None else None
    exc = set(exclude)
    return [s for s in STAGES if s.when == "post_ingest" and (inc is None or s.name in inc) and s.name not in exc]


def run_stage(stage: Stage, ctx: StageContext, *, raise_errors: bool = False) -> Any:
    """Run one stage, isolated: failures are logged (and re-raised only if asked)."""
    started = time.monotonic()
    print(f"  [Stage] {stage.name} (v{stage.version}){' [dry-run]' if ctx.dry_run else ''}")
    try:
        with usage_context(job=stage.name, meeting_id=ctx.meeting_ids[0] if ctx.meeting_ids and len(ctx.meeting_ids) == 1 else None):
            result = stage.run(ctx)
        print(f"  [Stage] {stage.name} done in {time.monotonic() - started:.1f}s")
        return result
    except StageError:
        raise
    except Exception as e:
        print(f"  [!] Stage {stage.name} failed: {e}")
        traceback.print_exc()
        if raise_errors:
            raise
        return None


def run_post_ingest(ctx: StageContext, *, include: Iterable[str] | None = None, exclude: Iterable[str] = ()) -> dict[str, Any]:
    """Run the post_ingest stages in registry order. One failing stage never stops the rest."""
    results: dict[str, Any] = {}
    for stage in post_ingest_stages(include, exclude):
        if stage.scope != "global" and not ctx.meeting_ids:
            continue
        try:
            results[stage.name] = run_stage(stage, ctx)
        except StageError as e:  # misconfiguration of one stage: log and continue
            print(f"  [!] Stage {stage.name}: {e}")
    return results


def describe_stages() -> str:
    lines = []
    for s in STAGES:
        deps = f" after {', '.join(s.depends_on)}" if s.depends_on else ""
        stale = " [--stale]" if s.stale else ""
        lines.append(f"  {s.name:<24} {s.when:<13} {s.scope:<7} v{s.version}{stale}{deps}\n      {s.description}")
    return "\n".join(lines)
