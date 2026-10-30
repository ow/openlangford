"""A short, plain-language overview of what Council has considered at an address.

Property pages (lots and streets) list every matter and agenda item linked to
the address. This writes the lead on top of that list into
``properties.meta.summary``, which is also the page's search description:
what is happening there, most recent first, then a closing count in everyday
words ("Mentioned in council meetings 41 times since 2009.") computed here, not
by the model, so it always matches the page header.

A lot is summarized when it has at least ``MIN_RECORDS`` visible records (a
distinct matter, or an agenda item outside any matter, linked through a
non-hidden ``property_links`` row). A street page also lists its addresses and
charts their activity, so a street's summary covers the road itself and the
busiest developments on it, over the same span the page shows; a street is
summarized when it has ``MIN_RECORDS`` records of its own or ``MIN_ADDRESSES``
addresses with records. Lots known only because a resident gave their home
address while speaking or writing to Council (``resident_only``) are never
summarized and never feed a street's summary; the web app noindexes them.

``meta.summary_version`` stamps the prompt version and ``meta.summary_inputs``
a hash of the record set (a street's includes its lots') and the closing line,
so ``--stale`` re-runs a property when the prompt changes or its records do.
Bump ``PROPERTY_SUMMARY_VERSION`` after a prompt change and run
``main.py --stage property-summaries --stale``.
"""
from __future__ import annotations

import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from pydantic import BaseModel

from pipeline import ai

PROPERTY_SUMMARY_VERSION = "2"
MIN_RECORDS = 2
MIN_ADDRESSES = 2  # a street page with two or more addresses gets a summary even with no records of its own
NARRATIVE_MAX = 220  # the model's part; the closing count follows
MAX_CHARS = NARRATIVE_MAX  # kept for callers of clean()
MAX_MATTERS = 30
MAX_ITEMS = 15
STREET_BUSIEST = 8  # a street's busiest addresses fed to the model
STREET_RECENT = 4  # plus its most recently active ones
PER_ADDRESS_MATTERS = 4
STAGE = "extraction"  # same model config as matter summaries and decision headlines
META_KEYS = ("summary", "summary_version", "summary_inputs", "summary_updated_at")

# Same rule as the web app (lib/public-input.ts): a resident speaking or writing to Council.
PUBLIC_INPUT = re.compile(r"public\s+(?:participation|input|comment|hearing\s+submission)|correspondence|delegation|"
                          r"written\s+submission|petition", re.I)
PUBLIC_INPUT_CATEGORIES = {"public input"}

SYSTEM = """You write the opening lines of an address page on a civic site for Langford, BC.
Readers are residents on a phone who have never read a council agenda. They want to know what is happening at this address or on this street, and whether it affects them.
The same text is the page's description in Google search results, so the first sentence must stand on its own.

Write one to three short sentences, at most 170 characters in total. Do not give any count, total or date range: a closing line with those is added after your text.

Rules from the site's writing guide:
- "Say what happened, not what was on the agenda." "Council approved 47 homes on Latoria Road", not "Consider bringing Bylaw 2278 forward".
- "Most important first. Lead with the outcome and who it affects." Lead with what matters most to a neighbour: the biggest change (the most homes, the tallest building, a new school or park, a road change), with its year and outcome. Then, after "Earlier:" or "Later:", at most one or two other significant ones. Skip minor items (trail names, signs, a single licence) when bigger ones exist.
- "Everyday words." Write "garbage" not "solid waste", "passed" not "adopted", "rules" not "regulations". Say "official community plan", "variance", "temporary use permit", never OCP, DVP or TUP.
- "Explain process instead of naming it." "Moved one step from final approval", not "gave first, second and third reading". "Made final", not "adopted at fourth reading".
- "No internal codes." No bylaw, file, permit or policy numbers.
- "No database words." Never "matters", "records", "agenda items" or "mentions".
- "Short sentences, active voice." About 20 words at most per sentence. Council is the subject.
- "Concrete." Name the development, the facility and the dollar amount. Whenever the inputs give the number of homes, lots, units or storeys for a project you mention, keep that number ("a 47-lot subdivision", "a six-storey building with 93 homes").
- "Never invent." If the inputs don't say how something ended, leave the outcome out. Don't open with what is missing.
- "Write so it stays true." No "currently" or "recently"; give the year instead.
- Canadian spelling.

For a lot (kind "lot"): say what has been proposed or decided there. Example: "A subdivision of up to 47 homes, approved in 2015 after changes to the official community plan and zoning."
For a street (kind "street"): cover both the road itself (roadworks, closures, traffic, grants; newest first) and the developments at addresses on it. Name the projects at the addresses in "most_considered" (the ones Council considered most often) first; add one other, larger project only if it fits. Example: "In 2024 Council backed grant applications for walking and cycling upgrades on Latoria Road. Earlier: a 47-lot subdivision at 935 and the 501-home McCormick Meadows plan at 940." Refer to an address on the street by its number alone ("a 47-lot subdivision at 935"), since the street is the page.
Never mention people's names, applicants, companies, or residents' personal details. Never start with "This address", "This street" or the address itself."""


