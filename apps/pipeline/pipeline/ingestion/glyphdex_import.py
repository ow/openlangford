"""Backfill meetings we never scraped from the Goldstream Public Record archive (Glyphdex).

Glyphdex (https://gspr.emc2.build) holds Langford's standing committee meetings
before 2023 (Planning, Zoning & Affordable Housing; Transportation & Public Works;
...) and Council back to 2008, as the original PDFs. We download the originals
into the usual archive layout and ingest them with our own pipeline; Glyphdex's
extracted text is only used to cross-check page coverage (it is the raw PDF text
layer, with words run together).

Provenance: each PDF gets a ``.url`` sidecar pointing at Glyphdex's archived copy
(read by the ingester as the document's source_url) and the meeting folder gets
``glyphdex.json`` with the Glyphdex document ids, original filenames and SHA-256.

Uses the public document list and artifact downloads, not the rate-limited search.

    uv run python -m pipeline.ingestion.glyphdex_import --body "Planning, Zoning" --from 2019-06-01 --to 2019-10-31
    uv run python -m pipeline.ingestion.glyphdex_import ... --ingest   # then run the pipeline on each new folder
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
import multiprocessing
import signal
import traceback
from datetime import datetime

import requests

API = "https://gspr.emc2.build/api"
ARCHIVE_URL = "https://gspr.emc2.build/documents/{id}"
USER_AGENT = "OpenLangford/1.0 (openlangford.ca; civic records backfill)"
TITLE = re.compile(r"^(?P<body>.+?) (?P<y>\d{4}) (?P<m>\d{2}) (?P<d>\d{2}) (?P<time>\d{4}) (?P<kind>Regular|Special|In Camera)"
                   r"\b.*?(?P<part>Minutes|Agenda)", re.I)


def list_documents(session=None, pause: float = 0.3) -> list[dict]:
    session = session or requests.Session()
    docs, offset = [], 0
    while True:
        page = session.get(f"{API}/documents", params={"limit": 50, "offset": offset},
                           headers={"User-Agent": USER_AGENT}, timeout=30).json()
        docs += page["documents"]
        offset += 50
        if offset >= page["total"] or not page["documents"]:
            return docs
        time.sleep(pause)


def group_meetings(docs: list[dict]) -> list[dict]:
    """Agenda packages and minutes grouped per meeting (body, date, time, regular/special)."""
    meetings: dict[tuple, dict] = {}
    for doc in docs:
        if doc.get("doc_type") != "council_minutes" or doc.get("source_kind") != "pdf":
            continue
        m = TITLE.match(doc["title"])
        if not m or m["kind"].lower() == "in camera":
            continue
        key = (m["body"], f"{m['y']}-{m['m']}-{m['d']}", m["time"], m["kind"].title())
        meeting = meetings.setdefault(key, {"body": key[0], "date": key[1], "time": key[2], "kind": key[3],
                                            "agenda": [], "minutes": []})
        meeting["minutes" if m["part"].lower() == "minutes" else "agenda"].append(doc)
    return sorted(meetings.values(), key=lambda x: (x["date"], x["time"], x["body"]))


def folder_for(meeting: dict, archive_root: str) -> str:
    """archive/<Body>/<YYYY>/<MM>/<YYYY-MM-DD 530pm Body[ – Special] [gx-xxxxxxxx]> (the parser strips
    the time and bracketed source id from the title)."""
    hour, minute = int(meeting["time"][:2]), meeting["time"][2:]
    clock = f"{hour % 12 or 12}{minute}{'am' if hour < 12 else 'pm'}"
    first = (meeting["minutes"] or meeting["agenda"])[0]["id"]
    if meeting["body"] == "Council":
        title = f"{meeting['kind']} Council"  # "Regular Council" / "Special Council", like the city's own folders
    else:
        title = meeting["body"] + (" – Special" if meeting["kind"] == "Special" else "")
    top = "Council" if meeting["body"] == "Council" else meeting["body"]
    name = f"{meeting['date']} {clock} {title} [gx-{first[:8]}]"
    return os.path.join(archive_root, top, meeting["date"][:4], meeting["date"][5:7], name)


def _safe_filename(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "-", name).strip()


def download_meeting(meeting: dict, archive_root: str, session=None, pause: float = 0.5) -> dict:
    """Download the meeting's PDFs (idempotent: files with the right SHA-256 are kept)."""
    session = session or requests.Session()
    folder = folder_for(meeting, archive_root)
    record = {"source": "glyphdex", "documents": []}
    for part, category in (("agenda", "Agenda"), ("minutes", "Minutes")):
        for doc in meeting[part]:
            detail = session.get(f"{API}/documents/{doc['id']}", headers={"User-Agent": USER_AGENT}, timeout=30).json()
            info = detail["document"]
            original = next(a for a in detail["artifacts"] if a["kind"] == "original")
            target_dir = os.path.join(folder, category)
            os.makedirs(target_dir, exist_ok=True)
            path = os.path.join(target_dir, _safe_filename(info.get("original_filename") or f"{doc['title']}.pdf"))
            if not (os.path.exists(path) and _sha256(path) == info["sha256"]):
                response = session.get(f"https://gspr.emc2.build{original['url']}", headers={"User-Agent": USER_AGENT}, timeout=120)
                response.raise_for_status()
                if hashlib.sha256(response.content).hexdigest() != info["sha256"]:
                    raise RuntimeError(f"checksum mismatch for {doc['id']}")
                with open(path, "wb") as handle:
                    handle.write(response.content)
                time.sleep(pause)
            with open(path + ".url", "w", encoding="utf-8") as handle:
                handle.write(ARCHIVE_URL.format(id=doc["id"]))
            record["documents"].append({"glyphdex_id": doc["id"], "category": category, "file": os.path.basename(path),
                                        "original_filename": info.get("original_filename"), "sha256": info["sha256"],
                                        "page_count": info.get("page_count"), "archive_url": ARCHIVE_URL.format(id=doc["id"])})
    with open(os.path.join(folder, "glyphdex.json"), "w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=2)
    return {"folder": folder, "files": len(record["documents"])}


def minutes_url_for_folder(folder: str) -> str | None:
    """Glyphdex URL of the meeting's minutes document, from the folder's ``glyphdex.json`` (None if it has none)."""
    try:
        with open(os.path.join(folder, "glyphdex.json"), encoding="utf-8") as handle:
            record = json.load(handle)
    except (OSError, ValueError):
        return None
    urls = [d.get("archive_url") for d in record.get("documents", []) if d.get("category") == "Minutes" and d.get("archive_url")]
    return urls[0] if urls else None


def set_minutes_url(supabase, meeting_id, folder: str) -> str | None:
    """Set ``meetings.minutes_url`` from the Glyphdex minutes URL (the ingester only fills ``agenda_url``
    from the Agenda ``.url`` sidecar). Returns the URL written, or None."""
    url = minutes_url_for_folder(folder)
    if url:
        supabase.table("meetings").update({"minutes_url": url}).eq("id", meeting_id).execute()
    return url


def archive_path_for(folder: str) -> str:
    """Same value the ingester stores in ``meetings.archive_path`` (``archive/<slug>/...``)."""
    abs_path = os.path.abspath(folder)
    return abs_path[abs_path.find("/archive/") + 1:]


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


# Glyphdex body -> how our own (eSCRIBE) database files the same meetings. Verified by SHA-256 matches of the
# 2023-2026 PDFs (research/glyphdex/2023-2026-overlap.md): Council and Committee of the Whole live under the
# 'Council' organization (types 'Regular Council' / 'Special Council' / 'Committee of the Whole'); the Community
# Advisory Committee is filed under the generic 'Advisory Committee' organization (archive folder 'Joint Advisory
# Committee', title 'Advisory Committee'); eSCRIBE dates can differ from Glyphdex's by one day.
DATE_TOLERANCE_DAYS = 1


def _our_filing(meeting: dict) -> dict | None:
    """Organizations/types our database uses for a Glyphdex body, or None for bodies we have no mapping for."""
    body, kind = meeting["body"].lower(), meeting["kind"].lower()
    if body == "council":
        return {"orgs": {"council"}, "types": {f"{kind} council"}}
    if body == "committee of the whole":
        return {"orgs": {"council"}, "types": {"committee of the whole"}}
    if body == "community advisory committee":
        return {"orgs": {"advisory committee", "community advisory committee"}, "types": {"advisory committee"}}
    return None


def matches_existing(meeting: dict, rows: list[dict]) -> bool:
    """Is one of our meetings (rows with ``meeting_date``, ``title``, ``type``, ``organization.name``) the same
    meeting as this Glyphdex one?"""
    from datetime import date

    day = date.fromisoformat(meeting["date"])
    filing = _our_filing(meeting)
    body = meeting["body"].lower()
    for row in rows:
        gap = abs((date.fromisoformat(str(row["meeting_date"])) - day).days)
        org = ((row.get("organization") or {}).get("name") or "").lower()
        title = (row.get("title") or "").lower()
        if filing:
            if gap <= DATE_TOLERANCE_DAYS and org in filing["orgs"] and (row.get("type") or "").lower() in filing["types"]:
                return True
        elif gap == 0 and (body in title or org == body):
            # Unmapped body (Board of Variance, Sustainable Development Advisory Committee, the 2016-2022
            # standing committees): only its own organization/title on the same date counts, never a
            # neighbouring Council meeting.
            return True
    return False


def already_ingested(supabase, meeting: dict) -> bool:
    """A meeting we have from the city's own archive (see ``matches_existing``)."""
    from datetime import date, timedelta

    day = date.fromisoformat(meeting["date"])
    rows = (supabase.table("meetings").select("id,title,type,meeting_date,organization:organizations(name)")
            .gte("meeting_date", str(day - timedelta(days=DATE_TOLERANCE_DAYS)))
            .lte("meeting_date", str(day + timedelta(days=DATE_TOLERANCE_DAYS))).execute().data or [])
    return matches_existing(meeting, rows)


def main(argv=None):
    from pipeline.supabase_client import create_client

    from pipeline import config
    from pipeline.paths import get_municipality_archive_root

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--body", action="append",
                        help="Substring of the committee/council name, e.g. 'Planning, Zoning' (repeatable: any match)")
    parser.add_argument("--from", dest="date_from")
    parser.add_argument("--to", dest="date_to")
    parser.add_argument("--dry-run", action="store_true", help="List what would be imported; download nothing")
    parser.add_argument("--ingest", action="store_true", help="Run the pipeline on each downloaded folder")
    parser.add_argument("--workers", type=int, default=1,
                        help="With --ingest: run N child processes (meetings dealt round-robin by date), then the post-ingest "
                             "stages once for every new meeting. Holds the pipeline lock throughout.")
    parser.add_argument("--shard-file", help=argparse.SUPPRESS)  # child mode
    args = parser.parse_args(argv)
    if args.shard_file:
        return run_shard(args.shard_file)

    supabase = create_client(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY)
    archive_root = get_municipality_archive_root("langford")
    meetings = [m for m in group_meetings(list_documents())
                if (not args.body or any(b.lower() in m["body"].lower() for b in args.body))
                and (not args.date_from or m["date"] >= args.date_from) and (not args.date_to or m["date"] <= args.date_to)]
    todo = [m for m in meetings if not already_ingested(supabase, m)]
    print(f"{len(meetings)} Glyphdex meeting(s) match; {len(meetings) - len(todo)} already in our database; {len(todo)} to import")
    for m in todo:
        print(f"  {m['date']} {m['body']} ({m['kind']}): {len(m['agenda'])} agenda, {len(m['minutes'])} minutes")
    if args.dry_run:
        return
    if args.ingest and args.workers > 1:
        return run_parallel(todo, archive_root, args.workers)
    import subprocess

    report_path = os.path.join(archive_root, "reports", "glyphdex-import.jsonl")
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    failed = 0
    for i, m in enumerate(todo, 1):
        entry = {"at": datetime.now().isoformat(timespec="seconds"), "date": m["date"], "body": m["body"], "kind": m["kind"]}
        try:
            result = download_meeting(m, archive_root)
            entry["folder"] = result["folder"]
            print(f"  [{i}/{len(todo)}] {result['files']} file(s) -> {result['folder']}", flush=True)
            if args.ingest:
                log = os.path.join(archive_root, "reports", "glyphdex-logs", os.path.basename(result["folder"]) + ".log")
                os.makedirs(os.path.dirname(log), exist_ok=True)
                with open(log, "w") as handle:
                    code = subprocess.run(["uv", "run", "python", "main.py", "--target", result["folder"]],
                                          stdout=handle, stderr=subprocess.STDOUT).returncode
                entry.update({"ingest_exit": code, "log": log})
                if not code:
                    row = (supabase.table("meetings").select("id").eq("archive_path", archive_path_for(result["folder"]))
                           .limit(1).execute().data)
                    if row:
                        set_minutes_url(supabase, row[0]["id"], result["folder"])
                if code:
                    failed += 1
                    print(f"      [!] ingest failed (exit {code}); see {log}", flush=True)
        except Exception as error:  # one bad meeting never stops the backfill
            failed += 1
            entry["error"] = f"{type(error).__name__}: {error}"
            print(f"      [!] {entry['error']}", flush=True)
        with open(report_path, "a") as handle:
            handle.write(json.dumps(entry) + "\n")
    print(f"Done: {len(todo) - failed} ok, {failed} failed. Report: {report_path}")


