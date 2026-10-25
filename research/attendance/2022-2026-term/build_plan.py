"""Issue #56: evidence-backed council attendance for the whole 2022-2026 term.

Builds a finite plan (no writes) for every Council-classified meeting in the term that has minutes:
page 1 of the original signed minutes PDF read with column layout preserved, every sitting council
member classified exactly once (present/absent) or held with a reason. Also writes before.json (all
existing attendance rows for the planned meetings).
Run from apps/pipeline: uv run python ../../research/attendance/2022-2026-term/build_plan.py
"""
import hashlib, json, os, re, sys
from collections import Counter
from datetime import datetime, date
from pathlib import Path
sys.path.insert(0, os.getcwd())
from supabase import create_client
from pipeline import config
from pipeline.ingestion.minutes_roster import first_page_text, parse_roster, surname

TERM_START, TERM_END = "2022-11-07", "2026-11-01"
ROOT = Path(os.environ.get("ARCHIVE_ROOT", Path(__file__).resolve().parents[3]))  # archive/ lives in the main checkout
HERE = Path(__file__).parent
sb = create_client(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY)
council = sb.table("organizations").select("id").eq("name", "Council").eq("classification", "Council").single().execute().data["id"]
members = sb.table("memberships").select("person_id,start_date,end_date,person:people(name)").eq("organization_id", council).execute().data
today = date.today().isoformat()
meetings = (sb.table("meetings").select("id,meeting_date,archive_path,status,title").eq("organization_id", council)
            .gte("meeting_date", TERM_START).lte("meeting_date", min(TERM_END, today)).order("meeting_date").execute().data)
meetings = [m for m in meetings if not re.match(r"^(planned|cancelled|canceled)$", (m["status"] or ""), re.I)]
records, holds, sources = [], [], []
for meeting in meetings:
    mid = meeting["id"]
    base = {"meeting_id": mid, "meeting_date": meeting["meeting_date"]}
    docs = sb.table("documents").select("file_path,source_url").eq("meeting_id", mid).ilike("category", "%minute%").execute().data
    pdfs = [d for d in docs if (d["file_path"] or "").lower().endswith(".pdf")]
    doc = next((d for d in pdfs if "signed" in (d["file_path"] or "").lower()), None) or (pdfs[0] if pdfs else None)
    if not docs:
        holds.append({**base, "reason": "no minutes"}); continue
    if not doc:
        holds.append({**base, "reason": "minutes are not a PDF", "files": [d["file_path"] for d in docs]}); continue
    if not doc["source_url"] or not doc["source_url"].startswith("https://"):
        holds.append({**base, "reason": "no https source_url"}); continue
    path = ROOT / (meeting["archive_path"] or "") / (doc["file_path"] or "")
    if not path.is_file():
        holds.append({**base, "reason": "minutes PDF not in archive", "file": str(path)}); continue
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    text = first_page_text(str(path))
    d = datetime.fromisoformat(meeting["meeting_date"])
    flat = re.sub(r",\s*", ", ", re.sub(r"\s+", " ", text))
    if d.strftime("%B ") + str(d.day) + ", " + str(d.year) not in flat:
        found = re.findall(r"(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, ?\d{4}", flat)
        holds.append({**base, "reason": "page-1 date does not match meeting date" if found else "no extractable page-1 date (scanned or unreadable)", "page_1_dates": found[:3]}); continue
    roster = parse_roster(text)
    if not roster["present"] and not roster["absent"]:
        holds.append({**base, "reason": "no named roster on page 1", "sections": roster["sections"]}); continue
    sitting = [m for m in members if m["start_date"] <= meeting["meeting_date"] and (not m["end_date"] or meeting["meeting_date"] <= m["end_date"])]
    sources.append({**base, "local_date": meeting["meeting_date"], "file": str(path.relative_to(ROOT)), "source_url": doc["source_url"], "source_sha256": sha})
    for member in sitting:
        last = surname(member["person"]["name"].split()[-1])
        hits = [(state, entry) for state in ("present", "absent") for entry in roster[state] if surname(entry[0]) == last]
        if len(hits) != 1:
            holds.append({**base, "person_id": member["person_id"], "person": member["person"]["name"], "reason": f"{len(hits)} roster matches"}); continue
        state, (name, remote, line) = hits[0]
        section = "PRESENT" if state == "present" else next(k for k in ("ABSENT", "REGRETS") if k in roster["sections"])
        quote = ("PRESENT:" if state == "present" else "ABSENT:") + "\n" + roster["sections"][section]
        evidence = {"schema": "council-attendance/v1", "method": "original_roster", "state": state, "meeting_id": mid,
                    "person_id": member["person_id"], "local_date": meeting["meeting_date"], "source_url": doc["source_url"],
                    "source_sha256": sha, "source_page": 1, "source_quote": quote,
                    "review": "Original signed minutes, page 1 read with column layout preserved (pdftotext -layout); explicit named roster section"
                              + (", listed as remote" if remote else "") + ". Presence does not assert full-meeting duration or physical modality.",
                    "reviewed_meeting_state": state}
        records.append({"meeting_id": mid, "person_id": member["person_id"], "attendance_mode": "Unknown" if state == "present" else "Absent",
                        "notes": json.dumps(evidence, sort_keys=True, separators=(",", ":"))})
mids = [m["id"] for m in meetings]
before = []
for i in range(0, len(mids), 50):
    before += sb.table("attendance").select("*").in_("meeting_id", mids[i:i + 50]).limit(5000).execute().data
(HERE / "before.json").write_text(json.dumps(before, indent=1, sort_keys=True) + "\n")
(HERE / "plan.json").write_text(json.dumps({"schema": "attendance-correction/v1", "issue": 56, "term": [TERM_START, TERM_END], "built": today,
    "meeting_ids": mids, "sources": sources, "records": records, "holds": holds}, indent=2) + "\n")
print(json.dumps({"meetings_in_term": len(mids), "meetings_with_roster": len(sources), "records": len(records),
                  "states": Counter(json.loads(r["notes"])["state"] for r in records),
                  "hold_reasons": Counter(h["reason"] for h in holds), "before_rows": len(before)}, default=str, indent=1))
