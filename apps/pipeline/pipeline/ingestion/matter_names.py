"""Timeline entries found by name: items and annual-report pages that name a matter's place or project.

``matter_links`` finds mentions by meaning (embeddings) and only within a few years of the matter, which
suits broad topics but loses the long tail of a named place: the North Langford Recreation Centre was
bought in 2014, repaired in 2015, budgeted for until 2019, sold in 2020 and still raised in public comment
in 2024. Here each matter gets its exact names (``matters.meta.anchor_names``):

- the specific names in its own title, summary and agenda item titles (a facility, park, building,
  development or program name), picked by the model and kept only if they appear verbatim, and
- the civic addresses it is linked to (never a hidden property: those are residents' homes).

Any agenda item whose title, summary or attached report sections use one of those names, any page of an
annual report that does, and any other matter with the same name, becomes a candidate with no limit on
the years between. The Decisions API then answers the same yes/no questions ``matter_links`` asks, so a
shared name alone never links anything. Names that appear in too many items to tell anything apart are
dropped.

Writes ``matter_links`` (kind ``mention`` / ``related_matter``, source ``name``) and
``matter_report_mentions``.
"""
from __future__ import annotations

import json as _json
import re
from collections import defaultdict
from typing import Any, Literal

from pydantic import BaseModel

from pipeline import ai

NAMES_VERSION = "2"
NAME_BATCH = 20
MAX_ITEMS_PER_NAME = 60  # a name in more items than this (a busy park, a main road) can't single out a matter
MIN_PROBABILITY = 0.7
MENTION_MIN_PROBABILITY = 0.85  # annual-report pages
ITEM_MIN_PROBABILITY = 0.85  # agenda items: "about" + "mentioned"
GENERIC = {
    "city of langford", "langford", "council", "langford city council", "west shore", "westshore",
    "capital regional district", "crd", "british columbia", "province of british columbia", "city hall",
    "community charter", "local government act", "official community plan", "five year financial plan",
    "five-year financial plan", "financial plan", "zoning bylaw", "staff report",
}


class _Names(BaseModel):
    id: int
    names: list[str]


class _Batch(BaseModel):
    matters: list[_Names]


PROMPT = """For each City of Langford council matter below, list the specific proper names a document would
use to refer to the exact thing this matter is about: the facility, building, park, development, project,
program or agreement at its centre (e.g. "North Langford Recreation Centre", "Westhills Stadium").
Copy each name exactly as it appears in the matter's title or summary. Leave out places and organizations
that are only mentioned along the way (a street it is on, a partner, the committee that discussed it, things
in its agenda items' titles), generic words and phrases (a budget, a bylaw number on its own, "parks"),
people's names, and names of the City, Council or other governments. Most matters have no such name:
return an empty list.

{matters}"""


def _norm(text: str | None) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


# Speech-to-text writes American spellings: "North Langford Recreation Center".
SPELLINGS = {"centre": "center", "center": "centre", "theatre": "theater", "theater": "theatre"}


# An address's street type is written both ways: "977 Langford Parkway" is "101-977 Langford Pkwy" in 2023's agenda.
STREET_TYPES = {"parkway": "pkwy", "road": "rd", "street": "st", "avenue": "ave", "drive": "dr", "boulevard": "blvd",
                "highway": "hwy", "crescent": "cres", "place": "pl", "court": "ct", "terrace": "terr"}
STREET_TYPES.update({short: full for full, short in list(STREET_TYPES.items())})


def _alternates(name: str) -> list[list[str]]:
    """Each word's spellings: centre/center anywhere, and an address's last word in full and abbreviated."""
    words = name.split()
    out = []
    for i, w in enumerate(words):
        key = w.lower().rstrip(".")
        forms = [w]
        if key in SPELLINGS:
            forms.append(SPELLINGS[key])
        if i == len(words) - 1 and i > 0 and re.match(r"^\d", name) and key in STREET_TYPES:
            forms = [key, STREET_TYPES[key]]
        out.append(forms)
    return out


def name_pattern(name: str) -> re.Pattern:
    """Case-insensitive whole-word match that tolerates line breaks, doubled spaces, centre/center and an
    address's abbreviated street type ("Pkwy", "Pkwy.")."""
    parts = []
    for forms in _alternates(name):
        alts = [re.escape(f) + (r"\.?" if f.lower() in STREET_TYPES and len(forms) > 1 else "") for f in forms]
        parts.append(alts[0] if len(alts) == 1 else f"(?:{'|'.join(alts)})")
    return re.compile(r"(?<![\w])" + r"\s+".join(parts) + r"(?![\w])", re.I)


def tsquery_variants(name: str) -> list[str]:
    """The name and its other spellings, for phrase search (the index stems 'centre' and 'center' differently,
    and 'Pkwy' is a different word from 'Parkway')."""
    from itertools import product

    return list(dict.fromkeys(" ".join(words) for words in product(*_alternates(name))))


# Planning file numbers name one application across every agenda that handles it: "TUP20-0002", "DVP14-0015",
# "Z-07-34", "RZ-01-11". (Bylaw numbers and numeric records-file numbers are shared too widely to use.)
FILE_NUMBER = re.compile(r"\b[A-Z]{1,5}-?\d{2}-\d{2,5}[A-Z]?\b")


def file_numbers(identifier: str | None) -> list[str]:
    return list(dict.fromkeys(FILE_NUMBER.findall(identifier or "")))


def keep_name(name: str, source_text: str) -> bool:
    """A usable anchor: two or more words (or a civic number), not generic, and verbatim in the source."""
    name = _norm(name)
    if len(name) < 6 or name.lower() in GENERIC or len(name.split()) < 2:
        return False
    if not re.search(r"[A-Z0-9]", name):
        return False
    return bool(name_pattern(name).search(source_text))


