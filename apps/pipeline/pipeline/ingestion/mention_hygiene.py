"""Which "found by name" timeline mentions are worth showing.

Name matching (``matter_names``) finds every agenda item whose text uses a topic's name or address. Three kinds of
hit are noise on a topic page (page checks, 2026-11-02: mention and background entries drew 58% of all flags):

- Minutes echoes. "Adoption of minutes" and "Minutes of the … meeting" items repeat the earlier meeting's text, so
  they name the topic whenever that meeting did. When the earlier meeting is already on the topic the echo is a
  duplicate; when it isn't, the real item from that meeting is the entry to show, not its echo.
- Legal-description lists in omnibus bylaws: "on land legally described as Lot A … (911 Jenkins Avenue)" in a
  housekeeping bylaw that touches dozens of properties.
- Lists: an item linked to more topics than any one item can be about (Bylaw 1662 was on 146 topic pages).

``plan`` decides what to hide (never delete: staff decisions and history stay) and which echoes to re-point at
their real item; ``apply`` writes it. ``candidate_ok`` keeps new links from being made in the first place.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import date, datetime
from typing import Any

MINUTES_ECHO = re.compile(
    r"(?i)\badoption of (?:the |council |committee )?minutes\b|\bminutes of the\b.{0,80}\bmeeting\b"
    r"|^\s*(?:[\d.]+\s*[a-z]?[.)]?\s*)?(?:regular |special )?(?:council |committee )?minutes\b"
    r"|\b(?:regular |special )?(?:council|committee) (?:meeting )?minutes\b")
LEGAL_DESCRIPTION = re.compile(
    r"(?i)strata plan|unit entitlement|legally described|common property|\bplan\s+(?:VIP|VIS|EPP|EPS)\d+|\bPID\b"
    r"|\bsection\s+\d+.{0,40}\bdistrict\b")
OMNIBUS = re.compile(r"(?i)\bomnibus\b|\btext amendments\b|\bhousekeeping\b")
MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december"
TITLE_DATE = re.compile(rf"(?i)\b({MONTHS})\s+(\d{{1,2}})(?:st|nd|rd|th)?\s*,?\s*(\d{{4}})")
LIST_ITEM_MAX = 25  # more topics than this on one item: it is a list (an omnibus bylaw, a budget), not a mention
RESOLVE_MIN = 0.6  # share of the real item's title words that the echo's passage repeats

_STOP = {"the", "and", "for", "staff", "report", "planning", "bylaw", "from", "that", "council", "with", "application",
         "amendment", "langford", "city", "zoning", "official", "community", "plan"}


def first_line(title: str | None) -> str:
    return (title or "").split("\n")[0]


COUNCIL_ACTION = re.compile(r"(?i)^\s*(?:[\d.]+\s*[a-z]?[.)]?\s*)?committee resolutions\b")


def is_minutes_echo(title: str | None) -> bool:
    """An item that repeats an earlier meeting's minutes. "Committee resolutions" items are not: there Council
    decides on the committee's recommendations, a step of its own."""
    line = first_line(title)
    return bool(MINUTES_ECHO.search(line)) and not COUNCIL_ACTION.search(line)


def legal_list_match(item_title: str | None, quote: str | None) -> bool:
    """The passage is a legal description inside an omnibus or housekeeping bylaw: one property of many."""
    return bool(quote and LEGAL_DESCRIPTION.search(quote) and OMNIBUS.search(first_line(item_title)))


def candidate_ok(item_title: str | None, passage: str | None) -> bool:
    """Whether a name hit may become a mention at all (``matter_names.find_hits``)."""
    return not is_minutes_echo(item_title) and not legal_list_match(item_title, passage)


def echoed_day(title: str | None) -> date | None:
    m = TITLE_DATE.search(first_line(title))
    if not m:
        return None
    try:
        return datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)}", "%B %d %Y").date()
    except ValueError:
        return None


def _words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]{3,}", (text or "").lower())) - _STOP


def resolve_echo(quote: str, items: list[tuple[int, str]]) -> int | None:
    """The item of the echoed meeting that the echo's passage repeats: the one whose title words the passage uses
    most (at least RESOLVE_MIN of them), and clearly more than any other."""
    words = _words(quote)
    scored = sorted(((len(_words(first_line(t)) & words) / max(1, len(_words(first_line(t)))), iid)
                     for iid, t in items if not is_minutes_echo(t) and _words(first_line(t))), reverse=True)
    if not scored or scored[0][0] < RESOLVE_MIN or (len(scored) > 1 and scored[1][0] >= scored[0][0]):
        return None
    return scored[0][1]


