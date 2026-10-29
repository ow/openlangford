"""Matter 1791 (Purchasing Policy, POL-0031-FIN) was rescinded on June 1, 2026 by motion 1474
(meeting 143, item 2269), which approved POL-0185-FIN (matter 46) and rescinded POL-0031-FIN.
Mark it Repealed with meta.superseded_by so matter-summaries keeps that status.
Dry run by default; --apply writes a backup and updates with a CAS on updated_at."""
import json, sys, datetime, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "apps/pipeline"))
from supabase import create_client
from pipeline import config

s = create_client(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY)
row = s.table("matters").select("id,identifier,status,meta,updated_at").eq("id", 1791).single().execute().data
assert row["identifier"] == "POL-0031-FIN", row
motion = s.table("motions").select("id,text_content,result,meeting_id").eq("id", 1474).single().execute().data
assert "POL-0031-FIN" in motion["text_content"] and "rescind" in motion["text_content"].lower(), "motion does not rescind POL-0031-FIN"
meta = dict(row.get("meta") or {})
meta["superseded_by"] = {"matter_id": 46, "identifier": "POL-0185-FIN", "date": "2026-06-01", "motion_id": 1474, "meeting_id": motion["meeting_id"]}
meta["status_line"] = "Rescinded June 1, 2026 and replaced by the new Purchasing Policy (POL-0185-FIN)."
update = {"status": "Repealed", "meta": meta}
print(row["status"], "->", update["status"], "|", meta["status_line"], "| motion result:", motion["result"])
if "--apply" not in sys.argv:
    sys.exit("dry run; pass --apply")
backup = pathlib.Path(__file__).with_name(f"backup-matter-1791-{datetime.datetime.now():%Y%m%d-%H%M%S}.json")
backup.write_text(json.dumps(row, indent=1, default=str))
res = s.table("matters").update(update).eq("id", 1791).eq("updated_at", row["updated_at"]).execute()
assert len(res.data) == 1, res
print("applied; backup", backup.name)