def excerpt(text: str, name: str, width: int = 320) -> str:
    """The sentence(s) around the first use of ``name``, at most ``width`` characters."""
    flat = _norm(text)
    m = name_pattern(name).search(flat)
    if not m:
        return flat[:width]
    sentence = flat.rfind(". ", 0, m.start())
    sentence = 0 if sentence == -1 else sentence + 2
    start, cut = (sentence, False) if m.start() - sentence <= width // 2 else (m.start() - width // 2, True)
    if cut:  # begin on a whole word, and say the sentence began earlier
        start = flat.find(" ", start) + 1 or start
    end = flat.find(". ", m.end())
    end = min(end + 1 if end != -1 else len(flat), start + width - (1 if cut else 0))
    return ("…" if cut else "") + flat[start:end].strip()


# --- names -------------------------------------------------------------------------------------------

def load_matters(cur) -> list[dict]:
    cur.execute("""
        select m.id, m.title, m.plain_english_summary, m.meta, m.first_seen, m.last_seen, m.identifier,
               coalesce((select json_agg(a.title order by a.id) from agenda_items a where a.matter_id = m.id), '[]'),
               coalesce((select json_agg(distinct p.address) from property_links pl join properties p on p.id = pl.property_id
                         where pl.matter_id = m.id and not pl.hidden and not p.hidden and p.civic_number is not null), '[]')
        from matters m
        where m.meta->>'canonical_matter_id' is null and coalesce(m.meta->>'hidden', '') <> 'container'
        order by m.id""")
    out = []
    for mid, title, summary, meta, first, last, identifier, items, addresses in cur.fetchall():
        meta = meta or {}
        out.append({"id": mid, "title": meta.get("display_title") or title, "raw_title": title, "summary": summary or "",
                    "meta": meta, "first_seen": first, "last_seen": last, "item_titles": items or [], "file_numbers": file_numbers(identifier),
                    "addresses": [a for a in (addresses or []) if a]})
    return out


def load_matters_light(file_numbers_only: bool = True) -> list[dict]:
    """Each matter's permit and file numbers (from its identifier), for checks that need nothing else."""
    from pipeline.db import connect

    conn = connect()
    conn.set_session(readonly=True)
    try:
        cur = conn.cursor()
        cur.execute("select id, identifier from matters where identifier is not null")
        rows = [{"id": mid, "file_numbers": file_numbers(ident)} for mid, ident in cur.fetchall()]
        conn.rollback()
    finally:
        conn.close()
    return [r for r in rows if r["file_numbers"]]


def source_text(m: dict) -> str:
    """Where a name must appear to belong to the matter: its own title and summary. Its agenda items' titles are
    shown to the model for context only; a name found only there ("Goldstream Avenue" in one item of a ticket
    giveaway) is about something else."""
    return " \n".join([m["title"], m["raw_title"], m["summary"]])


STREET = re.compile(r"(?i)\b(?:road|rd|avenue|ave|street|st|drive|dr|way|parkway|pkwy|place|pl|crescent|cres|boulevard|blvd|"
                    r"lane|terrace|court|ct|highway|hwy|trail|close|circle|view|heights|park\s+road)\.?$")
ORGANIZATION = re.compile(r"(?i)\b(?:committee|commission|board|society|association|foundation|council|club|"
                          r"chamber|authority|district|network|coalition|alliance)\b")


def central_name(name: str, m: dict) -> bool:
    """A street is never a matter's name unless it carries a civic number (that is an address); a body or
    organization is only when the matter's own title names it (its budget, its terms of reference)."""
    if re.match(r"^\d", name):
        return True  # a civic address ("1997 Country Club Way" is not a club)
    if STREET.search(name):
        return False
    if ORGANIZATION.search(name) and not name_pattern(name).search(f"{m['title']} {m['raw_title']}"):
        return False
    return True


def _name_batch(batch: list[dict]) -> dict[int, list[str]]:
    listing = "\n\n".join(
        f"[{m['id']}] {m['title']}\n{m['summary'][:600]}\nAgenda items: " + "; ".join(t for t in m["item_titles"][:8])
        for m in batch)
    result = ai.json(PROMPT.format(matters=listing), stage="extraction", schema=_Batch)
    picked = {r.id: r.names for r in result.matters}
    names = {}
    for m in batch:
        text = source_text(m)
        kept = []
        for n in [*picked.get(m["id"], []), *m["addresses"]]:
            n = _norm(n)
            if (n in m["addresses"] or keep_name(n, text)) and central_name(n, m):
                if n.lower() in {k.lower() for k in kept}:
                    continue
                kept.append(n)
        names[m["id"]] = kept
    return names