def split_by_meeting(meetings: list[dict], workers: int) -> list[list[dict]]:
    """Round-robin over meetings sorted by date, so every worker stays busy until the queue is nearly
    empty. (Two workers creating the same new matter at once is handled by the ingester, which links to
    the existing matter on a ``matters_identifier_key`` conflict.)"""
    ordered = sorted(meetings, key=lambda m: (m["date"], m["time"], m["body"]))
    shards: list[list[dict]] = [[] for _ in range(max(1, workers))]
    for i, m in enumerate(ordered):
        shards[i % len(shards)].append(m)
    return [shard for shard in shards if shard]


def collect_run_results(report_paths: list[str], since: str) -> tuple[list[int], int]:
    """(meeting ids, failure count) from the shard reports, counting only entries whose ``at`` timestamp
    (ISO, second resolution) is >= ``since``: the reports accumulate across runs."""
    ids, failed = [], 0
    for path in report_paths:
        if not os.path.exists(path):
            continue
        with open(path) as handle:
            for line in handle:
                if not line.strip():
                    continue
                entry = json.loads(line)
                if str(entry.get("at", "")) < since:
                    continue
                if entry.get("meeting_id"):
                    ids.append(entry["meeting_id"])
                else:
                    failed += 1
    return ids, failed


def run_parallel(todo: list[dict], archive_root: str, workers: int):
    import subprocess
    import sys

    from pipeline.lockfile import PipelineLock

    reports = os.path.join(archive_root, "reports")
    os.makedirs(reports, exist_ok=True)
    shards = split_by_meeting(todo, workers)
    with PipelineLock():  # scheduled runs wait (exit cleanly) until the backfill is done
        # The shard .jsonl reports are appended to across runs (history is kept), so only entries stamped at or
        # after this moment belong to this run (issue #66).
        run_started = datetime.now().isoformat(timespec="seconds")
        children = []
        for i, shard in enumerate(shards):
            shard_file = os.path.join(reports, f"glyphdex-shard-{i}.json")
            with open(shard_file, "w") as handle:
                json.dump(shard, handle)
            log = open(os.path.join(reports, f"glyphdex-shard-{i}.log"), "w")
            years = sorted({m["date"][:4] for m in shard})
            print(f"  shard {i}: {len(shard)} meetings ({', '.join(years)})", flush=True)
            children.append((subprocess.Popen([sys.executable, "-m", "pipeline.ingestion.glyphdex_import", "--shard-file", shard_file],
                                              stdout=log, stderr=subprocess.STDOUT), log))
        for child, log in children:
            child.wait()
            log.close()
        ids, failed = collect_run_results([os.path.join(reports, f"glyphdex-shard-{i}.jsonl") for i in range(len(shards))],
                                          run_started)
        print(f"Ingested {len(ids)} meeting(s), {failed} failed. Running post-ingest stages once...", flush=True)
        if ids:
            from pipeline.orchestrator import Archiver, load_municipality
            archiver = Archiver(load_municipality("langford"), initialize_diarizer=False)
            archiver.run_post_ingest_stages(ids)
        print("Done.", flush=True)


