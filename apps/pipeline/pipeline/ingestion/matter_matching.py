"""
Matter matching module for deduplicating matters during ingestion.

Provides multi-signal matching (identifier + address + title similarity)
to correctly merge related matters and distinguish different ones.
"""

import difflib
import json
import re
from collections import defaultdict
from typing import Optional

# --- Utility Functions ---


def parse_compound_identifier(raw: str) -> list[str]:
    """Split a compound identifier on ';' and return normalized parts.

    Example: "Bylaw No. 1160; REZ 2025-01" -> ["Bylaw 1160", "REZ 2025-01"]
    """
    if not raw:
        return []

    # Split on semicolons only (commas are used in "Bylaw No. X, 2024")
    parts = raw.split(";")
    result = []
    for part in parts:
        # Bare bylaw numbers ("1852; 1853"), but never years.
        bare = part.strip()
        if re.fullmatch(r"\d{3,4}", bare) and not 2000 <= int(bare) <= 2035:
            result.append(f"Bylaw {bare}")
            continue
        # Plural bundles must index every bylaw, not the unparsed whole label.
        plural = re.fullmatch(
            r"Bylaws?\s+Nos?\.?\s*(\d+(?:-\d+)?(?:\s*(?:,|&|and)\s*\d+(?:-\d+)?)*)",
            part.strip(), re.IGNORECASE,
        )
        if plural and re.search(r",|&|\band\b", plural.group(1)):
            result.extend(f"Bylaw {number}" for number in re.findall(r"\d+(?:-\d+)?", plural.group(1)))
            continue
        normalized = normalize_identifier(part.strip())
        if normalized and len(normalized) > 2:
            result.append(normalized)
    return result


def bylaw_identifiers(text: str | None) -> set[str]:
    """Only explicit bylaw labels; never infer an identity from a bare number."""
    if not text:
        return set()
    identifiers = set()
    for match in re.finditer(
        r"\bBylaws?\s+(?:Nos?\.?\s*)?(\d+(?:-\d+)?)", text, re.IGNORECASE
    ):
        identifiers.add(f"Bylaw {match.group(1)}")
    for match in re.finditer(
        r"\bBylaws?\s+Nos\.?\s+(\d+(?:\s*(?:,|&|and)\s*\d+)*)", text, re.IGNORECASE
    ):
        identifiers.update(f"Bylaw {number}" for number in re.findall(r"\d+", match.group(1)))
    return identifiers


# City-wide bylaws that nearly every application cites ("vary Zoning Bylaw No. 300", "Subdivision and Development
# Servicing Bylaw No. 1000"). They say which rules a property is under, not which application an item is about, so
# they never identify a topic: as identifiers they pulled unrelated variances on other streets into one topic.
# Amendment bylaws keep their own numbers ("Zoning Bylaw No. 300, Amendment No. 706, Bylaw No. 1927" -> Bylaw 1927).
CITY_WIDE_BYLAWS = frozenset({
    "Bylaw 300",   # Zoning Bylaw
    "Bylaw 1000",  # Subdivision and Development Servicing Bylaw
    "Bylaw 500",   # Subdivision and Development Servicing Bylaw (earlier)
    "Bylaw 1200",  # Official Community Plan Bylaw (2008)
    "Bylaw 2200",  # Official Community Plan Bylaw (2025)
    "Bylaw 1160",  # Building Bylaw
    "Bylaw 1250",  # Sign Bylaw
    "Bylaw 33",    # Traffic Bylaw
    "Bylaw 34",    # Ticket Information Bylaw
    "Bylaw 209",   # Development Procedures (application fees) Bylaw
})


# A bare records-classification code ("File No. 8100-20" events, "5400-20" roads, "5480-04" parking) is a subject
# folder shared by every request of that kind; like a city-wide bylaw it grouped unrelated events and petitions.
# A code with something specific after it ("File No. 8100-20 Bryn Maur Market", "File No. 3900-1427") still identifies.
CLASSIFICATION_CODE = re.compile(r"^(?:File\s+(?:No\.?\s*)?)?\d{4}-\d{2}$", re.IGNORECASE)


def is_city_wide(part: str) -> bool:
    """"Bylaw 300", "Zoning Bylaw No. 300", "File No. 8100-20" -> True; "Traffic Bylaw No. 33, Amendment ...,
    Bylaw No. 1890", "File No. 3900-1427" -> False."""
    if CLASSIFICATION_CODE.match(part.strip()):
        return True
    numbers = bylaw_identifiers(part) or ({part} if part.startswith("Bylaw ") else set())
    return bool(numbers) and numbers <= CITY_WIDE_BYLAWS


def identifying(parts) -> set[str]:
    """Identifier parts that can identify a topic: everything except city-wide bylaws."""
    return {p for p in parts if not is_city_wide(p)}


def identifying_identifier(raw: str | None) -> str | None:
    """A compound identifier as written, minus its city-wide bylaw parts; None when nothing identifying is left."""
    kept = [part.strip() for part in (raw or "").split(";")
            if part.strip() and identifying(parse_compound_identifier(part))]
    return "; ".join(kept) or None


def matter_identifiers(matter: dict) -> set[str]:
    identifiers = identifying(parse_compound_identifier(matter.get("identifier")))
    if not any(value.startswith("Bylaw ") for value in identifiers) and not re.search(
        r"\b(vary|variance|contravention|enforcement)\b", matter.get("title") or "", re.I
    ):
        identifiers |= identifying(bylaw_identifiers(matter.get("title")))
    return identifiers