def extract_names(matters: list[dict], *, save: bool = False, workers: int = 8) -> dict[int, list[str]]:
    """Model-picked names per matter, verified verbatim, plus linked civic addresses. With ``save``, each
    batch is stored as it finishes, so an interrupted run keeps its progress."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    names: dict[int, list[str]] = {}
    batches = [matters[i : i + NAME_BATCH] for i in range(0, len(matters), NAME_BATCH)]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_name_batch, b): b for b in batches}
        for done, future in enumerate(as_completed(futures), 1):
            try:
                got = future.result()
            except Exception as exc:  # one failed batch leaves those matters unnamed until the next run
                print(f"  [Names] batch of {len(futures[future])} failed: {exc}")
                continue
            names.update(got)
            if save:
                save_names(got)
            if done % 10 == 0 or done == len(batches):
                print(f"  [Names] {done}/{len(batches)} batches", flush=True)
    return names


def save_names(names: dict[int, list[str]], conn=None) -> None:
    from pipeline.db import run_write

    def write(cur):
        for mid, kept in names.items():
            cur.execute("update matters set meta = coalesce(meta, '{}'::jsonb) || %s::jsonb where id = %s",
                        (_json.dumps({"anchor_names": kept, "anchor_names_version": NAMES_VERSION}), mid))
    run_write(write, conn)


# --- candidates --------------------------------------------------------------------------------------

def table_row(excerpt: str) -> bool:
    """A row of a table (an application log, a supplier list): a name there is one line of many, and the quote
    reads as "| DVP-17-20 | 8-Aug-17 | …"."""
    return excerpt.count("|") >= 4


def find_hits(cur, name: str, meeting_ids: list[int] | None = None) -> dict:
    """Agenda items (by their own text or an attached report section) and annual-report pages using ``name``."""
    pat = name_pattern(name)
    variants = tsquery_variants(name)
    any_variant = lambda col: "(" + " or ".join(f"{col} @@ phraseto_tsquery('english', %s)" for _ in variants) + ")"
    meeting_filter = " and a.meeting_id = any(%s)" if meeting_ids else ""
    extra = [meeting_ids] if meeting_ids else []
    items: dict[int, dict] = {}
    cur.execute(f"""select a.id, a.matter_id, mt.meeting_date, a.title, coalesce(a.plain_english_summary, '') || ' ' || coalesce(a.debate_summary, '')
                    from agenda_items a join meetings mt on mt.id = a.meeting_id
                    where {any_variant("a.text_search")}{meeting_filter}""", [*variants, *extra])
    for iid, matter_id, day, title, body in cur.fetchall():
        text = f"{title}. {body}"
        if pat.search(text):
            items[iid] = {"id": iid, "matter_id": matter_id, "date": str(day), "title": title, "excerpt": excerpt(text, name), "where": "item"}
    cur.execute(f"""select a.id, a.matter_id, mt.meeting_date, a.title, ds.section_text
                    from document_sections ds join agenda_items a on a.id = ds.agenda_item_id join meetings mt on mt.id = a.meeting_id
                    where {any_variant("ds.text_search")}{meeting_filter}""", [*variants, *extra])
    for iid, matter_id, day, title, text in cur.fetchall():
        if iid not in items and pat.search(text or ""):
            items[iid] = {"id": iid, "matter_id": matter_id, "date": str(day), "title": title, "excerpt": excerpt(text, name), "where": "document"}
    # Spoken mentions (public comment years later often names the place only aloud): a transcript line belongs
    # to the item whose discussion window holds its start time.
    segment_filter = " and t.meeting_id = any(%s)" if meeting_ids else ""
    cur.execute(f"""select a.id, a.matter_id, mt.meeting_date, a.title, t.text_content
                    from transcript_segments t join meetings mt on mt.id = t.meeting_id
                    join lateral (select a.id, a.matter_id, a.title from agenda_items a
                                  where a.meeting_id = t.meeting_id and a.discussion_start_time is not null
                                    and t.start_time >= a.discussion_start_time
                                    and t.start_time < coalesce(a.discussion_end_time, a.discussion_start_time + 1800)
                                  order by a.discussion_start_time desc limit 1) a on true
                    where {any_variant("t.text_search")}{segment_filter}""", [*variants, *extra])
    for iid, matter_id, day, title, text in cur.fetchall():
        if iid not in items and pat.search(text or ""):
            items[iid] = {"id": iid, "matter_id": matter_id, "date": str(day), "title": title,
                          "excerpt": excerpt(text, name), "spoken": True, "where": "spoken"}
    from pipeline.ingestion.mention_hygiene import candidate_ok

    # A table row, a minutes echo or an omnibus bylaw's legal description is one line of many, not a mention.
    items = {iid: it for iid, it in items.items() if not table_row(it["excerpt"]) and candidate_ok(it["title"], it["excerpt"])}
    pages = []
    if not meeting_ids:
        cur.execute(f"""select p.report_id, p.page, r.year, r.title, p.content from public_report_pages p
                       join public_reports r on r.id = p.report_id
                       where {any_variant("p.text_search")}""", variants)
        for report_id, page, year, title, content in cur.fetchall():
            if pat.search(content):
                pages.append({"report_id": report_id, "page": page, "year": year, "title": title, "excerpt": excerpt(content, name)})
    return {"items": list(items.values()), "pages": pages}


def _describe(m: dict) -> str:
    return f"\"{m['title']}\" ({m['first_seen']} to {m['last_seen']}) — {m['summary'][:400]}"


def editor_examples(cur, limit: int = 8) -> str:
    """Recent staff decisions on timeline links (page review bar): entries removed or suggestions rejected, and
    suggestions accepted. Added to the question so later judgments follow what an editor decided."""
    cur.execute("""select l.review, coalesce(m.meta->>'display_title', m.title), a.title, coalesce(l.quote, '')
                   from matter_links l join matters m on m.id = l.matter_id join agenda_items a on a.id = l.agenda_item_id
                   where l.kind = 'mention' and l.review is not null order by l.reviewed_at desc limit 60""")
    rows = cur.fetchall()
    keep = [r for r in rows if r[0] == "accepted"][:limit // 2] + [r for r in rows if r[0] != "accepted"][:limit // 2]
    if not keep:
        return ""
    lines = [f"- {'BELONGS' if review == 'accepted' else 'DOES NOT BELONG'}: matter \"{matter}\"; item \"{(title or '')[:90]}\""
             f"{f'; passage: {quote[:160]}' if quote else ''}" for review, matter, title, quote in keep]
    return "\n\nAn editor has already decided these, as examples:\n" + "\n".join(lines)


def judge(matters: list[dict], names: dict[int, list[str]], cur, meeting_ids: list[int] | None = None,
          existing: dict | None = None, all_names: dict[int, list[str]] | None = None,
          min_item: float = ITEM_MIN_PROBABILITY, min_page: float = MENTION_MIN_PROBABILITY,
          min_related: float = MIN_PROBABILITY) -> dict:
    """Candidates by name, then one Decisions API question each. Returns the links to write."""
    by_id = {m["id"]: m for m in matters}
    existing = existing or {"mentions": set(), "related": set(), "pages": set()}
    hits_cache: dict[str, dict] = {}
    skipped: list[str] = []
    item_jobs, page_jobs, pair_jobs = [], [], []
    owners: dict[str, set[int]] = defaultdict(set)
    for mid, kept in (all_names or names).items():
        for n in kept:
            owners[n.lower()].add(mid)
    for mid, kept in names.items():
        m = by_id.get(mid)
        if not m:
            continue
        for n in kept:
            key = n.lower()
            if key not in hits_cache:
                hits_cache[key] = find_hits(cur, n, meeting_ids)
                if len(hits_cache[key]["items"]) > MAX_ITEMS_PER_NAME:
                    skipped.append(f"{n} ({len(hits_cache[key]['items'])} items)")
            hits = hits_cache[key]
            if len(hits["items"]) > MAX_ITEMS_PER_NAME:
                continue
            for it in hits["items"]:
                if it["matter_id"] == mid or (mid, it["id"]) in existing["mentions"]:
                    continue
                item_jobs.append((mid, it, n))
            for pg in hits["pages"]:
                if (mid, pg["report_id"], pg["page"]) not in existing["pages"]:
                    page_jobs.append((mid, pg, n))
            for other in owners[key]:
                pair = (min(mid, other), max(mid, other))
                if other != mid and other in by_id and pair not in existing["related"]:
                    pair_jobs.append(pair)

    def dedupe(jobs, key):
        seen, out = set(), []
        for j in jobs:
            k = key(j)
            if k not in seen:
                seen.add(k)
                out.append(j)
        return out

    item_jobs = dedupe(item_jobs, lambda j: (j[0], j[1]["id"]))
    page_jobs = dedupe(page_jobs, lambda j: (j[0], j[1]["report_id"], j[1]["page"]))
    pair_jobs = dedupe(pair_jobs, lambda j: j)
    print(f"  [Names] candidates: {len(item_jobs)} item(s), {len(page_jobs)} report page(s), {len(pair_jobs)} matter pair(s)"
          + (f"; too common, skipped: {', '.join(skipped[:12])}{' …' if len(skipped) > 12 else ''}" if skipped else ""), flush=True)

    scores: list = []

    def ask(jobs, build, accept):
        out = []
        for start in range(0, len(jobs), 200):
            chunk = jobs[start : start + 200]
            for job, res in zip(chunk, ai.decide_many([build(j) for j in chunk])):
                if isinstance(res, Exception):
                    continue
                ans = next(iter(res.values()), None)
                if getattr(ans, "type", None) == "choice":  # {choice: probability}
                    prob = {c.value: c.probability or 0 for c in ans.probabilities}
                else:
                    prob = getattr(ans, "probability", 0) or 0
                scores.append((job, prob))
                link = accept(job, prob)
                if link:
                    out.append(link)
        return out

    # Asked about the named place, not the matter's one decision: the sale of a recreation centre has a story that
    # includes its purchase, its repair budgets, and residents citing the sale years later in another debate. That
    # last kind is a "mention": a small timeline entry with the quote.
    examples = editor_examples(cur)
    mention_q = lambda m, n: ai.choice(
        "role",
        f"This matter is about \"{n}\": {_describe(m)}. How does this agenda item involve \"{n}\"?{examples}",
        [("about", f"It does something about \"{n}\" itself: decides, budgets or spends money on it, reports on it, "
                   f"or carries public comment about it."),
         ("mentioned", f"It is about something else, but someone refers to \"{n}\" or what happened to it in a way a "
                       f"reader following its story would want to see (an example, a comparison, a criticism)."),
         ("passing", f"\"{n}\" is only a location, a venue, or one of a list of places, or the name means something else.")],
    )

    def accept_item(j, probs):
        # "about" and "mentioned" often split one judgement ("it's part of the story"), so they count together.
        about, mentioned = probs.get("about", 0), probs.get("mentioned", 0)
        if about + mentioned >= min_item:
            return {"matter_id": j[0], "agenda_item_id": j[1]["id"], "kind": "mention", "confidence": about + mentioned,
                    "source": "name" if about >= mentioned else "name_mention", "quote": j[1]["excerpt"]}
        return None

    mentions = ask(
        item_jobs,
        lambda j: (f"AGENDA ITEM ({j[1]['date']}): {j[1]['title']}\n{'Said at the meeting' if j[1].get('spoken') else 'Passage'} "
                   f"naming \"{j[2]}\": {j[1]['excerpt']}", [mention_q(by_id[j[0]], j[2])]),
        accept_item,
    )
    report_q = lambda m, n: {
        "type": "predicate", "name": "describes_matter",
        "instructions": f"This matter is about \"{n}\": {_describe(m)}. Does this passage of the City's annual report say what "
                        f"happened to \"{n}\" itself — something done, built, bought, sold, repaired or spent on it? Naming it only "
                        f"in passing (as a venue, or in a list of places) is not enough.",
    }
    pages = ask(
        page_jobs,
        lambda j: (f"{j[1]['title']}, page {j[1]['page']}: {j[1]['excerpt']}", [report_q(by_id[j[0]], j[2])]),
        lambda j, p: {"matter_id": j[0], "report_id": j[1]["report_id"], "page": j[1]["page"], "quote": j[1]["excerpt"],
                      "confidence": p, "source": "name"} if p >= min_page else None,
    )
    related_q = {
        "type": "predicate", "name": "same_initiative",
        "instructions": "Are A and B steps in the story of the same specific place, facility, project or program in this city — "
                        "for example its purchase, a repair budget for it, and its later sale? Two different applications or "
                        "decisions that only share a street or a broad topic are NOT the same.",
    }
    related = ask(
        pair_jobs,
        lambda j: (f"A: {_describe(by_id[j[0]])}\n\nB: {_describe(by_id[j[1]])}", [related_q]),
        lambda j, p: {"matter_id": j[0], "related_matter_id": j[1], "kind": "related_matter", "confidence": p, "source": "name"}
        if p >= min_related else None,
    )
    return {"mentions": mentions, "pages": pages, "related": related, "skipped": skipped, "scores": scores}


def existing_links(cur) -> dict:
    cur.execute("select kind, matter_id, related_matter_id, agenda_item_id from matter_links")
    mentions, related = set(), set()
    for kind, mid, rid, iid in cur.fetchall():
        if kind == "mention":
            mentions.add((mid, iid))
        else:
            related.add((min(mid, rid), max(mid, rid)))
    cur.execute("select matter_id, report_id, page from matter_report_mentions")
    return {"mentions": mentions, "related": related, "pages": set(cur.fetchall())}


def write_links(found: dict, conn=None, hidden: bool = False, suggested: bool = False) -> dict:
    """Insert new links (existing and hidden ones stay as they are). Returns {"matters", "links", "pages"}: the matters
    that gained any and the new row ids. ``hidden`` writes them unpublished; ``suggested`` marks them for staff to
    accept or reject in the page review bar (implies hidden)."""
    hidden = hidden or suggested
    when = "now()" if suggested else "null"
    from pipeline.db import run_write

    def write(cur):
        changed, new_links, new_related, new_pages = set(), [], [], []
        for l in found["mentions"]:
            cur.execute(f"""insert into matter_links (matter_id, kind, agenda_item_id, confidence, source, hidden, quote, suggested_at, suggest_reason, found_in)
                           values (%s, 'mention', %s, %s, %s, %s, %s, {when}, %s, %s)
                           on conflict do nothing returning matter_id, id""", (l["matter_id"], l["agenda_item_id"], l["confidence"], l["source"], hidden, l.get("quote"),
                                                                             l.get("suggest_reason"), l.get("found_in")))
            for mid, lid in cur.fetchall():
                changed.add(mid)
                new_links.append(lid)
        for l in found["related"]:
            cur.execute(f"""insert into matter_links (matter_id, kind, related_matter_id, confidence, source, hidden, suggested_at, suggest_reason, found_in)
                           values (%s, 'related_matter', %s, %s, %s, %s, {when}, %s, %s)
                           on conflict do nothing returning matter_id, related_matter_id, id""", (l["matter_id"], l["related_matter_id"], l["confidence"], l["source"], hidden,
                                                                                              l.get("suggest_reason"), "topic" if l.get("suggest_reason") else None))
            for a, b, lid in cur.fetchall():
                changed.update((a, b))
                new_related.append(lid)
        for l in found["pages"]:
            cur.execute(f"""insert into matter_report_mentions (matter_id, report_id, page, quote, confidence, source, hidden, suggested_at, suggest_reason)
                           values (%s, %s, %s, %s, %s, %s, %s, {when}, %s)
                           on conflict do nothing returning matter_id, id""", (l["matter_id"], l["report_id"], l["page"], l["quote"], l["confidence"], l["source"], hidden,
                                                                             l.get("suggest_reason")))
            for mid, pid in cur.fetchall():
                changed.add(mid)
                new_pages.append(pid)
        return {"matters": sorted(changed), "links": new_links, "related": new_related, "pages": new_pages}
    return run_write(write, conn)


def run(*, matter_ids: list[int] | None = None, meeting_ids: list[int] | None = None, stale: bool = False,
        dry_run: bool = False, hidden: bool = False) -> dict[str, Any]:
    """Name every matter that needs it, then find and judge candidates.

    ``matter_ids``: only these matters' names (backfill of one matter). ``meeting_ids`` (post-ingest): only items
    in these meetings are candidates, for every named matter. ``stale``: re-pick names older than NAMES_VERSION."""
    from pipeline.db import connect

    conn = connect()
    conn.set_session(readonly=True)
    try:
        cur = conn.cursor()
        matters = load_matters(cur)
        conn.rollback()
        wanted = [m for m in matters if (not matter_ids or m["id"] in matter_ids)
                  and (stale or m["meta"].get("anchor_names_version") != NAMES_VERSION or matter_ids)]
        names = extract_names(wanted, save=not dry_run) if wanted else {}
        all_names = {m["id"]: m["meta"].get("anchor_names") or [] for m in matters}
        all_names.update(names)
        for m in matters:  # file numbers come from the matter's own identifier, not the model
            all_names[m["id"]] = [*all_names[m["id"]], *(f for f in m["file_numbers"] if f not in all_names[m["id"]])]
        scope = {mid: n for mid, n in all_names.items() if n and (not matter_ids or mid in matter_ids or meeting_ids)}
        found = judge(matters, scope, cur, meeting_ids=meeting_ids, existing=existing_links(cur), all_names=all_names)
        conn.rollback()
    finally:
        conn.close()
    print(f"  [Names] {sum(1 for n in names.values() if n)} of {len(names)} newly named matter(s) have names; "
          f"linking {len(found['mentions'])} mention(s), {len(found['related'])} related pair(s), {len(found['pages'])} report page(s)")
    if dry_run:
        return {"names": names, **found, "changed": []}
    # Written unpublished, then a second, stricter check against each matter itself; survivors are published
    # unless this run is for review (``hidden``).
    written = write_links(found, hidden=True)
    checked = verify_hidden_links(link_ids=written["links"], page_ids=written["pages"])
    checked_related = verify_hidden_related(link_ids=written["related"])
    print(f"  [Names] second check dropped {checked['dropped_links']} mention(s), {checked['dropped_pages']} page(s), "
          f"{checked_related['dropped']} related pair(s)")
    if not hidden:
        from pipeline.db import run_write

        def publish(c):
            c.execute("update matter_links set hidden = false where id = any(%s) and hidden", (written["links"] + written["related"],))
            c.execute("update matter_report_mentions set hidden = false where id = any(%s) and hidden", (written["pages"],))
        run_write(publish)
    from pipeline.ingestion import mention_hygiene

    mention_hygiene.run()  # an item that now reaches too many topics is a list: hide its links everywhere
    return {"names": names, **found, "changed": written["matters"]}


class _Verdict(BaseModel):
    n: int
    verdict: Literal["belongs", "mentioned", "unrelated"]
    reason: str


class _Verdicts(BaseModel):
    verdicts: list[_Verdict]


SUGGEST_PROMPT = """You help an editor of Open Langford, a site that follows Langford City council, fill gaps in a topic's
timeline. The topic is below with the entries it already has. Most numbered candidates name one of the topic's names
or file numbers somewhere; some were found only because they read similarly, and are often about something else.
Decide whether each is part of THIS topic's story.

