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
the years between. The reviewer model then judges each topic's candidates together against its timeline
(``judge_story``), so a shared name or address alone never links anything: another application on the same
lot is left to the topic's address box. Names that appear in too many items to tell anything apart are
dropped. ``rejudge`` puts links already published by name through the same judgment.

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
MIN_PROBABILITY = 0.7  # other topics with the same name
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
        f"[{m['id']}] {m['title']}\n{m['summary']}\nAgenda items: " + "; ".join(t for t in m["item_titles"])
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
            items[iid] = {"id": iid, "matter_id": matter_id, "date": str(day), "title": title, "excerpt": excerpt(text, name),
                          "context": text, "where": "item"}
    cur.execute(f"""select a.id, a.matter_id, mt.meeting_date, a.title, ds.section_text
                    from document_sections ds join agenda_items a on a.id = ds.agenda_item_id join meetings mt on mt.id = a.meeting_id
                    where {any_variant("ds.text_search")}{meeting_filter}""", [*variants, *extra])
    for iid, matter_id, day, title, text in cur.fetchall():
        if iid not in items and pat.search(text or ""):
            items[iid] = {"id": iid, "matter_id": matter_id, "date": str(day), "title": title, "excerpt": excerpt(text, name),
                          "context": text, "where": "document"}
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
                          "excerpt": excerpt(text, name), "context": text, "spoken": True, "where": "spoken"}
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
                pages.append({"report_id": report_id, "page": page, "year": year, "title": title, "excerpt": excerpt(content, name),
                              "context": content})
    return {"items": list(items.values()), "pages": pages}


def _describe(m: dict) -> str:
    return f"\"{m['title']}\" ({m['first_seen']} to {m['last_seen']}) — {m['summary']}"


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
    lines = [f"- {'BELONGS' if review == 'accepted' else 'DOES NOT BELONG'}: matter \"{matter}\"; item \"{title or ''}\""
             f"{f'; passage: {quote}' if quote else ''}" for review, matter, title, quote in keep]
    return "\n\nAn editor has already decided these, as examples:\n" + "\n".join(lines)


def judge(matters: list[dict], names: dict[int, list[str]], cur, meeting_ids: list[int] | None = None,
          existing: dict | None = None, all_names: dict[int, list[str]] | None = None,
          min_related: float = MIN_PROBABILITY, workers: int = 6) -> dict:
    """Candidates by name, judged by the reviewer model one topic at a time (``judge_story``, with the topic's
    timeline), and other topics with the same name by a Decisions API question each. Returns the links to write."""
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

    # Agenda items and report pages: one reviewer-model call per topic sees all its candidates next to its timeline, so it
    # can tell this application's own steps from another application on the same lot (2026-11-03: the Decisions API,
    # asked one item at a time how it "involves" the name, linked every application at a shared address).
    per_matter: dict[int, list[dict]] = defaultdict(list)
    for mid, it, n in item_jobs:
        per_matter[mid].append({"kind": "item", "name": n, **it})
    for mid, pg, n in page_jobs:
        per_matter[mid].append({"kind": "page", "name": n, **pg})
    timelines = {mid: _timeline(cur, mid) for mid in per_matter}
    examples = editor_examples(cur)

    def one(mid: int) -> list[tuple[dict, _Verdict, float | None]]:
        target, cands = by_id[mid], per_matter[mid]
        # Same permit or file number in the item's own title: the same application, kept without asking.
        same = [c for c in cands if c["kind"] == "item" and same_application(c["title"], target)]
        rest = [c for c in cands if not any(c is s for s in same)]
        judged = [(c, _Verdict(n=0, verdict="belongs", reason="The same application: its file number is in the item's title."))
                  for c in same]
        if rest:
            try:
                judged += [(rest[v.n - 1], v) for v in judge_story(target, timelines[mid], examples, rest)]
            except Exception as exc:  # unanswered: nothing is linked rather than guessed
                print(f"  [Names] matter {mid}: judging {len(rest)} candidate(s) failed: {exc}", flush=True)
        kept = [(k, c) for k, (c, v) in enumerate(judged, 1) if v.verdict != "unrelated" and c["kind"] == "item"]
        scores = story_scores(target, timelines[mid], kept)
        return [(c, v, scores.get(k)) for k, (c, v) in enumerate(judged, 1)]

    from concurrent.futures import ThreadPoolExecutor

    mentions, pages, verdicts = [], [], []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for done, (mid, results) in enumerate(zip(per_matter, pool.map(one, per_matter)), 1):
            for c, v, score in results:
                verdicts.append((mid, c, v))
                if v.verdict == "unrelated":
                    continue
                if c["kind"] == "item":
                    mentions.append({"matter_id": mid, "agenda_item_id": c["id"], "kind": "mention", "confidence": score,
                                     "source": "name" if v.verdict == "belongs" else "name_mention", "quote": c["excerpt"],
                                     "suggest_reason": v.reason, "found_in": c["where"]})
                else:
                    pages.append({"matter_id": mid, "report_id": c["report_id"], "page": c["page"], "quote": c["excerpt"],
                                  "confidence": None, "source": "name", "suggest_reason": v.reason})
            if done % 25 == 0 or done == len(per_matter):
                print(f"  [Names] judged {done}/{len(per_matter)} topic(s): {len(mentions)} mention(s), {len(pages)} page(s) kept", flush=True)

    def ask(jobs, build, accept):
        out = []
        for start in range(0, len(jobs), 200):
            chunk = jobs[start : start + 200]
            for job, res in zip(chunk, ai.decide_many([build(j) for j in chunk])):
                if isinstance(res, Exception):
                    continue
                link = accept(job, getattr(next(iter(res.values()), None), "probability", 0) or 0)
                if link:
                    out.append(link)
        return out

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
    return {"mentions": mentions, "pages": pages, "related": related, "skipped": skipped, "verdicts": verdicts}


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
    # Written unpublished, then a second check of related topics (the reviewer model already judged items and pages
    # against each topic); survivors are published unless this run is for review (``hidden``).
    written = write_links(found, hidden=True)
    checked_related = verify_hidden_related(link_ids=written["related"])
    print(f"  [Names] second check dropped {checked_related['dropped']} related pair(s)")
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


