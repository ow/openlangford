"""Story links between matters, and mentions in mixed-topic agenda items.

Merging is for duplicates. Many matters are distinct steps of one initiative
(a notice of motion, an options report, a procurement scope, then the bylaw),
and showing the bylaw alone makes it look like the subject came out of nowhere.

- related_matter: two matters are steps of the same policy, program or project.
- mention: a mixed-topic item (notice of motion, presentation, delegation,
  public participation, correspondence) discussed a matter.

Candidates come from embeddings of the matters' plain-English summaries (titles
are too terse to compare); the Decisions API answers one yes/no question per
candidate, so an item can mention several matters.
"""
from __future__ import annotations

import re
from datetime import date

import numpy as np
from supabase import Client

from pipeline import ai

RELATED_SIM = 0.55
MENTION_SIM = 0.45
TOP_K = 5
MIN_PROBABILITY = 0.7
MAX_YEARS_APART = 4
MIXED_ITEM = re.compile(
    r"^\s*(?:[\d.]+[a-z]?[.)]?\s*)?(?:notices? of motion|presentations?|delegations?|public participation|"
    r"correspondence|petitions?|question period|public input|mayor'?s report|council(?:lor)? reports?)\b",
    re.I,
)
MENTION_MIN_PROBABILITY = 0.85  # mixed items touch many topics; be stricter than for related matters


def _paginate(build, page: int = 1000) -> list[dict]:
    rows, start = [], 0
    while True:
        chunk = build().range(start, start + page - 1).execute().data or []
        rows.extend(chunk)
        if len(chunk) < page:
            return rows
        start += page


def _years_apart(a: str | None, b: str | None) -> float:
    try:
        return abs((date.fromisoformat(str(a)[:10]) - date.fromisoformat(str(b)[:10])).days) / 365.25
    except (TypeError, ValueError):
        return 0.0


def _matter_text(m: dict) -> str:
    meta = m.get("meta") or {}
    return f"{meta.get('display_title') or m['title']}. {m.get('plain_english_summary') or ''}".strip()


def _embed(texts: list[str]) -> np.ndarray:
    mat = np.array(ai.embed(texts), dtype=np.float32)
    return mat / (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-9)


def load_matters(supabase: Client, since: str | None) -> list[dict]:
    def q():
        query = (
            supabase.table("matters")
            .select("id, municipality_id, title, plain_english_summary, meta, first_seen, last_seen")
            .is_("meta->>canonical_matter_id", "null")
            .or_("meta->>hidden.is.null,meta->>hidden.neq.container")  # "no_records" matters can gain mentions
            .not_.is_("plain_english_summary", "null")
            .order("id")
        )
        return query.gte("last_seen", since) if since else query

    return _paginate(q)


def link_related(
    supabase: Client, matters: list[dict], vecs: np.ndarray, *, dry_run: bool = False, focus: set[int] | None = None
) -> list[dict]:
    sims = vecs @ vecs.T
    pairs: set[tuple[int, int]] = set()
    for i in range(len(matters)):
        if focus is not None and matters[i]["id"] not in focus:
            continue
        order = np.argsort(-sims[i])
        picked = 0
        for j in order:
            if j == i or sims[i, j] < RELATED_SIM or picked >= TOP_K:
                if sims[i, j] < RELATED_SIM:
                    break
                continue
            if matters[i]["municipality_id"] != matters[j]["municipality_id"]:
                continue
            if _years_apart(matters[i]["first_seen"], matters[j]["first_seen"]) > MAX_YEARS_APART:
                continue
            pairs.add((min(i, j), max(i, j)))
            picked += 1

    def describe(m: dict) -> str:
        meta = m.get("meta") or {}
        return (
            f"{meta.get('display_title') or m['title']} ({m.get('first_seen')} to {m.get('last_seen')}): "
            f"{m.get('plain_english_summary') or ''} Latest: {meta.get('status_line') or '-'}"
        )

    question = {
        "type": "predicate",
        "name": "same_initiative",
        "instructions": "Are A and B steps of the same specific policy, program or project in this city — for example "
                        "a notice of motion, the options report it asked for, a procurement scope, and the bylaw that "
                        "implements it? Merely sharing a broad topic (housing, parks, traffic) is NOT enough, and "
                        "two different properties or applications are never the same initiative.",
    }
    pair_list = sorted(pairs)
    jobs = [(f"A: {describe(matters[i])}\n\nB: {describe(matters[j])}", [question]) for i, j in pair_list]
    links = []
    for start in range(0, len(jobs), 200):
        for (i, j), res in zip(pair_list[start : start + 200], ai.decide_many(jobs[start : start + 200])):
            if isinstance(res, Exception):
                continue
            ans = res.get("same_initiative")
            prob = getattr(ans, "probability", 0) or 0
            if prob >= MIN_PROBABILITY:
                links.append(
                    {"matter_id": matters[i]["id"], "related_matter_id": matters[j]["id"], "kind": "related_matter", "confidence": prob}
                )
        print(f"  [Links] related {min(start + 200, len(jobs))}/{len(jobs)} — {len(links)} linked")
    if not dry_run:
        for link in links:
            try:
                supabase.table("matter_links").insert(link).execute()
            except Exception:
                pass  # already linked (unique pair index)
    return links