def plan(cur) -> dict[str, Any]:
    """Visible mention links to hide (by reason) and real items to link in place of echoes. Links an editor
    accepted and manual links are kept."""
    cur.execute("""select ml.id, ml.matter_id, ml.agenda_item_id, ai.title, coalesce(ml.quote, ''), ml.confidence, ml.source,
                          mt.meeting_date, mt.organization_id
                   from matter_links ml join agenda_items ai on ai.id = ml.agenda_item_id join meetings mt on mt.id = ai.meeting_id
                   where ml.kind = 'mention' and not ml.hidden and ml.review is distinct from 'accepted'
                     and ml.source is distinct from 'manual'""")
    links = cur.fetchall()
    # A topic's days, its merged topics' included (merge_matters moves their items, so this is a safety net).
    cur.execute("""select coalesce(m.merged_into, m.id), mt.meeting_date
                   from agenda_items ai join matters m on m.id = ai.matter_id join meetings mt on mt.id = ai.meeting_id""")
    days: dict[int, set] = defaultdict(set)
    for mid, d in cur.fetchall():
        days[mid].add(d)
    cur.execute("select id, merged_into from matters")
    canonical = {mid: c or mid for mid, c in cur.fetchall()}
    for lid, mid, iid, title, quote, conf, source, day, org in links:  # other visible mentions are on the topic too
        if not is_minutes_echo(title):
            days[canonical.get(mid, mid)].add(day)
    cur.execute("select id, meeting_date, organization_id from meetings order by meeting_date")
    meetings = cur.fetchall()
    by_org: dict[int, list] = defaultdict(list)
    for mid, d, org in meetings:
        by_org[org].append(d)
    cur.execute("""select mt.meeting_date, ai.id, ai.title, ai.matter_id from agenda_items ai join meetings mt on mt.id = ai.meeting_id
                   where ai.item_order is distinct from 'official-recorded-motions'""")
    items_on: dict[date, list] = defaultdict(list)
    owner: dict[int, int | None] = {}
    for d, iid, t, mid in cur.fetchall():
        items_on[d].append((iid, t or ""))
        owner[iid] = mid
    cur.execute("select matter_id, agenda_item_id from matter_links where kind = 'mention'")
    linked = set(cur.fetchall())

    hide: dict[str, list[int]] = defaultdict(list)
    repoint: list[dict] = []
    kept_echo = 0
    per_item: dict[int, list[int]] = defaultdict(list)
    cur.execute("select id, matter_id, title from agenda_items where matter_id is not null")
    home, topic_items = {}, defaultdict(list)
    for iid, mid, t in cur.fetchall():
        home[iid] = canonical.get(mid, mid)
        topic_items[home[iid]].append((iid, t or ""))
    for lid, mid, iid, title, quote, conf, source, day, org in links:
        topic = canonical.get(mid, mid)
        if home.get(iid) == topic:
            hide["already one of the topic's own entries"].append(lid)
            continue
        if is_minutes_echo(title):
            echoed = echoed_day(title)
            if echoed is None:  # "ADOPTION OF MINUTES": the same body's previous meeting
                earlier = [d for d in by_org.get(org, []) if d < day]
                echoed = earlier[-1] if earlier else None
            if echoed is not None and echoed in days[topic]:
                hide["minutes echo of a meeting already on the topic"].append(lid)
                continue
            if resolve_echo(quote, topic_items.get(topic, [])) is not None:  # a misdated echo of an entry it has
                hide["minutes echo of an entry already on the topic"].append(lid)
                continue
            real = resolve_echo(quote, items_on.get(echoed, [])) if echoed else None
            if real is not None:
                hide["minutes echo, linked to the real item instead"].append(lid)
                if canonical.get(owner.get(real) or 0, owner.get(real)) != topic and (mid, real) not in linked:
                    repoint.append({"matter_id": mid, "agenda_item_id": real, "confidence": conf, "source": source,
                                    "quote": quote, "echo_link_id": lid})
                    linked.add((mid, real))
                continue
            kept_echo += 1  # the only record of that step here: keep it
        elif legal_list_match(title, quote):
            hide["legal description in an omnibus bylaw"].append(lid)
            continue
        per_item[iid].append(lid)
    for iid, lids in per_item.items():
        if len(lids) > LIST_ITEM_MAX:
            hide["item linked to too many topics (a list)"].extend(lids)
    return {"hide": dict(hide), "repoint": repoint, "kept_echoes": kept_echo, "visible": len(links)}