# Asked of the reviewer model (Terra) both by the pipeline's name matching and by "Find missing" in the review bar.
# What counts as the same story depends on the topic: a stadium's story spans its purchase, repairs and sale, but a
# rezoning's story is that one application. Other applications on the same property are listed on the topic page
# under its address ("3 other matters at this address"), so they don't also belong on its timeline.
STORY_PROMPT = """You help an editor of Open Langford, a site that follows Langford City council, keep a topic's
timeline to its own story. The topic is below with the entries it already has. Most numbered candidates name one of
the topic's names, addresses or file numbers somewhere; some were found only because they read similarly, and are
often about something else. Decide whether each is part of THIS topic's story.

- belongs: it is a step in this topic's story (a decision, hearing, notice, report or comment about this very thing).
- mentioned: it is about something else but refers to this topic in a way a reader following it would want to see
  (an example, a comparison, a criticism, a resident raising it years later).
- unrelated: the name matches but it's a different thing, or the topic is only named in passing (a location, a
  venue, one of a list of many items).

What the same story means depends on what the topic is:
- One application, permit or decision for a property (a rezoning, variance, development or temporary use permit,
  subdivision, covenant, housing agreement, licence, a one-time grant or contract): its own steps belong, including
  the staff report, the readings and adoption of the bylaw that carries it out, its hearing and comment on it. So do
  the other approvals for the same proposal (the same building, lots or units): the rezoning, housing agreement,
  covenant, variances, tax exemption, road closure or sale, or encroachment agreement that came with it. When a
  housing agreement, road closure or similar agreement for the property comes within a few years of a rezoning or
  permit and nothing points to a different proposal, it belongs with that proposal. And what came of the decision
  belongs: the thing designed, funded or contracted being built, completed or opened. A different proposal for the
  property is unrelated, before
  or after (an earlier or later rezoning or permit for a different number of lots or units or a different use), and
  so are changes to a wider zone or development the property is only part of, and another business or unit at the
  same address. Something else about a project the decision belongs to is unrelated too (a parcel tax or contract
  for a road project is not a noise variance for its construction).
- A place, facility, program, plan or agreement itself (a stadium, recreation centre, park, road project, a plan or
  a service agreement): decisions about that thing belong across the years (its purchase, budgets, repairs,
  renewals, sale, and public comment about it). A different thing that shares its name is unrelated.

Give a reason a resident would understand, naming what the candidate is actually about (e.g. "A different business,
in unit #103 of the same building", "An earlier rezoning of the same lot, for six lots under Bylaw 1103"). Compare
the details: a different bylaw number, unit count, lot count or applicant than the topic's own means a different
application. Don't guess from a title alone: an item's attached documents are often about something its title
doesn't say.{examples}

TOPIC: {topic}
Already on its timeline:
{timeline}

CANDIDATES:
{candidates}"""