def link_mentions(
    supabase: Client, matters: list[dict], vecs: np.ndarray, since: str | None, *, dry_run: bool = False,
    meeting_ids: list[int] | None = None, exclude_meeting_ids: set[int] | None = None,
) -> list[dict]:
    def q():
        query = (
            supabase.table("agenda_items")
            .select("id, meeting_id, title, plain_english_summary, meta, meetings!inner(meeting_date,municipality_id)")
            .not_.is_("plain_english_summary", "null")
            .order("id")
        )
        if meeting_ids:
            return query.in_("meeting_id", meeting_ids)
        return query.gte("meetings.meeting_date", since) if since else query

    items = [it for it in _paginate(q) if MIXED_ITEM.search(it.get("title") or "") and it["meeting_id"] not in (exclude_meeting_ids or set())]
    if not items:
        return []

    def item_text(it: dict) -> str:
        # Public comment summarized per speaker says far more than the one-line item summary.
        speakers = ((it.get("meta") or {}).get("participation") or {}).get("speakers") or []
        lines = [f"- {sp.get('topic')}: {sp.get('point')}" for sp in speakers]
        return f"{it['title']}. {it['plain_english_summary']}" + ("\nSpeakers:\n" + "\n".join(lines) if lines else "")

    # Mixed items cover several topics, so one embedding averages them away. Embed the item and
    # each speaker's point separately and keep each matter's best match.
    texts, owner = [], []
    for idx, it in enumerate(items):
        texts.append(f"{it['title']}. {it['plain_english_summary']}")
        owner.append(idx)
        for sp in (((it.get("meta") or {}).get("participation") or {}).get("speakers") or []):
            texts.append(f"{sp.get('topic')}: {sp.get('point')}")
            owner.append(idx)
    part_sims = _embed(texts) @ vecs.T
    sims = np.full((len(items), len(matters)), -1.0, dtype=np.float32)
    for row, idx in enumerate(owner):
        sims[idx] = np.maximum(sims[idx], part_sims[row])
    jobs, meta = [], []
    for i, it in enumerate(items):
        cands = [j for j in np.argsort(-sims[i]) if sims[i, j] >= MENTION_SIM
                 and matters[j]["municipality_id"] == it["meetings"]["municipality_id"]][:TOP_K]
        cands = [j for j in cands if _years_apart(it["meetings"]["meeting_date"], matters[j]["last_seen"]) <= 2]
        if not cands:
            continue
        questions = [
            {
                "type": "predicate",
                "name": f"m{matters[j]['id']}",
                "instructions": f"Is this agenda item part of the story of this matter — it discusses it, proposes or "
                                f"asks for it (e.g. a notice of motion that led to it), presents on it, or carries public "
                                f"comment about it: \"{(matters[j].get('meta') or {}).get('display_title') or matters[j]['title']}\" — "
                                f"{matters[j].get('plain_english_summary') or ''}? Sharing only a broad topic "
                                f"(housing, parks, budget) without being about this specific matter is not enough.",
            }
            for j in cands
        ]
        jobs.append((f"AGENDA ITEM ({it['meetings']['meeting_date']}): {item_text(it)}", questions))
        meta.append(it)
    links = []
    for start in range(0, len(jobs), 200):
        for it, res in zip(meta[start : start + 200], ai.decide_many(jobs[start : start + 200])):
            if isinstance(res, Exception):
                continue
            for name, ans in res.items():
                prob = getattr(ans, "probability", 0) or 0
                if prob >= MENTION_MIN_PROBABILITY:
                    links.append({"matter_id": int(name[1:]), "agenda_item_id": it["id"], "kind": "mention", "confidence": prob})
        print(f"  [Links] mentions {min(start + 200, len(jobs))}/{len(jobs)} — {len(links)} linked")
    if dry_run:
        return links
    written = []
    for link in links:
        try:
            if supabase.table("matter_links").insert(link).execute().data:
                written.append(link)
        except Exception as exc:
            # Existing unique pairs (including deliberately hidden ones) stay
            # untouched. Do not count them as new summary inputs.
            if getattr(exc, "code", None) != "23505":
                print(f"  [Links] could not persist mention: {exc}")
    return written


def build_links(
    supabase: Client, *, since: str | None = None, dry_run: bool = False,
    focus_matter_ids: list[int] | None = None, meeting_ids: list[int] | None = None,
    new_matter_dates: set[str] | None = None,
) -> dict:
    """Link related matters and mentions. With focus/meeting ids, only judge what a new meeting touched."""
    matters = load_matters(supabase, since)
    print(f"  [Links] {len(matters)} summarized matters")
    if not matters:
        return {"related": [], "mentions": []}
    vecs = _embed([_matter_text(m) for m in matters])
    related = link_related(supabase, matters, vecs, dry_run=dry_run, focus=set(focus_matter_ids) if focus_matter_ids else None)
    mentions = link_mentions(supabase, matters, vecs, since, dry_run=dry_run, meeting_ids=meeting_ids)
    if meeting_ids and focus_matter_ids:
        # A newly created matter can explain an earlier presentation. Revisit
        # older mixed-topic items only against affected matters, not the city.
        indices = [i for i, matter in enumerate(matters) if matter["id"] in set(focus_matter_ids)
                   and (new_matter_dates is None or str(matter["first_seen"])[:10] in new_matter_dates)]
        if indices:
            mentions.extend(link_mentions(supabase, [matters[i] for i in indices], vecs[indices], since,
                                          dry_run=dry_run, exclude_meeting_ids=set(meeting_ids)))
    if not dry_run:
        # A matter hidden for having no records becomes visible once something discusses it.
        gained = {l["matter_id"] for l in mentions} | {l["matter_id"] for l in related} | {l["related_matter_id"] for l in related}
        for m in matters:
            meta = m.get("meta") or {}
            if m["id"] in gained and meta.get("hidden") == "no_records":
                meta = {k: v for k, v in meta.items() if k != "hidden"}
                supabase.table("matters").update({"meta": meta}).eq("id", m["id"]).execute()
        if mentions:
            from pipeline.ingestion import participation_mentions

            participation_mentions.run()  # public comment: only the speakers about each topic
    return {"related": related, "mentions": mentions}
