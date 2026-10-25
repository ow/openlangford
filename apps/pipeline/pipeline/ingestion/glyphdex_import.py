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
from collections import defaultdict

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


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def already_ingested(supabase, meeting: dict) -> bool:
    """A meeting we have from the city's own archive: same date and the same body (or Council)."""
    rows = (supabase.table("meetings").select("id,title,organization:organizations(name)")
            .eq("meeting_date", meeting["date"]).execute().data or [])
    body = meeting["body"].lower()
    for row in rows:
        org = ((row.get("organization") or {}).get("name") or "").lower()
        title = (row.get("title") or "").lower()
        if body == "council" and org == "council" and "committee" not in title:
            return True
        if body != "council" and (body in title or org == body):
            return True
    return False


def main(argv=None):
    from supabase import create_client

    from pipeline import config
    from pipeline.paths import get_municipality_archive_root

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--body", help="Substring of the committee/council name, e.g. 'Planning, Zoning'")
    parser.add_argument("--from", dest="date_from")
    parser.add_argument("--to", dest="date_to")
    parser.add_argument("--dry-run", action="store_true", help="List what would be imported; download nothing")
    parser.add_argument("--ingest", action="store_true", help="Run the pipeline on each downloaded folder")
    parser.add_argument("--workers", type=int, default=1,
                        help="With --ingest: run N child processes (meetings split by year), then the post-ingest "
                             "stages once for every new meeting. Holds the pipeline lock throughout.")
    parser.add_argument("--shard-file", help=argparse.SUPPRESS)  # child mode
    args = parser.parse_args(argv)
    if args.shard_file:
        return run_shard(args.shard_file)

    supabase = create_client(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY)
    archive_root = get_municipality_archive_root("langford")
    meetings = [m for m in group_meetings(list_documents())
                if (not args.body or args.body.lower() in m["body"].lower())
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
    from datetime import datetime

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


def split_by_year(meetings: list[dict], workers: int) -> list[list[dict]]:
    """Whole years per worker (a bylaw's meetings mostly fall in one year, so two workers rarely
    create the same new matter at once), balanced by meeting count."""
    years: dict[str, list[dict]] = defaultdict(list)
    for m in meetings:
        years[m["date"][:4]].append(m)
    shards: list[list[dict]] = [[] for _ in range(workers)]
    for year in sorted(years, key=lambda y: -len(years[y])):
        min(shards, key=len).extend(years[year])
    return [sorted(shard, key=lambda m: (m["date"], m["time"])) for shard in shards if shard]


def run_parallel(todo: list[dict], archive_root: str, workers: int):
    import subprocess
    import sys

    from pipeline.lockfile import PipelineLock

    reports = os.path.join(archive_root, "reports")
    os.makedirs(reports, exist_ok=True)
    shards = split_by_year(todo, workers)
    with PipelineLock():  # scheduled runs wait (exit cleanly) until the backfill is done
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
        ids, failed = [], 0
        for i in range(len(shards)):
            path = os.path.join(reports, f"glyphdex-shard-{i}.jsonl")
            for line in open(path) if os.path.exists(path) else []:
                entry = json.loads(line)
                if entry.get("meeting_id"):
                    ids.append(entry["meeting_id"])
                else:
                    failed += 1
        print(f"Ingested {len(ids)} meeting(s), {failed} failed. Running post-ingest stages once...", flush=True)
        if ids:
            from pipeline.orchestrator import Archiver, load_municipality
            archiver = Archiver(load_municipality("langford"), initialize_diarizer=False)
            archiver.run_post_ingest_stages(ids)
        print("Done.", flush=True)


def run_shard(shard_file: str):
    """Child: download and ingest each meeting directly (no pipeline lock, no post-ingest stages),
    and record it only once its meeting row and agenda items exist."""
    from datetime import datetime

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
            ingester.process_meeting(folder, force_update=True, force_refine=True)
            row = (ingester.supabase.table("meetings").select("id").eq("archive_path", ingester._normalize_archive_path(folder))
                   .limit(1).execute().data)
            items = row and ingester.supabase.table("agenda_items").select("id", count="exact").eq("meeting_id", row[0]["id"]).limit(1).execute().count
            if not row or not items:
                raise RuntimeError("meeting not in the database after ingest" if not row else "meeting has no agenda items")
            entry["meeting_id"] = row[0]["id"]
        except Exception as error:  # one bad meeting never stops the shard
            entry["error"] = f"{type(error).__name__}: {error}"
            print(f"  [!] {entry['error']}", flush=True)
        with open(report, "a") as handle:
            handle.write(json.dumps(entry) + "\n")


if __name__ == "__main__":
    main()
