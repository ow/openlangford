#!/usr/bin/env python3
"""Insert the historical council terms + memberships from plan.json (insert-only).

Usage: apply.py            # dry run, prints the plan
       apply.py --apply    # writes backup JSON, then inserts in one transaction
"""
import json, os, subprocess, sys, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = "/Users/owen/Projects/viewroyal/.env"
url = next(l.split("=", 1)[1].strip().strip("\"'") for l in open(ENV) if l.startswith("DATABASE_URL"))
PSQL = "/opt/homebrew/opt/libpq/bin/psql"
plan = json.load(open(f"{HERE}/plan.json"))
APPLY = "--apply" in sys.argv


def run(sql, **kw):
    return subprocess.run([PSQL, url, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True, check=True, **kw).stdout


def lit(s):
    return "'" + s.replace("'", "''") + "'"


for t in plan["terms"]:
    print(f"TERM {t['name']}  {t['start_date']} .. {t['end_date']}  (start: {t['start_source']}; end: {t['end_basis']})")
    for m in plan["memberships"]:
        if m["term"] == t["name"]:
            print(f"   {m['role']:10} {m['person_name']:17} (person {m['person_id']})  first_present={m['first_present']} last_present={m['last_present']}")
if not APPLY:
    sys.exit(0)

stamp = datetime.date.today().isoformat()
backup = {
    "council_terms": json.loads(run("select coalesce(json_agg(t),'[]') from council_terms t") or "[]"),
    "memberships_council_org": json.loads(run("select coalesce(json_agg(m),'[]') from memberships m where organization_id=1") or "[]"),
}
bp = f"{HERE}/backup-{stamp}.json"
json.dump(backup, open(bp, "w"), indent=1)
print("backup ->", bp)

stmts = ["begin;"]
for t in plan["terms"]:
    meta = {"historical_import": {"election_date": t["election_date"], "start_source": t["start_source"], "end_basis": t["end_basis"],
                                  "method": "research/council-terms: PRESENT rosters of all minutes in term; no mid-term changes found",
                                  "verified_on": stamp}}
    stmts.append(
        f"insert into council_terms (municipality_id,election_id,name,start_date,end_date,meta) "
        f"select 1,null,{lit(t['name'])},{lit(t['start_date'])},{lit(t['end_date'])},{lit(json.dumps(meta, ensure_ascii=False))}::jsonb "
        f"where not exists (select 1 from council_terms where municipality_id=1 and start_date={lit(t['start_date'])});")
    for m in plan["memberships"]:
        if m["term"] != t["name"]:
            continue
        mm = {"interval_kind": "elected_term_from_inaugural_meeting", "start_source": m["start_source"], "end_basis": m["end_source"],
              "first_present": m["first_present"], "last_present": m["last_present"], "verified_on": stamp}
        stmts.append(
            f"insert into memberships (person_id,organization_id,role,start_date,end_date,council_term_id,meta) "
            f"select {m['person_id']},1,{lit(m['role'])},{lit(m['start_date'])},{lit(m['end_date'])},ct.id,{lit(json.dumps(mm))}::jsonb "
            f"from council_terms ct where ct.municipality_id=1 and ct.start_date={lit(t['start_date'])} "
            f"and not exists (select 1 from memberships x where x.person_id={m['person_id']} and x.organization_id=1 and x.role={lit(m['role'])} and x.council_term_id=ct.id);")
stmts.append("commit;")
out = subprocess.run([PSQL, url, "-v", "ON_ERROR_STOP=1", "-c", "\n".join(stmts)], capture_output=True, text=True)
print(out.stdout, out.stderr)