def apply(found: dict[str, Any], backup_path: str | None = None, conn=None) -> dict[str, int]:
    """Hide the planned links (recording why in hidden_reason when the column exists) and add the re-pointed ones."""
    from pipeline.db import connect, run_write

    ids = sorted({lid for lids in found["hide"].values() for lid in lids})
    if backup_path:
        c = connect()
        c.set_session(readonly=True)
        try:
            cur = c.cursor()
            cur.execute("select row_to_json(l) from matter_links l where id = any(%s)", (ids,))
            rows = [r[0] for r in cur.fetchall()]
            c.rollback()
        finally:
            c.close()
        with open(backup_path, "w") as f:
            json.dump({"hidden_links": rows, "plan": found}, f, default=str)

    def write(cur):
        for i in range(0, len(ids), 500):
            cur.execute("update matter_links set hidden = true where id = any(%s) and not hidden", (ids[i:i + 500],))
        added = 0
        for r in found["repoint"]:
            cur.execute("""insert into matter_links (matter_id, kind, agenda_item_id, confidence, source, hidden, quote)
                           values (%s, 'mention', %s, %s, %s, false, %s) on conflict do nothing returning id""",
                        (r["matter_id"], r["agenda_item_id"], r["confidence"], r["source"], r["quote"]))
            added += len(cur.fetchall())
        return added
    added = run_write(write, conn)
    return {"hidden": len(ids), "added": added}


def run(*, dry_run: bool = False, backup_path: str | None = None) -> dict[str, Any]:
    from pipeline.db import connect

    c = connect()
    c.set_session(readonly=True)
    try:
        found = plan(c.cursor())
        c.rollback()
    finally:
        c.close()
    counts = {reason: len(lids) for reason, lids in found["hide"].items()}
    print(f"  [Mentions] {found['visible']} visible; hide {counts}; re-point {len(found['repoint'])}; "
          f"keep {found['kept_echoes']} echo(es) that are the only record")
    if dry_run:
        return {**found, "counts": counts}
    applied = apply(found, backup_path)
    from pipeline.ingestion import participation_mentions

    participation_mentions.run()  # public comment linked since the last run: only the speakers about each topic
    return {**applied, "counts": counts}


# --- a topic's own steps shown as mentions ------------------------------------------------------------------------

def _bylaws(text: str | None) -> set[str]:
    from pipeline.ingestion.matter_matching import CITY_WIDE_BYLAWS, bylaw_identifiers

    return bylaw_identifiers(text) - CITY_WIDE_BYLAWS


ADDRESS_LIST = re.compile(
    r"\b(\d+[A-Za-z]?(?:\s*(?:,|&|and|/|–|-)\s*\d+[A-Za-z]?)*)\s+((?:[A-Z][a-z]+\s+)+"
    r"(?:Road|Rd|Street|St|Avenue|Ave|Drive|Dr|Lane|Ln|Place|Pl|Crescent|Cres|Way|Boulevard|Blvd|Court|Ct|Terrace|Terr|"
    r"Circle|Cir|Parkway|Pkwy|Close|Trail|Highway|Hwy)\b)")


def _numbered_addresses(text: str | None) -> set[str]:
    """Civic addresses in a title, each number of a list on its own: "3690 and 3694 Happy Valley Road" is two
    addresses, "967A and 967B Isabell Avenue" too."""
    from pipeline.ingestion.matter_matching import normalize_address

    out = set()
    for numbers, street in ADDRESS_LIST.findall(text or ""):
        for n in re.findall(r"\d+[A-Za-z]?", numbers):
            out.add(normalize_address(f"{n} {street}"))
    return out


def civic_numbers(text: str | None) -> set[str]:
    """Numbers in a title that look like civic numbers (not years): "875–881 Brock" -> {"875", "881"}."""
    return {n for n in re.findall(r"(?<![\w.])\d{3,5}[A-Za-z]?(?![\w])", text or "")
            if not re.fullmatch(r"(?:19|20)\d\d", n)}