WHERE = {"item": "in the item's own text", "document": "in a document attached to the item", "spoken": "said at the meeting",
         "similar": "by meaning (it doesn't name the topic; this is the item's summary)", "linked": "in this passage"}
STORY_CHUNK = 40  # candidates per call; a long list loses detail on the later ones


def _timeline(cur, matter_id: int, name_links: bool = True) -> str:
    """The topic's own items and its published mentions; without ``name_links``, leaving out the mentions found by
    name (when those are what's being judged)."""
    cur.execute("""select mt.meeting_date, a.title from agenda_items a join meetings mt on mt.id = a.meeting_id
                   where a.matter_id = %s
                   union select mt.meeting_date, a.title from matter_links l join agenda_items a on a.id = l.agenda_item_id
                   join meetings mt on mt.id = a.meeting_id where l.matter_id = %s and l.kind = 'mention' and not l.hidden
                     and (%s or l.source not in ('name', 'name_mention'))
                   order by 1""", (matter_id, matter_id, name_links))
    return "\n".join(f"- {d}: {' '.join((t or '').split())}" for d, t in cur.fetchall()) or "(nothing yet)"


def _candidate_line(i: int, c: dict) -> str:
    if c["kind"] == "topic":
        return f"{i}. ANOTHER TOPIC: {c['title']} ({c['date']}). {c['summary']}"
    if c["kind"] == "page":
        return f"{i}. ANNUAL REPORT {c['year']}, page {c['page']}: {c['excerpt']}"
    # The whole text the name was found in (the item's own text, the report section, the spoken line), not the short
    # quote the page shows, so the judge can tell what the item is actually about.
    return f"{i}. AGENDA ITEM {c['date']}: {' '.join((c['title'] or '').split())}. Found {WHERE[c['where']]}: {c.get('context') or c['excerpt']}"


def judge_story(target: dict, timeline: str, examples: str, candidates: list[dict]) -> list[_Verdict]:
    """The reviewer model's verdict on each candidate, with ``n`` its 1-based place in ``candidates``. Name matches
    and similar-by-meaning items are judged in separate calls: mixed in, the loose similar items unsettled verdicts
    on the name matches (8 of ~105 changed vs 2 between repeat runs; research/similar-candidates)."""
    from concurrent.futures import ThreadPoolExecutor

    def judge_group(group: list[int]) -> list[_Verdict]:
        res = ai.json(STORY_PROMPT.format(
            examples=examples, topic=_describe(target), timeline=timeline,
            candidates="\n\n".join(_candidate_line(k, candidates[n - 1]) for k, n in enumerate(group, 1))),
            stage="review", schema=_Verdicts)
        return [v.model_copy(update={"n": group[v.n - 1]}) for v in res.verdicts if 1 <= v.n <= len(group)]

    by_name = [n for n, c in enumerate(candidates, 1) if c.get("where") != "similar"]
    by_meaning = [n for n, c in enumerate(candidates, 1) if c.get("where") == "similar"]
    # Grouped by size (the candidates' whole texts within the input budget, beside the topic and its timeline), never
    # by cutting a candidate's text; at most STORY_CHUNK per call, since a long list loses care on the later ones.
    fixed = ai.budget.size(STORY_PROMPT) + ai.budget.size(_describe(target)) + ai.budget.size(timeline) + ai.budget.size(examples)
    line = lambda n: ai.budget.size(_candidate_line(n, candidates[n - 1]))
    groups = [g for part in (by_name, by_meaning) if part
              for g in ai.pack(part, budget=ai.INPUT_BUDGET_CHARS - fixed, measure=line, max_count=STORY_CHUNK)]
    # Independent calls: run them side by side (each takes ~8s on the reviewer model).
    with ThreadPoolExecutor(max_workers=max(1, len(groups))) as pool:
        return [v for part in pool.map(judge_group, groups) for v in part]


