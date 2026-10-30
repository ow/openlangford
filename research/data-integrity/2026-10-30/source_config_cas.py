"""Add every Langford eSCRIBE meeting type to source_config.meeting_types (backup + compare-and-swap).
usage: config_cas.py BACKUP_DIR [--apply]
"""
import sys, os, json, re
from urllib.parse import unquote_plus
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from db import sb

D = os.path.dirname(os.path.abspath(__file__))
backup_dir, apply = sys.argv[1], "--apply" in sys.argv
row = sb.table("municipalities").select("*").eq("slug", "langford").single().execute().data
old = row["source_config"]
cal = open(os.path.join(D, "dl", "cal.html"), encoding="utf-8").read()
portal = sorted({unquote_plus(t) for t in re.findall(r'Expanded=([^"&]*)', cal)})
types = list(old["meeting_types"]) + [t for t in portal if t not in old["meeting_types"]]
new = {**old, "meeting_types": types}
print("added:", [t for t in types if t not in old["meeting_types"]])
print("columns:", sorted(row))
os.makedirs(backup_dir, exist_ok=True)
stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
json.dump({"municipality_id": row["id"], "source_config_before": old, "source_config_after": new},
          open(os.path.join(backup_dir, f"langford-source-config-{stamp}.json"), "w"), indent=1)
if apply:
    q = sb.table("municipalities").update({"source_config": new}).eq("id", row["id"])
    q = q.eq("updated_at", row["updated_at"]) if "updated_at" in row else q.filter("source_config", "eq", json.dumps(old))
    res = q.execute().data
    if len(res) != 1:
        sys.exit("compare-and-swap failed: config changed concurrently; nothing written")
    after = sb.table("municipalities").select("source_config").eq("id", row["id"]).single().execute().data["source_config"]
    assert after == new, "post-write mismatch"
    print("updated; verified")