def companion_bylaws(a: set[str], b: set[str]) -> bool:
    """An OCP amendment and its rezoning are numbered together (Bylaw 1612 and Bylaw 1613)."""
    num = lambda s: {int(n) for x in s for n in re.findall(r"\d+", x)}
    return any(abs(x - y) <= 2 for x in num(a) for y in num(b))


PROJECT_GAP_DAYS = 365


def close_in_time(a: dict, b: dict) -> bool:
    """The two topics' dates overlap or are within PROJECT_GAP_DAYS of each other."""
    try:
        gap = max((b["first"] - a["last"]).days, (a["first"] - b["last"]).days)
    except TypeError:
        return False
    return gap <= PROJECT_GAP_DAYS


def _street(address: str) -> str:
    return re.sub(r"^\S+\s+", "", address)


def same_project(a: dict, b: dict) -> bool:
    """Two topics are one project when they share a bylaw or a numbered address and neither also covers something
    else: a topic for "734 Latoria and 3416 Hazelwood hearings" is a bundle, not 734 Latoria's story. Extra addresses
    on the same street are the same land ("967A" and "967B Isabell Avenue"); a topic with no address must not
    carry bylaws the other doesn't have ("Zoning and sewer assistance bylaws" with five)."""
    if not (a["bylaws"] & b["bylaws"] or a["addresses"] & b["addresses"] or a["numbers"] & b["numbers"]):
        return False
    if not a["bylaws"] & b["bylaws"]:
        if a["bylaws"] and b["bylaws"] and not companion_bylaws(a["bylaws"], b["bylaws"]):
            return False  # two bylaws for one lot are two applications (a housing rezoning, then a daycare one)
        if not close_in_time(a, b):
            return False  # one lot, years apart, no shared bylaw: a cinema's sign variance is not a later showroom permit
        if (a["addresses"] & b["addresses"]) and (a["addresses"] & b["addresses"]) <= BUSY_ADDRESSES:
            return False  # a building with many tenants and applications: the address alone tells nothing
        # Without a shared bylaw, only the very same lots count: "778 Hockley" is not the four-lot "772–784 Hockley".
        if a["addresses"] and b["addresses"]:
            if a["addresses"] != b["addresses"]:
                return False
        elif a["numbers"] != b["numbers"] or not a["numbers"]:
            return False
    for x, y in ((a, b), (b, a)):
        if not x["addresses"]:  # "875–881 Brock and Strathmore rezoning": only its civic numbers to go by
            if x["bylaws"] - y["bylaws"] or (x["numbers"] and y["numbers"] and not x["numbers"] & y["numbers"]):
                return False
        elif y["addresses"]:
            if not x["addresses"] & y["addresses"]:
                return False
            streets = {_street(s) for s in x["addresses"] & y["addresses"]}
            if any(_street(s) not in streets for s in x["addresses"] - y["addresses"]):
                return False
    return True


BUSY_ADDRESSES: set[str] = set()
BUSY_MIN_TOPICS = 4


def load_topics(cur) -> dict[int, dict]:
    """Each topic's bylaws, addresses and dates, its aliases' included (a merged page is one project)."""
    cur.execute("""select m.id, m.identifier, coalesce(m.meta->>'display_title', m.title) || ' ' || m.title,
                          m.merged_into, m.meta->>'hidden', m.first_seen, m.last_seen from matters m""")
    topics = {mid: {"bylaws": _bylaws(ident), "addresses": _numbered_addresses(title), "numbers": civic_numbers(title),
                    "canonical": c, "hidden": hidden, "first": None, "last": None}
              for mid, ident, title, c, hidden, first, last in cur.fetchall()}
    # Dates from the topic's own items (first_seen/last_seen can carry other things' dates).
    cur.execute("""select ai.matter_id, min(mt.meeting_date), max(mt.meeting_date) from agenda_items ai
                   join meetings mt on mt.id = ai.meeting_id where ai.matter_id is not null group by 1""")
    for mid, first, last in cur.fetchall():
        if mid in topics:
            topics[mid]["first"], topics[mid]["last"] = first, last
    for mid, t in topics.items():
        if t["canonical"] and t["canonical"] in topics:
            home = topics[t["canonical"]]
            for k in ("bylaws", "addresses", "numbers"):
                home[k] = home[k] | t[k]
            if t["first"]:
                home["first"] = min(filter(None, (home["first"], t["first"])))
                home["last"] = max(filter(None, (home["last"], t["last"])))
    counts: dict[str, int] = defaultdict(int)
    for t in topics.values():
        if not t["canonical"] and t["hidden"] not in ("container", "staff", "true"):
            for a in t["addresses"]:
                counts[a] += 1
    BUSY_ADDRESSES.clear()
    BUSY_ADDRESSES.update(a for a, n in counts.items() if n >= BUSY_MIN_TOPICS)
    return topics