def story_scores(target: dict, timeline: str, items: list[tuple[int, dict]]) -> dict[int, float]:
    """The Decisions API's calibrated score for agenda items the reviewer model kept ({n: probability}), for sorting
    and for comparing later with what staff accept."""
    if not items:
        return {}
    question = ai.predicate(
        "part_of_story",
        f"Topic: {_describe(target)}\nAlready on its timeline:\n{timeline}\n\nIs this agenda item part of THIS topic's story, "
        f"or does it refer to it in a way someone following the topic would want to see? Another business or unit at "
        f"the same address, or a different application, is not.")
    answers = ai.decide_many([(_candidate_line(n, c).split(". ", 1)[1], [question]) for n, c in items])
    scores = {}
    for (n, _), res in zip(items, answers):
        if not isinstance(res, Exception):
            ans = next(iter(res.values()), None)
            scores[n] = round(float(getattr(ans, "probability", 0) or 0), 3)
    return scores


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
                    "excerpt": summary[:320], "context": summary, "where": "similar", "similarity": round(float(sim), 3)})
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
                candidates.append({"kind": "topic", "id": other["id"], "title": other["title"], "summary": other["summary"],
                                   "date": str(other["first_seen"] or "")})
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

    # Terra decides and explains; the Decisions API (Luna) adds a calibrated score to each item it kept.
    verdicts = judge_story(target, timeline, examples, candidates)
    kept = {v.n for v in verdicts if v.verdict != "unrelated"}
    scores = story_scores(target, timeline, [(n, candidates[n - 1]) for n in kept if candidates[n - 1]["kind"] == "item"])
    found: dict = {"mentions": [], "related": [], "pages": []}
    for v in verdicts:
        if v.verdict == "unrelated":
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
        return {"names": names, "candidates": len(candidates), "found": found,
                "verdicts": [{"n": v.n, "verdict": v.verdict, "reason": v.reason, **{k: candidates[v.n - 1].get(k) for k in
                              ("kind", "id", "title", "where", "similarity", "date")}} for v in verdicts]}
    written = write_links(found, suggested=True)
    count = len(written["links"]) + len(written["related"]) + len(written["pages"])
    print(f"  [Names] matter {matter_id}: searched {', '.join(names) or 'no names'}; {len(candidates)} candidate(s), {count} suggestion(s)")
    return {"suggested": count, "candidates": len(candidates), "names": names}


def same_application(item_title: str | None, m: dict) -> bool:
    """The item's own title names one of the matter's permit or file numbers ("TUP20-0002"): a step in the same
    application, linked without asking. A shared civic address is not enough: tested on
    2026-11-02 (research/linking-question), about 4 in 10 links rescued by address alone were a different
    application on the same property (a speedway licence vs an OCP amendment at 2207 Millstream Road)."""
    return any(name_pattern(f).search(item_title or "") for f in m.get("file_numbers") or [])


# --- second check ---------------------------------------------------------------------------------------


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
    jobs = [(f"A: {ta} — {sa}\n\nB: {tb} — {sb}", [question]) for _, ta, sa, tb, sb in pairs]
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


# --- re-judging published links ----------------------------------------------------------------------------

