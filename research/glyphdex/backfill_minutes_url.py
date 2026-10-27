"""One-off: set meetings.minutes_url for meetings imported from Glyphdex before the importer did it.

Finds meeting folders under archive/langford that have a glyphdex.json, takes the Glyphdex URL of the
minutes document (same value as the Minutes/*.pdf.url sidecar), and matches the meeting row by archive_path.
Only rows whose minutes_url is currently empty are updated; rows with a different non-empty value are
reported and left alone.

Dry-run by default: prints the plan and writes a JSON backup of the current values next to this script.
Nothing is written to the database without --apply.

    cd apps/pipeline
    uv run python ../../research/glyphdex/backfill_minutes_url.py              # dry-run
    uv run python ../../research/glyphdex/backfill_minutes_url.py --apply
    ... --archive-root /path/to/archive/langford   # default: get_municipality_archive_root("langford")
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "apps", "pipeline"))

from pipeline.ingestion.glyphdex_import import archive_path_for, minutes_url_for_folder  # noqa: E402


def find_folders(archive_root: str) -> list[str]:
    return sorted(root for root, _dirs, files in os.walk(archive_root) if "glyphdex.json" in files)


def build_plan(folders: list[str], rows_by_path: dict[str, dict]) -> dict:
    plan = {"update": [], "already_set": [], "conflict": [], "no_minutes": [], "not_in_db": []}
    for folder in folders:
        path = archive_path_for(folder)
        url = minutes_url_for_folder(folder)
        row = rows_by_path.get(path)
        if not url:
            plan["no_minutes"].append({"archive_path": path})
        elif not row:
            plan["not_in_db"].append({"archive_path": path})
        elif not row.get("minutes_url"):
            plan["update"].append({"id": row["id"], "archive_path": path, "old": row.get("minutes_url"), "new": url})
        elif row["minutes_url"] == url:
            plan["already_set"].append({"id": row["id"], "archive_path": path})
        else:
            plan["conflict"].append({"id": row["id"], "archive_path": path, "old": row["minutes_url"], "new": url})
    return plan


def fetch_rows(supabase, paths: list[str]) -> dict[str, dict]:
    rows = {}
    for i in range(0, len(paths), 20):  # long paths go in the URL; keep batches small
        for row in (supabase.table("meetings").select("id,archive_path,minutes_url")
                    .in_("archive_path", paths[i:i + 20]).execute().data or []):
            rows[row["archive_path"]] = row
    return rows


def main(argv=None):
    from pipeline import config
    from pipeline.paths import get_municipality_archive_root
    from pipeline.supabase_client import create_client

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="Write minutes_url (default: dry-run)")
    parser.add_argument("--archive-root", help="Override archive/langford")
    args = parser.parse_args(argv)

    archive_root = args.archive_root or get_municipality_archive_root("langford")
    folders = find_folders(archive_root)
    supabase = create_client(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY)
    plan = build_plan(folders, fetch_rows(supabase, [archive_path_for(f) for f in folders]))

    print(f"{len(folders)} Glyphdex folder(s) under {archive_root}")
    for key, items in plan.items():
        print(f"  {key}: {len(items)}")
    for item in plan["update"][:3]:
        print(f"  e.g. meeting {item['id']}: {item['archive_path']}\n       -> {item['new']}")
    for item in plan["conflict"][:3]:
        print(f"  [conflict, left alone] meeting {item['id']}: has {item['old']}, Glyphdex says {item['new']}")

    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    backup = os.path.join(HERE, f"minutes-url-backup-{stamp}.json")
    with open(backup, "w") as handle:
        json.dump({"note": "current meetings.minutes_url for the rows in plan['update']; restore by setting these values",
                   "rows": plan["update"], "conflicts": plan["conflict"]}, handle, indent=2)
    print(f"Backup of current values: {backup}")

    if not args.apply:
        print(f"Dry-run: would update {len(plan['update'])} meeting(s). Re-run with --apply to write.")
        return
    for item in plan["update"]:
        supabase.table("meetings").update({"minutes_url": item["new"]}).eq("id", item["id"]).execute()
    print(f"Updated {len(plan['update'])} meeting(s).")


if __name__ == "__main__":
    main()
