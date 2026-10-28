"""A short, plain-language overview of what Council has considered at an address.

Property pages (lots and streets) list every matter and agenda item linked to
the address. This writes one or two sentences on top of that list into
``properties.meta.summary`` ("9 matters since 2016, mostly about rezoning for a
mixed-use building, ..."), for every property with at least ``MIN_RECORDS``
visible records. A record is a distinct matter, or an agenda item outside any
matter, linked through a non-hidden ``property_links`` row (the same count the
properties index shows).

``meta.summary_version`` stamps the prompt version and ``meta.summary_inputs``
a hash of the record set, so ``--stale`` re-runs a property when the prompt
changes or its linked records change. Bump ``PROPERTY_SUMMARY_VERSION`` after a
prompt change and run ``main.py --stage property-summaries --stale``.
"""
from __future__ import annotations

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from pydantic import BaseModel

from pipeline import ai

PROPERTY_SUMMARY_VERSION = "1"
MIN_RECORDS = 2
MAX_CHARS = 240
MAX_MATTERS = 40  # long streets: the most recent ones are plenty for an overview
MAX_ITEMS = 25
STAGE = "extraction"  # same model config as matter summaries and decision headlines

SYSTEM = """You write the opening line of an address page on a civic records site for a small Canadian city.
Residents read it to learn, at a glance, what Council has considered at that address.

Write one or two plain sentences, at most 240 characters in total.
Start with the number of records and the first year when known, e.g. "9 matters since 2016, mostly about ...".
Use the record count and first year given in the input exactly; never recount.
Then say what kind of change it has mostly been about: housing, rezoning, development or building permits,
subdivision, variances, roads, parks, business licences, and so on. Name the scale when the inputs say it
(e.g. "a six-storey apartment building", "40 townhomes") and name the most significant one or two items.
Plain everyday words for residents. No bylaw, amendment, permit or file numbers ("Bylaw No. 300 Amendment No. 769"),
no planning jargon ("OCP", "DVP", "TUP"); say "official community plan", "variance", "temporary use permit" instead.
For a street (no civic number), describe what Council considered about the street itself (roadworks, closures, names, traffic).
Never invent anything that is not in the inputs: no outcomes, numbers, dates or building details beyond them.
Never mention people's names, applicants, companies, or residents' personal details.
Do not repeat the address, and do not start with "This address" or "Council"."""


class PropertySummary(BaseModel):
    summary: str


def _year(value) -> int | None:
    text = str(value or "")[:4]
    return int(text) if text.isdigit() else None


def record_keys(links: list[dict], visible_matters: set[int] | None = None) -> list[str]:
    """Distinct records for one property's visible links: ``m<matter id>`` or ``i<agenda item id>``.

    Links to a hidden or merged matter (not in ``visible_matters``, when given) don't count."""
    keys = set()
    for link in links:
        if link.get("hidden"):
            continue
        if link.get("matter_id"):
            if visible_matters is None or link["matter_id"] in visible_matters:
                keys.add(f"m{link['matter_id']}")
        elif link.get("agenda_item_id"):
            keys.add(f"i{link['agenda_item_id']}")
    return sorted(keys, key=lambda k: (k[0], int(k[1:])))


def inputs_hash(keys: list[str]) -> str:
    return hashlib.sha1(",".join(sorted(keys)).encode()).hexdigest()[:16]


def _pages(build, size: int = 1000) -> list[dict]:
    rows, start = [], 0
    while True:
        page = build().range(start, start + size - 1).execute().data or []
        rows += page
        if len(page) < size:
            return rows
        start += size


def load_properties(supabase) -> list[dict]:
    """Every property with its visible record keys and current summary stamps."""
    properties = _pages(lambda: supabase.table("properties").select("id, slug, address, civic_number, meta").order("id"))
    links = _pages(lambda: supabase.table("property_links").select("property_id, matter_id, agenda_item_id, hidden")
                   .eq("hidden", False).order("id"))
    matter_rows = _pages(lambda: supabase.table("matters")
                         .select("id, canonical:meta->>canonical_matter_id, hidden:meta->>hidden").order("id"))
    visible = {m["id"] for m in matter_rows if not m.get("canonical") and m.get("hidden") not in ("true", True)}
    by_property: dict[int, list[dict]] = {}
    for link in links:
        by_property.setdefault(link["property_id"], []).append(link)
    out = []
    for p in properties:
        keys = record_keys(by_property.get(p["id"], []), visible)
        out.append({**p, "meta": p.get("meta") or {}, "records": keys})
    return out


def eligible(p: dict) -> bool:
    return len(p["records"]) >= MIN_RECORDS


def is_property_stale(p: dict, version: str = PROPERTY_SUMMARY_VERSION) -> bool:
    """Eligible and either never summarized, summarized by an older prompt, or its records changed."""
    from pipeline.stages import is_stale

    meta = p.get("meta") or {}
    return eligible(p) and (
        not meta.get("summary")
        or is_stale(meta.get("summary_version"), version)
        or meta.get("summary_inputs") != inputs_hash(p["records"])
    )


def needs_clearing(p: dict) -> bool:
    """A summary left over from when the property had more records."""
    return not eligible(p) and bool((p.get("meta") or {}).get("summary"))


def _chunks(ids: list[int], size: int = 200):
    for start in range(0, len(ids), size):
        yield ids[start:start + size]