def rejudge(*, matter_ids: list[int] | None = None, limit: int | None = None, dry_run: bool = True, workers: int = 6) -> dict:
    """Put mentions and report pages already published by name (and not yet decided by staff) through ``judge_story``,
    one topic at a time, as new candidates are. Links found before 2026-11-03 were judged by the Decisions API one
    item at a time, which linked every application at a shared address. Returns ``drop`` (what it calls unrelated,
    with its reason) and ``kept``; without ``dry_run`` the drops are hidden (``hide_rejudged``)."""
    from concurrent.futures import ThreadPoolExecutor
    from pipeline.db import connect

    conn = connect()
    conn.set_session(readonly=True)
    try:
        cur = conn.cursor()
        cur.execute("""select l.id, l.matter_id, a.id, a.title, mt.meeting_date, coalesce(l.quote, a.plain_english_summary, '')
                       from matter_links l join agenda_items a on a.id = l.agenda_item_id join meetings mt on mt.id = a.meeting_id
                       where l.kind = 'mention' and not l.hidden and l.source in ('name', 'name_mention')
                         and l.review is null and l.suggested_at is null
                         and (%(m)s::bigint[] is null or l.matter_id = any(%(m)s))""", {"m": matter_ids})
        per_matter: dict[int, list[dict]] = defaultdict(list)
        for lid, mid, iid, title, day, quote in cur.fetchall():
            per_matter[mid].append({"kind": "item", "link_id": lid, "id": iid, "title": title, "date": str(day),
                                    "excerpt": quote, "where": "linked"})
        cur.execute("""select p.id, p.matter_id, p.report_id, p.page, r.year, coalesce(p.quote, '')
                       from matter_report_mentions p join public_reports r on r.id = p.report_id
                       where not p.hidden and p.source = 'name' and p.review is null and p.suggested_at is null
                         and (%(m)s::bigint[] is null or p.matter_id = any(%(m)s))""", {"m": matter_ids})
        for pid, mid, rid, page, year, quote in cur.fetchall():
            per_matter[mid].append({"kind": "page", "page_id": pid, "report_id": rid, "page": page, "year": year, "excerpt": quote})
        matters = {m["id"]: m for m in load_matters(cur)}
        ids = [mid for mid in sorted(per_matter) if mid in matters][:limit]
        timelines = {mid: _timeline(cur, mid, name_links=False) for mid in ids}
        examples = editor_examples(cur)
        conn.rollback()
    finally:
        conn.close()

    def one(mid: int) -> list[tuple[dict, _Verdict]]:
        target = matters[mid]
        # Same permit or file number in the item's own title: the same application, kept without asking.
        rest = [c for c in per_matter[mid] if not (c["kind"] == "item" and same_application(c["title"], target))]
        if not rest:
            return []
        try:
            return [(rest[v.n - 1], v) for v in judge_story(target, timelines[mid], examples, rest)]
        except Exception as exc:  # unanswered: kept as they are
            print(f"  [Names] matter {mid}: re-judging {len(rest)} link(s) failed: {exc}", flush=True)
            return []

    drop, kept = [], []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for done, (mid, results) in enumerate(zip(ids, pool.map(one, ids)), 1):
            for c, v in results:
                row = {"matter_id": mid, "topic": matters[mid]["title"], "verdict": v.verdict, "reason": v.reason,
                       **{k: c.get(k) for k in ("kind", "link_id", "page_id", "id", "title", "date", "year", "page", "excerpt")}}
                (drop if v.verdict == "unrelated" else kept).append(row)
            if done % 25 == 0 or done == len(ids):
                print(f"  [Names] re-judged {done}/{len(ids)} topic(s): {len(drop)} unrelated, {len(kept)} kept", flush=True)
    changed = [] if dry_run else hide_rejudged(drop)
    return {"topics": len(ids), "links": sum(len(per_matter[m]) for m in ids), "drop": drop, "kept": kept, "changed": changed}


def hide_rejudged(drop: list[dict]) -> list[int]:
    """Hide what ``rejudge`` called unrelated, keeping its reason (in ``suggest_reason``, which only the review bar's
    suggestions show), unless staff decided the link in the meantime. Returns the topics that changed."""
    from pipeline.db import run_write

    links = [(d["link_id"], d["reason"]) for d in drop if d.get("link_id")]
    pages = [(d["page_id"], d["reason"]) for d in drop if d.get("page_id")]

    def write(cur):
        changed = set()
        for table, rows in (("matter_links", links), ("matter_report_mentions", pages)):
            if not rows:
                continue
            cur.execute(f"""update {table} t set hidden = true, suggest_reason = v.reason
                            from unnest(%s::bigint[], %s::text[]) as v(id, reason)
                            where t.id = v.id and not t.hidden and t.review is null returning t.matter_id""",
                        ([i for i, _ in rows], [r for _, r in rows]))
            changed.update(mid for (mid,) in cur.fetchall())
        return sorted(changed)
    return run_write(write)
