"""Properties: one civic address is one lot, and everything Council considered about it.

A rezoning, a later variance, a business's temporary use permit and a letter
about the same lot are separate matters; this links them by place. Addresses
come from agenda_items.related_address (extracted at ingest), item titles and
matter titles. Each lot is its own property: "2848 and 2852 Millstream Rd"
links the matter to both lots; ranges ("1216-1230 Goldstream Ave") expand only
to numbers seen elsewhere on that street. Unit numbers ("105-693 Hoffman Ave")
belong to the building at the civic number.
"""
from __future__ import annotations

import json
import re
import statistics
from collections import defaultdict
from datetime import datetime, timezone

TYPES = {
    "road": "Road", "rd": "Road", "avenue": "Avenue", "ave": "Avenue", "av": "Avenue", "drive": "Drive", "dr": "Drive",
    "parkway": "Parkway", "pkwy": "Parkway", "place": "Place", "pl": "Place", "crescent": "Crescent", "cres": "Crescent",
    "court": "Court", "crt": "Court", "ct": "Court", "terrace": "Terrace", "terr": "Terrace", "ter": "Terrace",
    "close": "Close", "cl": "Close", "highway": "Highway", "hwy": "Highway", "street": "Street", "st": "Street",
    "lane": "Lane", "ln": "Lane", "boulevard": "Boulevard", "blvd": "Boulevard", "way": "Way", "trail": "Trail",
    "rise": "Rise", "plateau": "Plateau", "plat": "Plateau", "heights": "Heights", "view": "View", "ridge": "Ridge", "gate": "Gate",
    "grove": "Grove", "hill": "Hill", "walk": "Walk", "circle": "Circle", "landing": "Landing", "bay": "Bay",
    "green": "Green", "mews": "Mews", "path": "Path", "run": "Run", "point": "Point", "row": "Row",
}
# City hall: on letterheads and in "submit to" lines everywhere; says nothing about a lot.
NOT_PROPERTIES = {("877", "goldstream", "Avenue")}
# Legal descriptions ("Section 114, Esquimalt District, Plan VIP1234", "PID 000-874") and run-ons.
NOT_NAMES = re.compile(r"\b(?:district|plan|lots?|section|pid|block|and|road|rd|avenue|ave|street|drive|highway|hwy)\b", re.I)

_WORD = r"[A-Z][A-Za-z'’.-]*"
_NUMS = r"(?P<nums>\d{1,5}[A-Za-z]?(?:\s*(?:[-–/&,]|(?i:\band\b|\bto\b))\s*\d{1,5}[A-Za-z]?)*)"
_TYPE = r"(?P<type>(?i:" + "|".join(sorted(TYPES, key=len, reverse=True)) + r"))\.?(?![A-Za-z])"
TYPED = re.compile(_NUMS + r"\s+(?P<name>(?:" + _WORD + r"\s+){0,3}" + _WORD + r")\s+" + _TYPE)
UNTYPED = re.compile(_NUMS + r"\s+(?P<name>" + _WORD + r"(?:\s+" + _WORD + r"){0,3})")


def _case(word: str) -> str:
    if any(c.isupper() for c in word[1:]) and not word.isupper():
        return word  # McCallum
    return "-".join(part[:1].upper() + part[1:].lower() for part in word.split("-"))


def _civic_numbers(nums: str) -> tuple[list[str], list[tuple[int, int]]]:
    """Civic numbers and (low, high) ranges from "2848 and 2852", "105-693", "1144-1198, 1216-1230"."""
    tokens = re.split(r"\s*([-–/&,]|\band\b|\bto\b)\s*", nums.strip(), flags=re.I)
    numbers, seps = tokens[0::2], tokens[1::2]
    singles, ranges = [], []
    i = 0
    while i < len(numbers):
        if i < len(seps) and seps[i] in ("-", "–", "to"):
            a, b = numbers[i], numbers[i + 1]
            da, db = re.sub(r"\D", "", a), re.sub(r"\D", "", b)
            if len(da) == len(db) and abs(int(da) - int(db)) < 100 and a.isdigit() and b.isdigit():
                ranges.append((min(int(da), int(db)), max(int(da), int(db))))
            else:
                # "105-693 Hoffman Ave", "105 & 111 - 945 Reunion Ave": units in the building at the last number.
                return [b], []
            i += 2
        else:
            singles.append(numbers[i])
            i += 1
    return singles, ranges