def normalize_identifier(raw: str) -> str:
    """Normalize an identifier to a canonical short form.

    - "Bylaw No. 1160" -> "Bylaw 1160"
    - "Rezoning Application No. 2025-01" -> "REZ 2025-01"
    - "Temporary Use Permit No. 2025-03" -> "TUP 2025-03"
    - "Development Variance Permit No. 2024-01" -> "DVP 2024-01"
    - "Development Permit No. 2024-02" -> "DP 2024-02"
    """
    if not raw:
        return ""

    text = raw.strip()

    # Bylaw: "Bylaw No. 1160" -> "Bylaw 1160"
    m = re.match(
        r"(?:Amendment\s+)?Bylaws?\s+(?:Nos?\.?\s*)?(\d+(?:-\d+)?)", text, re.IGNORECASE
    )
    if m:
        return f"Bylaw {m.group(1)}"

    # Langford file numbers: "TUP16-0006 (Renewal)", "DVP 26-0001 - 2899 Sooke Lake Rd"
    m = re.match(r"(?:Planning\s+)?(TUP|DVP|DP|Z|OCP|ALR|LLP|REZ|SUB)\s?(\d{2})-(\d{4})\b", text, re.IGNORECASE)
    if m:
        return f"{m.group(1).upper()} {m.group(2)}-{m.group(3)}"

    # Rezoning: various forms -> "REZ YYYY-NN"
    m = re.match(
        r"(?:Rezoning|REZ)\s+(?:Application\s+)?(?:No\.?\s*)?(\d{4}[\-\/]\d{2})",
        text,
        re.IGNORECASE,
    )
    if m:
        return f"REZ {m.group(1).replace('/', '-')}"

    # TUP: "Temporary Use Permit No. X" -> "TUP X"
    m = re.match(
        r"(?:Temporary\s+Use\s+Permit|TUP)\s+(?:No\.?\s*)?(\d{4}[\-\/]\d{2})",
        text,
        re.IGNORECASE,
    )
    if m:
        return f"TUP {m.group(1).replace('/', '-')}"

    # DVP: "Development Variance Permit No. X" -> "DVP X"
    m = re.match(
        r"(?:Development\s+Variance\s+Permit|DVP)\s+(?:No\.?\s*)?(\d{4}[\-\/]\d{2})",
        text,
        re.IGNORECASE,
    )
    if m:
        return f"DVP {m.group(1).replace('/', '-')}"

    # DP: "Development Permit No. X" -> "DP X"
    m = re.match(
        r"(?:Development\s+Permit|DP)\s+(?:No\.?\s*)?(\d{4}[\-\/]\d{2})",
        text,
        re.IGNORECASE,
    )
    if m:
        return f"DP {m.group(1).replace('/', '-')}"

    # Fallback: strip extra whitespace
    return " ".join(text.split())


def extract_addresses(text: str) -> list[str]:
    """Extract street addresses from text using regex.

    Matches patterns like "258 Helmcken Road", "1 Bate Road", etc.
    """
    if not text:
        return []

    # Match: number + street name + street type
    pattern = r"\b(\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Road|Rd|Street|St|Avenue|Ave|Drive|Dr|Lane|Ln|Place|Pl|Crescent|Cres|Way|Boulevard|Blvd|Court|Ct|Terrace|Terr|Circle|Cir|Parkway|Pkwy))\b"
    matches = re.findall(pattern, text, re.IGNORECASE)
    return [normalize_address(m) for m in matches]


def normalize_address(addr: str) -> str:
    """Normalize an address: lowercase, expand abbreviations."""
    if not addr:
        return ""

    text = addr.strip().lower()

    # Expand common abbreviations
    replacements = {
        r"\brd\b": "road",
        r"\bst\b": "street",
        r"\bave\b": "avenue",
        r"\bpkwy\b": "parkway",
        r"\bdr\b": "drive",
        r"\bln\b": "lane",
        r"\bpl\b": "place",
        r"\bcres\b": "crescent",
        r"\bblvd\b": "boulevard",
        r"\bct\b": "court",
        r"\bterr\b": "terrace",
        r"\bcir\b": "circle",
    }
    for pattern, replacement in replacements.items():
        text = re.sub(pattern, replacement, text)

    return " ".join(text.split())


def extract_numbers(text: str) -> set[str]:
    """Extract distinct numbers from text."""
    if not text:
        return set()
    return set(re.findall(r"\d+", text))


_BOILERPLATE_WORDS = {
    "staff", "report", "reports", "file", "no", "re", "request", "requests", "application", "applications", "permit",
    "permits", "committee", "council", "city", "langford", "the", "of", "and", "for", "to", "at", "on", "in", "a",
    "bylaw", "amendment", "development", "variance", "temporary", "use", "zoning", "rezoning", "engineering",
}


def names_differ(t1: str, t2: str) -> bool:
    """True when each title names something the other doesn't ("Terry Fox Run" vs "Toy Run Motorcycle Event",
    "Parking Permit Zone on Anders Road" vs "... on Rowils"): templated titles read alike while being about
    different events, streets or applicants."""
    def named(text: str) -> set[str]:
        return {w.lower() for w in re.findall(r"\b[A-Z][A-Za-z'’]+\b", text or "") if w.lower() not in _BOILERPLATE_WORDS}
    a, b = named(t1), named(t2)
    return bool(a - b) and bool(b - a)


