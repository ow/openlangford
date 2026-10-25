"""Entity resolution for matters: find records that describe the same thing.

Exact identifier matching misses duplicates whenever the source formats a
bylaw differently, bundles two bylaws, or carries the reading stage in the
title. This resolver works in two steps:

1. Candidate generation from several cheap signals — any overlap in bylaw
   numbers / permit codes, a shared address or street, embedding similarity,
   and stage-free title similarity.
2. Decision: unambiguous pairs are linked deterministically; everything else
   goes to the model, which sees both records side by side and answers
   same_matter / same_project / different with a confidence.

``audit()`` runs this over every canonical matter and returns proposed merge
clusters; ``apply_merges()`` records them with the existing non-destructive
alias convention (alias ``meta.canonical_matter_id`` + canonical
``meta.merged_matter_ids``), so merges are reversible.
"""
from __future__ import annotations

import difflib
import json
import math
import re
from collections import defaultdict
from dataclasses import dataclass, field

from supabase import Client

from pipeline import ai
from pipeline.ingestion.matter_matching import (
    _street_names,
    bylaw_identifiers,
    normalize_address,
    parse_compound_identifier,
    strip_stage,
)

EMBED_THRESHOLD = 0.86
TITLE_THRESHOLD = 0.72
MAX_PER_ADDRESS = 8  # busier addresses (city hall, big sites) are too ambiguous to pair blindly


@dataclass
class MatterRecord:
    id: int
    title: str
    identifier: str | None
    category: str | None
    first_seen: str | None
    last_seen: str | None
    keys: set[str] = field(default_factory=set)
    addresses: set[str] = field(default_factory=set)
    streets: set[str] = field(default_factory=set)
    items: list[dict] = field(default_factory=list)
    embedding: list[float] | None = None
    meta: dict = field(default_factory=dict)
    summary: str | None = None

    @property
    def clean_title(self) -> str:
        return strip_stage(self.title).lower()


def _keys(identifier: str | None, title: str | None) -> set[str]:
    keys = {p for p in parse_compound_identifier(identifier or "") if re.match(r"^(Bylaw|TUP|DVP|DP|Z|OCP|ALR|LLP|REZ|SUB) ", p)}
    if not any(k.startswith("Bylaw ") for k in keys) and not re.search(
        r"\b(vary|variance|contravention|enforcement)\b", title or "", re.I
    ):
        keys |= bylaw_identifiers(title)
    return {k.upper() for k in keys}


def _paginate(build, page: int = 500) -> list[dict]:
    rows, start = [], 0
    while True:
        chunk = build().range(start, start + page - 1).execute().data or []
        rows.extend(chunk)
        if len(chunk) < page:
            return rows
        start += page


def _parse_vec(v) -> list[float] | None:
    if v is None:
        return None
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return None
    return list(v)


def load_records(supabase: Client, municipality_id: int = 1) -> dict[int, MatterRecord]:
    matters = _paginate(
        lambda: supabase.table("matters")
        .select("id, title, identifier, category, first_seen, last_seen, meta, embedding")
        .eq("municipality_id", municipality_id)
        .order("id")
    )
    records: dict[int, MatterRecord] = {}
    for m in matters:
        meta = m.get("meta") or {}
        # Aliases are already merged; hidden matters (procedural containers,
        # empty records) are kept out of listings, so never propose them.
        if meta.get("canonical_matter_id") or meta.get("hidden") is not None:
            continue
        records[m["id"]] = MatterRecord(
            id=m["id"],
            title=m["title"] or "",
            identifier=m.get("identifier"),
            category=m.get("category"),
            first_seen=m.get("first_seen"),
            last_seen=m.get("last_seen"),
            keys=_keys(m.get("identifier"), m.get("title")),
            streets=_street_names(m.get("title")),
            embedding=_parse_vec(m.get("embedding")),
            meta=meta,
        )
    items = _paginate(
        lambda: supabase.table("agenda_items")
        .select("matter_id, title, plain_english_summary, related_address, meetings(meeting_date)")
        .not_.is_("matter_id", "null")
        .order("id"),
        page=1000,
    )
    # Alias matters' history belongs to their canonical matter.
    alias_to_canonical = {
        m["id"]: int(m["meta"]["canonical_matter_id"])
        for m in matters
        if (m.get("meta") or {}).get("canonical_matter_id")
    }
    for it in items:
        rec = records.get(alias_to_canonical.get(it["matter_id"], it["matter_id"]))
        if not rec:
            continue
        addrs = it.get("related_address")
        if isinstance(addrs, str):
            try:
                addrs = json.loads(addrs)
            except ValueError:
                addrs = [addrs]
        for a in addrs or []:
            if a:
                rec.addresses.add(normalize_address(a))
                rec.streets |= _street_names(a)
        rec.streets |= _street_names(it.get("title"))
        rec.items.append(
            {
                "date": (it.get("meetings") or {}).get("meeting_date"),
                "title": it.get("title"),
                "summary": (it.get("plain_english_summary") or "")[:280],
            }
        )
    for rec in records.values():
        rec.items.sort(key=lambda i: i["date"] or "")
    return records


