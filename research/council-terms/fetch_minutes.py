#!/usr/bin/env python3
"""Fetch Goldstream Public Record council minutes (2008-2015) via Glyphdex API.
Usage: fetch_minutes.py OUT_DIR   (writes OUT_DIR/index.json and OUT_DIR/<date>-<id8>.md)"""
import json, re, sys, time, urllib.request
B = "https://gspr.emc2.build/api/documents"
out = sys.argv[1]


def get(u):
    time.sleep(0.4)
    req = urllib.request.Request(u, headers={"User-Agent": "openlangford-research"})
    return urllib.request.urlopen(req, timeout=60).read()


docs, off = [], 0
while True:
    d = json.loads(get(f"{B}?limit=50&offset={off}"))
    docs += d["documents"]
    off += 50
    if off >= d["total"]:
        break
mins = [x for x in docs if x["doc_type"] == "council_minutes" and re.match(r"Council \d{4} \d{2} \d{2}", x["title"])]
idx = []
for x in sorted(mins, key=lambda x: x["title"]):
    m = re.match(r"Council (\d{4}) (\d{2}) (\d{2})", x["title"])
    date = "-".join(m.groups())
    try:
        t = get(f"{B}/{x['id']}/artifacts/markdown").decode()
    except Exception as e:
        print("FAIL", x["title"], e)
        continue
    fn = f"{date}-{x['id'][:8]}.md"
    open(f"{out}/{fn}", "w").write(t)
    idx.append({"id": x["id"], "title": x["title"], "date": date, "file": fn})
json.dump(idx, open(f"{out}/index.json", "w"), indent=1)
print(len(idx), "minutes")
