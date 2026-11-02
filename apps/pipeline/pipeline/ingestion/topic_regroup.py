"""Regroup topics that city-wide bylaws mixed together (stage ``topic-regroup``).

Until Nov 2026 a city-wide bylaw cited by nearly every application (Zoning Bylaw No. 300, the subdivision servicing
bylaw ...) counted as a topic identifier, so variances on unrelated streets were filed under one topic (Katie's Pond
picked up Selwyn Road and Jeanine Drive). The matcher no longer does this (matter_matching.CITY_WIDE_BYLAWS); this
stage cleans up what it left:

- ``plan``: for each topic whose entries sit on streets that never overlap, or that a city-wide bylaw identified, the
  review model says which entries are about something else. Each of those goes to the topic the matcher now finds for
  it (the mixed topic itself excluded), or to a new topic. City-wide bylaws are dropped from topic identifiers.
  Nothing is written; the plan is saved as JSON and a readable markdown file.
- ``apply``: carries out a saved plan after backing up every row it changes, then refreshes the touched topics'
  summaries. Items staff placed by hand (agenda_items.meta.staff_matter) are never moved.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from pipeline import ai
from pipeline.ingestion.matter_matching import (
    MatterMatcher, extract_addresses, identifying_identifier, is_city_wide, is_matter_eligible, normalize_address,
    parse_compound_identifier,
)
from pipeline.ingestion.staff_fixes import staff_matter

_SUFFIX = r"\b(road|rd|avenue|ave|drive|dr|street|st|way|place|pl|crescent|cres|terrace|boulevard|blvd|lane|ln|court|ct|parkway|pkwy|close|trail|highway|hwy)\b\.?"


def _street(address: str) -> str:
    s = re.sub(r"^\s*[\d\-&,\s]+", "", address or "").lower()
    return re.sub(r"\W+", " ", re.sub(_SUFFIX, "", s)).strip()


def _addresses(raw) -> list[str]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = [raw]
    return [a for a in (raw or []) if isinstance(a, str) and a.strip()]


def street_groups(entries: list[dict]) -> list[set[int]]:
    """Entries joined by any shared street; more than one group means the topic spans unrelated places."""
    groups: list[tuple[set[int], set[str]]] = []
    for e in entries:
        streets = {_street(a) for a in e["addresses"]} - {""}
        if not streets:
            continue
        hit = [g for g in groups if g[1] & streets]
        merged = ({e["id"]}, set(streets))
        for g in hit:
            merged[0].update(g[0]); merged[1].update(g[1]); groups.remove(g)
        groups.append(merged)
    return [g[0] for g in groups]


class EntryVerdict(BaseModel):
    item_id: int
    belongs: bool = Field(description="True when the entry is about the topic's subject (the same application, site or project).")
    reason: str = Field(description="One plain sentence.")


class TopicVerdict(BaseModel):
    subject: str = Field(description="The topic's subject in a few words, e.g. 'Katie's Pond lot-width variances, 3467 Happy Valley Road'.")
    entries: list[EntryVerdict]


def _ask(topic: dict, entries: list[dict]) -> TopicVerdict:
    lines = "\n".join(
        f"[{e['id']}] {e['date']} | {e['title']} | addresses: {', '.join(e['addresses']) or 'none'}"
        f"{' | ' + e['summary'] if e['summary'] else ''}" for e in entries)
    prompt = f"""A topic page on Open Langford (a site that follows Langford City council) groups agenda entries about one
application, site or project. Some topics wrongly picked up entries about other applications because they all cite
the same city-wide bylaw (such as Zoning Bylaw No. 300).

Topic title: {topic['title']}
Topic permit/bylaw numbers: {identifying_identifier(topic['identifier']) or 'none'}

The subject is what the title and numbers name; if they don't settle it, what most entries share. For each entry say
whether it is about that subject. Entries about the same project can span several streets (a subdivision's phases, a
road project, an event route); entries about a different property's own application do not belong.