def load_inputs(supabase, props: list[dict]) -> dict[int, dict]:
    """Property id -> the model's input (address, record count, matters, loose agenda items)."""
    matter_ids = sorted({int(k[1:]) for p in props for k in p["records"] if k[0] == "m"})
    item_ids = sorted({int(k[1:]) for p in props for k in p["records"] if k[0] == "i"})
    matters: dict[int, dict] = {}
    for chunk in _chunks(matter_ids):
        for m in supabase.table("matters").select(
            "id, title, category, status, first_seen, last_seen, plain_english_summary, meta"
        ).in_("id", chunk).execute().data or []:
            matters[m["id"]] = m
    items: dict[int, dict] = {}
    for chunk in _chunks(item_ids):
        for i in supabase.table("agenda_items").select(
            "id, title, plain_english_summary, meetings(meeting_date)"
        ).in_("id", chunk).execute().data or []:
            items[i["id"]] = i
    return {p["id"]: build_input(p, matters, items) for p in props}


def build_input(p: dict, matters: dict[int, dict], items: dict[int, dict]) -> dict:
    ms = [matters[int(k[1:])] for k in p["records"] if k[0] == "m" and int(k[1:]) in matters]
    its = [items[int(k[1:])] for k in p["records"] if k[0] == "i" and int(k[1:]) in items]
    ms.sort(key=lambda m: str(m.get("last_seen") or m.get("first_seen") or ""), reverse=True)
    its.sort(key=lambda i: str((i.get("meetings") or {}).get("meeting_date") or ""), reverse=True)
    years = [y for m in ms for y in (_year(m.get("first_seen")), _year(m.get("last_seen"))) if y]
    years += [y for i in its if (y := _year((i.get("meetings") or {}).get("meeting_date")))]
    matter_rows = []
    for m in ms[:MAX_MATTERS]:
        first, last = _year(m.get("first_seen")), _year(m.get("last_seen"))
        matter_rows.append({
            "title": (m.get("meta") or {}).get("display_title") or m.get("title") or "",
            "category": m.get("category") or "",
            "status": m.get("status") or "",
            "years": f"{first}–{last}" if first and last and first != last else str(first or last or ""),
            "summary": (m.get("plain_english_summary") or "")[:500],
        })
    item_rows = [{
        "title": i.get("title") or "",
        "year": _year((i.get("meetings") or {}).get("meeting_date")),
        "summary": (i.get("plain_english_summary") or "")[:300],
    } for i in its[:MAX_ITEMS]]
    n_matters, n_items = len(ms), len(its)
    if n_items and n_matters:
        count = f"{n_matters} {'matter' if n_matters == 1 else 'matters'} and {n_items} other agenda {'item' if n_items == 1 else 'items'}"
    elif n_matters:
        count = f"{n_matters} {'matter' if n_matters == 1 else 'matters'}"
    else:
        count = f"{n_items} agenda {'item' if n_items == 1 else 'items'}"
    return {
        "address": p["address"],
        "kind": "street" if p.get("civic_number") == "" else "lot",
        "record_count": count,
        "first_year": min(years) if years else None,
        "last_year": max(years) if years else None,
        "matters": matter_rows,
        "other_agenda_items": item_rows,
    }


def prompt(data: dict) -> str:
    return "Write the overview for this address.\n\n" + json.dumps(data, ensure_ascii=False)


def clean(summary: str) -> str:
    text = " ".join((summary or "").split()).strip().strip('"').strip()
    if len(text) > MAX_CHARS:  # trim at a sentence, else a word
        cut = text[:MAX_CHARS]
        end = cut.rfind(". ")
        text = cut[:end + 1] if end > MAX_CHARS // 2 else cut[:cut.rfind(" ")].rstrip(",;:") + "…"
    return text


def summarize(data: dict) -> str:
    result = ai.json(prompt(data), stage=STAGE, schema=PropertySummary, system=SYSTEM)
    return clean(result.summary)


def summarize_properties(supabase, props: list[dict], *, write: bool = True, workers: int = 4) -> dict[int, str]:
    """Summarize ``props`` (rows from ``load_properties``). Model calls run in parallel; reads and
    writes stay on the calling thread (the supabase client isn't thread-safe)."""
    inputs = load_inputs(supabase, props)

    def one(p):
        try:
            return p["id"], summarize(inputs[p["id"]])
        except Exception as e:  # one property failing shouldn't stop the rest
            print(f"  [!] Property summary for {p['address']} ({p['id']}) failed: {e}", flush=True)
            return p["id"], None

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        results = dict(pool.map(one, props))
    done: dict[int, str] = {}
    now = datetime.now(timezone.utc).isoformat()
    for p in props:
        summary = results.get(p["id"])
        if not summary:
            continue
        done[p["id"]] = summary
        if write:
            meta = {**(p.get("meta") or {}), "summary": summary, "summary_version": PROPERTY_SUMMARY_VERSION,
                    "summary_inputs": inputs_hash(p["records"]), "summary_updated_at": now}
            supabase.table("properties").update({"meta": meta}).eq("id", p["id"]).execute()
    return done


def clear_summaries(supabase, props: list[dict]) -> int:
    for p in props:
        meta = {k: v for k, v in (p.get("meta") or {}).items()
                if k not in ("summary", "summary_version", "summary_inputs", "summary_updated_at")}
        supabase.table("properties").update({"meta": meta}).eq("id", p["id"]).execute()
    return len(props)