class PropertySummary(BaseModel):
    summary: str


def _year(value) -> int | None:
    text = str(value or "")[:4]
    return int(text) if text.isdigit() else None


def is_public_input(item: dict | None) -> bool:
    """An agenda item where residents spoke or wrote to Council (their own addresses are personal)."""
    if not item:
        return False
    return (str(item.get("category") or "").strip().lower() in PUBLIC_INPUT_CATEGORIES
            or bool(PUBLIC_INPUT.search(item.get("title") or "")))


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


def inputs_hash(keys: list[str], closing: str = "") -> str:
    return hashlib.sha1((",".join(sorted(keys)) + ("|" + closing if closing else "")).encode()).hexdigest()[:16]


def _pages(build, size: int = 1000) -> list[dict]:
    rows, start = [], 0
    while True:
        page = build().range(start, start + size - 1).execute().data or []
        rows += page
        if len(page) < size:
            return rows
        start += size


def _item_date(link: dict) -> str | None:
    return ((link.get("agenda_items") or {}).get("meetings") or {}).get("meeting_date")


def resident_only(links: list[dict]) -> bool:
    """Every visible link to this lot comes from residents' input (a delegation, a letter, public comment)."""
    return bool(links) and all(is_public_input(l.get("agenda_items")) for l in links)


def closing_line(mentions: int, first: int | None, last: int | None, this_year: int | None = None) -> str:
    """The count, last and in everyday words, over the span the page header shows."""
    if not mentions or not first:
        return ""
    this_year = this_year or datetime.now(timezone.utc).year
    last = last or first
    times = "once" if mentions == 1 else "twice" if mentions == 2 else f"{mentions} times"
    if mentions == 1:
        return f"Mentioned once in council meetings, in {first}."
    if first == last:
        return f"Mentioned in council meetings {times} in {first}."
    if last >= this_year - 1:
        return f"Mentioned in council meetings {times} since {first}."
    return f"Mentioned in council meetings {times}, {first}–{last}."


