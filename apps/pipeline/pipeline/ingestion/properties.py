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
NOT_NAMES = re.compile(r"\b(?:district|plan|lots?|section|pid|block|and|road|rd|avenue|ave|street|drive|highway|hwy|"
                       r"fund-raising|fundraising|unnamed)\b", re.I)
# "2019 Eagle Ridge (Community Centre)", "2016 Apple Day": a year before a name is an address only with a
# common street type.
COMMON_TYPES = {"Road", "Avenue", "Street", "Drive", "Way", "Place", "Court", "Crescent", "Terrace", "Parkway",
                "Highway", "Lane", "Close", "Boulevard", "Trail"}
YEAR = re.compile(r"(?:199\d|20[0-3]\d)")

_WORD = r"[A-Z][A-Za-z'’.-]*"
_NUMS = r"(?P<nums>\d{1,5}[A-Za-z]?(?:\s*(?:[-–/&,]|(?i:\band\b|\bto\b))\s*\d{1,5}[A-Za-z]?)*)"
_TYPE = r"(?P<type>(?i:" + "|".join(sorted(TYPES, key=len, reverse=True)) + r"))\.?(?![A-Za-z])"
TYPED = re.compile(_NUMS + r"\s+(?P<name>(?:" + _WORD + r"\s+){0,3}" + _WORD + r")\s+" + _TYPE)
UNTYPED = re.compile(_NUMS + r"\s+(?P<name>" + _WORD + r"(?:\s+" + _WORD + r"){0,3})")


def _case(word: str) -> str:
    if any(c.isupper() for c in word[1:]) and not word.isupper():
        return word  # McCallum
    def one(part: str) -> str:
        part = part[:1].upper() + part[1:].lower()
        return "Mc" + part[2:3].upper() + part[3:] if part.startswith("Mc") and len(part) > 3 else part
    return "-".join(one(part) for part in word.split("-"))


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
                if YEAR.fullmatch(number) and kind not in COMMON_TYPES:
                    continue
                if re.fullmatch(r"\d{3,4}[A-Za-z]?", number):  # Langford civic numbers; longer ones are PIDs
                    found.append({"number": number.upper(), "name": name, "type": kind})
            for low, high in ranges:
                if YEAR.fullmatch(str(low)) and YEAR.fullmatch(str(high)) and kind not in COMMON_TYPES:
                    continue  # "Contract 2019-2024 Eagle Ridge Centre"
                if 100 <= low and high < 10000:
                    found.append({"range": (low, high), "name": name, "type": kind})
    return found


STREET_ONLY = re.compile(r"^\s*(?:(?i:portion of|along|on)\s+)?(?P<name>" + _WORD + r"(?:\s+" + _WORD + r"){0,3})\s+" + _TYPE + r"\s*$")


def parse_street(text: str) -> dict | None:
    """A mention of a whole street ("Leigh Road", "Portion of McCallum Road"): number ""."""
    m = STREET_ONLY.match(text or "")
    if not m:
        return None
    raw = m.group("name").split()
    name = " ".join(_case(w) for w in raw)
    if NOT_NAMES.search(name):
        return None
    return {"number": "", "name": name, "type": TYPES[m.group("type").lower().rstrip(".")]}


def is_street(key: tuple) -> bool:
    return key[0] == ""


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
    # Spellings that differ only in punctuation or spacing ("Trans-Canada" / "Trans Canada") are one lot,
    # shown with its most common spelling.
    def compact(key):  # "Westshore" / "West Shore" / "West-Shore"
        return slug_of(key).replace("-", "")
    merged: dict[str, tuple] = {}
    for key in sorted(out, key=lambda k: -len(out[k])):
        merged.setdefault(compact(key), key)
    result: dict[tuple, list[dict]] = defaultdict(list)
    for key, sources in out.items():
        result[merged[compact(key)]] += sources
    return {k: v for k, v in result.items() if (k[0], k[1], k[2]) not in NOT_PROPERTIES}


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