- belongs: it is a step in this topic's story (a decision, hearing, notice, report or comment about this very thing).
- mentioned: it is about something else but refers to this topic in a way a reader following it would want to see.
- unrelated: the name matches but it's a different thing: another business or unit at the same address, another
  application, a list of many items, or a passing reference.

Give a reason a resident would understand, naming what the candidate is actually about (e.g. "A different business,
in unit #103 of the same building"). Don't guess from a title alone: an item's attached documents are often about
something its title doesn't say.{examples}

TOPIC: {topic}
Already on its timeline:
{timeline}

CANDIDATES:
{candidates}"""

WHERE = {"item": "in the item's own text", "document": "in a document attached to the item", "spoken": "said at the meeting",
         "similar": "by meaning (it doesn't name the topic; this is the item's summary)"}


def _timeline(cur, matter_id: int) -> str:
    cur.execute("""select mt.meeting_date, a.title from agenda_items a join meetings mt on mt.id = a.meeting_id
                   where a.matter_id = %s
                   union select mt.meeting_date, a.title from matter_links l join agenda_items a on a.id = l.agenda_item_id
                   join meetings mt on mt.id = a.meeting_id where l.matter_id = %s and l.kind = 'mention' and not l.hidden
                   order by 1 limit 40""", (matter_id, matter_id))
    return "\n".join(f"- {d}: {(t or '').splitlines()[0][:120]}" for d, t in cur.fetchall()) or "(nothing yet)"


SIMILAR_LIMIT = 15  # closest items by meaning, from any year, added to the name matches for the judge


def similar_items(cur, matter_id: int, exclude: set[int], limit: int = SIMILAR_LIMIT) -> list[dict]:
    """Agenda items closest in meaning to the topic (embeddings, any year), for what names miss: paraphrases, a
    renamed project, a different address for the same development. Loose by nature; the judge filters."""
    cur.execute("""select a.id, a.matter_id, mt.meeting_date, a.title, coalesce(a.plain_english_summary, ''),
                          1 - (a.embedding <=> m.embedding) as similarity
                   from matters m, agenda_items a join meetings mt on mt.id = a.meeting_id
                   where m.id = %s and a.embedding is not null and m.embedding is not null
                     and a.matter_id is distinct from m.id
                   order by a.embedding <=> m.embedding limit %s""", (matter_id, limit + len(exclude) + 10))
    out = []
    for iid, owner, day, title, summary, sim in cur.fetchall():
        if iid in exclude or not summary.strip():
            continue
        out.append({"kind": "item", "id": iid, "matter_id": owner, "date": str(day), "title": title,
                    "excerpt": summary[:320], "where": "similar", "similarity": round(float(sim), 3)})
        if len(out) >= limit:
            break
    return out


def suggest_links(matter_id: int, *, similar: bool = True, dry_run: bool = False) -> dict[str, Any]:
    """"Find missing" from the page review bar: search again for one matter by its names and file numbers, and ask
    the reviewer model (stage "review", Terra) which candidates belong in its story, all in one call. What it keeps
    is written as suggestions (hidden, suggested_at set, with its reason and where the name was found) for staff to
    add or reject. Links already on the page, removed by staff, or rejected before are never suggested again."""
    from pipeline.db import connect

    conn = connect()
    conn.set_session(readonly=True)
    try:
        cur = conn.cursor()
        matters = load_matters(cur)
        target = next((m for m in matters if m["id"] == matter_id), None)
        if target is None:
            return {"suggested": 0, "names": []}
        names = extract_names([target], save=not dry_run).get(matter_id, [])
        names = [*names, *(f for f in target["file_numbers"] if f not in names)]
        existing = existing_links(cur)
        candidates: list[dict] = []
        seen: set = set()
        for name in names:
            hits = find_hits(cur, name)
            if len(hits["items"]) > MAX_ITEMS_PER_NAME:
                continue
            for it in hits["items"]:
                key = ("item", it["id"])
                if it["matter_id"] == matter_id or (matter_id, it["id"]) in existing["mentions"] or key in seen:
                    continue
                seen.add(key)
                candidates.append({"kind": "item", "name": name, **it})
            for pg in hits["pages"]:
                key = ("page", pg["report_id"], pg["page"])
                if (matter_id, pg["report_id"], pg["page"]) in existing["pages"] or key in seen:
                    continue
                seen.add(key)
                candidates.append({"kind": "page", "name": name, **pg})
        for other in matters:  # other topics with one of the same names
            if other["id"] == matter_id or not set(map(str.lower, other["meta"].get("anchor_names") or [])) & set(map(str.lower, names)):
                continue
            pair = (min(matter_id, other["id"]), max(matter_id, other["id"]))
            if pair not in existing["related"] and ("topic", other["id"]) not in seen:
                seen.add(("topic", other["id"]))
                candidates.append({"kind": "topic", "id": other["id"], "title": other["title"], "summary": other["summary"][:300],
                                   "date": str(other["first_seen"] or "")})
        candidates = candidates[:60]
        if similar:
            taken = {c["id"] for c in candidates if c["kind"] == "item"} | {iid for (mid, iid) in existing["mentions"] if mid == matter_id}
            candidates += similar_items(cur, matter_id, taken)
        timeline = _timeline(cur, matter_id)
        examples = editor_examples(cur)
        conn.rollback()
    finally:
        conn.close()
    if not candidates:
        print(f"  [Names] matter {matter_id}: searched {', '.join(names) or 'no names'}; nothing new")
        return {"suggested": 0, "names": names}

    def line(i: int, c: dict) -> str:
        if c["kind"] == "topic":
            return f"{i}. ANOTHER TOPIC: {c['title']} ({c['date']}). {c['summary']}"
        if c["kind"] == "page":
            return f"{i}. ANNUAL REPORT {c['year']}, page {c['page']}: {c['excerpt']}"
        return f"{i}. AGENDA ITEM {c['date']}: {(c['title'] or '').splitlines()[0][:140]}. Found {WHERE[c['where']]}: {c['excerpt']}"

    # Name matches and similar-by-meaning items are judged in separate calls: mixed in, the loose similar items
    # unsettled verdicts on the name matches (8 of ~105 changed vs 2 between repeat runs; research/similar-candidates).
    def judge_group(group: list[int]) -> list[_Verdict]:
        if not group:
            return []
        res = ai.json(SUGGEST_PROMPT.format(
            examples=examples, topic=_describe(target), timeline=timeline,
            candidates="\n\n".join(line(k, candidates[n - 1]) for k, n in enumerate(group, 1))),
            stage="review", schema=_Verdicts)
        return [v.model_copy(update={"n": group[v.n - 1]}) for v in res.verdicts if 1 <= v.n <= len(group)]

    by_name = [n for n, c in enumerate(candidates, 1) if c.get("where") != "similar"]
    by_meaning = [n for n, c in enumerate(candidates, 1) if c.get("where") == "similar"]

    class _All:
        verdicts = judge_group(by_name) + judge_group(by_meaning)
    result = _All
    # Terra decides and explains; the Decisions API (Luna) adds a calibrated score to each item it kept, for sorting
    # and for comparing later with what staff accept.
    kept = {v.n: v for v in result.verdicts if v.verdict != "unrelated" and 1 <= v.n <= len(candidates)}
    score_jobs = [(n, candidates[n - 1]) for n in kept if candidates[n - 1]["kind"] == "item"]
    scores: dict[int, float] = {}
    if score_jobs:
        story_q = lambda c: ai.predicate(
            "part_of_story",
            f"Topic: {_describe(target)}\nAlready on its timeline:\n{timeline}\n\nIs this agenda item part of THIS topic's story, "
            f"or does it refer to it in a way someone following the topic would want to see? Another business or unit at "
            f"the same address, or a different application, is not.")
        answers = ai.decide_many([(f"AGENDA ITEM {c['date']}: {(c['title'] or '').splitlines()[0][:140]}. Found {WHERE[c['where']]}: {c['excerpt']}",
                                   [story_q(c)]) for _, c in score_jobs])
        for (n, _), res in zip(score_jobs, answers):
            if not isinstance(res, Exception):
                ans = next(iter(res.values()), None)
                scores[n] = round(float(getattr(ans, "probability", 0) or 0), 3)
    found: dict = {"mentions": [], "related": [], "pages": []}
    for v in result.verdicts:
        if v.verdict == "unrelated" or not 1 <= v.n <= len(candidates):
            continue
        c = candidates[v.n - 1]
        if c["kind"] == "item":
            found["mentions"].append({"matter_id": matter_id, "agenda_item_id": c["id"], "kind": "mention", "confidence": scores.get(v.n),
                                      "source": "name" if v.verdict == "belongs" else "name_mention", "quote": c["excerpt"],
                                      "suggest_reason": v.reason, "found_in": c["where"]})
        elif c["kind"] == "page":
            found["pages"].append({"matter_id": matter_id, "report_id": c["report_id"], "page": c["page"], "quote": c["excerpt"],
                                   "confidence": None, "source": "name", "suggest_reason": v.reason})
        else:
            found["related"].append({"matter_id": min(matter_id, c["id"]), "related_matter_id": max(matter_id, c["id"]),
                                     "kind": "related_matter", "confidence": None, "source": "name", "suggest_reason": v.reason})
    if dry_run:
        verdicts = [{"n": v.n, "verdict": v.verdict, "reason": v.reason, **{k: candidates[v.n - 1].get(k) for k in
                     ("kind", "id", "title", "where", "similarity", "date")}} for v in result.verdicts if 1 <= v.n <= len(candidates)]
        return {"names": names, "candidates": len(candidates), "verdicts": verdicts, "found": found}
    written = write_links(found, suggested=True)
    count = len(written["links"]) + len(written["related"]) + len(written["pages"])
    print(f"  [Names] matter {matter_id}: searched {', '.join(names) or 'no names'}; {len(candidates)} candidate(s), {count} suggestion(s)")
    return {"suggested": count, "candidates": len(candidates), "names": names}


def same_application(item_title: str | None, m: dict) -> bool:
    """The item's own title names one of the matter's permit or file numbers ("TUP20-0002"): a step in the same
    application, so the second check doesn't get to drop it. A shared civic address is not enough: tested on
    2026-11-02 (research/linking-question), about 4 in 10 links rescued by address alone were a different
    application on the same property (a speedway licence vs an OCP amendment at 2207 Millstream Road)."""
    return any(name_pattern(f).search(item_title or "") for f in m.get("file_numbers") or [])


# --- second check --------------------------------------------------------------------------------------

VERIFY_MIN_PROBABILITY = 0.75


def verify_hidden_links(*, dry_run: bool = False, link_ids: list[int] | None = None, page_ids: list[int] | None = None) -> dict:
    """Second, stricter check of unpublished links found by name: judged against the matter itself (its title and
    summary), not the name. A shared address or program name is how a candidate was found, not a reason to show
    it: "a church at 2207 Millstream Road" is not part of a sign variance's story. Failures are deleted."""
    from pipeline.db import connect, run_write

    conn = connect()
    conn.set_session(readonly=True)
    cur = conn.cursor()
    cur.execute("""select l.id, m.id, coalesce(m.meta->>'display_title', m.title), coalesce(m.plain_english_summary, ''),
                          mt.meeting_date, a.title, coalesce(l.quote, a.plain_english_summary, '')
                   from matter_links l join matters m on m.id = l.matter_id
                   join agenda_items a on a.id = l.agenda_item_id join meetings mt on mt.id = a.meeting_id
                   where l.hidden and l.source in ('name', 'name_mention') and l.kind = 'mention'
                     and l.review is null and l.suggested_at is null
                     and (%(links)s::bigint[] is null or l.id = any(%(links)s))""", {"links": link_ids})
    links = cur.fetchall()
    cur.execute("""select id, report_id, page, quote, matter_id from matter_report_mentions where hidden and source = 'name'
                   and review is null and suggested_at is null
                   and (%(pages)s::bigint[] is null or id = any(%(pages)s))""", {"pages": page_ids})
    pages = cur.fetchall()
    cur.execute("""select id, coalesce(meta->>'display_title', title), coalesce(plain_english_summary, '') from matters""")
    matters = {mid: (t, s) for mid, t, s in cur.fetchall()}
    cur.execute("select id, year from public_reports")
    years = dict(cur.fetchall())
    conn.rollback()
    conn.close()

    def question(title, summary):
        return {"type": "predicate", "name": "belongs",
                "instructions": f"A resident is reading the timeline of this council matter: \"{title}\" — {summary[:400]}. "
                                f"Would they expect this entry on it, as part of the story of the same property, place or "
                                f"project? Every step for the same property or project belongs: its rezoning, variance "
                                f"permits, subdivision, bylaw readings, agreements, budgets, reports and public comment, "
                                f"before or after this matter. Answer no when the entry is about a different property, place "
                                f"or project that only shares a street, park or program name, or names it only in passing "
                                f"(a location, a venue, one of a list)."}

    # Same permit or file number in the item's own title: the same application, kept without asking.
    numbers = {m["id"]: m for m in load_matters_light(file_numbers_only=True)}
    links = [l for l in links if not same_application(l[5], numbers.get(l[1], {}))]
    jobs = [(f"ENTRY ({day}): {item}\nPassage: {quote[:400]}", [question(title, summary)])
            for _, _, title, summary, day, item, quote in links]
    jobs += [(f"ENTRY: City annual report {years.get(rid)}, page {page}: {quote[:400]}", [question(*matters[mid])])
             for _, rid, page, quote, mid in pages]
    drop_links, drop_pages = [], []
    for start in range(0, len(jobs), 200):
        for k, res in zip(range(start, start + 200), ai.decide_many(jobs[start : start + 200])):
            prob = 0 if isinstance(res, Exception) else (getattr(next(iter(res.values()), None), "probability", 0) or 0)
            if isinstance(res, Exception):
                continue  # unanswered: keep for the next run rather than guess
            if prob < VERIFY_MIN_PROBABILITY:
                (drop_links if k < len(links) else drop_pages).append(links[k][0] if k < len(links) else pages[k - len(links)][0])
        print(f"  [Names] second check {min(start + 200, len(jobs))}/{len(jobs)}: dropping {len(drop_links)} link(s), {len(drop_pages)} page(s)", flush=True)
    if not dry_run and (drop_links or drop_pages):
        def write(c):
            for i in range(0, len(drop_links), 500):
                c.execute("delete from matter_links where id = any(%s) and hidden", (drop_links[i:i + 500],))
            if drop_pages:
                c.execute("delete from matter_report_mentions where id = any(%s) and hidden", (drop_pages,))
        run_write(write)
    return {"links": len(links), "pages": len(pages), "dropped_links": len(drop_links), "dropped_pages": len(drop_pages)}


def verify_hidden_related(*, dry_run: bool = False, link_ids: list[int] | None = None) -> dict:
    """The second check for unpublished related-matter links found by name: both must be steps in the story of the same
    property, place or project, not two applications or events that only share a street, address or kind."""
    from pipeline.db import connect, run_write

    conn = connect()
    conn.set_session(readonly=True)
    cur = conn.cursor()
    cur.execute("""select l.id, coalesce(a.meta->>'display_title', a.title), coalesce(a.plain_english_summary, ''),
                          coalesce(b.meta->>'display_title', b.title), coalesce(b.plain_english_summary, '')
                   from matter_links l join matters a on a.id = l.matter_id join matters b on b.id = l.related_matter_id
                   where l.hidden and l.source = 'name' and l.kind = 'related_matter' and l.review is null and l.suggested_at is null
                     and (%(links)s::bigint[] is null or l.id = any(%(links)s))""", {"links": link_ids})
    pairs = cur.fetchall()
    conn.rollback()
    conn.close()
    question = {"type": "predicate", "name": "same_story",
                "instructions": "Are A and B steps in the story of the same property, place, facility or project in this city "
                                "(for example its rezoning and later variance permit, or its purchase, repair budget and sale)? "
                                "Answer no for two different applications, businesses, events or decisions that only share an "
                                "address, a street, a building, or a kind of request."}
    jobs = [(f"A: {ta} — {sa[:400]}\n\nB: {tb} — {sb[:400]}", [question]) for _, ta, sa, tb, sb in pairs]
    drop = []
    for start in range(0, len(jobs), 200):
        for (lid, *_), res in zip(pairs[start : start + 200], ai.decide_many(jobs[start : start + 200])):
            if isinstance(res, Exception):
                continue
            if (getattr(next(iter(res.values()), None), "probability", 0) or 0) < 0.8:
                drop.append(lid)
    if not dry_run and drop:
        run_write(lambda c: c.execute("delete from matter_links where id = any(%s) and hidden", (drop,)))
    return {"pairs": len(pairs), "dropped": len(drop)}