def _cos(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def candidate_pairs(records: dict[int, MatterRecord]) -> dict[tuple[int, int], set[str]]:
    """Return {(a, b): {signals}} for plausibly-related matter pairs."""
    pairs: dict[tuple[int, int], set[str]] = defaultdict(set)

    def add(a: int, b: int, signal: str):
        if a != b:
            pairs[(min(a, b), max(a, b))].add(signal)

    by_key: dict[str, list[int]] = defaultdict(list)
    by_addr: dict[str, list[int]] = defaultdict(list)
    for r in records.values():
        for k in r.keys:
            by_key[k].append(r.id)
        for a in r.addresses:
            by_addr[a].append(r.id)
    for k, ids in by_key.items():
        for i, a in enumerate(ids):
            for b in ids[i + 1 :]:
                add(a, b, f"key:{k}")
    for addr, ids in by_addr.items():
        if len(ids) > MAX_PER_ADDRESS:
            continue
        for i, a in enumerate(ids):
            for b in ids[i + 1 :]:
                add(a, b, "address")

    # Embedding neighbours (numpy if available; pure Python fallback is fine at this size).
    with_vec = [r for r in records.values() if r.embedding]
    try:
        import numpy as np

        mat = np.array([r.embedding for r in with_vec], dtype=np.float32)
        mat /= np.linalg.norm(mat, axis=1, keepdims=True) + 1e-9
        sims = mat @ mat.T
        for i in range(len(with_vec)):
            for j in np.where(sims[i, i + 1 :] >= EMBED_THRESHOLD)[0]:
                add(with_vec[i].id, with_vec[i + 1 + j].id, f"embedding:{sims[i, i + 1 + j]:.2f}")
    except ImportError:
        for i, a in enumerate(with_vec):
            for b in with_vec[i + 1 :]:
                s = _cos(a.embedding, b.embedding)
                if s >= EMBED_THRESHOLD:
                    add(a.id, b.id, f"embedding:{s:.2f}")

    # Stage-free title similarity within a shared street or key-less bylaw-ish titles.
    by_street: dict[str, list[MatterRecord]] = defaultdict(list)
    for r in records.values():
        for s in r.streets:
            by_street[s].append(r)
    for street, recs in by_street.items():
        if len(recs) > 40:
            continue
        for i, a in enumerate(recs):
            for b in recs[i + 1 :]:
                sim = difflib.SequenceMatcher(None, a.clean_title, b.clean_title).ratio()
                add(a.id, b.id, f"street:{street}" + (f",title:{sim:.2f}" if sim >= TITLE_THRESHOLD else ""))
    return pairs


def deterministic(a: MatterRecord, b: MatterRecord) -> str | None:
    """Return 'same_matter' for pairs that need no judgement, else None."""
    if len(a.keys) == 1 and a.keys == b.keys:
        return "same_matter"  # the same single bylaw or permit
    permits = {k for k in a.keys & b.keys if not k.startswith("BYLAW ")}
    if permits and len(a.keys) <= 2 and len(b.keys) <= 2:
        return "same_matter"
    return None


_PROCEDURAL = re.compile(
    r"\b(minutes|committee\s*(?:meeting|report|recommendations|[-–—:]\s*\w+ \d)|receipt of|correspondence|in camera|adjourn|"
    r"multiple bylaws|bylaws for consideration)",
    re.I,
)


def _house_numbers(r: MatterRecord) -> set[str]:
    nums = set()
    for text in [r.title, *r.addresses]:
        nums |= set(re.findall(r"\b(\d{2,5})(?=\s*(?:[-–&,]\s*\d{2,5}\s*)*\s+[A-Z][a-z])", text or ""))
    return nums


def _amendment_numbers(title: str) -> set[str]:
    return set(re.findall(r"amendment\s+no\.?\s*(\d+)", title or "", re.I))


def definitely_different(a: MatterRecord, b: MatterRecord) -> bool:
    """Cheap rejections so the model only sees genuinely ambiguous pairs."""
    if _PROCEDURAL.search(a.title) or _PROCEDURAL.search(b.title):
        return True
    am_a, am_b = _amendment_numbers(a.title), _amendment_numbers(b.title)
    if am_a and am_b and not am_a & am_b:
        return True  # "Zoning Amendment No. 505" vs "No. 648"
    shared_addr = bool(a.addresses & b.addresses)
    bylaws_a = {k for k in a.keys if k.startswith("BYLAW ")}
    bylaws_b = {k for k in b.keys if k.startswith("BYLAW ")}
    if bylaws_a and bylaws_b and not bylaws_a & bylaws_b and not shared_addr:
        return True  # different bylaws, different places
    permits_a = a.keys - bylaws_a
    permits_b = b.keys - bylaws_b
    if permits_a and permits_b and not permits_a & permits_b:
        return True  # different permit files
    ha, hb = _house_numbers(a), _house_numbers(b)
    if ha and hb and not ha & hb and not (a.keys & b.keys):
        return True  # same street, different property
    return False


def _needs_judgement(signals: set[str], a: MatterRecord, b: MatterRecord) -> bool:
    if definitely_different(a, b):
        return False
    if any(s.startswith("key:") for s in signals):
        return True
    if "address" in signals:
        return True
    emb = max((float(s.split(":")[1]) for s in signals if s.startswith("embedding:")), default=0.0)
    title = any(",title:" in s for s in signals)
    if emb >= 0.9 or title:
        return True
    return emb >= EMBED_THRESHOLD and bool(a.streets & b.streets)


SAME_MATTER_QUESTION = ai.choice(
    "verdict",
    "Records A and B come from a small Canadian city's council records. A matter is one thing residents "
    "would follow over time: one development application, one bylaw through all its readings, one permit, "
    "one program. Are A and B the same matter? Be conservative.",
    [
        ("same_matter", "The same thing at different stages or described differently: first reading vs adoption "
                        "of one bylaw, a referral and the resulting bylaw for the same property, a permit and its renewal."),
        ("same_project", "Distinct legal instruments residents would see as one application, e.g. the OCP amendment "
                         "and the rezoning for the same property."),
        ("different", "Anything else: different properties; separate applications for the same property (a new rezoning "
                      "years later, or a variance permit after a rezoning was finished); different amendments to the same "
                      "parent bylaw; the same recurring item in different years; events that merely share a venue; "
                      "bundles of unrelated bylaws; committee minutes."),
    ],
)


def _describe(label: str, r: MatterRecord) -> str:
    lines = [
        f"{label}: {r.title}",
        f"  identifier: {r.identifier or '-'}",
        f"  addresses: {', '.join(sorted(r.addresses)[:4]) or '-'}",
        f"  seen: {r.first_seen} to {r.last_seen}",
    ]
    lines += [f"  {i['date']}: {i['title']} — {i['summary']}" for i in r.items[-4:]]
    return "\n".join(lines)


def adjudicate(pairs: list[tuple[MatterRecord, MatterRecord, set[str]]]) -> list[dict]:
    """Judge each pair with the Decisions API. Returns [{a, b, verdict, confidence, probabilities}]."""
    inputs = [(f"{_describe('A', a)}\n\n{_describe('B', b)}", [SAME_MATTER_QUESTION]) for a, b, _ in pairs]
    out: list[dict] = []
    for start in range(0, len(inputs), 200):
        results = ai.decide_many(inputs[start : start + 200])
        for (a, b, signals), res in zip(pairs[start : start + 200], results):
            if isinstance(res, Exception):
                print(f"  [Resolver] {a.id}/{b.id}: {res}")
                continue
            ans = res.get("verdict")
            if ans is None or ans.type != "choice":
                continue
            probs = {p.value: p.probability for p in ans.probabilities}
            out.append(
                {
                    "a": a.id,
                    "b": b.id,
                    "verdict": ans.choice,
                    # Merging is right for either "same" verdict, so threshold on their combined probability.
                    "confidence": probs.get("same_matter", 0) + probs.get("same_project", 0)
                    if ans.choice != "different" else probs.get("different", 0),
                    "probabilities": probs,
                    "signals": sorted(signals),
                }
            )
        print(f"  [Resolver] judged {min(start + 200, len(inputs))}/{len(inputs)}")
    return out


def cluster(decisions: list[dict], min_confidence: float, forbidden: set[tuple[int, int]]) -> list[list[int]]:
    """Complete-link grouping: join two groups only if no cross pair is known to be different.

    Plain union-find chains plausible links into wrong groups (rezoning 2017 → same
    address → variance 2022 → ...); checking every cross pair prevents that.
    """
    group: dict[int, set[int]] = {}
    links = sorted(
        (d for d in decisions if d["verdict"] in ("same_matter", "same_project") and d["confidence"] >= min_confidence),
        key=lambda d: -d["confidence"],
    )
    for d in links:
        ga = group.get(d["a"], {d["a"]})
        gb = group.get(d["b"], {d["b"]})
        if ga is gb:
            continue
        if any((min(x, y), max(x, y)) in forbidden for x in ga for y in gb):
            continue
        merged = ga | gb
        for x in merged:
            group[x] = merged
    seen, out = set(), []
    for g in group.values():
        if id(g) not in seen and len(g) > 1:
            seen.add(id(g))
            out.append(sorted(g))
    return out


def _months_apart(a: MatterRecord, b: MatterRecord) -> float:
    from datetime import date

    def d(x):
        try:
            return date.fromisoformat(str(x)[:10])
        except (TypeError, ValueError):
            return None

    a0, a1, b0, b1 = d(a.first_seen), d(a.last_seen), d(b.first_seen), d(b.last_seen)
    if not (a0 and b0):
        return 0.0
    a1, b1 = a1 or a0, b1 or b0
    gap = max((b0 - a1).days, (a0 - b1).days, 0)
    return gap / 30.4


def _auto_ok(d: dict, records: dict[int, MatterRecord]) -> bool:
    a, b = records[d["a"]], records[d["b"]]
    return bool(a.keys & b.keys) or _months_apart(a, b) <= 12


def audit(supabase: Client, *, municipality_id: int = 1) -> dict:
    """Find duplicate matters. Returns {"decisions": [...], "auto": [[ids]], "review": [[ids]]}."""
    records = load_records(supabase, municipality_id)
    pairs = candidate_pairs(records)
    print(f"  [Resolver] {len(records)} matters, {len(pairs)} candidate pairs")
    decisions: list[dict] = []
    to_judge = []
    for (a_id, b_id), signals in pairs.items():
        a, b = records[a_id], records[b_id]
        verdict = deterministic(a, b)
        if verdict:
            decisions.append({"a": a_id, "b": b_id, "verdict": verdict, "confidence": 1.0, "reason": "same identifier"})
        elif _needs_judgement(signals, a, b):
            to_judge.append((a, b, signals))
    print(f"  [Resolver] {len(decisions)} deterministic, {len(to_judge)} for the model")
    decisions += adjudicate(to_judge)
    forbidden = {(min(d["a"], d["b"]), max(d["a"], d["b"])) for d in decisions if d["verdict"] == "different"}
    ids = sorted({i for d in decisions for i in (d["a"], d["b"])})
    for i, a in enumerate(ids):
        for b in ids[i + 1 :]:
            if definitely_different(records[a], records[b]):
                forbidden.add((a, b))
    # Auto-merge only links that are corroborated or close in time; the rest wait for review.
    auto_links = [d for d in decisions if _auto_ok(d, records)]
    auto = cluster(auto_links, 0.85, forbidden)
    everything = cluster(decisions, 0.6, forbidden)
    auto_sets = [set(c) for c in auto]
    review = [c for c in everything if set(c) not in auto_sets]
    return {"decisions": decisions, "auto": auto, "review": review}


def apply_merges(supabase: Client, clusters: list[list[int]], *, reason: str = "resolver") -> list[dict]:
    """Merge each cluster into its earliest matter using the alias convention."""
    applied = []
    for ids in clusters:
        rows = (
            supabase.table("matters").select("id, first_seen, last_seen, meta").in_("id", ids).execute().data or []
        )
        if len(rows) < 2:
            continue
        rows.sort(key=lambda r: (r.get("first_seen") or "9999", r["id"]))
        canonical, aliases = rows[0], rows[1:]
        meta = dict(canonical.get("meta") or {})
        merged = sorted(set(meta.get("merged_matter_ids") or []) | {r["id"] for r in aliases})
        meta["merged_matter_ids"] = merged
        last = max((r.get("last_seen") or "" for r in rows), default=None) or canonical.get("last_seen")
        supabase.table("matters").update({"meta": meta, "last_seen": last}).eq("id", canonical["id"]).execute()
        for alias in aliases:
            ameta = dict(alias.get("meta") or {})
            ameta["canonical_matter_id"] = canonical["id"]
            ameta["merge_reason"] = reason
            supabase.table("matters").update({"meta": ameta}).eq("id", alias["id"]).execute()
        applied.append({"canonical": canonical["id"], "aliases": [r["id"] for r in aliases]})
    return applied


# --- Ingest-time resolution ---------------------------------------------------

MAX_INGEST_CANDIDATES = 6
INGEST_MIN_PROBABILITY = 0.8


def _record_from_matcher(m: dict) -> MatterRecord:
    return MatterRecord(
        id=m["id"],
        title=m.get("title") or "",
        identifier=m.get("identifier"),
        category=m.get("category"),
        first_seen=m.get("first_seen"),
        last_seen=m.get("last_seen"),
        keys=_keys(m.get("identifier"), m.get("title")),
        addresses=set(m.get("_addresses") or ()),
        streets=_street_names(m.get("title")),
        meta=m.get("meta") or {},
        summary=m.get("plain_english_summary"),
    )


def ingest_candidates(matcher, identifier: str | None, title: str | None, addresses: set[str]) -> list[MatterRecord]:
    """Plausible existing matters for an incoming agenda item the exact matcher couldn't place."""
    incoming = MatterRecord(
        id=-1, title=title or "", identifier=identifier, category=None, first_seen=None, last_seen=None,
        keys=_keys(identifier, title), addresses=set(addresses), streets=_street_names(title),
    )
    found: dict[int, tuple[float, dict]] = {}

    def add(m: dict, score: float):
        from .matter_matching import compatible_policy_scope
        if not compatible_policy_scope(title, m.get("title")):
            return  # A plan and procurement/implementation are distinct scopes.
        if (m.get("meta") or {}).get("canonical_matter_id"):
            return
        if m["id"] not in found or found[m["id"]][0] < score:
            found[m["id"]] = (score, m)

    for key in incoming.keys:
        for m in matcher.identifier_index.get(key.lower(), []):
            add(m, 3.0)
    for addr in incoming.addresses:
        hits = matcher.address_index.get(addr, [])
        if len(hits) <= MAX_PER_ADDRESS:
            for m in hits:
                add(m, 2.0)
    clean = incoming.clean_title
    for m in matcher.matters:
        if incoming.streets and incoming.streets & _street_names(m.get("title")):
            add(m, 1.0 + difflib.SequenceMatcher(None, clean, strip_stage(m.get("title")).lower()).ratio())
        elif clean and len(clean) > 12:
            sim = difflib.SequenceMatcher(None, clean, strip_stage(m.get("title")).lower()).ratio()
            if sim >= 0.6:
                add(m, sim)

    ranked = sorted(found.values(), key=lambda x: -x[0])
    out = []
    for _, m in ranked:
        rec = _record_from_matcher(m)
        if not definitely_different(incoming, rec):
            out.append(rec)
        if len(out) >= MAX_INGEST_CANDIDATES:
            break
    return out


def resolve_incoming(
    matcher, identifier: str | None, title: str | None, addresses: set[str], *, date: str | None = None, summary: str | None = None
) -> tuple[int | None, str]:
    """Pick the existing matter an incoming agenda item belongs to, or None for a new matter."""
    candidates = ingest_candidates(matcher, identifier, title, addresses)
    if not candidates:
        return None, "no_candidates"
    incoming = "\n".join(
        [
            f"NEW ITEM ({date or 'date unknown'}): {title}",
            f"  identifier: {identifier or '-'}",
            f"  addresses: {', '.join(sorted(addresses)[:4]) or '-'}",
            f"  summary: {(summary or '-')[:400]}",
        ]
    )
    def describe(c: MatterRecord) -> str:
        bits = [f"m{c.id}: {c.title}", f"identifier: {c.identifier or '-'}",
                f"addresses: {', '.join(sorted(c.addresses)[:3]) or '-'}", f"active: {c.first_seen} to {c.last_seen}"]
        where = (c.meta or {}).get("status_line") or c.summary
        if where:
            bits.append(f"latest: {where[:240]}")
        return " | ".join(bits)

    listing = "\n".join(describe(c) for c in candidates)
    question = ai.choice(
        "matter",
        "A new council agenda item arrived. Does it continue one of the existing matters listed (the same bylaw at "
        "another reading, the same application or permit, or the OCP/zoning pair for the same property)? "
        "Separate applications for the same property, different amendments of a parent bylaw, and recurring "
        "items from other years are NOT the same matter. A later reading, adoption, or decision on the same "
        "bylaw or application IS the same matter even if worded differently.",
        [(f"m{c.id}", c.title[:200]) for c in candidates] + [("new", "None of these; it is a new matter.")],
    )
    try:
        answer = ai.decide(f"{incoming}\n\nEXISTING MATTERS:\n{listing}", [question]).get("matter")
    except Exception as exc:
        print(f"  [Resolver] ingest decision failed: {exc}")
        return None, "decision_error"
    if answer is None or answer.type != "choice" or answer.choice == "new":
        return None, "decided_new"
    prob = {p.value: p.probability for p in answer.probabilities}.get(answer.choice, 0)
    if prob < INGEST_MIN_PROBABILITY:
        return None, f"low_confidence:{prob:.2f}"
    return int(answer.choice[1:]), f"resolver:{prob:.2f}"


def save_proposals(supabase: Client, clusters: list[list[int]], decisions_list: list[dict]) -> int:
    """Queue clusters for admin review, skipping any already proposed."""
    existing = {
        tuple(sorted(r["matter_ids"]))
        for r in supabase.table("matter_merge_proposals").select("matter_ids").execute().data or []
    }
    rows = []
    for ids in clusters:
        key = tuple(sorted(ids))
        if key in existing:
            continue
        members = set(ids)
        rows.append(
            {
                "matter_ids": list(key),
                "decisions": [d for d in decisions_list if d["a"] in members and d["b"] in members],
            }
        )
    if rows:
        supabase.table("matter_merge_proposals").insert(rows).execute()
    return len(rows)
