"""Reconcile missed agenda ownership without fuzzy merges or new matters.

The same title on a different year's recurring item is not proof of identity.
Only a unique, substantive title inside the matter's existing dated interval is
eligible for automatic repair. Other plausible matches remain review findings.
"""
from collections import defaultdict
import re

from .matter_matching import bylaw_identifiers, identifying, is_matter_eligible, matter_identifiers, policy_identity, policy_candidates, is_valid_matter_identifier
from .staff_fixes import staff_matter


def _pages(build):
    rows, start = [], 0
    while True:
        chunk = build().range(start, start + 499).execute().data or []
        rows.extend(chunk)
        if len(chunk) < 500:
            return rows
        start += 500


def _title(value):
    # Agenda time estimates do not change identity. Keep years, bylaw numbers,
    # application references and reading stages: do not normalize those away.
    value = re.sub(r"\s*\(\s*(?:approx\.?\s*)?\d+\s*(?:min(?:ute)?s?)\s*\)\s*$", "", value or "", flags=re.I)
    return " ".join(value.casefold().split())


def plan_history(matters, items, *, focus_ids=None, review_meeting_ids=None):
    titles = defaultdict(list)
    for matter in matters:
        if not matter.get("canonical_matter_id") and matter.get("hidden") != "container":
            titles[(matter["municipality_id"], _title(matter["title"]))].append(matter)
    assignments, review, unmatched = [], [], []
    missing_policies = defaultdict(list)
    for item in items:
        if item.get("matter_id") is not None:
            continue
        meeting = item.get("meetings") or {}
        city, day = meeting.get("municipality_id"), str(meeting.get("meeting_date") or "")[:10]
        eligible, _ = is_matter_eligible(identifier=None, title=item.get("title"), category=item.get("category"), summary=item.get("plain_english_summary"))
        if not eligible:
            continue
        exact = titles.get((city, _title(item.get("title"))), [])
        policy_key = policy_identity(item.get("title"))
        policy_match = False
        if policy_key:
            exact = policy_candidates([m for m in matters if m["municipality_id"] == city
                                       and not m.get("canonical_matter_id") and m.get("hidden") != "container"], item["title"], day)
            policy_match = bool(exact)
            if not exact:
                previous = policy_candidates([m for m in matters if m["municipality_id"] == city
                                              and not m.get("canonical_matter_id") and m.get("hidden") != "container"], item["title"], None)
                if previous:
                    review.append({"agenda_item_id": item["id"], "meeting_id": item["meeting_id"],
                                   "meeting_date": day, "title": item["title"],
                                   "candidate_matter_ids": [m["id"] for m in previous],
                                   "reason": "policy_other_year_requires_review"})
                    continue
            if not exact and (review_meeting_ids is None or item["meeting_id"] in review_meeting_ids):
                missing_policies[(city, day[:4], policy_key)].append(item["id"])
        # Ambiguity is assessed against ALL canonical matters in this city,
        # before focus filtering, so a targeted run cannot make a tie disappear.
        candidates = [m for m in exact if focus_ids is None or m["id"] in focus_ids]
        if not candidates:
            unmatched.append({"agenda_item_id": item["id"], "meeting_id": item["meeting_id"], "meeting_date": day, "title": item["title"], "reason": "no_exact_candidate_in_scope"})
            continue
        candidate = candidates[0]
        in_interval = bool(day and candidate.get("first_seen") and candidate.get("last_seen")
                           and str(candidate["first_seen"])[:10] <= day <= str(candidate["last_seen"])[:10])
        item_bylaws = identifying(bylaw_identifiers(item.get("title")))
        identifiers = matter_identifiers(candidate)
        target_bylaws = {key for key in identifiers if key.startswith("Bylaw ")}
        safe = len(exact) == 1 and in_interval and item_bylaws == target_bylaws and identifiers == target_bylaws
        if policy_match:
            safe = len(exact) == 1 and in_interval and not is_valid_matter_identifier(candidate.get("identifier"))
        finding = {"agenda_item_id": item["id"], "meeting_id": item["meeting_id"], "meeting_date": day,
                   "title": item["title"], "candidate_matter_ids": [m["id"] for m in candidates]}
        if safe:
            assignments.append({**finding, "matter_id": candidate["id"], "reason": "unique_policy_subject_within_existing_dates" if policy_match else "unique_exact_title_within_existing_dates"})
        else:
            review.append({**finding, "reason": "ambiguous_title" if len(exact) != 1 else "policy_date_or_identifier_requires_review" if policy_match else "date_or_identifier_requires_review"})
    new_proceedings = [{"municipality_id": city, "year": year, "policy_subject": key,
                        "agenda_item_ids": sorted(ids), "reason": "no_existing_policy_proceeding"}
                       for (city, year, key), ids in sorted(missing_policies.items())]
    return {"assignments": assignments, "review": review, "unmatched_eligible": len(unmatched), "unmatched": unmatched,
            "new_proceedings": new_proceedings}