def same_project_pairs(cur, topics: dict[int, dict]) -> list[tuple[int, int, str]]:
    """Visible topic pairs that are one project: linked as related, or one's item shown as a mention on the other."""
    cur.execute("""select matter_id, related_matter_id, 'related' from matter_links where kind = 'related_matter' and not hidden
                   union
                   select ml.matter_id, ai.matter_id, 'mention' from matter_links ml join agenda_items ai on ai.id = ml.agenda_item_id
                   where ml.kind = 'mention' and not ml.hidden and ai.matter_id is not null""")
    out, seen = [], set()
    for a, b, why in cur.fetchall():
        a = topics.get(a, {}).get("canonical") or a
        b = topics.get(b, {}).get("canonical") or b
        pair = (min(a, b), max(a, b))
        if a == b or pair in seen or a not in topics or b not in topics:
            continue
        seen.add(pair)
        if any(topics[x]["hidden"] in ("container", "staff", "true") for x in pair):
            continue
        if same_project(topics[a], topics[b]):
            out.append((*pair, why))
    return out


def own_step_plan(cur) -> dict[str, Any]:
    """Mentions whose item's own title names the topic's own bylaw: a step of the topic, shown only as "Also
    discussed" (so its summary and status never see it). The item's topic (through any alias) decides:

    - duplicate: it is this topic already: hide the mention;
    - merge: another visible topic for the same bylaw or the same numbered address: the two are one project;
    - move: no visible topic (unfiled, a hidden heading topic) or one about something else: file it here
      (staff locks are respected);
    - skip: the item names several bylaws (a bundle), or is staff-locked to another topic."""
    topics = load_topics(cur)
    cur.execute("""select ml.id, ml.matter_id, ai.id, ai.title, ai.matter_id, ai.item_order, ai.meta->'staff_matter'
                   from matter_links ml join matters m on m.id = ml.matter_id join agenda_items ai on ai.id = ml.agenda_item_id
                   where ml.kind = 'mention' and not ml.hidden and m.identifier is not null
                     and m.merged_into is null""")
    out: dict[str, list] = {"move": [], "duplicate": [], "merge": [], "skip": []}
    for lid, mid, iid, title, owner, order, lock in cur.fetchall():
        mine, named = topics[mid]["bylaws"], _bylaws(first_line(title))
        if not mine & named or order == "official-recorded-motions":
            continue
        home = topics[owner]["canonical"] or owner if owner else None
        row = {"link_id": lid, "matter_id": mid, "item_id": iid, "owner": owner, "home": home, "title": first_line(title)[:120]}
        if home == mid:
            out["duplicate"].append(row)
        elif lock and lock.get("matter_id") not in (None, mid):
            out["skip"].append({**row, "why": "staff-locked to another topic"})
        elif len(named) > 1:
            out["skip"].append({**row, "why": "item names several bylaws"})
        elif home is None or topics[home]["hidden"] in ("container", "staff", "true"):
            out["move"].append(row)
        elif same_project(topics[home], topics[mid]):
            out["merge"].append({**row, "pair": sorted((mid, home))})
        elif topics[home]["bylaws"] & mine or topics[home]["addresses"] & topics[mid]["addresses"]:
            out["skip"].append({**row, "why": "shares a bylaw or address with a bundle of other projects"})
        else:
            out["move"].append(row)
    return out


def _bylaws_of(identifiers: dict, matter_id: int) -> set[str]:
    return _bylaws(identifiers.get(matter_id))