def check_number_mismatch(t1: str, t2: str) -> bool:
    """Returns True if t1 and t2 contain conflicting numbers.

    e.g. {1156} vs {1157} -> True (mismatch)
    e.g. {258} vs {258} -> False (match)
    e.g. {258} vs {258, 2025} -> False (subset)
    e.g. {2016, 7} vs {2016, 9} -> True (partial overlap but disjoint distincts)
    """
    nums1 = extract_numbers(t1)
    nums2 = extract_numbers(t2)

    if nums1 and nums2:
        # If disjoint, definite mismatch (e.g. 100 vs 101)
        if nums1.isdisjoint(nums2):
            return True
        # If overlap, check for conflicting distinct numbers (neither is subset of other)
        if not nums1.issubset(nums2) and not nums2.issubset(nums1):
            return True
    return False


# Category keywords for grouping matters
CATEGORY_KEYWORDS = {
    "rezoning": {"rezoning", "rezone", "rez"},
    "tup": {"temporary use permit", "tup"},
    "dvp": {"development variance permit", "dvp", "variance"},
    "dp": {"development permit"},
    "bylaw": {"bylaw"},
    "subdivision": {"subdivision"},
    "oc_plan": {"official community plan", "ocp"},
}

GENERIC_MATTER_TITLES = {
    "adoption of minutes",
    "adjournment",
    "approval of agenda",
    "approval of minutes",
    "bylaws",
    "bylaws (see sub-items)",
    "call to order",
    "closed meeting resolution",
    "consent agenda",
    "consideration of matters removed from the consent agenda",
    "correspondence",
    "delegations",
    "design guidelines",
    "in camera resolution",
    "mayor's report",
    "new business",
    "presentations",
    "public hearing",
    "public input",
    "public participation",
    "question period",
    "reports",
    "rising report",
    "termination",
}

GENERIC_CATEGORY_KEYWORDS = {
    "procedural",
    "public input",
    "public participation",
    "consent agenda",
}

SUBSTANTIVE_TITLE_KEYWORDS = {
    "agreement",
    "amendment",
    "application",
    "award",
    "budget",
    "bylaw",
    "contract",
    "development permit",
    "development variance permit",
    "grant",
    "lease",
    "licence",
    "license",
    "memorandum of understanding",
    "mou",
    "official community plan",
    "permit",
    "policy",
    "purchase",
    "rezoning",
    "service agreement",
    "subdivision",
    "temporary use permit",
    "variance",
    "zoning",
}

ENTITY_CLUSTERS = {
    "langford_aquatic_centre_ymca": {
        "title": "Langford Aquatic Centre / YMCA",
        "category": "Civic Asset",
        "description": "Umbrella history for the Langford Aquatic Centre, Westhills Y, YMCA/YWCA agreements, lease/rent arrangements, reserve funds, and related operating decisions.",
        "aliases": {
            "aquatic centre",
            "aquatic centre lease",
            "aquatic centre management reserve fund",
            "aquatic centre reserve fund",
            "langford aquatic centre",
            "langford aquatic centre supplementary agreement",
            "vancouver island y",
            "westhills aquatic centre",
            "westhills langford aquatic centre",
            "westhills y",
            "ymca",
            "ymca/ywca",
            "ymca-ywca",
            "ymca-ywca of greater victoria",
            "ymca-ywca vancouver island",
        },
        "subject_terms": {
            "agreement",
            "contribution",
            "debt",
            "deficit",
            "facility",
            "lease",
            "landlord",
            "operating",
            "operation",
            "profit",
            "purchase",
            "rent",
            "reserve fund",
            "service agreement",
            "services agreement",
            "supplementary agreement",
            "surplus",
        },
    },
    "starlight_stadium": {
        "title": "Starlight Stadium",
        "category": "Civic Asset",
        "description": "Umbrella history for Starlight Stadium, including naming, operating, capital, event, lease, partnership, and budget decisions.",
        "aliases": {
            "city centre park stadium",
            "goudy field",
            "langford stadium",
            "starlight stadium",
            "westhills stadium",
        },
        "subject_terms": {
            "agreement",
            "asset",
            "budget",
            "capital",
            "event",
            "facility",
            "field",
            "lease",
            "naming",
            "operating",
            "operation",
            "park",
            "partnership",
            "stadium",
        },
    },
    "langford_parkway": {
        "title": "Langford Parkway",
        "category": "Civic Asset",
        "description": "Umbrella history for Langford Parkway as a road corridor, including improvements, permits, frontage works, temporary uses, access, traffic, and development impacts along the corridor.",
        "aliases": {
            "langford parkway",
            "langford parkway improvements",
            "jacklin to ccp",
            "101-977 langford parkway",
            "#101-977 langford parkway",
            "103-977 langford parkway",
            "#103-977 langford parkway",
            "977 langford parkway",
        },
        "subject_terms": {
            "access",
            "award",
            "contract",
            "corridor",
            "development",
            "frontage",
            "improvement",
            "improvements",
            "parkway",
            "permit",
            "road",
            "sidewalk",
            "temporary use",
            "traffic",
            "transportation",
            "works",
        },
    },
}


def _extract_category_keywords(text: str) -> set[str]:
    """Extract category keyword groups present in text."""
    if not text:
        return set()
    lower = text.lower()
    found = set()
    for category, keywords in CATEGORY_KEYWORDS.items():
        if any(kw in lower for kw in keywords):
            found.add(category)
    return found


_STAGE_RE = re.compile(
    r"\s*[-–—(]?\s*\b(?:(?:first|second|third|1st|2nd|3rd)(?:\s*(?:,|and|&)\s*(?:first|second|third|1st|2nd|3rd))*"
    r"\s+readings?|readings?|adoption|final adoption|rescind(?:ing)? readings?|background report attached|"
    r"all readings|for adoption)\b[^)]*\)?\s*$",
    re.IGNORECASE,
)