MEETING_TIMEOUT = float(os.environ.get("GLYPHDEX_MEETING_TIMEOUT", 30 * 60))  # seconds per meeting ingest


class MeetingTimeout(Exception):
    pass


def _child_main(target, args, conn):
    """Child process entry: become a process-group leader (so the parent can kill ffmpeg/marker
    grandchildren too), run ``target`` and report the outcome over the pipe."""
    try:
        os.setsid()
    except OSError:
        pass
    try:
        target(*args)
        conn.send(("ok", ""))
    except BaseException:  # report everything, including SystemExit
        conn.send(("error", traceback.format_exc(limit=8)))
    finally:
        conn.close()


def run_with_timeout(target, args: tuple, timeout: float):
    """Run ``target(*args)`` in a fresh child process; kill its whole process group and raise
    ``MeetingTimeout`` if it runs longer than ``timeout`` seconds. A child failure raises RuntimeError."""
    ctx = multiprocessing.get_context("spawn")
    parent_conn, child_conn = ctx.Pipe(duplex=False)
    process = ctx.Process(target=_child_main, args=(target, args, child_conn))
    process.start()
    child_conn.close()
    try:
        if parent_conn.poll(timeout):
            try:
                status, detail = parent_conn.recv()
            except EOFError:
                status, detail = "error", "child exited without a result"
            process.join(10)
            if status != "ok":
                raise RuntimeError(detail.strip().splitlines()[-1] if detail.strip() else "child failed")
            return
        _kill_group(process)
        raise MeetingTimeout(f"ingest exceeded {timeout:.0f}s and was abandoned")
    finally:
        if process.is_alive():
            _kill_group(process)
        parent_conn.close()


