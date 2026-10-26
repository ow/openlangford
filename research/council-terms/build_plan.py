#!/usr/bin/env python3
"""Build research/council-terms/plan.json from minutes rosters.

Usage: build_plan.py MINUTES_DIR   (MINUTES_DIR from fetch_minutes.py)

Sources: GSPR minutes (2008-12 .. 2015+), plus our DB documents (category 'Minutes') for 2015-12 .. 2018-11-04.
For every minutes document, parses the PRESENT / ABSENT blocks, matches surnames against the known
council candidates, and also lists any other "<initial> <Surname>" tokens so unexpected members are noticed.
"""
import json, os, re, subprocess, sys, collections

HERE = os.path.dirname(os.path.abspath(__file__))
MIN = sys.argv[1]
ENV = "/Users/owen/Projects/viewroyal/.env"
url = next(l.split("=", 1)[1].strip().strip("\"'") for l in open(ENV) if l.startswith("DATABASE_URL"))
PSQL = "/opt/homebrew/opt/libpq/bin/psql"


def q(sql):
    return subprocess.run([PSQL, url, "-At", "-F", "\x1f", "-c", sql], capture_output=True, text=True, check=True).stdout


# Surname -> our canonical people row (resolved by inspection of `people`; variants like "B. Sifert" #392 left alone)
PEOPLE = {
    "Young": ("Stew Young", 143), "Blackwell": ("Denise Blackwell", 133), "Sahlstrom": ("Matt Sahlstrom", 134),
    "Seaton": ("Lanny Seaton", 135), "Sifert": ("Winnie Sifert", 363), "Szpak": ("Lillian Szpak", 35),
    "Wade": ("Roger Wade", 137),
}
FUZZ = {"Blackwell": r"Bl?ac?k?we?[il1]l?", "Sahlstrom": r"Sah?[il]?str[o0][mn]+", "Seaton": r"Seaton", "Sifert": r"Sifert",
        "Szpak": r"Szpak", "Wade": r"Wade", "Young": r"Young"}
TERMS = [
    ("2008–2011 Council", "2008-11-15", "2008-12-01", "2011-12-04", "Inaugural Meeting of Council, Dec 1 2008"),
    ("2011–2014 Council", "2011-11-19", "2011-12-05", "2014-11-30", "Inaugural Meeting of Council, Dec 5 2011"),
    ("2014–2018 Council", "2014-11-15", "2014-12-01", "2018-11-04", "Inaugural Meeting of Council, Dec 1 2014"),
]
NEXT_START = {"2008–2011 Council": "2011-12-05 inaugural", "2011–2014 Council": "2014-12-01 inaugural",
              "2014–2018 Council": "2018-11-05 inaugural (existing term 3 '2018–2022 Council' starts 2018-11-05)"}

docs = []  # (date, source, label, text)
idx = json.load(open(f"{MIN}/index.json"))
for x in idx:
    if "Minutes" not in x["title"]:
        continue
    docs.append((x["date"], "gspr:" + x["id"], x["title"], open(f"{MIN}/{x['file']}").read()[:6000]))
for l in q("select m.id,m.meeting_date,m.title,replace(replace(substr(d.full_text,1,6000),E'\\x1f',' '),E'\\n',' ') from meetings m join documents d "
           "on d.meeting_id=m.id and d.category='Minutes' where m.meeting_date between '2015-12-01' and '2018-11-04' "
           "and m.organization_id=1 order by 2").split("\n"):
    p = l.split("\x1f")
    if len(p) >= 4:
        docs.append((p[1], f"db:meeting:{p[0]}", p[2], p[3]))

ev = collections.defaultdict(lambda: collections.defaultdict(lambda: {"present": [], "absent": []}))
unknown = collections.Counter()
noroster = []
for date, src, label, text in sorted(docs):
    t = re.sub(r"\s+", " ", text)
    m = re.search(r"PRESENT(.*?)(?=CALL TO ORDER|\b1\. |ATTENDING|STAFF)", t, re.I)
    if not m:
        noroster.append((date, src, label))
        continue
    pres = m.group(1)
    rest = t[m.end():m.end() + 600]
    am = re.search(r"ABSENT(.*?)(?=CALL TO ORDER|\b1\. )", t[m.start():m.start() + 1500])
    absn = am.group(1) if am else ""
    pres = pres.split("ABSENT")[0]
    for k, rx in FUZZ.items():
        if re.search(rx, pres):
            ev[date][k]["present"].append(src)
        elif re.search(rx, absn):
            ev[date][k]["absent"].append(src)
    for blk in ((pres, absn) if date <= '2018-11-04' else ()):
        for nm in re.findall(r"(?:\b[A-Z]\.? ?)+ ?([A-Z][a-z]+)", blk):
            if not any(re.fullmatch(rx, nm) for rx in FUZZ.values()):
                unknown[nm] += 1

plan = {"terms": [], "memberships": [], "notes": {}, "unknown_name_tokens_in_rosters": dict(unknown),
        "documents_without_roster_block": [{"date": a, "source": b, "title": c} for a, b, c in noroster]}
for name, elect, start, end, start_src in TERMS:
    term = {"name": name, "election_date": elect, "start_date": start, "end_date": end, "start_source": start_src,
            "end_basis": f"Day before {NEXT_START[name]}", "election_id": None}
    plan["terms"].append(term)
    dates = [d for d in sorted(ev) if start <= d <= end]
    term["minutes_rosters_scanned"] = len(dates)
    for sn, (pname, pid) in PEOPLE.items():
        pres = [d for d in dates if ev[d][sn]["present"]]
        absn = [d for d in dates if ev[d][sn]["absent"]]
        role = "Mayor" if sn == "Young" else "Councillor"
        plan["memberships"].append({
            "term": name, "person_id": pid, "person_name": pname, "role": role, "start_date": start, "end_date": end,
            "first_present": pres[0] if pres else None, "last_present": pres[-1] if pres else None,
            "n_present": len(pres), "n_absent": len(absn),
            "start_source": start_src, "end_source": term["end_basis"],
            "roster_at_inaugural_present": bool(ev.get(start, {}).get(sn, {}).get("present")),
        })
json.dump(plan, open(f"{HERE}/plan.json", "w"), indent=1, ensure_ascii=False)
for t in plan["terms"]:
    print(t["name"], t["start_date"], t["end_date"], "rosters:", t["minutes_rosters_scanned"])
for m in plan["memberships"]:
    print(f"{m['term']:18} {m['person_name']:17} {m['role']:10} first={m['first_present']} last={m['last_present']} P={m['n_present']} A={m['n_absent']} inaug={m['roster_at_inaugural_present']}")
print("unknown tokens:", dict(unknown))
print("no roster:", len(noroster))
