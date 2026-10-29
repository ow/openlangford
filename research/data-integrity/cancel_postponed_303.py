"""Meeting 303 (Committee of the Whole, 2023-04-11) was postponed: eSCRIBE lists only an agenda
cover and "NOTICE - Postponement of the Committee of the Whole Meeting" (DocumentId=5418), with no
minutes, video or attendance. Mark it Cancelled so it never counts toward attendance.
Dry run by default; --apply writes a backup and updates with a CAS on status."""
import json, sys, datetime, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "apps/pipeline"))
from supabase import create_client
from pipeline import config

s = create_client(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY)
row = s.table("meetings").select("*").eq("id", 303).single().execute().data
assert row["meeting_date"] == "2023-04-11" and row["title"] == "Committee of the Whole", row
assert s.table("attendance").select("id", count="exact").eq("meeting_id", 303).execute().count == 0
meta = dict(row.get("meta") or {})
meta["cancellation"] = {
    "reason": "postponed",
    "source_title": "NOTICE - Postponement of the Committee of the Whole Meeting",
    "source_url": "https://pub-langford.escribemeetings.com/FileStream.ashx?DocumentId=5418",
    "recorded_at": datetime.date.today().isoformat(),
}
update = {"status": "Cancelled", "meta": meta}
print("current status:", row["status"], "->", update)
if "--apply" not in sys.argv:
    sys.exit("dry run; pass --apply")
backup = pathlib.Path(__file__).with_name(f"backup-meeting-303-{datetime.datetime.now():%Y%m%d-%H%M%S}.json")
backup.write_text(json.dumps(row, indent=1, default=str))
res = s.table("meetings").update(update).eq("id", 303).eq("status", row["status"]).execute()
assert len(res.data) == 1, res
print("applied; backup", backup.name)