def review_missing_decisions(supabase, meeting_ids):
    """Flag adoption items lacking an outcome, without inventing a decision.

    An adoption heading is an expectation to inspect original minutes, never
    proof of adoption. Existing unknown motion results remain unknown.
    """
    if not meeting_ids:
        return []
    items = _pages(lambda: supabase.table("agenda_items").select("id,meeting_id,title,matter_id")
                   .in_("meeting_id", meeting_ids).order("id"))
    motions = _pages(lambda: supabase.table("motions").select("id,agenda_item_id,result")
                     .in_("meeting_id", meeting_ids).order("id"))
    by_item = defaultdict(list)
    for motion in motions:
        by_item[motion["agenda_item_id"]].append(motion)
    return [{"agenda_item_id": item["id"], "meeting_id": item["meeting_id"],
             "matter_id": item.get("matter_id"), "title": item["title"],
             "motion_ids": [m["id"] for m in by_item[item["id"]]],
             "reason": "adoption_item_without_recorded_outcome"}
            for item in items if re.search(r"\badoption\b", item.get("title") or "", re.I)
            and is_matter_eligible(identifier=None, title=item["title"])[0]
            and not any(m.get("result") for m in by_item[item["id"]])]


def reconcile_history(supabase, *, municipality_ids=None, focus_ids=None, meeting_ids=None,
                      review_meeting_ids=None, since=None, dry_run=True):
    """A dry run reads only; apply uses a still-unassigned ownership guard.

    Focus includes existing one-hop same-initiative neighbours, not recursively
    related topics. No matter is merged and no existing item owner is replaced.
    """
    if focus_ids is not None and not focus_ids:
        if not meeting_ids:
            return {"assignments": [], "review": [], "unmatched_eligible": 0, "unmatched": [], "new_proceedings": [], "applied": [], "dry_run": dry_run}
        # An import with no tracked matter still needs a missing-proceeding
        # review, scoped strictly to its meetings rather than all city history.
        focus_ids = None
    matters = _pages(lambda: supabase.table("matters")
                    .select("id, municipality_id, title, identifier, first_seen, last_seen, canonical_matter_id:meta->>canonical_matter_id, hidden:meta->>hidden")
                    .order("id"))
    if focus_ids is not None:
        focus = set(focus_ids)
        links = _pages(lambda: supabase.table("matter_links").select("matter_id,related_matter_id")
                       .eq("kind", "related_matter").eq("hidden", False).order("id"))
        original = set(focus)
        for link in links:
            if link["matter_id"] in original or link["related_matter_id"] in original:
                focus.update((link["matter_id"], link["related_matter_id"]))
        cities = {m["municipality_id"] for m in matters if m["id"] in original}
    else:
        focus = None
        cities = set(municipality_ids or [m["municipality_id"] for m in matters])
    if municipality_ids is not None:
        cities &= set(municipality_ids)
    matters = [m for m in matters if m["municipality_id"] in cities]
    items = []
    for city in sorted(cities):
        def build():
            q = supabase.table("agenda_items").select("id,meeting_id,matter_id,title,category,plain_english_summary,meta,meetings!inner(municipality_id,meeting_date)") \
                .is_("matter_id", "null").eq("meetings.municipality_id", city).order("id")
            if meeting_ids is not None:
                q = q.in_("meeting_id", meeting_ids)
            return q.gte("meetings.meeting_date", since) if since else q
        # An item staff took off a topic stays unfiled (agenda_items.meta.staff_matter).
        items.extend(i for i in _pages(build) if not staff_matter(i.get("meta")))
    plan = plan_history(matters, items, focus_ids=focus, review_meeting_ids=review_meeting_ids)
    applied = []
    if not dry_run:
        for assignment in plan["assignments"]:
            result = supabase.table("agenda_items").update({"matter_id": assignment["matter_id"]}) \
                .eq("id", assignment["agenda_item_id"]).eq("title", assignment["title"]) \
                .eq("meeting_id", assignment["meeting_id"]).is_("matter_id", "null").execute()
            if result.data:
                applied.append(assignment)
    return {**plan, "applied": applied, "dry_run": dry_run}
