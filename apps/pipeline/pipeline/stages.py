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
``motions.meta.headline_version``);
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
from pipeline.ingestion.matter_images import IMAGES_VERSION
from pipeline.ingestion.matter_summaries import SUMMARY_VERSION
from pipeline.ingestion.motion_headlines import HEADLINE_VERSION
from pipeline.ingestion.participation_summaries import PARTICIPATION_VERSION

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
    from supabase import create_client

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
          f"{stats['multi_matter_properties']} properties with 2+ matters")
    for key in stats.get("sample", []):
        print(f"    {key}")
    return stats


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
        name="participation-summaries",
        description="Per-speaker bullets for public participation / delegation items (--target is a meeting id).",
        run=run_participation_summaries, when="post_ingest", scope="meeting", version=PARTICIPATION_VERSION,
        depends_on=("agenda-alignment",), stale=stale_participation,
    ),
    Stage(
        name="participation-names",
        description="Name resident-labelled speakers in existing summaries from the meeting minutes (no redraft; --target is a meeting id).",
        run=run_participation_names, when="post_ingest", scope="meeting", version="1",
        depends_on=("participation-summaries",),
    ),
    Stage(
        name="motion-headlines",
        description="Short newspaper-style headline per decided, non-procedural motion (home page lead). --target is a meeting id.",
        run=run_motion_headlines, when="post_ingest", scope="meeting", version=HEADLINE_VERSION,
        stale=stale_motion_headlines,
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
        name="profile-refresh",
        description="Councillor key votes, stances and a new overview draft for review (--target is a person id).",
        run=run_profile_refresh, when="post_ingest", scope="meeting", version="1",
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