def build_properties(supabase, *, dry_run: bool = False, geocode_limit: int | None = None) -> dict:
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
        from_address = []
        for text in _related(item.get("related_address")):
            found = parse_addresses(text, need_type=False) or [street for street in [parse_street(text)] if street]
            from_address += found
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
    # Every street with a lot on it gets a street page, even if nothing names the street alone.
    taken = {slug_of(key) for key in groups}
    for key in list(groups):
        street = ("", key[1], key[2])
        if not is_street(key) and key[2] and slug_of(street) not in taken:
            groups[street] = []
            taken.add(slug_of(street))
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

    existing = {p["slug"]: p for p in _pages(lambda: supabase.table("properties").select("id,slug,geo").order("id"))}
    rows, now = [], datetime.now(timezone.utc).isoformat()
    for key in groups:
        geo = None
        if points.get(key):
            geo = {"lat": statistics.median(p["lat"] for p in points[key]), "lng": statistics.median(p["lng"] for p in points[key]),
                   "precision": "address"}  # mark_shared_points downgrades pins other lots share
        row = {"slug": slug_of(key), "address": display(key), "civic_number": key[0],
               "street": display(("", key[1], key[2])).strip(), "updated_at": now}
        # Agenda items' pins only seed new properties; geocode_missing replaces them with BC's.
        pinned = (existing.get(row["slug"]) or {}).get("geo")
        rows.append({**row, "geo": {**geo, "source": "items"}} if geo and not pinned else row)
    ids = {}
    # Rows without item coordinates leave geo alone (it may hold an earlier geocode). PostgREST bulk
    # upserts need one column set per request, so the two kinds go separately.
    for batch in ([r for r in rows if "geo" in r], [r for r in rows if "geo" not in r]):
        for start in range(0, len(batch), 500):
            for row in supabase.table("properties").upsert(batch[start:start + 500], on_conflict="slug").execute().data or []:
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
    linked |= {ids[slug_of(key)] for key in groups if is_street(key)}
    orphans = [pid for slug, pid in ids.items() if pid not in linked]
    for start in range(0, len(orphans), 200):
        supabase.table("properties").delete().in_("id", orphans[start:start + 200]).execute()
    geocoded = geocode_missing(supabase, limit=geocode_limit)
    mark_shared_points(supabase)
    return {**stats, "inserted": len(inserts), "removed": len(stale), "updated": len(updates),
            "orphans_removed": len(orphans), "geocoded": geocoded}


NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_USER_AGENT = "civic-meeting-intelligence/1.0 (municipal records site)"
LANGFORD_VIEWBOX = "-123.62,48.39,-123.45,48.50"  # same area the ingester's geocoder accepts
RETRY_AFTER_DAYS = 30


BC_GEOCODER_URL = "https://geocoder.api.gov.bc.ca/addresses.json"
BC_MIN_SCORE = 90


def bc_geocode(address: str, *, get=None) -> dict | None:
    """BC's Address Geocoder (DataBC), built from the province's civic address registry: knows lots
    OpenStreetMap doesn't. CIVIC_NUMBER matches are the parcel itself; BLOCK matches are placed along
    the right block by civic number (tens of metres). Anything vaguer is rejected."""
    import requests

    get = get or requests.get
    response = get(BC_GEOCODER_URL, params={"addressString": f"{address}, Langford, BC", "maxResults": 1,
                                            "echo": "false", "locationDescriptor": "parcelPoint"},
                   headers={"User-Agent": NOMINATIM_USER_AGENT}, timeout=10)
    response.raise_for_status()
    features = response.json().get("features") or []
    if not features:
        return None
    props, (lng, lat) = features[0]["properties"], features[0]["geometry"]["coordinates"]
    precision = {"CIVIC_NUMBER": "address", "BLOCK": "block"}.get(props.get("matchPrecision"))
    if not precision or (props.get("score") or 0) < BC_MIN_SCORE or "langford" not in (props.get("fullAddress") or "").lower():
        return None
    return {"lat": lat, "lng": lng, "precision": precision, "source": "bc"}


