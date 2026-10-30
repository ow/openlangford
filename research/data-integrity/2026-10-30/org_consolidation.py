"""File every Langford committee/board meeting under its own organization and type.

Body comes from the meeting title (escribe_body), or for generic 'Advisory Committee' titles from the linked
eSCRIBE MeetingType. Also links the misfiled 2023-07-26 Board of Variance meeting to its eSCRIBE ID.
usage: consolidate.py BACKUP_DIR [--apply]
"""
import sys, os, json, collections
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, os.getcwd())
from db import sb, all_rows
from pipeline.scrapers.escribe_bodies import escribe_body

backup_dir, apply = sys.argv[1], "--apply" in sys.argv
orgs = {o["name"]: o for o in all_rows(lambda: sb.table("organizations").select("*").eq("municipality_id", 1))}
org_by_id = {o["id"]: o for o in orgs.values()}
ms = all_rows(lambda: sb.table("meetings").select("id,meeting_date,title,type,organization_id,archive_path,status,slug").eq("municipality_id", 1))
src = all_rows(lambda: sb.table("source_meetings").select("id,source_id,ingested_meeting_id,title,raw").eq("municipality_id", 1).eq("source_type", "escribe"))
src_type = collections.defaultdict(set)
for s in src:
    if s["ingested_meeting_id"]:
        src_type[s["ingested_meeting_id"]].add(((s.get("raw") or {}).get("escribe_meeting") or {}).get("MeetingType") or s["title"])

changes, unresolved = [], []
for m in ms:
    body = escribe_body(m["title"])
    via = "title"
    if not body and (m["title"] or "").strip().lower() == "advisory committee":
        bodies = {escribe_body(t) for t in src_type.get(m["id"], set())}
        body = next(iter(bodies)) if len(bodies) == 1 else None
        via = "escribe type"
        if not body:
            unresolved.append(m); continue
    if not body:
        continue
    org = orgs.get(body.name)
    if not org:
        unresolved.append({**m, "missing_org": body.name}); continue
    upd = {}
    if m["organization_id"] != org["id"]:
        upd["organization_id"] = org["id"]
    if m["type"] != body.meeting_type:
        upd["type"] = body.meeting_type
    if via == "escribe type" and m["title"] != body.title:
        upd["title"] = body.title
    if upd:
        changes.append({"meeting": m, "update": upd, "via": via,
                        "from_org": org_by_id.get(m["organization_id"], {}).get("name")})

print("changes:", len(changes), "unresolved:", unresolved)
print(collections.Counter((c["from_org"], org_by_id[c["update"].get("organization_id", c["meeting"]["organization_id"])]["name"],
                           tuple(sorted(c["update"]))) for c in changes))
mem = all_rows(lambda: sb.table("memberships").select("*").in_("organization_id", [28, 9, 18, 37]))
print("memberships on 28/9/18/37:", collections.Counter(r["organization_id"] for r in mem))
remaining_28 = [m["id"] for m in ms if m["organization_id"] == 28 and m["id"] not in {c["meeting"]["id"] for c in changes if "organization_id" in c["update"]}]
print("meetings left on generic org 28:", remaining_28)

stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
os.makedirs(backup_dir, exist_ok=True)
bov_src = [s for s in src if s["source_id"] == "ce032961-d6eb-4546-86ba-408e15e47e8e"]
with open(os.path.join(backup_dir, f"org-consolidation-backup-{stamp}.json"), "w") as f:
    json.dump({"note": "meetings rows before org/type/title consolidation; memberships on affected orgs (unchanged)",
               "changes": changes, "memberships": mem, "bov_source_rows_before": bov_src}, f, indent=1, default=str)
if not apply:
    print("dry run; pass --apply"); sys.exit()
for c in changes:
    sb.table("meetings").update(c["update"]).eq("id", c["meeting"]["id"]).execute()
print("updated", len(changes))
