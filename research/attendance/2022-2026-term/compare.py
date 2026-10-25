"""Compare plan.json with the pre-existing attendance rows in before.json (read-only).

Writes disagreements.json and prints counts. Old rows with valid council-attendance/v1 evidence are
reported separately (they are replaced by an equivalent record when the roster agrees).
Run: python3 research/attendance/2022-2026-term/compare.py
"""
import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent
plan = json.loads((HERE / "plan.json").read_text())
before = {(r["meeting_id"], r["person_id"]): r for r in json.loads((HERE / "before.json").read_text())}


def old_state(row):
    try:
        ev = json.loads(row["notes"] or "null")
        if ev and ev.get("schema") == "council-attendance/v1":
            return ev["state"], True
    except Exception:
        pass
    mode = row["attendance_mode"]
    return ("present" if mode in ("In Person", "Remote") else "absent" if mode in ("Absent", "Regrets") else "unknown"), False


tally, disagreements = Counter(), []
for rec in plan["records"]:
    new = json.loads(rec["notes"])["state"]
    row = before.get((rec["meeting_id"], rec["person_id"]))
    if not row:
        tally["no previous row (insert)"] += 1
        continue
    old, had_evidence = old_state(row)
    if had_evidence:
        tally[f"previous evidence row, same state" if old == new else "previous evidence row, DIFFERENT state"] += 1
        if old != new:
            disagreements.append({"meeting_id": rec["meeting_id"], "person_id": rec["person_id"], "old": old, "old_mode": row["attendance_mode"], "roster": new, "kind": "evidence-vs-roster"})
    elif old == new:
        tally["old AI row agrees"] += 1
    elif old == "unknown":
        tally["old row unknown/Unknown mode (roster resolves it)"] += 1
    else:
        tally["old AI row DISAGREES"] += 1
        disagreements.append({"meeting_id": rec["meeting_id"], "person_id": rec["person_id"], "old": old, "old_mode": row["attendance_mode"], "roster": new, "kind": "ai-vs-roster"})
planned = {(r["meeting_id"], r["person_id"]) for r in plan["records"]}
orphan = [k for k in before if k[0] in {s["meeting_id"] for s in plan["sources"]} and k not in planned]
tally["old rows in planned meetings not touched (non-sitting/extra people)"] = len(orphan)
(HERE / "disagreements.json").write_text(json.dumps(disagreements, indent=1) + "\n")
print(json.dumps(tally, indent=1))
for d in disagreements:
    print(d)