def load_properties(supabase, this_year: int | None = None) -> list[dict]:
    """Every property with its visible record keys, its span and mention count (as the page shows
    them), whether it is a resident's home known only from public input, and a street's lots."""
    properties = _pages(lambda: supabase.table("properties").select("id, slug, address, civic_number, street, meta, hidden").order("id"))
    links = _pages(lambda: supabase.table("property_links")
                   .select("property_id, matter_id, agenda_item_id, hidden, agenda_items(title, category, meetings(meeting_date))")
                   .eq("hidden", False).order("id"))
    matter_rows = _pages(lambda: supabase.table("matters")
                         .select("id, first_seen, last_seen, canonical:meta->>canonical_matter_id, hidden:meta->>hidden").order("id"))
    visible = {m["id"] for m in matter_rows if not m.get("canonical") and m.get("hidden") not in ("true", True)}
    spans = {m["id"]: (_year(m.get("first_seen")), _year(m.get("last_seen"))) for m in matter_rows}
    by_property: dict[int, list[dict]] = {}
    for link in links:
        by_property.setdefault(link["property_id"], []).append(link)

    def mentions_of(ls: list[dict], *, own_matters_only_visible: bool = True) -> set[str]:
        out = set()
        for l in ls:
            if l.get("agenda_item_id"):
                out.add(f"i{l['agenda_item_id']}")
            elif l.get("matter_id") and (l["matter_id"] in visible or not own_matters_only_visible):
                out.add(f"m{l['matter_id']}")
        return out

    out = []
    for p in properties:
        ls = by_property.get(p["id"], [])
        # Links to a hidden or merged matter drop out of the page entirely.
        shown = [l for l in ls if not l.get("matter_id") or l["matter_id"] in visible]
        keys = record_keys(ls, visible)
        out.append({**p, "street": p.get("street") or "", "meta": p.get("meta") or {}, "records": keys,
                    "links": shown, "resident_only": p.get("civic_number") != "" and (bool(p.get("hidden")) or resident_only(shown)),
                    "mentions": mentions_of(shown), "lots": []})
    lots_by_street: dict[str, list[dict]] = {}
    for p in out:
        if p["civic_number"] != "" and p["records"] and not p.get("hidden"):  # hidden lots aren't on street pages
            lots_by_street.setdefault(p["street"].lower(), []).append(p)
    for p in out:
        if p["civic_number"] == "":
            p["lots"] = lots_by_street.get(p["street"].lower(), [])
        p["first_year"], p["last_year"] = _span(p, spans, by_property, visible)
        mentions = set(p["mentions"])
        for lot in p["lots"]:
            mentions |= lot["mentions"]
        p["mention_count"] = len(mentions)
        p["closing"] = closing_line(len(mentions), p["first_year"], p["last_year"], this_year)
    return out


def _span(p: dict, spans: dict, by_property: dict, visible: set[int]) -> tuple[int | None, int | None]:
    """The years the page header shows (routes/property-detail.tsx).

    A lot: its visible matters' first and last meetings, and its other agenda items' meetings.
    A street: the per-year chart's range, i.e. the meeting of every link to the street or any lot
    on it, plus the first meeting of the street's own matters with no dated link."""
    years: list[int] = []
    if p["civic_number"] != "":
        for key in p["records"]:
            if key[0] == "m":
                years += [y for y in spans.get(int(key[1:]), (None, None)) if y]
        years += [y for l in p["links"] if not l.get("matter_id") and (y := _year(_item_date(l)))]
    else:
        dated = set()
        for l in p["links"]:
            if (y := _year(_item_date(l))):
                years.append(y)
                dated.add(l.get("matter_id"))
        for key in p["records"]:
            if key[0] == "m" and int(key[1:]) not in dated and (y := spans.get(int(key[1:]), (None, None))[0]):
                years.append(y)
        for lot in p["lots"]:
            years += [y for l in by_property.get(lot["id"], []) if (y := _year(_item_date(l)))]
    return (min(years), max(years)) if years else (None, None)


def scope_keys(p: dict) -> list[str]:
    """The records a summary is built from: its own, and for a street every listed lot's."""
    keys = list(p["records"])
    for lot in p.get("lots") or []:
        if not lot.get("resident_only"):
            keys += [f"{lot['id']}:{k}" for k in lot["records"]]
    return keys


def summary_lots(p: dict) -> list[dict]:
    return [lot for lot in p.get("lots") or [] if not lot.get("resident_only")]


def eligible(p: dict) -> bool:
    if p.get("resident_only"):
        return False
    if p.get("civic_number") == "":
        return len(p["records"]) >= MIN_RECORDS or len(summary_lots(p)) >= MIN_ADDRESSES
    return len(p["records"]) >= MIN_RECORDS


def current_hash(p: dict) -> str:
    return inputs_hash(scope_keys(p), p.get("closing", ""))


def is_property_stale(p: dict, version: str = PROPERTY_SUMMARY_VERSION) -> bool:
    """Eligible and either never summarized, summarized by an older prompt, or its records changed."""
    from pipeline.stages import is_stale

    meta = p.get("meta") or {}
    return eligible(p) and (
        not meta.get("summary")
        or is_stale(meta.get("summary_version"), version)
        or meta.get("summary_inputs") != current_hash(p)
    )


