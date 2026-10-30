"""Match every eSCRIBE meeting (inventory.json) to an existing DB meeting, if any. Read-only.

Writes match_plan.json with one record per eSCRIBE meeting:
  state: linked (source row already points at a meeting) | match (unique same-day same-body meeting)
         | match_shift (unique +-1 day, flagged) | ambiguous | none (genuinely not in DB)
"""
import sys, os, json, re, collections
from datetime import date, timedelta
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, os.getcwd())
from db import sb, all_rows

D = os.path.dirname(os.path.abspath(__file__))
ARCH = "/Users/owen/Projects/viewroyal"
inv = json.load(open(os.path.join(D, "inventory.json")))

# eSCRIBE type -> (orgs that may hold it today, db types, special?)
COUNCIL = {1}
BODY = {
    "Council Meeting": (COUNCIL, {"Regular Council"}, None),
    "Special Council Meeting": (COUNCIL, {"Special Council"}, None),
    "Committee of the Whole Meeting": (COUNCIL, {"Committee of the Whole"}, None),
    "Inaugural Council Meeting": (COUNCIL, {"Inauguration", "Special Council", "Regular Council"}, None),
    "Special Inaugural Council Meeting": (COUNCIL, {"Inauguration", "Special Council"}, None),
    "Public Hearing": (COUNCIL, {"Public Hearing"}, None),
    "Administration and Finance Committee": ({33}, {"Standing Committee"}, False),
    "Special Administration and Finance Committee": ({33}, {"Standing Committee"}, True),
    "Board of Variance": ({37}, {"Board of Variance"}, None),
    "Capital West Accessibility Advisory Committee": ({31, 28}, {"Advisory Committee"}, False),
    "Special Capital West Accessibility Advisory Committee": ({31, 28}, {"Advisory Committee"}, True),
    "Community Advisory Committee": ({9, 28}, {"Advisory Committee"}, False),
    "Special Community Advisory Committee": ({9, 28}, {"Advisory Committee"}, True),
    "Parks, Recreation, Culture and Beautification Committee": ({34}, {"Standing Committee"}, False),
    "Parks, Recreation, Environment, Culture, and Beautification Committee": ({34}, {"Standing Committee"}, False),
    "Planning Zoning and Affordable Housing Committee": ({32}, {"Standing Committee"}, False),
    "Planning, Zoning and Affordable Housing Committee Meeting": ({32}, {"Standing Committee"}, False),
    "Special Planning, Zoning and Affordable Housing Committee": ({32}, {"Standing Committee"}, True),
    "Protective Services Committee": ({35}, {"Standing Committee"}, False),
    "Sustainable Development Advisory Committee": ({18, 28}, {"Advisory Committee"}, False),
    "Special Sustainable Development Advisory Committee": ({18, 28}, {"Advisory Committee"}, True),
    "Transportation and Public Works Committee": ({36}, {"Standing Committee"}, False),
}
# Words that must appear in a meeting title held on a shared org (28 = generic advisory).
TITLE_KEY = {"Sustainable Development": "sustainable development", "Capital West": "capital west",
             "Community Advisory": None}

meetings = all_rows(lambda: sb.table("meetings").select(
    "id,meeting_date,type,title,organization_id,archive_path,video_url,status,calendar_source_id").eq("municipality_id", 1))
by_date = collections.defaultdict(list)
for m in meetings:
    by_date[m["meeting_date"]].append(m)
srcs = all_rows(lambda: sb.table("source_meetings").select(
    "id,source_type,source_id,ingested_meeting_id,archive_path,status,title,meeting_date").eq("municipality_id", 1))
esc_src = {s["source_id"]: s for s in srcs if s["source_type"] == "escribe"}
linked_meeting = collections.defaultdict(set)
for s in srcs:
    if s["source_type"] == "escribe" and s["ingested_meeting_id"]:
        linked_meeting[s["ingested_meeting_id"]].add(s["source_id"])


