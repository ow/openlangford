"""Link matters to the bylaw they are about (matters.bylaw_id).

A matter links to bylaw X when the first bylaw number in its title (falling
back to its identifier) is X, or is one of X's amending bylaws that has no
bylaw row of its own ("Elections Bylaw No. 1819, Amendment No. 2, Bylaw No.
2267" -> 1819). Numbers are read with ``find_bylaw_numbers``, which refuses
street addresses and bare years. Merged matters (``merged_into``) resolve to
their canonical matter, so only the canonical gets the link.

Pure planning; the caller writes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from pipeline.bylaw_numbers import find_bylaw_numbers, normalize_number, primary_bylaw_number


@dataclass
class PlannedLink:
    matter_id: int
    title: str
    slug: str | None
    via: str  # "direct" | "amendment <n>"
    matched_matter_ids: list[int]  # the matters whose text matched (aliases included)
    current_bylaw_id: int | None = None

    @property
    def conflict(self) -> bool:
        return self.current_bylaw_id is not None


def _match(matter: dict, number: str, amendments: set[str], numbers_with_rows: set[str]) -> str | None:
    primary = primary_bylaw_number(matter.get("title"), matter.get("identifier"))
    if primary is None:
        return None
    if primary == number:
        return "direct"
    if primary in amendments and primary not in numbers_with_rows:
        return f"amendment {primary}"
    return None


def plan_links(
    matters: list[dict],
    *,
    bylaw_id: int | None,
    bylaw_number: str,
    amendment_numbers: list[str] | None = None,
    numbers_with_rows: set[str] | None = None,
) -> list[PlannedLink]:
    """``matters`` rows need id, title, identifier, slug, meta, bylaw_id, merged_into."""
    number = normalize_number(bylaw_number)
    amendments = {normalize_number(n) for n in (amendment_numbers or []) if normalize_number(n)}
    others = {normalize_number(n) for n in (numbers_with_rows or set())} - {number}
    by_id = {m["id"]: m for m in matters}

    planned: dict[int, PlannedLink] = {}
    for m in matters:
        via = _match(m, number, amendments, others)
        if not via:
            continue
        canonical_id = m.get("merged_into")
        target = by_id.get(canonical_id) if canonical_id else m
        if target is None:
            target = m
        link = planned.get(target["id"])
        if link is None:
            current = target.get("bylaw_id")
            link = PlannedLink(
                matter_id=target["id"],
                title=target.get("title") or "",
                slug=target.get("slug"),
                via=via,
                matched_matter_ids=[],
                current_bylaw_id=current if current not in (None, bylaw_id) else None,
            )
            planned[target["id"]] = link
        if m["id"] not in link.matched_matter_ids:
            link.matched_matter_ids.append(m["id"])
        if via == "direct":
            link.via = "direct"
    return sorted(planned.values(), key=lambda l: l.matter_id)


def mentions(matter: dict, number: str) -> bool:
    """True if the matter mentions the bylaw number anywhere (for reporting
    near-misses that the primary-reference rule skipped)."""
    text = f"{matter.get('identifier') or ''} | {matter.get('title') or ''}"
    return normalize_number(number) in find_bylaw_numbers(text)


# ── all bylaws at once ───────────────────────────────────────────────────

_AMEND = re.compile(r"\bamend(?:s|ed|ing|ment|ments)?\b", re.IGNORECASE)
# Regional (CRD) bylaws share number ranges with Langford's; never link them.
_REGIONAL = re.compile(r"\b(?:CRD|Capital\s+Regional|Regional\s+District|Regional\s+Parks?|Regional\s+Growth)\b", re.IGNORECASE)
_IDENT_PART = re.compile(r"^\s*by-?laws?\s*(?P<nos>nos?\.?|#)?\s*(?P<num>\d{1,4})\b(?![.,]?\d)", re.IGNORECASE)
_PLAIN_NUMBER = re.compile(r"^\s*(?:no\.?\s*)?(\d{1,4})\s*$", re.IGNORECASE)

VIA_RANK = {"own": 0, "consolidated": 1, "amends": 2, "amends-name": 3}


def identifier_numbers(identifier: str | None) -> list[str]:
    """Bylaw numbers in a matter identifier ("BYLAW NO. 1612", "Bylaw No. 2253;
    Bylaw No. 2254", "BYLAW NOS. 1634; 1635; 1636"). The identifier is a
    structured field, so a bare "BYLAW 2019" is a bylaw number, not a year;
    other parts ("1234 Goldstream Avenue", "Z17-0004") are ignored."""
    out: list[str] = []
    in_list = False
    for part in re.split(r"[;,]", identifier or ""):
        m = _IDENT_PART.match(part)
        if m:
            n = normalize_number(m.group("num"))
            if n and n not in out:
                out.append(n)
            in_list = bool(m.group("nos") and m.group("nos").lower().startswith("nos"))
            continue
        p = _PLAIN_NUMBER.match(part)
        if in_list and p:
            n = normalize_number(p.group(1))
            if n and n not in out:
                out.append(n)
            continue
        in_list = False
    return out


def _name_core(title: str) -> str | None:
    t = title.lower()
    t = re.sub(r"^(?:the\s+)?(?:city\s+of\s+)?langford\s+", "", t)
    t = re.sub(r"\s*\bbylaw\b.*$", "", t).strip(" ,-–")
    return t if len(t) >= 4 else None


def _year(text: str | None) -> int | None:
    m = re.match(r"\s*((?:19|20)\d{2})", str(text or ""))
    return int(m.group(1)) if m else None


@dataclass
class BulkLink:
    matter_id: int
    title: str
    bylaw_id: int
    bylaw_number: str
    via: str  # "own" | "consolidated" | "amends" | "amends-name"
    detail: str
    matched_matter_ids: list[int]
    current_bylaw_id: int | None = None

    @property
    def conflict(self) -> bool:
        return self.current_bylaw_id is not None and self.current_bylaw_id != self.bylaw_id

    @property
    def unchanged(self) -> bool:
        return self.current_bylaw_id == self.bylaw_id


def match_matter(
    matter: dict,
    rows_by_number: dict[str, dict],
    consolidated_in: dict[str, str],
    names: dict[str, list[dict]],
) -> tuple[str, str, str] | None:
    """(bylaw_number, via, detail) for one matter, or None.

    1. own: the matter's own bylaw (identifier, else the title's principal
       number; for an amendment, the newest number) has a row.
    2. consolidated: the own bylaw is an amendment listed in a row's
       consolidation, and has no row of its own.
    3. amends: the title says "amend..." and names the parent by number.
    4. amends-name: the title says "amend..." and names exactly one current
       bylaw by name ("Langford Zoning Bylaw, Amendment No. 592") that was
       already enacted when the matter began.
    """
    title = matter.get("title") or ""
    if _REGIONAL.search(title):
        return None
    amends = bool(_AMEND.search(title))
    title_nums = find_bylaw_numbers(title)
    own = identifier_numbers(matter.get("identifier"))
    if not own and title_nums:
        if amends and len(title_nums) > 1:
            own = [max(title_nums, key=int)]
        else:
            own = title_nums[:1]
    for n in own:
        if n in rows_by_number:
            return n, "own", f"own bylaw {n}"
    for n in own:
        if n in consolidated_in:
            return consolidated_in[n], "consolidated", f"amendment {n} is consolidated into {consolidated_in[n]}"
    if not amends:
        return None
    multi = len(own) > 1  # a matter bundling several bylaws: only explicit numbers count
    newest_own = max((int(n) for n in own), default=None)
    for n in title_nums:
        if n in own or n not in rows_by_number:
            continue
        if newest_own is not None and int(n) >= newest_own:
            continue  # an amended bylaw is older than its amendment
        return n, "amends", f"amends bylaw {n} (own {', '.join(own) or 'none'} has no row)"
    low = title.lower()
    present = [core for core in names if re.search(rf"\b{re.escape(core)}\s+bylaw\b", low)]
    present = [c for c in present if not any(c != o and c in o for o in present)]
    if multi or len(present) != 1 or len(names[present[0]]) != 1:
        return None
    row = names[present[0]][0]
    parent = normalize_number(row["bylaw_number"])
    # Bylaw numbers are sequential: an amendment numbered below the bylaw
    # cannot amend it (e.g. OCP amendment 1887 predates OCP Bylaw 2200).
    if newest_own is not None and parent and newest_own < int(parent):
        return None
    started = _year(matter.get("first_seen"))
    if started is None:
        y = re.findall(r"\b((?:19|20)\d{2})\b", title)
        started = int(y[-1]) if y else None
    if row.get("year") and started and int(row["year"]) > started:
        return None
    return normalize_number(row["bylaw_number"]), "amends-name", f"amends the {present[0]} bylaw by name"


def plan_all_links(matters: list[dict], bylaws: list[dict]) -> tuple[list[BulkLink], list[dict]]:
    """Plan matters.bylaw_id for every matter against every bylaw row.

    ``bylaws`` rows: id, bylaw_number, title, year, status, and ``amendments``
    (numbers listed in its consolidation). Name matching only uses current
    bylaws (status set from the City's directory). Merged matters
    (``merged_into``) resolve to the canonical matter. Returns
    (links, ambiguous) where ambiguous lists canonicals whose aliases point at
    different bylaws (not linked).
    """
    rows_by_number = {normalize_number(b["bylaw_number"]): b for b in bylaws if b.get("bylaw_number")}
    consolidated_in: dict[str, str] = {}
    for b in bylaws:
        for a in b.get("amendments") or []:
            a = normalize_number(a)
            if a and a not in rows_by_number:
                consolidated_in.setdefault(a, normalize_number(b["bylaw_number"]))
    names: dict[str, list[dict]] = {}
    for b in bylaws:
        if not b.get("status") or not b.get("title"):
            continue
        core = _name_core(b["title"])
        if core:
            names.setdefault(core, []).append(b)

    by_id = {m["id"]: m for m in matters}
    proposals: dict[int, list[tuple[int, str, str, str, int]]] = {}  # target -> [(rank, number, via, detail, src id)]
    for m in matters:
        hit = match_matter(m, rows_by_number, consolidated_in, names)
        if not hit:
            continue
        number, via, detail = hit
        canonical_id = m.get("merged_into")
        target = by_id.get(canonical_id) if canonical_id else m
        target = target or m
        proposals.setdefault(target["id"], []).append((VIA_RANK[via], number, via, detail, m["id"]))

    links: list[BulkLink] = []
    ambiguous: list[dict] = []
    for tid, props in proposals.items():
        target = by_id[tid]
        own_props = [p for p in props if p[4] == tid]
        pool = own_props or props
        best_rank = min(p[0] for p in pool)
        numbers = {p[1] for p in pool if p[0] == best_rank}
        if len(numbers) > 1:
            ambiguous.append({"matter_id": tid, "title": target.get("title"), "numbers": sorted(numbers, key=int)})
            continue
        number = numbers.pop()
        rank, _, via, detail, _ = next(p for p in pool if p[0] == best_rank and p[1] == number)
        links.append(
            BulkLink(
                matter_id=tid,
                title=target.get("title") or "",
                bylaw_id=rows_by_number[number]["id"],
                bylaw_number=number,
                via=via,
                detail=detail,
                matched_matter_ids=sorted({p[4] for p in props if p[1] == number}),
                current_bylaw_id=target.get("bylaw_id"),
            )
        )
    links.sort(key=lambda l: l.matter_id)
    return links, ambiguous