def parse_addresses(text: str, *, need_type: bool) -> list[dict]:
    """Civic addresses in free text: [{number|range, name, type}]. ``need_type`` (for titles) requires a
    street type so "Bylaw No. 1949" or "2020 Financial Plan" never read as addresses."""
    found = []
    for segment in re.split(r";|\(|\)|—|\n", text or ""):
        matches = list(TYPED.finditer(segment))
        if not matches and not need_type:
            matches = list(UNTYPED.finditer(segment))
        for m in matches:
            if re.search(r"\bblock\b", segment[m.end():m.end() + 8] + m.group("name"), re.I):
                continue
            raw = m.group("name").split()
            name = " ".join(_case(w) for w in raw)
            if NOT_NAMES.search(name) or (not m.groupdict().get("type") and (len(name) < 4 or (raw[-1].isupper() and len(raw[-1]) < 4))):
                continue
            kind = TYPES.get((m.groupdict().get("type") or "").lower().rstrip("."))
            singles, ranges = _civic_numbers(m.group("nums"))
            for number in singles:
                if re.fullmatch(r"\d{3,4}[A-Za-z]?", number):  # Langford civic numbers; longer ones are PIDs
                    found.append({"number": number.upper(), "name": name, "type": kind})
            for low, high in ranges:
                if 100 <= low and high < 10000:
                    found.append({"range": (low, high), "name": name, "type": kind})
    return found


def key_of(address: dict) -> tuple:
    return (address["number"], address["name"].lower(), address["type"])


def display(key: tuple) -> str:
    number, name, kind = key
    return " ".join(filter(None, [number, " ".join(_case(w) for w in name.split()), kind]))


def slug_of(key: tuple) -> str:
    return re.sub(r"[^a-z0-9]+", "-", display(key).lower()).strip("-")


def resolve(addresses_by_source: list[tuple[dict, dict]]) -> dict[tuple, list[dict]]:
    """Group raw parses into property keys -> the sources that named them.

    Untyped addresses ("981 Capella") join the single typed address with the same number and name;
    ranges expand to numbers seen elsewhere on the street (same parity as the endpoints when they agree)."""
    typed = defaultdict(set)  # (number, name) -> {type}
    street_types = defaultdict(set)  # name -> {type}
    by_street = defaultdict(set)  # (name, type) -> {number}
    for address, _ in addresses_by_source:
        if "number" in address and address["type"]:
            typed[(address["number"], address["name"].lower())].add(address["type"])
            street_types[address["name"].lower()].add(address["type"])
            if address["number"].isdigit():
                by_street[(address["name"].lower(), address["type"])].add(int(address["number"]))
    out: dict[tuple, list[dict]] = defaultdict(list)
    for address, source in addresses_by_source:
        if "range" in address:
            low, high = address["range"]
            streets = [(address["name"].lower(), address["type"])] if address["type"] else \
                [s for s in by_street if s[0] == address["name"].lower()]
            if len(streets) != 1:
                continue
            same_parity = low % 2 == high % 2
            for number in sorted(by_street[streets[0]] | {low, high}):
                if low <= number <= high and (not same_parity or number % 2 == low % 2):
                    out[(str(number), *streets[0])].append(source)
            continue
        kind = address["type"]
        if not kind:
            options = typed.get((address["number"], address["name"].lower())) or street_types.get(address["name"].lower(), set())
            if len(options) > 1:
                continue
            kind = next(iter(options), None)
        out[(address["number"], address["name"].lower(), kind)].append(source)
    return {k: v for k, v in out.items() if (k[0], k[1], k[2]) not in NOT_PROPERTIES}


def _pages(build, size: int = 1000) -> list[dict]:
    rows, start = [], 0
    while True:
        page = build().range(start, start + size - 1).execute().data or []
        rows += page
        if len(page) < size:
            return rows
        start += size


def _related(value) -> list[str]:
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str)]
    text = (value or "").strip()
    if text.startswith("["):
        try:
            return [v for v in json.loads(text) if isinstance(v, str)]
        except ValueError:
            return []
    return [text] if text else []


