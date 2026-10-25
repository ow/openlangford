"""Apply plan.json: upsert on (meeting_id, person_id) in one transaction. Never deletes.

Default is a dry run (rolls back). Aborts if any attendance row in the planned meetings differs from
before.json (stale plan). Run from apps/pipeline: uv run python ../../research/attendance/2022-2026-term/apply.py [--apply]
"""
import json, os, sys
from pathlib import Path
sys.path.insert(0, os.getcwd())
import psycopg2
from psycopg2.extras import RealDictCursor, execute_values
from pipeline import config

HERE = Path(__file__).parent
plan = json.loads((HERE / "plan.json").read_text())
before = {(r["meeting_id"], r["person_id"]): r for r in json.loads((HERE / "before.json").read_text())}
conn = psycopg2.connect(config.DATABASE_URL)
cur = conn.cursor(cursor_factory=RealDictCursor)
cur.execute("SELECT * FROM attendance WHERE meeting_id = ANY(%s)", (plan["meeting_ids"],))
now = {(r["meeting_id"], r["person_id"]): r for r in cur.fetchall()}
for key, row in now.items():
    old = before.get(key)
    assert old and all(str(old[k]) == str(row[k]) or (old[k] is None and row[k] is None) for k in ("id", "attendance_mode", "notes")), f"stale before-image: {key}"
assert set(before) <= set(now), "rows deleted since before.json"
todo = [r for r in plan["records"] if not (now.get((r["meeting_id"], r["person_id"])) and now[(r["meeting_id"], r["person_id"])]["notes"] == r["notes"]
                                              and now[(r["meeting_id"], r["person_id"])]["attendance_mode"] == r["attendance_mode"])]
print(f"records {len(plan['records'])}; to write {len(todo)} (updates {sum((r['meeting_id'], r['person_id']) in now for r in todo)}, inserts {sum((r['meeting_id'], r['person_id']) not in now for r in todo)})")
execute_values(cur, """INSERT INTO attendance (meeting_id, person_id, attendance_mode, notes) VALUES %s
    ON CONFLICT (meeting_id, person_id) DO UPDATE SET attendance_mode = EXCLUDED.attendance_mode, notes = EXCLUDED.notes, updated_at = now()""",
               [(r["meeting_id"], r["person_id"], r["attendance_mode"], r["notes"]) for r in todo])
if "--apply" in sys.argv:
    conn.commit(); print("committed")
else:
    conn.rollback(); print("dry run, rolled back")