def needs_clearing(p: dict) -> bool:
    """A summary left over from when the property had more records (or wasn't known to be a resident's home)."""
    return not eligible(p) and bool((p.get("meta") or {}).get("summary"))


def _chunks(ids: list[int], size: int = 200):
    for start in range(0, len(ids), size):
        yield ids[start:start + size]


def load_inputs(supabase, props: list[dict]) -> dict[int, dict]:
    """Property id -> the model's input."""
    every = [q for p in props for q in [p, *summary_lots(p)]]
    matter_ids = sorted({int(k[1:]) for p in every for k in p["records"] if k[0] == "m"})
    item_ids = sorted({int(k[1:]) for p in every for k in p["records"] if k[0] == "i"})
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


def _years(first, last) -> str:
    first, last = _year(first), _year(last)
    return f"{first}–{last}" if first and last and first != last else str(first or last or "")


def _records(p: dict, matters: dict[int, dict], items: dict[int, dict], max_matters: int, max_items: int,
             summary_chars: int) -> tuple[list[dict], list[dict], str]:
    """A property's matters and other agenda items, newest first, plus its latest date."""
    ms = [matters[int(k[1:])] for k in p["records"] if k[0] == "m" and int(k[1:]) in matters]
    its = [items[int(k[1:])] for k in p["records"] if k[0] == "i" and int(k[1:]) in items]
    ms.sort(key=lambda m: str(m.get("last_seen") or m.get("first_seen") or ""), reverse=True)
    its.sort(key=lambda i: str((i.get("meetings") or {}).get("meeting_date") or ""), reverse=True)
    latest = max([str(m.get("last_seen") or m.get("first_seen") or "") for m in ms]
                 + [str((i.get("meetings") or {}).get("meeting_date") or "") for i in its] or [""])
    matter_rows = [{
        "title": (m.get("meta") or {}).get("display_title") or m.get("title") or "",
        "category": m.get("category") or "",
        "status": m.get("status") or "",
        "years": _years(m.get("first_seen"), m.get("last_seen")),
        "summary": (m.get("plain_english_summary") or "")[:summary_chars],
    } for m in ms[:max_matters]]
    item_rows = [{
        "title": i.get("title") or "",
        "year": _year((i.get("meetings") or {}).get("meeting_date")),
        "summary": (i.get("plain_english_summary") or "")[:min(summary_chars, 300)],
    } for i in its[:max_items] if not is_public_input(i) or i.get("plain_english_summary")]
    return matter_rows, item_rows, latest


def build_input(p: dict, matters: dict[int, dict], items: dict[int, dict]) -> dict:
    own_matters, own_items, _ = _records(p, matters, items, MAX_MATTERS, MAX_ITEMS, 500)
    if p.get("civic_number") != "":
        return {
            "address": p["address"],
            "kind": "lot",
            "council_decisions_and_projects": own_matters,
            "other_mentions": own_items,
        }
    lots = []
    for lot in summary_lots(p):
        ms, its, latest = _records(lot, matters, items, PER_ADDRESS_MATTERS, 2, 250)
        lots.append({"lot": lot, "latest": latest, "row": {
            "address": lot["address"], "number": lot["civic_number"], "times_considered": len(lot["records"]), "years": _years(lot.get("first_year"), lot.get("last_year")),
            "council_decisions_and_projects": ms, "other_mentions": its,
        }})
    busiest = sorted(lots, key=lambda r: (-len(r["lot"]["records"]), r["lot"]["address"]))[:STREET_BUSIEST]
    recent = [r for r in sorted(lots, key=lambda r: r["latest"], reverse=True) if r not in busiest][:STREET_RECENT]
    chosen = busiest + recent  # busiest first, then the latest of the rest
    return {
        "address": p["address"],
        "kind": "street",
        "the_street_itself": {"council_decisions_and_projects": own_matters, "other_mentions": own_items},
        "addresses_on_the_street": [r["row"] for r in chosen],
        "most_considered": [r["row"]["number"] for r in busiest[:2]],
        "addresses_in_total": len(lots),
    }