def geocode(address: str, *, get=None) -> dict | None:
    """Nominatim, restricted to Langford. Returns {lat, lng, precision} ("address" when OpenStreetMap
    knows the house, else "street": new builds are often missing, and the street is close enough for a pin)."""
    import requests

    get = get or requests.get
    response = get(NOMINATIM_URL, params={"q": f"{address}, Langford, BC, Canada", "format": "json", "limit": 1,
                                          "viewbox": LANGFORD_VIEWBOX, "bounded": 1, "countrycodes": "ca",
                                          "addressdetails": 0},
                   headers={"User-Agent": NOMINATIM_USER_AGENT}, timeout=10)
    response.raise_for_status()
    results = response.json()
    if not results:
        return None
    top = results[0]
    precise = top.get("addresstype") in ("house", "building") or top.get("class") in ("building", "place") and top.get("type") == "house"
    return {"lat": float(top["lat"]), "lng": float(top["lon"]), "precision": "address" if precise else "street",
            "source": "osm"}


def shared_points(rows: list[dict]) -> set[int]:
    """Ids of lots whose pin is shared with another lot: a geocoder's fallback to the street (or an
    agenda item geocoded that way), not the lot itself."""
    by_point = defaultdict(list)
    for row in rows:
        geo = row.get("geo") or {}
        if geo.get("lat") is not None:
            by_point[(round(geo["lat"], 6), round(geo["lng"], 6))].append(row["id"])
    return {i for ids in by_point.values() if len(ids) > 1 for i in ids}


def mark_shared_points(supabase) -> int:
    """Mark shared pins as street-precision so distances and "nearby" never treat them as exact."""
    rows = _pages(lambda: supabase.table("properties").select("id,geo").neq("civic_number", "").not_.is_("geo", "null").order("id"))
    shared = shared_points(rows)
    changed = 0
    for row in rows:
        precision = "street" if row["id"] in shared else (row["geo"].get("precision") or "address")
        if row["id"] in shared and row["geo"].get("precision") != "street" and row["geo"].get("source") != "bc":
            supabase.table("properties").update({"geo": {**row["geo"], "precision": precision}}).eq("id", row["id"]).execute()
            changed += 1
    return changed


def geocode_missing(supabase, *, limit: int | None = None, sleep=None) -> int:
    """Geocode lots with BC's geocoder (falling back to OpenStreetMap), and streets with OpenStreetMap.

    Picks up properties with no pin, and lots whose pin came from elsewhere (agenda items geocoded at
    ingest, OpenStreetMap) that haven't had a BC attempt yet. Failed attempts are retried after
    RETRY_AFTER_DAYS. OpenStreetMap allows 1 request/second."""
    import time
    from datetime import timedelta

    sleep = sleep or time.sleep
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RETRY_AFTER_DAYS)).isoformat()
    missing = _pages(lambda: supabase.table("properties").select("id,address,civic_number,geo").is_("geo", "null")
                     .or_(f"geocode_attempted_at.is.null,geocode_attempted_at.lt.{cutoff}").order("id"))
    upgrade = [row for row in _pages(lambda: supabase.table("properties").select("id,address,civic_number,geo")
                                     .neq("civic_number", "").not_.is_("geo", "null").order("id"))
               if not (row["geo"] or {}).get("bc_tried") and (row["geo"] or {}).get("source") != "bc"]
    found = 0
    for row in (missing + upgrade)[:limit] if limit else missing + upgrade:
        geo = None
        if row["civic_number"]:
            try:
                geo = bc_geocode(row["address"])
            except Exception as error:
                print(f"    [!] BC geocoder failed for {row['address']}: {error}")
            sleep(0.2)
        if not geo and not row.get("geo"):
            try:
                geo = geocode(row["address"])
            except Exception as error:
                print(f"    [!] Geocoding failed for {row['address']}: {error}")
            sleep(1.1)
            if geo and row["civic_number"] == "" and geo["precision"] == "address":
                geo = None  # a street resolved to one house is not the street
        update = {"geocode_attempted_at": datetime.now(timezone.utc).isoformat()}
        if geo:
            update["geo"] = {**geo, "bc_tried": True} if row["civic_number"] else geo
            found += 1
        elif row.get("geo"):
            update["geo"] = {**row["geo"], "bc_tried": True}  # keep the old pin; don't ask BC again
        supabase.table("properties").update(update).eq("id", row["id"]).execute()
    return found
