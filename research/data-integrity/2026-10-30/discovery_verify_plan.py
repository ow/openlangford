"""Prove the discovery plan: which 'new' meetings would become meetings, and what gap-fill would add."""
import sys, os, json, collections
from dotenv import load_dotenv
load_dotenv("/Users/owen/Projects/viewroyal/.env")
sys.path.insert(0, os.getcwd())
import pipeline.paths as paths
paths.BASE_DIR = "/Users/owen/Projects/viewroyal"
from pipeline import orchestrator
orchestrator.BASE_DIR = paths.BASE_DIR
from pipeline.orchestrator import Archiver, load_municipality
from pipeline.ops import source_document_status
from pipeline.source_identity import gap_fill_documents, DuplicateGuard

plan = json.load(open(sys.argv[1]))
D = os.path.dirname(os.path.abspath(__file__))
inv = json.load(open(os.path.join(D, "inventory.json")))
app = Archiver(municipality=load_municipality("langford"), initialize_diarizer=False)
raw = {r["Id"]: (t, r) for t, rows in inv.items() for r in rows}
app.scraper._fetch_meetings_for_type = lambda t: [r for (tt, r) in raw.values() if tt == t]
meetings = {m.source_id: m for m in app.scraper.discover_meetings()}
status = collections.Counter(); would_ingest = []
for sid, e in plan.items():
    m = meetings[sid]
    if e["action"] == "new":
        st = source_document_status(m, "discovered")
        status[st] += 1
        cats = {d.category for d in m.documents}
        if st == "discovered":
            would_ingest.append((e["date"], e["title"], sorted(cats)))
    elif e["action"] == "linked" and e.get("foreign_folder"):
        filled, _ = gap_fill_documents(m, e["archive_root"])
        if filled.documents or filled.meta["escribe_meeting"]["MeetingLinks"]:
            print("gap-fill would add", e["date"], e["title"], [(d.category, d.title) for d in filled.documents],
                  [l["Title"] for l in filled.meta["escribe_meeting"]["MeetingLinks"]])
print("new by source status:", status)
print("new meetings with official documents (would be ingested):", would_ingest)
# Independent duplicate check: every 'new' meeting against all held meetings that day, any body.
sb = app._get_admin_supabase()
g = DuplicateGuard(sb, 1).load(e["date"] for e in plan.values() if e["action"] == "new")
for sid, e in plan.items():
    if e["action"] == "new":
        same_day = [(r["id"], r["title"], r["type"]) for r in g.by_date.get(e["date"], [])]
        if same_day:
            print("same-day held meetings for new", e["date"], e["title"], "->", same_day, "linked:", [sorted(g.linked.get(r[0], [])) for r in same_day])