def prompt(data: dict) -> str:
    return "Write the opening lines for this page.\n\n" + json.dumps(data, ensure_ascii=False)


def clean(summary: str, max_chars: int = NARRATIVE_MAX) -> str:
    text = " ".join((summary or "").split()).strip().strip('"').strip()
    if len(text) > max_chars:  # trim at a sentence, else a word
        cut = text[:max_chars]
        end = cut.rfind(". ")
        text = cut[:end + 1] if end > max_chars // 2 else cut[:cut.rfind(" ")].rstrip(",;:") + "…"
    return text


def compose(narrative: str, closing: str) -> str:
    narrative = clean(narrative)
    if narrative and narrative[-1] not in ".!?…":
        narrative += "."
    return f"{narrative} {closing}".strip()


SIZE = re.compile(r"\b(?:\d[\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:-\s*)?(?:homes?|lots?|units?|storeys?|stories|townhomes?|townhouses?|apartments?|dwellings?|suites?)\b", re.I)

DATABASE_WORDS = re.compile(r"\b(?:matters?|records?|agenda items?|the link is unclear)\b", re.I)


def _sizes_given(data: dict) -> bool:
    """The inputs state how big something is (homes, lots, units, storeys)."""
    rows = list(data.get("council_decisions_and_projects") or [])
    for address in data.get("addresses_on_the_street") or []:
        rows += address.get("council_decisions_and_projects") or []
    return any(SIZE.search(f"{r.get('title', '')} {r.get('summary', '')}") for r in rows[:8])


def summarize(data: dict, closing: str = "") -> str:
    result = ai.json(prompt(data), stage=STAGE, schema=PropertySummary, system=SYSTEM)
    text = result.summary
    # Up to two more tries for a lead that drops the size of the project ("a subdivision" for "a
    # 47-lot subdivision") or uses database words ("matter", "record") or hedges about the records.
    for _ in range(2):
        problems = []
        if _sizes_given(data) and not SIZE.search(text or ""):
            problems.append("it leaves out how big the projects are; keep the number of homes, lots, units or storeys the inputs give")
        if DATABASE_WORDS.search(text or ""):
            problems.append('it uses database words ("matter", "record", "agenda item") or talks about the records; '
                            "say only what Council did, and leave out anything the inputs don't make clear")
        if not problems:
            break
        try:
            retry = ai.json(prompt(data) + "\n\nRewrite your last draft: \"" + (text or "") + "\". Problems: " +
                            "; ".join(problems) + ".",
                            stage=STAGE, schema=PropertySummary, system=SYSTEM)
            text = retry.summary or text
        except Exception as e:  # the last draft is still usable
            print(f"  [!] Property summary retry failed, keeping the last draft: {e}", flush=True)
            break
    return compose(text, closing)


def summarize_properties(supabase, props: list[dict], *, write: bool = True, workers: int = 4) -> dict[int, str]:
    """Summarize ``props`` (rows from ``load_properties``). Model calls run in parallel; reads and
    writes stay on the calling thread (the supabase client isn't thread-safe)."""
    inputs = load_inputs(supabase, props)

    def one(p):
        try:
            return p["id"], summarize(inputs[p["id"]], p.get("closing", ""))
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
            # Re-read meta right before writing so keys other stages wrote meanwhile survive.
            fresh = (supabase.table("properties").select("meta").eq("id", p["id"]).execute().data or [{}])[0].get("meta")
            meta = {**(fresh if fresh is not None else (p.get("meta") or {})), "summary": summary,
                    "summary_version": PROPERTY_SUMMARY_VERSION, "summary_inputs": current_hash(p), "summary_updated_at": now}
            supabase.table("properties").update({"meta": meta}).eq("id", p["id"]).execute()
    return done


def clear_summaries(supabase, props: list[dict]) -> int:
    for p in props:
        meta = {k: v for k, v in (p.get("meta") or {}).items() if k not in META_KEYS}
        supabase.table("properties").update({"meta": meta}).eq("id", p["id"]).execute()
    return len(props)