def build_properties(supabase, *, dry_run: bool = False) -> dict:
    """Rebuild properties and their links from every agenda item and matter. Admin links and hidden
    (admin-rejected) links are kept as they are."""
    matters = _pages(lambda: supabase.table("matters").select("id,title,meta").order("id"))
    canonical = {}
    for m in matters:
        meta = m.get("meta") or {}
        canonical[m["id"]] = int(meta["canonical_matter_id"]) if meta.get("canonical_matter_id") else m["id"]
    hidden = {m["id"] for m in matters if (m.get("meta") or {}).get("hidden")}

    def matter_of(matter_id):
        target = canonical.get(matter_id, matter_id) if matter_id else None
        return None if target in hidden else target

    items = _pages(lambda: supabase.table("agenda_items").select("id,matter_id,title,related_address,geo_location").order("id"))
    parsed: list[tuple[dict, dict]] = []
    geo_parsed: list[tuple[dict, dict]] = []
    for item in items:
        source = {"agenda_item_id": item["id"], "matter_id": matter_of(item.get("matter_id"))}
        from_address = [a for text in _related(item.get("related_address")) for a in parse_addresses(text, need_type=False)]
        parsed += [(a, {**source, "source": "item_address"}) for a in from_address]
        if not from_address:
            parsed += [(a, {**source, "source": "item_title"}) for a in parse_addresses(item.get("title") or "", need_type=True)]
        geo = item.get("geo_location") or {}
        if geo.get("lat") and geo.get("lng") and geo.get("address"):
            geo_parsed += [(a, {"lat": geo["lat"], "lng": geo["lng"]}) for a in parse_addresses(geo["address"], need_type=False)]
    for m in matters:
        if m["id"] in hidden or canonical[m["id"]] != m["id"]:
            continue
        parsed += [(a, {"agenda_item_id": None, "matter_id": m["id"], "source": "matter_title"})
                   for a in parse_addresses(m.get("title") or "", need_type=True)]

    groups = resolve(parsed)
    points = defaultdict(list)
    for key, coords in resolve(geo_parsed + [(a, None) for a, _ in parsed if "number" in a]).items():
        points[key] += [c for c in coords if c]

    # One link per (property, item); matter-title links only where no item of that matter names the lot.
    desired: dict[tuple, dict] = {}
    for key, sources in groups.items():
        item_matters = {s["matter_id"] for s in sources if s["agenda_item_id"]}
        for s in sources:
            if s["agenda_item_id"]:
                desired.setdefault((key, s["agenda_item_id"], None), s)
            elif s["matter_id"] not in item_matters:
                desired.setdefault((key, None, s["matter_id"]), s)
    stats = {"properties": len(groups), "links": len(desired),
             "matters": len({s["matter_id"] for s in desired.values() if s["matter_id"]}),
             "multi_matter_properties": sum(1 for k in groups if len({s["matter_id"] for (kk, _, _), s in desired.items()
                                                                       if kk == k and s["matter_id"]}) > 1)}
    if dry_run:
        stats["sample"] = sorted(groups, key=lambda k: -len(groups[k]))[:15]
        return stats

    existing = {p["slug"]: p for p in _pages(lambda: supabase.table("properties").select("id,slug").order("id"))}
    rows, now = [], datetime.now(timezone.utc).isoformat()
    for key in groups:
        geo = None
        if points.get(key):
            geo = {"lat": statistics.median(p["lat"] for p in points[key]), "lng": statistics.median(p["lng"] for p in points[key])}
        rows.append({"slug": slug_of(key), "address": display(key), "civic_number": key[0],
                     "street": display(("", key[1], key[2])).strip(), "geo": geo, "updated_at": now})
    ids = {}
    for start in range(0, len(rows), 500):
        for row in supabase.table("properties").upsert(rows[start:start + 500], on_conflict="slug").execute().data or []:
            ids[row["slug"]] = row["id"]
    ids = {**{s: p["id"] for s, p in existing.items()}, **ids}

    links = _pages(lambda: supabase.table("property_links").select("id,property_id,agenda_item_id,matter_id,source,hidden").order("id"))
    have = {(l["property_id"], l["agenda_item_id"], None if l["agenda_item_id"] else l["matter_id"]): l for l in links}
    want = {}
    for (key, item_id, matter_id), s in desired.items():
        want[(ids[slug_of(key)], item_id, matter_id)] = s
    stale = [l["id"] for k, l in have.items() if k not in want and l["source"] != "admin" and not l["hidden"]]
    for start in range(0, len(stale), 200):
        supabase.table("property_links").delete().in_("id", stale[start:start + 200]).execute()
    inserts = [{"property_id": pid, "agenda_item_id": item_id, "matter_id": s["matter_id"], "source": s["source"]}
               for (pid, item_id, matter_id), s in want.items() if (pid, item_id, matter_id) not in have]
    updates = [(have[k]["id"], s["matter_id"]) for k, s in want.items()
               if k in have and k[1] and have[k]["matter_id"] != s["matter_id"]]
    for start in range(0, len(inserts), 500):
        supabase.table("property_links").insert(inserts[start:start + 500]).execute()
    for link_id, matter_id in updates:  # an item re-filed under another matter, or a matter merged
        supabase.table("property_links").update({"matter_id": matter_id}).eq("id", link_id).execute()
    linked = {pid for pid, _, _ in want} | {l["property_id"] for l in links if l["source"] == "admin" or l["hidden"]}
    orphans = [pid for slug, pid in ids.items() if pid not in linked]
    for start in range(0, len(orphans), 200):
        supabase.table("properties").delete().in_("id", orphans[start:start + 200]).execute()
    return {**stats, "inserted": len(inserts), "removed": len(stale), "updated": len(updates), "orphans_removed": len(orphans)}