def fix_own_steps(supabase, *, dry_run: bool = True, backup_path: str | None = None,
                  clusters: list[list[int]] | None = None) -> dict[str, Any]:
    """Act on ``own_step_plan``: merge each same-project cluster (plus any ``clusters`` given), file the items that
    belong here, then hide the mentions that became the topic's own entries and refresh the touched topics."""
    from pipeline.db import connect
    from pipeline.ingestion.matter_lifecycle import refresh_meeting_matter_lifecycles
    from pipeline.ingestion.matter_resolver import merge_flat
    from pipeline.ingestion.matter_summaries import refresh_matter_summaries
    from pipeline.ingestion.staff_fixes import move_item

    c = connect()
    c.set_session(readonly=True)
    try:
        cur = c.cursor()
        found = own_step_plan(cur)
        cur.execute("select id, identifier from matters")
        cur_ident = dict(cur.fetchall())
        parent: dict[int, int] = {}

        def root(x):
            while parent.get(x, x) != x:
                x = parent[x]
            return x
        pairs = [tuple(r["pair"]) for r in found["merge"]] + [p[:2] for p in same_project_pairs(cur, load_topics(cur))]
        for a, b in pairs:
            parent[root(a)] = root(b)
        for cl in clusters or []:
            for x in cl[1:]:
                parent[root(x)] = root(cl[0])
        groups: dict[int, set[int]] = defaultdict(set)
        for x in list(parent):
            groups[root(x)].add(x)
            groups[root(x)].add(root(x))
        merges = [sorted(g) for g in groups.values() if len(g) > 1]
        merged = {x: root(x) for g in merges for x in g}
        moves, by_item = [], defaultdict(list)
        for m in found["move"]:
            by_item[m["item_id"]].append(m)
        for item_id, options in by_item.items():  # one item, several topics: the most specific one (fewest bylaws)
            targets = {merged.get(o["matter_id"], o["matter_id"]) for o in options}
            if len(targets) == 1:
                moves.append(options[0])
                continue
            ranked = sorted(options, key=lambda o: len(_bylaws_of(cur_ident, o["matter_id"])))
            if len(_bylaws_of(cur_ident, ranked[0]["matter_id"])) < len(_bylaws_of(cur_ident, ranked[1]["matter_id"])):
                moves.append(ranked[0])
        ids = sorted({i for g in merges for i in g} | {m["matter_id"] for m in moves})
        cur.execute("select row_to_json(m) from matters m where id = any(%s) or merged_into = any(%s)", (ids, ids))
        matters_before = [r[0] for r in cur.fetchall()]
        cur.execute("select id, matter_id, meeting_id, meta from agenda_items where id = any(%s)", ([m["item_id"] for m in moves],))
        items_before = [{"id": i, "matter_id": mid, "meeting_id": mt, "meta": meta} for i, mid, mt, meta in cur.fetchall()]
        c.rollback()
    finally:
        c.close()
    print(f"  [OwnSteps] {len(merges)} merge(s) of {sum(len(g) for g in merges)} topics, {len(moves)} move(s), "
          f"{len(found['duplicate'])} duplicate mention(s), {len(found['skip'])} skipped")
    if dry_run:
        return {"merges": merges, "moves": moves, "skip": found["skip"]}
    if backup_path:
        with open(backup_path, "w") as f:
            json.dump({"matters": matters_before, "items": items_before, "plan": found, "merges": merges}, f, default=str)
    touched: set[int] = set()
    done = []
    for g in merges:
        explicit = next((cl[0] for cl in clusters or [] if set(cl) <= set(g)), None)
        res = merge_flat(supabase, g, canonical=explicit, reason="same project (own-step mentions)")
        touched.add(res["canonical"])
        done.append(res)
    meetings = set()
    for m in moves:
        res = move_item(supabase, m["item_id"], m["matter_id"], by=None,
                        reason="Its own title names this topic's bylaw; it was shown here only as a mention")
        touched.update(x for x in (res["from"], res["to"]) if x)
        meetings.add(res["meeting_id"])
    for meeting_id in meetings:
        refresh_meeting_matter_lifecycles(supabase, meeting_id)
    hygiene = run()  # mentions that are now the topic's own entries
    summaries = refresh_matter_summaries(supabase, sorted(touched)) if touched else {}
    return {"merged": done, "moved": len(moves), "hygiene": hygiene, "summaries": len(summaries)}