def _kill_group(process):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sig)  # the child called setsid(), so pid == pgid
        except OSError:
            try:
                os.kill(process.pid, sig)
            except OSError:
                pass
        process.join(5)
        if not process.is_alive():
            return


def _child_ingest(folder: str, municipality_id) -> None:
    from pipeline import config
    from pipeline.ingestion.ingester import MeetingIngester

    key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
    ingester = MeetingIngester(config.SUPABASE_URL, key, municipality_id=municipality_id)
    ingester.process_meeting(folder, force_update=True, force_refine=True)


def ingest_guarded(ingester, folder: str, timeout: float = None, target=None) -> None:
    """Ingest one meeting in a child process under a time budget. On failure or timeout a meeting row
    we created is deleted (a rerun must not think it was done); one that existed before is left alone."""
    target = target or _child_ingest
    timeout = MEETING_TIMEOUT if timeout is None else timeout
    path = ingester._normalize_archive_path(folder)
    before = ingester.supabase.table("meetings").select("id").eq("archive_path", path).limit(1).execute().data
    try:
        run_with_timeout(target, (folder, ingester.municipality_id), timeout)
    except Exception:
        if not before:
            ingester.supabase.table("meetings").delete().eq("archive_path", path).execute()
        raise


def run_shard(shard_file: str):
    """Child: download and ingest each meeting (each in its own watchdog child process; no pipeline lock,
    no post-ingest stages), and record it only once its meeting row and agenda items exist."""
    from pipeline import config
    from pipeline.ingestion.ingester import MeetingIngester
    from pipeline.orchestrator import load_municipality
    from pipeline.paths import get_municipality_archive_root

    municipality = load_municipality("langford")
    archive_root = get_municipality_archive_root("langford")
    key = config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY
    ingester = MeetingIngester(config.SUPABASE_URL, key, municipality_id=municipality.id)
    report = shard_file.replace(".json", ".jsonl")
    for m in json.load(open(shard_file)):
        entry = {"at": datetime.now().isoformat(timespec="seconds"), "date": m["date"], "body": m["body"], "kind": m["kind"]}
        try:
            folder = download_meeting(m, archive_root)["folder"]
            entry["folder"] = folder
            print(f"[{entry['at']}] {m['date']} {m['body']}", flush=True)
            ingest_guarded(ingester, folder)
            row = (ingester.supabase.table("meetings").select("id").eq("archive_path", ingester._normalize_archive_path(folder))
                   .limit(1).execute().data)
            items = row and ingester.supabase.table("agenda_items").select("id", count="exact").eq("meeting_id", row[0]["id"]).limit(1).execute().count
            if not row or not items:
                raise RuntimeError("meeting not in the database after ingest" if not row else "meeting has no agenda items")
            entry["meeting_id"] = row[0]["id"]
            set_minutes_url(ingester.supabase, row[0]["id"], folder)
        except Exception as error:  # one bad meeting never stops the shard
            entry["error"] = f"{type(error).__name__}: {error}"
            print(f"  [!] {entry['error']}", flush=True)
        with open(report, "a") as handle:
            handle.write(json.dumps(entry) + "\n")


if __name__ == "__main__":
    main()