def player_id(m):
    if not m.get("archive_path"):
        return None
    p = os.path.join(ARCH, m["archive_path"], "Video", "player.url")
    if not os.path.exists(p):
        return None
    mt = re.search(r"Id=([0-9a-f-]{36})", open(p).read(), re.I)
    return mt.group(1).lower() if mt else None


def title_ok(raw_type, m):
    t = (m["title"] or "").lower()
    special = BODY[raw_type][2]
    if special is not None and (("special" in t) != special):
        return False
    if m["organization_id"] == 28:  # generic advisory org holds several committees
        if "sustainable development" in raw_type.lower():
            return "sustainable development" in t
        if "community advisory" in raw_type.lower():
            return "sustainable" not in t and "capital west" not in t
        if "capital west" in raw_type.lower():
            return "capital west" in t
    return True


def candidates(raw_type, day):
    orgs, types, _ = BODY[raw_type]
    return [m for m in by_date.get(day, []) if m["organization_id"] in orgs and m["type"] in types
            and title_ok(raw_type, m)]


plan = []
for raw_type, rows in inv.items():
    for r in rows:
        eid = r["Id"].lower()
        from pipeline.scrapers.escribe import EscribeScraper
        d = EscribeScraper._parse_meeting_date(r)
        rec = {"escribe_id": eid, "type": raw_type, "date": d.isoformat() if d else None,
               "time": r.get("MeetingTime"), "cancelled": bool(r.get("Cancelled")),
               "has_video": bool(r.get("VideoUrl")),
               "doc_titles": sorted({(l.get("Title") or "").strip() for l in (r.get("MeetingLinks") or [])})}
        s = esc_src.get(eid)
        rec["source_row"] = s and {k: s[k] for k in ("id", "status", "ingested_meeting_id", "archive_path")}
        if s and s["ingested_meeting_id"]:
            rec["state"] = "linked"; rec["meeting_id"] = s["ingested_meeting_id"]
            plan.append(rec); continue
        if not d:
            rec["state"] = "no_date"; plan.append(rec); continue
        c = candidates(raw_type, d.isoformat())
        # Exclude meetings already linked to a different eSCRIBE id.
        free = [m for m in c if not (linked_meeting.get(m["id"], set()) - {eid})]
        state = None
        if len(free) == 1:
            state = "match"
        elif not free:
            near = []
            for delta in (-1, 1):
                near += [m for m in candidates(raw_type, (d + timedelta(days=delta)).isoformat())
                         if not (linked_meeting.get(m["id"], set()) - {eid})]
            if len(near) == 1:
                free, state = near, "match_shift"
            elif len(near) > 1:
                free, state = near, "ambiguous"
            else:
                state = "none" if not c else "taken"
        else:
            state = "ambiguous"
        rec["state"] = state
        rec["candidates"] = [{"id": m["id"], "date": m["meeting_date"], "title": m["title"], "org": m["organization_id"],
                              "type": m["type"], "archive_path": m["archive_path"], "status": m["status"],
                              "player_id": player_id(m), "calendar_source_id": m["calendar_source_id"],
                              "linked_to": sorted(linked_meeting.get(m["id"], []))} for m in (free if state != "taken" else c)]
        if state in ("match", "match_shift"):
            rec["meeting_id"] = free[0]["id"]
            pid = rec["candidates"][0]["player_id"]
            rec["player_check"] = None if not pid else ("agree" if pid == eid else "CONFLICT")
        plan.append(rec)

# A meeting must not be claimed by two eSCRIBE ids.
claims = collections.Counter(p["meeting_id"] for p in plan if p.get("state") in ("match", "match_shift"))
for p in plan:
    if p.get("state") in ("match", "match_shift") and claims[p["meeting_id"]] > 1:
        p["state"] = "ambiguous"; p["reason"] = "meeting claimed by several eSCRIBE ids"
json.dump(plan, open(os.path.join(D, "match_plan.json"), "w"), indent=1, default=str)
print(collections.Counter(p["state"] for p in plan))
print(collections.Counter((p["type"], p["state"]) for p in plan))
print("player checks", collections.Counter(p.get("player_check") for p in plan if p.get("state", "").startswith("match")))