def strip_stage(title: str | None) -> str:
    """Drop bylaw stage suffixes ("(SECOND AND THIRD READINGS)", "- Adoption") — stage isn't identity."""
    text = (title or "").strip()
    for _ in range(3):
        stripped = _STAGE_RE.sub("", text).strip(" -–—,")
        if stripped == text or len(stripped) < 6:
            break
        text = stripped
    return text


def clean_matter_title(title: str | None) -> str:
    """Normalize an agenda/matter title for eligibility checks."""
    if not title:
        return ""
    text = str(title).strip()
    text = re.sub(r"^\s*\d+(?:\.\d+)?[.)]?\s+", "", text)
    text = re.sub(r"\s*\(approx\.[^)]+\)\s*$", "", text, flags=re.IGNORECASE)
    text = strip_stage(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def is_valid_matter_identifier(identifier: str | None) -> bool:
    """Return False for agenda section numbers masquerading as identifiers."""
    if not identifier:
        return False
    normalized = normalize_identifier(identifier)
    if not normalized:
        return False
    if re.fullmatch(r"\d+(?:\.\d+)?", normalized):
        return False
    return bool(parse_compound_identifier(normalized))


CONTAINER_TITLE = re.compile(
    r"^(notices? of motion|public participation|presentations?|delegations?|correspondence)$"
    r"|committee (?:of the whole )?(?:meeting )?(?:minutes|resolutions)|multiple (?:bylaws|topics)|receipt of .*minutes"
    r"|^(?:planning )?notices? of intent\b|^resolutions (?:from|of) .*committee|committee .*\bresolutions\b"
    r"|bylaws for consideration|^bylaw adoptions?$",
    re.I,
)


# An agenda section heading for a kind of application, with nothing naming one ("DEVELOPMENT VARIANCE PERMIT (block)",
# "TEMPORARY USE PERMITS"). It carries its sub-items' addresses, so it looked eligible, and became a catch-all that
# unrelated applications were matched into (matter 633, 2017-2024).
SECTION_HEADING = re.compile(
    r"^(?:(?:development|temporary use|building|subdivision|heritage alteration)\s+(?:variance\s+)?permits?"
    r"(?:\s+applications?)?|development variance permits?|rezoning(?:s| applications?)?|zoning(?: bylaw)? amendments?"
    r"|subdivisions?|official community plan amendments?|ocp amendments?|land use applications?|planning applications?"
    r"|public hearings?|bylaw readings?|first readings?|third readings?|second and third readings?|reports?)$",
    re.I,
)


def is_generic_or_procedural_matter(title: str | None, category: str | None = None) -> bool:
    """Detect headings that should remain agenda items, not tracked matters."""
    # "COMMITTEE RESOLUTIONS — Application for a Development Variance Permit at 2585 Selwyn Road": the section the
    # item sat under, then the item itself. Judge the item, not its section.
    sectioned = re.match(r"^([A-Z][A-Z0-9 ,&'/().-]+?)\s+[—–]\s+(\S.*)$", (title or "").strip(), re.S)
    if sectioned and len(sectioned.group(2).strip()) >= 6:
        return is_generic_or_procedural_matter(sectioned.group(2), category)
    if re.search(r"\(block\)\s*$", title or "", re.I):
        return True  # an agenda block heading: its sub-items are the business
    clean = clean_matter_title(title).lower()
    clean = clean.rstrip(":")
    # The heading as written: cleaning strips "Adoption — Meaford Ave (1638)" down to a bare "zoning amendment".
    if SECTION_HEADING.match(re.sub(r"\s+", " ", (title or "")).strip().rstrip(":").strip()):
        return True
    if clean in GENERIC_MATTER_TITLES:
        return True
    if clean.startswith("reports - ") or clean.startswith("reports – "):
        return True
    if CONTAINER_TITLE.search(clean):
        return True  # bundles of unrelated topics (committee resolutions, minutes receipts, notices of motion)
    cat = (category or "").strip().lower()
    return cat in GENERIC_CATEGORY_KEYWORDS


def _contains_any(text: str, terms: set[str]) -> bool:
    return any(term in text for term in terms)


def detect_entity_cluster(text: str | None) -> str | None:
    """Find a strong known civic-entity cluster in text.

    Entity aliases alone are not enough; we require a subject/action term too
    so nearby references like "1000m from Westhills YMCA" do not attach.
    """
    if not text:
        return None
    lower = text.lower()
    for cluster_id, spec in ENTITY_CLUSTERS.items():
        if _contains_any(lower, spec["aliases"]) and _contains_any(
            lower, spec["subject_terms"]
        ):
            return cluster_id
    return None


def matter_aliases_for_cluster(cluster_id: str) -> list[str]:
    spec = ENTITY_CLUSTERS.get(cluster_id)
    if not spec:
        return []
    return sorted(spec["aliases"], key=lambda value: (len(value), value))


def is_matter_eligible(
    *,
    identifier: str | None,
    title: str | None,
    category: str | None = None,
    related_addresses: Optional[list[str]] = None,
    summary: str | None = None,
) -> tuple[bool, str]:
    """Decide whether an agenda item deserves a durable matter record."""
    if is_generic_or_procedural_matter(title, category):
        return False, "generic_or_procedural"

    if is_valid_matter_identifier(identifier):
        return True, "identifier"

    addresses = [a for a in related_addresses or [] if a]
    if addresses:
        return True, "address"

    text = " ".join(filter(None, [title, summary]))
    # Early policy instruments often have a subject/title before an identifier
    # or a qualifying word such as "bylaw". Require a qualified instrument in
    # the TITLE, not an incidental mention buried in a summary. Bare headings
    # such as "Draft Plan" / "Program Update" do not qualify.
    instrument = re.compile(r"\b(?:master plan|action plan|strategic plan|plans?|strateg(?:y|ies)|program(?:me)?s?|rates?|fee schedule|development cost charges?|guidelines|standards|business case)\b", re.I)
    candidate = clean_matter_title(title or "")
    if instrument.search(candidate):
        subject = instrument.sub(" ", candidate)
        subject = re.sub(r"\b(?:draft|proposed|adoption|adopt|consideration|final|interim|information|update|progress|report|presentation|presentations|review|proposals?|new|approx|minutes?|min|hours?|hr|phase|of|the|a|an|and|for|on|to|city|municipal|council)\b", " ", subject, flags=re.I)
        words = re.findall(r"[a-z]{3,}", subject.casefold())
        if words:
            return True, "qualified_policy_instrument"

    if detect_entity_cluster(text):
        return True, "entity_cluster"

    lower = clean_matter_title(text).lower()
    if _contains_any(lower, SUBSTANTIVE_TITLE_KEYWORDS) and len(lower.split()) >= 3:
        return True, "substantive_title"

    return False, "weak_title_only"


# --- MatterMatcher Class ---


def policy_identity(title: str | None) -> str | None:
    """Exact plan/strategy subject, with only presentation/decision stages removed.

    Procurement, implementation, amendments and other instruments are separate
    proceedings. Years and subject words remain identity, not fuzzy signals.
    """
    text = re.sub(r"\s*\(\s*(?:approx\.?\s*)?\d+\s*(?:minutes?|min|hours?|hrs?)\s*\)\s*$", "", title or "", flags=re.I).strip()
    text = re.sub(r"^(?:adoption|approval|consideration) of (?:the )?", "", text, flags=re.I)
    text = re.sub(r"^(?:draft|proposed|final)\s+", "", text, flags=re.I)
    text = re.sub(r"\s*(?:[-–—]\s*|\(\s*)?\b(?:adoption(?: consideration)?|approval)\)?\s*$", "", text, flags=re.I).strip()
    if not re.fullmatch(r"[\w &’'/-]+\b(?:plan|strategy)(?:\s+20\d{2})?", text, re.I):
        return None
    if re.search(r"\b(?:rfp|procurement|consultant|scope|contract|implementation|amendment|funding|budget|annual)\b", text, re.I):
        return None
    if not is_matter_eligible(identifier=None, title=text)[0]:
        return None
    return " ".join(re.findall(r"\w+", text.casefold().replace("&", " and ")))


def policy_candidates(matters, title, day):
    """Same exact policy subject and calendar year; unknown dates require review."""
    key = policy_identity(title)
    if not key:
        return []
    candidates = [m for m in matters if policy_identity(m.get("title")) == key
                  and not (m.get("meta") or {}).get("canonical_matter_id")
                  and (m.get("meta") or {}).get("hidden") != "container"]
    if not day:
        return candidates
    year = str(day)[:4]
    return [m for m in candidates if not m.get("first_seen") or not m.get("last_seen")
            or str(m["first_seen"])[:4] <= year <= str(m["last_seen"])[:4]]


def compatible_policy_scope(incoming, existing):
    """Weak signals cannot cross from a policy to its procurement/implementation."""
    return bool(policy_identity(incoming)) == bool(policy_identity(existing))


def _corroborated_subset(incoming: set[str], existing: set[str], title, addrs: set[str], matter: dict) -> bool:
    """A bylaw-set overlap counts only for small combined items about the same thing.

    Omnibus items (3+ bylaws) never match by overlap, and a parent bylaw cited
    alongside its amendment must be backed by a shared address or a similar title.
    """
    if not existing or not (incoming <= existing or existing <= incoming):
        return False
    if max(len(incoming), len(existing)) > 2:
        return False
    if addrs and addrs & matter.get("_addresses", set()):
        return True
    a, b = strip_stage(title).lower(), strip_stage(matter.get("title")).lower()
    if a and b and difflib.SequenceMatcher(None, a, b).ratio() >= 0.55:
        return True
    return _same_street(title, matter.get("title"))


_STREET_SUFFIX = r"(?:Road|Rd|Avenue|Ave|Street|St|Drive|Dr|Way|Place|Pl|Crescent|Cres|Court|Ct|Lane|Ln|Parkway|Pkwy|Terrace|Trail|Boulevard|Blvd|Close|Hwy|Highway)\b"


def _street_names(text: str | None) -> set[str]:
    """"3690 & 3694 Happy Valley Rd" / "Happy Valley Rd rezoning" -> {"happy valley"}."""
    names = set()
    for m in re.finditer(r"((?:[A-Z][a-z]+\s){1,3})" + _STREET_SUFFIX, text or ""):
        names.add(m.group(1).strip().lower())
    return names


def _same_street(a: str | None, b: str | None) -> bool:
    return bool(_street_names(a) & _street_names(b))


class MatterMatcher:
    """Matches incoming agenda items to existing matters using multi-signal logic.

    Loaded once per ingestion session with all matters cached in memory.
    """

    def __init__(self, supabase_client, municipality_id=None):
        self.supabase = supabase_client
        self.municipality_id = municipality_id or 1
        self.matters = []
        self.identifier_index = defaultdict(list)  # normalized_id -> [matter]
        self.address_index = defaultdict(list)  # normalized_addr -> [matter]
        self.entity_cluster_index = defaultdict(list)  # cluster_id -> [matter]
        self._loaded = False

    def load(self):
        """Load all matters and build indices."""
        print("  [MatterMatcher] Loading all matters...")
        # Never match into a heading or a page staff removed: a section-heading topic attracted unrelated
        # applications by title alone.
        self.matters = [m for m in self._fetch_all_matters()
                        if (m.get("meta") or {}).get("hidden") not in ("container", "staff")
                        and not is_generic_or_procedural_matter(m.get("title"))]
        self._build_identifier_index()
        self._build_address_index()
        self._build_entity_cluster_index()
        self._loaded = True
        print(
            f"  [MatterMatcher] Loaded {len(self.matters)} matters, "
            f"{len(self.identifier_index)} unique identifiers, "
            f"{len(self.address_index)} unique addresses."
        )

    def _fetch_all_matters(self) -> list[dict]:
        """Fetch all matters for this municipality with pagination."""
        all_data = []
        page = 0
        page_size = 1000
        while True:
            res = (
                self.supabase.table("matters")
                .select("id, title, identifier, status, category, meta, first_seen, last_seen, plain_english_summary")
                .eq("municipality_id", self.municipality_id)
                .range(page * page_size, (page + 1) * page_size - 1)
                .execute()
            )
            if not res.data:
                break
            all_data.extend(res.data)
            if len(res.data) < page_size:
                break
            page += 1

        # Also fetch addresses from agenda_items
        addr_data = []
        page = 0
        while True:
            res = (
                self.supabase.table("agenda_items")
                .select("matter_id, related_address")
                .range(page * page_size, (page + 1) * page_size - 1)
                .execute()
            )
            if not res.data:
                break
            addr_data.extend(res.data)
            if len(res.data) < page_size:
                break
            page += 1

        # Attach addresses to matters
        matter_addrs = defaultdict(set)
        for row in addr_data:
            mid = row.get("matter_id")
            addrs = row.get("related_address")
            if not mid or not addrs:
                continue
            if isinstance(addrs, str) and addrs.lstrip().startswith("["):
                # related_address is stored as JSON text
                try:
                    addrs = json.loads(addrs)
                except ValueError:
                    pass
            if isinstance(addrs, list):
                for a in addrs:
                    if a:
                        matter_addrs[mid].add(normalize_address(a))
            elif isinstance(addrs, str):
                matter_addrs[mid].add(normalize_address(addrs))

        for m in all_data:
            m["_addresses"] = matter_addrs.get(m["id"], set())

        # Merged source IDs remain valid history, but must not win future matches.
        return [m for m in all_data if not (m.get("meta") or {}).get("canonical_matter_id")]

    def _build_identifier_index(self):
        """Build an index from normalized sub-identifiers to matters."""
        self.identifier_index.clear()
        for m in self.matters:
            parts = matter_identifiers(m)
            for part in parts:
                self.identifier_index[part.lower()].append(m)

    def _build_address_index(self):
        """Build an index from normalized addresses to matters."""
        self.address_index.clear()
        for m in self.matters:
            for addr in m.get("_addresses", set()):
                if addr:
                    self.address_index[addr].append(m)

    def _matter_entity_clusters(self, matter: dict) -> set[str]:
        """Return known entity clusters attached to or inferable from a matter."""
        clusters = set()
        meta = matter.get("meta") or {}
        if isinstance(meta, dict):
            cluster = meta.get("entity_cluster")
            if cluster:
                clusters.add(cluster)
            for cluster in meta.get("entity_clusters") or []:
                if cluster:
                    clusters.add(cluster)
            alias_text = " ".join(str(a) for a in meta.get("aliases") or [])
            detected = detect_entity_cluster(alias_text)
            if detected:
                clusters.add(detected)

        detected = detect_entity_cluster(matter.get("title") or "")
        if detected:
            clusters.add(detected)
        return clusters

    def _build_entity_cluster_index(self):
        """Build an index from known civic entity clusters to matters."""
        self.entity_cluster_index.clear()
        for m in self.matters:
            for cluster in self._matter_entity_clusters(m):
                self.entity_cluster_index[cluster].append(m)

    def _add_matter_to_indices(self, matter: dict):
        """Add a newly created matter to the in-memory indices."""
        self.matters.append(matter)
        for part in matter_identifiers(matter):
            self.identifier_index[part.lower()].append(matter)
        for addr in matter.get("_addresses", set()):
            if addr:
                self.address_index[addr].append(matter)
        for cluster in self._matter_entity_clusters(matter):
            self.entity_cluster_index[cluster].append(matter)

    def find_match(
        self,
        identifier: Optional[str],
        title: Optional[str],
        related_addresses: Optional[list[str]] = None,
        *, meeting_date: str | None = None,
    ) -> tuple[Optional[int], str, float]:
        """Find a matching matter using multi-signal matching.

        Returns: (matter_id, reason, confidence) or (None, reason, 0.0)
        """
        if not self._loaded:
            self.load()

        normalized_addrs = set()
        if related_addresses:
            normalized_addrs = {normalize_address(a) for a in related_addresses if a}

        # Also extract addresses from the title
        if title:
            title_addrs = extract_addresses(title)
            normalized_addrs.update(title_addrs)

        identifier = identifying_identifier(identifier)
        # Explicit title bylaw numbers also identify title-only source records.
        if not identifier and title and not re.search(r"\b(vary|variance|contravention|enforcement)\b", title, re.I):
            identifier = "; ".join(sorted(identifying(bylaw_identifiers(title)))) or None

        # --- Stage 1: Identifier matching ---
        if identifier:
            match = self._match_by_identifier(identifier, title, normalized_addrs)
            if match:
                return match
            if any(part.startswith("Bylaw ") for part in parse_compound_identifier(identifier)):
                # A rejected bylaw identity/scope must not be overridden by a
                # similar title or nearby address at a weaker matching stage.
                return None, "no_match", 0.0

        # Plans have stable subjects but stage titles differ substantially.
        # Do not let a fuzzy/AI fallback merge procurement or choose the first
        # of multiple same-subject proceedings. Other years remain separate.
        if not is_valid_matter_identifier(identifier) and policy_identity(title):
            candidates = policy_candidates(self.matters, title, meeting_date)
            if not candidates:
                if policy_candidates(self.matters, title, None):
                    return None, "policy_review", 0.0  # New edition or cross-year continuation is uncertain.
                return None, "policy_new", 0.0
            if len(candidates) != 1 or not meeting_date:
                return None, "policy_review", 0.0
            candidate = candidates[0]
            if not candidate.get("first_seen") or not candidate.get("last_seen") or is_valid_matter_identifier(candidate.get("identifier")):
                return None, "policy_review", 0.0
            return candidate["id"], "policy_exact_subject_and_year", 1.0

        # --- Stage 2: Address + category matching ---
        if normalized_addrs and title:
            match = self._match_by_address_and_category(title, normalized_addrs)
            if match:
                return match

        # --- Stage 3: Known entity cluster matching ---
        if title:
            match = self._match_by_entity_cluster(title, normalized_addrs)
            if match:
                return match

        # --- Stage 4: Title similarity matching ---
        # Fallback when identifier and address matching both fail.
        # Uses high threshold to avoid false positives.
        if title:
            match = self._match_by_title_similarity(title)
            if match:
                return match

        # No match found
        return None, "no_match", 0.0

    def _match_by_identifier(
        self,
        identifier: str,
        title: Optional[str],
        normalized_addrs: set[str],
    ) -> Optional[tuple[int, str, float]]:
        """Try to match by parsing and looking up identifier parts."""
        parts = [p for p in parse_compound_identifier(identifier) if not is_city_wide(p)]
        if not parts:
            return None

        # Collect all candidate matters from all sub-identifiers
        candidates = {}  # matter_id -> matter
        for part in parts:
            key = part.lower()
            for m in self.identifier_index.get(key, []):
                candidates[m["id"]] = m

        incoming_bylaws = {p for p in parts if p.startswith("Bylaw ")}
        if incoming_bylaws:
            filtered = {}
            for mid, matter in candidates.items():
                existing = {p for p in matter_identifiers(matter) if p.startswith("Bylaw ")}
                if existing == incoming_bylaws:
                    filtered[mid] = matter
                elif _corroborated_subset(incoming_bylaws, existing, title, normalized_addrs, matter):
                    # e.g. "Bylaw 1694; Bylaw 1703" (rezoning + OCP for one site) vs "Bylaw 1694"
                    filtered[mid] = matter
            exact = {
                mid: m for mid, m in filtered.items()
                if {p for p in matter_identifiers(m) if p.startswith("Bylaw ")} == incoming_bylaws
            }
            candidates = exact if len(exact) == 1 else filtered
        if not candidates:
            return None

        if len(candidates) == 1:
            matter = list(candidates.values())[0]
            # A permit may cite the same parent bylaw as a different property.
            if re.search(r"\b(vary|variance|contravention|enforcement)\b", (title or "") + " " + (matter.get("title") or ""), re.I):
                if normalized_addrs and matter.get("_addresses") and not normalized_addrs.intersection(matter["_addresses"]):
                    return None
                if not normalized_addrs.intersection(matter.get("_addresses", set())) and (title or "").casefold() != (matter.get("title") or "").casefold():
                    return None
            return matter["id"], f"identifier_exact:{parts[0]}", 1.0

        # Multiple candidates — disambiguation needed
        # Check if the incoming identifier has multiple sub-parts that narrow things down
        # e.g., "Bylaw 1160; REZ 2025-01" — a matter matching BOTH is a strong match
        best_match = None
        best_overlap = 0
        for m in candidates.values():
            m_parts = set(
                p.lower() for p in identifying(parse_compound_identifier(m.get("identifier", "")))
            )
            incoming_parts = set(p.lower() for p in parts)
            overlap = len(m_parts & incoming_parts)
            if overlap > best_overlap:
                best_overlap = overlap
                best_match = m

        # If one candidate has significantly more sub-identifier overlap, use it
        if best_match and best_overlap >= 2:
            return best_match["id"], f"identifier_multi_overlap:{best_overlap}", 0.98

        # Disambiguate with address
        if normalized_addrs:
            addr_matches = []
            for m in candidates.values():
                m_addrs = m.get("_addresses", set())
                if m_addrs & normalized_addrs:
                    addr_matches.append(m)

            if len(addr_matches) == 1:
                return (
                    addr_matches[0]["id"],
                    "identifier_ambiguous_resolved_by_address",
                    0.95,
                )

        # Disambiguate with title similarity
        if title:
            best_sim = 0.0
            best_title_match = None
            for m in candidates.values():
                sim = difflib.SequenceMatcher(
                    None, title.lower(), (m.get("title") or "").lower()
                ).ratio()
                if sim > best_sim:
                    best_sim = sim
                    best_title_match = m

            if best_title_match and best_sim > 0.7:
                return (
                    best_title_match["id"],
                    f"identifier_ambiguous_resolved_by_title:{best_sim:.2f}",
                    0.90,
                )

        # Still ambiguous — don't match (safer to create a new matter)
        return None

    def _match_by_entity_cluster(
        self,
        title: str,
        normalized_addrs: set[str] | None = None,
    ) -> Optional[tuple[int, str, float]]:
        cluster = detect_entity_cluster(title)
        if not cluster:
            return None

        # A street-level cluster ("Langford Parkway") holds many properties: an item at a street address joins only
        # a topic at that same address; one elsewhere on the street (or with no address) is a different application.
        numbered = lambda addrs: {a for a in addrs if a and a[0].isdigit()}  # a bare street name places nothing
        # Recorded addresses keep unit numbers ("136-1047"); title extraction drops them, so it is only the fallback.
        incoming_addrs = numbered(set(normalized_addrs or ())) or numbered(set(extract_addresses(title)))
        candidates = [m for m in self.entity_cluster_index.get(cluster, [])
                      if compatible_policy_scope(title, m.get("title"))
                      and (not incoming_addrs
                           or incoming_addrs & (numbered(set(m.get("_addresses") or ()))
                                                or numbered(set(extract_addresses(m.get("title") or "")))))]
        if not candidates:
            return None

        # Prefer canonical matters explicitly marked in metadata.
        canonical = []
        for m in candidates:
            meta = m.get("meta") or {}
            if isinstance(meta, dict) and meta.get("matter_quality") == "canonical":
                canonical.append(m)

        if len(canonical) == 1:
            return canonical[0]["id"], f"entity_cluster:{cluster}", 0.92

        unique = {m["id"]: m for m in candidates}
        if len(unique) == 1:
            m = next(iter(unique.values()))
            return m["id"], f"entity_cluster:{cluster}", 0.88

        # Multiple non-canonical candidates: choose closest title, but require
        # modest similarity because the shared cluster is already strong.
        best_match = None
        best_sim = 0.0
        for m in unique.values():
            sim = difflib.SequenceMatcher(
                None, title.lower(), (m.get("title") or "").lower()
            ).ratio()
            if sim > best_sim:
                best_sim = sim
                best_match = m

        if best_match and best_sim >= 0.45:
            return (
                best_match["id"],
                f"entity_cluster_title:{cluster}:{best_sim:.2f}",
                0.82,
            )

        return None

    def _match_by_address_and_category(
        self,
        title: str,
        normalized_addrs: set[str],
    ) -> Optional[tuple[int, str, float]]:
        """Match by shared address + title category keyword overlap."""
        incoming_categories = _extract_category_keywords(title)
        if not incoming_categories:
            return None

        candidates = []
        for addr in normalized_addrs:
            for m in self.address_index.get(addr, []):
                if not compatible_policy_scope(title, m.get("title")):
                    continue
                m_categories = _extract_category_keywords(m.get("title") or "")
                if m_categories & incoming_categories:
                    candidates.append(m)

        if not candidates:
            return None

        # Deduplicate
        seen_ids = set()
        unique_candidates = []
        for m in candidates:
            if m["id"] not in seen_ids:
                seen_ids.add(m["id"])
                unique_candidates.append(m)

        if len(unique_candidates) == 1:
            m = unique_candidates[0]
            # Safety: check number mismatch
            if check_number_mismatch(title, m.get("title") or ""):
                return None
            return m["id"], "address_category_match", 0.85

        # Multiple candidates — use title similarity to pick the best
        best_sim = 0.0
        best_match = None
        for m in unique_candidates:
            if check_number_mismatch(title, m.get("title") or ""):
                continue
            sim = difflib.SequenceMatcher(
                None, title.lower(), (m.get("title") or "").lower()
            ).ratio()
            if sim > best_sim:
                best_sim = sim
                best_match = m

        if best_match and best_sim > 0.6:
            return (
                best_match["id"],
                f"address_category_title:{best_sim:.2f}",
                0.85,
            )

        return None

    def _match_by_title_similarity(
        self,
        title: str,
    ) -> Optional[tuple[int, str, float]]:
        """Match by title similarity alone (high threshold to avoid false positives).

        Only matches when titles are very similar (>= 0.75 SequenceMatcher ratio)
        and there's no conflicting number mismatch.
        """
        if not title or len(title) < 10:
            return None

        best_sim = 0.0
        best_match = None
        title_lower = strip_stage(title).lower()

        for m in self.matters:
            if not compatible_policy_scope(title, m.get("title")):
                continue  # Procurement/implementation is not the plan itself.
            m_title = strip_stage(m.get("title")).lower()
            if not m_title or len(m_title) < 10:
                continue

            sim = difflib.SequenceMatcher(None, title_lower, m_title).ratio()
            if sim > best_sim:
                # Safety: reject if numbers conflict (e.g. "Bylaw 1160" vs "Bylaw 1161"), or if each names
                # something the other doesn't (a different event, street or applicant).
                if check_number_mismatch(title, m.get("title") or "") or names_differ(strip_stage(title), strip_stage(m.get("title"))):
                    continue
                best_sim = sim
                best_match = m

        if best_match and best_sim >= 0.75:
            return (
                best_match["id"],
                f"title_similarity:{best_sim:.2f}",
                best_sim,
            )

        return None
