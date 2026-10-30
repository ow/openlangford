"""Record eSCRIBE meeting IDs for meetings we already hold (Glyphdex imports + one unlinked eSCRIBE row).

Writes/updates source_meetings(source_type='escribe', source_id=<eSCRIBE GUID>) with
archive_path = the existing meeting's folder and ingested_meeting_id = that meeting, which is exactly
where discovery's dedupe (_pin_known_archive_paths / upsert_source_meetings) looks.

usage: link_gx.py BACKUP_DIR [--apply]
"""
import sys, os, json, dataclasses
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, os.getcwd())
from db import sb, all_rows
from pipeline.scrapers.escribe import EscribeScraper
from pipeline.scrapers.base import MunicipalityConfig
from pipeline.ops import meeting_source_record

D = os.path.dirname(os.path.abspath(__file__))
backup_dir, apply = sys.argv[1], "--apply" in sys.argv
plan = json.load(open(os.path.join(D, "match_plan.json")))
inv = json.load(open(os.path.join(D, "inventory.json")))
raw_by_id = {r["Id"].lower(): (t, r) for t, rows in inv.items() for r in rows}

links = {p["escribe_id"]: p["meeting_id"] for p in plan if p["state"] == "match"}
# Resolved by hand: the 7 pm Special Inaugural Council Meeting is meeting 967 (its own player URL and folder
# carry this GUID); the 5:30 pm 'Inaugural Council Meeting' entry is only a cancellation notice.
links["11caee49-20fe-4e1a-833a-697a339e4f04"] = 967

muni_row = sb.table("municipalities").select("*").eq("slug", "langford").single().execute().data
muni = MunicipalityConfig.from_db_row(muni_row)
scraper = EscribeScraper(dataclasses.replace(muni, source_config={**muni.source_config, "meeting_types": []}))
# Build ScrapedMeetings exactly as discovery would, from the saved portal inventory.
scraper._fetch_meetings_for_type = lambda t: [r for (tt, r) in raw_by_id.values() if tt == t]
scraper.meeting_types = sorted({raw_by_id[e][0] for e in links})
scraped = {m.source_id.lower(): m for m in scraper.discover_meetings()}

meetings = {m["id"]: m for m in all_rows(lambda: sb.table("meetings").select("id,meeting_date,title,type,organization_id,archive_path,video_url,status").in_("id", list(links.values())))}
existing = all_rows(lambda: sb.table("source_meetings").select("*").eq("municipality_id", 1).eq("source_type", "escribe").in_("source_id", list(links)))
existing_by_id = {r["source_id"]: r for r in existing}
claimed = all_rows(lambda: sb.table("source_meetings").select("id,source_id,ingested_meeting_id").eq("municipality_id", 1).in_("ingested_meeting_id", list(links.values())))

records, problems = [], []
for eid, mid in sorted(links.items(), key=lambda kv: meetings[kv[1]]["meeting_date"]):
    m, sm = meetings[mid], scraped.get(eid)
    if not sm:
        problems.append((eid, "not in scrape")); continue
    if sm.date.isoformat() != m["meeting_date"]:
        problems.append((eid, "date differs")); continue
    other = [c for c in claimed if c["ingested_meeting_id"] == mid and c["source_id"] != eid]
    if other:
        problems.append((eid, f"meeting {mid} already linked to {other}")); continue
    rec = meeting_source_record(muni, "escribe", sm, archive_path=m["archive_path"], status="ingested")
    rec["status"] = "ingested"  # an existing, ingested public meeting
    rec["ingested_meeting_id"] = mid
    rec["raw"]["linked_existing_meeting"] = {"meeting_id": mid, "method": "date+body+time (+player.url GUID where present)",
                                             "linked_at": datetime.now(timezone.utc).isoformat()}
    records.append(rec)

print(f"links={len(records)} problems={problems}")
print(f"source rows: insert={sum(r['source_id'] not in existing_by_id for r in records)} update={sum(r['source_id'] in existing_by_id for r in records)}")
for r in records[:3] + records[-3:]:
    print(" ", r["meeting_date"], r["title"], "->", r["ingested_meeting_id"], r["archive_path"])

os.makedirs(backup_dir, exist_ok=True)
stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
with open(os.path.join(backup_dir, f"escribe-link-backup-{stamp}.json"), "w") as f:
    json.dump({"note": "source_meetings rows before linking (absent = inserted) and the meetings they point at",
               "source_meetings_before": existing, "meetings": list(meetings.values()),
               "planned_records": records, "problems": problems}, f, indent=1, default=str)
if problems:
    sys.exit("refusing: problems present")
if apply:
    res = sb.table("source_meetings").upsert(records, on_conflict="municipality_id,source_type,source_id").execute()
    print("upserted", len(res.data or []))
else:
    print("dry run; pass --apply to write")
