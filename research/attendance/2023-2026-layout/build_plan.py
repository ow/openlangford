"""Issue #56: council attendance for meetings whose minutes interleave PRESENT/ATTENDING columns.

Builds a finite plan (no writes) from the original signed minutes PDFs: page-1 roster read with
its column layout preserved, every sitting council member classified exactly once or held.
Run from apps/pipeline: uv run python ../../research/attendance/2023-2026-layout/build_plan.py
"""
import hashlib, json, os, re, sys
from datetime import datetime
from pathlib import Path
sys.path.insert(0, os.getcwd())
from supabase import create_client
from pipeline import config
from pipeline.ingestion.minutes_roster import first_page_text, parse_roster, surname

MEETINGS = [207, 216, 285, 280, 205, 183, 307, 272, 329, 294, 160, 386, 162]
ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).with_name("plan.json")
sb = create_client(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY)
council = sb.table("organizations").select("id").eq("name", "Council").eq("classification", "Council").single().execute().data["id"]
members = sb.table("memberships").select("person_id,start_date,end_date,person:people(name)").eq("organization_id", council).execute().data
records, holds, sources = [], [], []
for mid in MEETINGS:
    meeting = sb.table("meetings").select("id,meeting_date,archive_path").eq("id", mid).single().execute().data
    docs = sb.table("documents").select("file_path,source_url").eq("meeting_id", mid).ilike("category", "%minute%").execute().data
    doc = next((d for d in docs if "signed" in (d["file_path"] or "").lower()), None) or (docs[0] if docs else None)
    if not doc:
        holds.append({"meeting_id": mid, "reason": "no minutes"}); continue
    path = ROOT / meeting["archive_path"] / doc["file_path"]
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    text = first_page_text(str(path))
    date = datetime.fromisoformat(meeting["meeting_date"])
    if date.strftime("%B ") + str(date.day) + ", " + str(date.year) not in re.sub(r"\s+", " ", text):
        holds.append({"meeting_id": mid, "reason": "page-1 date does not match meeting date"}); continue
    roster = parse_roster(text)
    sitting = [m for m in members if m["start_date"] <= meeting["meeting_date"] and (not m["end_date"] or meeting["meeting_date"] <= m["end_date"])]
    if not roster["present"] and not roster["absent"]:
        holds.append({"meeting_id": mid, "reason": "no named roster on page 1", "sections": roster["sections"]}); continue
    sources.append({"meeting_id": mid, "local_date": meeting["meeting_date"], "file": str(path.relative_to(ROOT)), "source_url": doc["source_url"], "source_sha256": sha})
    for member in sitting:
        last = surname(member["person"]["name"].split()[-1])
        hits = [(state, entry) for state in ("present", "absent") for entry in roster[state] if surname(entry[0]) == last]
        if len(hits) != 1:
            holds.append({"meeting_id": mid, "person_id": member["person_id"], "reason": f"{len(hits)} roster matches"}); continue
        state, (name, remote, line) = hits[0]
        quote = ("PRESENT:" if state == "present" else "ABSENT:") + "\n" + roster["sections"]["PRESENT" if state == "present" else next(k for k in ("ABSENT", "REGRETS") if k in roster["sections"])]
        evidence = {"schema": "council-attendance/v1", "method": "original_roster", "state": state, "meeting_id": mid,
                    "person_id": member["person_id"], "local_date": meeting["meeting_date"], "source_url": doc["source_url"],
                    "source_sha256": sha, "source_page": 1, "source_quote": quote,
                    "review": "Original signed minutes, page 1 read with column layout preserved (pdftotext -layout); explicit named roster section"
                              + (", listed as remote" if remote else "") + ". Presence does not assert full-meeting duration or physical modality.",
                    "reviewed_meeting_state": state}
        records.append({"meeting_id": mid, "person_id": member["person_id"], "attendance_mode": "Unknown" if state == "present" else "Absent",
                        "notes": json.dumps(evidence, sort_keys=True, separators=(",", ":"))})
OUT.write_text(json.dumps({"schema": "attendance-correction/v1", "issue": 56, "sources": sources, "records": records, "holds": holds}, indent=2) + "\n")
from collections import Counter
print(json.dumps({"records": len(records), "states": Counter(json.loads(r["notes"])["state"] for r in records), "holds": holds, "meetings": len(sources)}, default=str, indent=1))