Entries:
{lines}"""
    return ai.json(prompt, stage="review", schema=TopicVerdict)


def _load(cur) -> tuple[dict[int, dict], dict[int, list[dict]]]:
    cur.execute("""select m.id, m.title, m.identifier, coalesce(m.meta->>'display_title', m.title), m.slug
                   from matters m where m.meta->>'canonical_matter_id' is null and m.meta->>'hidden' is null""")
    topics = {r[0]: {"id": r[0], "title": r[1], "identifier": r[2], "display": r[3], "slug": r[4]} for r in cur.fetchall()}
    cur.execute("""select a.id, a.matter_id, mt.meeting_date, a.title, a.related_address, a.plain_english_summary, a.meta
                   from agenda_items a join meetings mt on mt.id = a.meeting_id
                   where a.matter_id = any(%s) order by mt.meeting_date""", (list(topics),))
    entries: dict[int, list[dict]] = defaultdict(list)
    for iid, mid, day, title, addrs, summary, meta in cur.fetchall():
        entries[mid].append({"id": iid, "date": str(day), "title": (title or "").split("\n")[0][:220],
                             "addresses": _addresses(addrs), "summary": (summary or "")[:280], "meta": meta or {}})
    return topics, entries


def plan(supabase, *, matter_ids: list[int] | None = None, log=print) -> dict[str, Any]:
    from pipeline.db import connect
    from pipeline.ingestion.matter_names import file_numbers

    conn = connect()
    conn.set_session(readonly=True)
    cur = conn.cursor()
    topics, entries = _load(cur)
    conn.rollback()
    conn.close()

    def city_keyed(t):
        return any(is_city_wide(p) for p in parse_compound_identifier(t["identifier"] or ""))

    review = [mid for mid, t in topics.items() if len(entries.get(mid, [])) >= 2
              and (matter_ids is None or mid in matter_ids)
              and (len(street_groups(entries[mid])) > 1 or city_keyed(t))]
    log(f"  [regroup] reviewing {len(review)} topic(s)")

    def judge(mid):
        try:
            return mid, _ask(topics[mid], entries[mid]), None
        except Exception as error:  # one topic's failure must not sink the plan
            return mid, None, str(error)

    with ThreadPoolExecutor(max_workers=6) as pool:
        verdicts = list(pool.map(judge, review))

    matcher = MatterMatcher(supabase, None)
    matcher.load()
    all_matters = list(matcher.matters)
    moves, kept, failed, skipped = [], [], [], []
    for mid, verdict, error in verdicts:
        if error or verdict is None:
            failed.append({"topic": mid, "error": error})
            continue
        own = {e["id"]: e for e in entries[mid]}
        leaving = [v for v in verdict.entries if not v.belongs and v.item_id in own]
        if len(leaving) == len(own):
            failed.append({"topic": mid, "error": "model said no entry belongs; left for a person"})
            continue
        # Find each leaving entry a home with the mixed topic out of the running.
        matcher.matters = [m for m in all_matters if m["id"] != mid]
        matcher._build_identifier_index(); matcher._build_address_index(); matcher._build_entity_cluster_index()
        for v in leaving:
            e = own[v.item_id]
            if staff_matter(e["meta"]):
                skipped.append({"topic": mid, "item": e["id"], "title": e["title"], "why": "placed by staff"})
                continue
            numbers = file_numbers(e["title"])
            move = {"item": e["id"], "date": e["date"], "title": e["title"], "addresses": e["addresses"],
                    "from": mid, "from_title": topics[mid]["display"], "subject": verdict.subject, "why": v.reason,
                    "to": None, "to_title": None, "match": None, "new_topic_key": None, "unfile": False}
            subject = re.sub(r"^[A-Z][A-Z ,&'/]+\s+[—-]\s+", "", e["title"])  # "COMMITTEE RESOLUTIONS — Application ..."
            if not is_matter_eligible(identifier=numbers[0] if numbers else None, title=subject,
                                      related_addresses=e["addresses"], summary=e["summary"])[0]:
                moves.append({**move, "unfile": True})  # a heading or procedural line: on no topic, as ingest would leave it
                continue
            to, how, _ = matcher.find_match(numbers[0] if numbers else None, subject, e["addresses"], meeting_date=e["date"])
            target = next((m for m in all_matters if m["id"] == to), None) if to in topics else None
            mine = {normalize_address(a) for a in e["addresses"]} | set(extract_addresses(e["title"]))
            # Only a destination as sure as the mistake is plain: the same permit or bylaw number, or the same address.
            if target and (str(how).startswith("identifier_exact") or mine & target.get("_addresses", set())):
                moves.append({**move, "to": to, "to_title": topics[to]["display"], "match": how})
            else:
                moves.append({**move, "new_topic_key": numbers[0] if numbers else
                              (sorted(mine)[0] if mine else f"item-{e['id']}")})
        kept.append({"topic": mid, "title": topics[mid]["display"], "subject": verdict.subject,
                     "stays": len(own) - len(leaving), "leaves": len(leaving)})
    identifiers = []
    for mid, t in topics.items():
        if city_keyed(t):
            new = identifying_identifier(t["identifier"])
            clash = [o for o, ot in topics.items() if o != mid and new and ot["identifier"] == new]
            identifiers.append({"topic": mid, "title": t["display"], "from": t["identifier"], "to": new, "clash": clash})
    return {"at": datetime.now(timezone.utc).isoformat(), "reviewed": len(review), "topics": kept, "moves": moves,
            "skipped": skipped, "failed": failed, "identifiers": identifiers}


def describe(report: dict) -> str:
    moves = report["moves"]
    existing = [m for m in moves if m["to"]]
    unfiled = [m for m in moves if m["unfile"]]
    new = [m for m in moves if not m["to"] and not m["unfile"]]
    out = [f"# Topic regroup plan ({report['at'][:10]})", "",
           f"Reviewed {report['reviewed']} topics. {len(moves)} entries move: {len(existing)} to an existing topic, "
           f"{len(new)} to {len({m['new_topic_key'] for m in new})} new topics, {len(unfiled)} off every topic (headings). "
           f"{len(report['skipped'])} skipped (placed by staff), {len(report['failed'])} not decided. "
           f"{len(report['identifiers'])} topic identifiers lose a city-wide bylaw.", ""]
    by_topic = defaultdict(list)
    for m in moves:
        by_topic[(m["from"], m["from_title"], m["subject"])].append(m)
    for (mid, title, subject), ms in sorted(by_topic.items(), key=lambda kv: -len(kv[1])):
        out += [f"## {title} (topic {mid})", f"Subject: {subject}", ""]
        for m in ms:
            dest = (f"→ **{m['to_title']}** (topic {m['to']}, {m['match']})" if m["to"] else
                    "→ **no topic** (a heading)" if m["unfile"] else f"→ **new topic** ({m['new_topic_key']})")
            out.append(f"- {m['date']} · {m['title']} {dest}  \n  _{m['why']}_")
        out.append("")
    if report["failed"]:
        out += ["## Not decided", ""] + [f"- topic {f['topic']}: {f['error']}" for f in report["failed"]] + [""]
    if report["skipped"]:
        out += ["## Skipped (placed by staff)", ""] + [f"- topic {s['topic']}: {s['title']}" for s in report["skipped"]] + [""]
    out += ["## Identifier cleanup", ""] + [
        f"- {i['title']} (topic {i['topic']}): `{i['from']}` → `{i['to'] or '(none)'}`"
        + (f" **clashes with topic {i['clash']}, left as is**" if i["clash"] else "") for i in report["identifiers"]]
    return "\n".join(out)


def apply(supabase, plan_path: str, *, dry_run: bool = True, backup_dir: str | None = None, log=print) -> dict[str, Any]:
    """Carry out a saved plan. Backs up every row first; dry_run (the default) only reports."""
    from pipeline.ingestion.ingester import _match_note
    from pipeline.ingestion.matter_summaries import refresh_matter_summaries

    report = json.loads(Path(plan_path).read_text())
    moves = report["moves"]
    item_ids = [m["item"] for m in moves]
    topic_ids = sorted({m["from"] for m in moves} | {m["to"] for m in moves if m["to"]} | {i["topic"] for i in report["identifiers"]})
    log(f"  [regroup] {len(moves)} move(s), {len(report['identifiers'])} identifier change(s)" + (" (dry run)" if dry_run else ""))
    if dry_run:
        return {"moves": len(moves), "identifiers": len(report["identifiers"]), "dry_run": True}

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    folder = Path(backup_dir or f"backups/topic-regroup-{stamp}")
    folder.mkdir(parents=True, exist_ok=True)
    for name, table, column, ids in [("agenda_items", "agenda_items", "id", item_ids), ("matters", "matters", "id", topic_ids),
                                     ("property_links", "property_links", "agenda_item_id", item_ids)]:
        rows = []
        for start in range(0, len(ids), 200):
            rows += supabase.table(table).select("*").in_(column, ids[start:start + 200]).execute().data or []
        (folder / f"{name}.json").write_text(json.dumps(rows, default=str))
    log(f"  [regroup] backup written to {folder}")

    created: dict[str, int] = {}
    touched: set[int] = set()
    done = 0
    for m in moves:
        item = supabase.table("agenda_items").select("id, matter_id, meta").eq("id", m["item"]).single().execute().data
        if item["matter_id"] != m["from"] or staff_matter(item.get("meta")):
            continue  # changed since the plan, or staff placed it
        to = m["to"]
        if not to and not m["unfile"]:
            to = created.get(m["new_topic_key"])
            if not to:
                numbers = parse_compound_identifier(m["new_topic_key"]) if not m["new_topic_key"].startswith("item-") else []
                title = re.sub(r"\s+[—-]\s+Staff Report\b.*$", "", re.sub(r"^[A-Z][A-Z ,&'/]+\s+[—-]\s+", "", m["title"]))
                data = {"title": title, "category": "Development", "status": "Active",
                        "first_seen": m["date"], "last_seen": m["date"], "municipality_id": 1,
                        "meta": {"created_by": "topic-regroup", "regrouped_from": m["from"]}}
                if numbers and not supabase.table("matters").select("id").eq("identifier", m["new_topic_key"]).execute().data:
                    data["identifier"] = m["new_topic_key"]
                to = supabase.table("matters").insert(data).execute().data[0]["id"]
                created[m["new_topic_key"]] = to
        meta = {**(item.get("meta") or {}), "matter_match": {**_match_note(f"regroup:{m['match'] or 'new_topic'}", 1.0),
                                                              "from": m["from"]}}
        supabase.table("agenda_items").update({"matter_id": to, "meta": meta}).eq("id", m["item"]).execute()
        supabase.table("property_links").update({"matter_id": to}).eq("agenda_item_id", m["item"]).execute()
        touched |= {m["from"]} | ({to} if to else set())
        done += 1
    for i in report["identifiers"]:
        if not i["clash"]:
            supabase.table("matters").update({"identifier": i["to"]}).eq("id", i["topic"]).eq("identifier", i["from"]).execute()
    log(f"  [regroup] moved {done} item(s), created {len(created)} topic(s); refreshing {len(touched)} topic summaries")
    if touched:
        refresh_matter_summaries(supabase, sorted(touched))
    return {"moves": done, "created": len(created), "touched": len(touched), "backup": str(folder)}


if __name__ == "__main__":
    # uv run python -m pipeline.ingestion.topic_regroup plan --out DIR [--topic ID ...]
    # uv run python -m pipeline.ingestion.topic_regroup apply DIR/topic-regroup-plan.json [--write]
    import argparse

    from pipeline import config
    from pipeline.ai.usage_sink import install_usage_logging
    from pipeline.supabase_client import create_client

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("plan"); p.add_argument("--out", required=True); p.add_argument("--topic", type=int, action="append")
    a = sub.add_parser("apply"); a.add_argument("plan"); a.add_argument("--write", action="store_true",
                                                                         help="Actually change the data (default: dry run).")
    args = parser.parse_args()
    client = create_client(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY or config.SUPABASE_KEY)
    sink = install_usage_logging()
    if args.command == "plan":
        result = plan(client, matter_ids=args.topic)
        out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
        (out / "topic-regroup-plan.json").write_text(json.dumps(result, default=str, indent=1))
        (out / "topic-regroup-plan.md").write_text(describe(result))
        print(f"  plan written to {out}/topic-regroup-plan.md")
    else:
        print(apply(client, args.plan, dry_run=not args.write))
    if sink is not None:
        sink.flush(timeout=10)
