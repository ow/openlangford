"""Experiment: ask the main linking question about the topic's story instead of about the name.

Re-judges a sample with the Decisions API (Luna), writing nothing:
  - published name links (the old question accepted them)
  - candidates the old question turned down (found by name today, not linked)
Old question: matter_names' "role" choice (about + mentioned >= 0.85 links).
New question: one predicate, "is this item part of THIS topic's story?", with the topic's timeline as context.
Disagreements at the 0.85 bar get a third opinion from Terra (stage "review"), with a reason.

Run from apps/pipeline:  uv run python ../../research/linking-question/experiment.py [n_each]
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from pipeline import ai
from pipeline.db import connect
from pipeline.ingestion import matter_names as mn

OUT = Path(__file__).parent
N = int(sys.argv[1]) if len(sys.argv) > 1 else 200
BAR = 0.85
random.seed(20261102)


def old_question(m: dict, name: str) -> dict:
    return ai.choice(
        "role",
        f"This matter is about \"{name}\": {mn._describe(m)}. How does this agenda item involve \"{name}\"?",
        [("about", f"It does something about \"{name}\" itself: decides, budgets or spends money on it, reports on it, "
                   f"or carries public comment about it."),
         ("mentioned", f"It is about something else, but someone refers to \"{name}\" or what happened to it in a way a "
                       f"reader following its story would want to see (an example, a comparison, a criticism)."),
         ("passing", f"\"{name}\" is only a location, a venue, or one of a list of places, or the name means something else.")],
    )


def new_question(m: dict, timeline: str) -> dict:
    return ai.predicate(
        "part_of_story",
        f"Topic: {mn._describe(m)}\nAlready on its timeline:\n{timeline}\n\nIs this agenda item part of THIS topic's "
        f"story (a decision, hearing, notice, report or public comment about this very thing), or does it refer to it in "
        f"a way someone following the topic would want to see? Another business or unit at the same address, a different "
        f"application or project with a similar name, or one line in a long list is not.")


def item_text(c: dict) -> str:
    where = mn.WHERE.get(c.get("where") or "item", "in the item's own text")
    return f"AGENDA ITEM ({c['date']}): {(c['title'] or '').splitlines()[0][:160]}\nFound {where}: {c['excerpt']}"


class Third(BaseModel):
    verdict: Literal["belongs", "mentioned", "unrelated"]
    reason: str


def main():
    conn = connect()
    conn.set_session(readonly=True)
    cur = conn.cursor()
    matters = {m["id"]: m for m in mn.load_matters(cur)}

    # 1. Published name links, with the passage that was judged.
    cur.execute("""select l.matter_id, a.id, mt.meeting_date, a.title, l.quote from matter_links l
                   join agenda_items a on a.id = l.agenda_item_id join meetings mt on mt.id = a.meeting_id
                   where l.kind = 'mention' and l.source in ('name', 'name_mention') and not l.hidden and l.review is null
                     and l.quote is not null order by random() limit %s""", (N,))
    accepted = [{"group": "accepted", "matter_id": mid, "id": iid, "date": str(d), "title": t, "excerpt": q}
                for mid, iid, d, t, q in cur.fetchall() if mid in matters]

    # 2. Candidates the old question turned down: found by name, not linked.
    existing = mn.existing_links(cur)
    named = [m for m in matters.values() if m["meta"].get("anchor_names")]
    random.shuffle(named)
    rejected, seen = [], set()
    for m in named:
        for name in m["meta"]["anchor_names"][:2]:
            hits = mn.find_hits(cur, name)
            if len(hits["items"]) > mn.MAX_ITEMS_PER_NAME:
                continue
            for it in hits["items"]:
                key = (m["id"], it["id"])
                if it["matter_id"] == m["id"] or key in existing["mentions"] or key in seen:
                    continue
                seen.add(key)
                # The item's own matter_id (what it's filed under) must not replace the topic being tested.
                rejected.append({**it, "filed_under": it["matter_id"], "group": "turned_down", "matter_id": m["id"], "name": name})
        if len(rejected) >= N * 3:
            break
    rejected = random.sample(rejected, min(N, len(rejected)))

    sample = accepted + rejected
    names = {m_id: (matters[m_id]["meta"].get("anchor_names") or [matters[m_id]["title"]])[0] for m_id in {s["matter_id"] for s in sample}}
    timelines = {m_id: mn._timeline(cur, m_id) for m_id in names}
    conn.rollback()
    print(f"sample: {len(accepted)} accepted, {len(rejected)} turned down, {len(names)} topics", flush=True)

    old = ai.decide_many([(item_text(s), [old_question(matters[s["matter_id"]], s.get("name") or names[s["matter_id"]])]) for s in sample])
    new = ai.decide_many([(item_text(s), [new_question(matters[s["matter_id"]], timelines[s["matter_id"]])]) for s in sample])
    for s, o, n in zip(sample, old, new):
        oa = next(iter(o.values()), None) if not isinstance(o, Exception) else None
        probs = {c.value: c.probability or 0 for c in oa.probabilities} if oa is not None and getattr(oa, "type", None) == "choice" else {}
        s["old"] = round(probs.get("about", 0) + probs.get("mentioned", 0), 3) if probs else None
        na = next(iter(n.values()), None) if not isinstance(n, Exception) else None
        s["new"] = round(float(getattr(na, "probability", 0) or 0), 3) if na is not None else None

    judged = [s for s in sample if s["old"] is not None and s["new"] is not None]
    disagree = [s for s in judged if (s["old"] >= BAR) != (s["new"] >= BAR)]
    print(f"judged {len(judged)}; disagreements at {BAR}: {len(disagree)}", flush=True)
    for s in disagree:
        m = matters[s["matter_id"]]
        t = ai.json(f"""You help an editor of Open Langford, a site that follows Langford City council. Is this agenda item part of
the topic's story, does it mention the topic in a way a reader following it would want to see, or is it unrelated (a
different business, unit, application or project that shares a name)? Give one plain sentence of reason.

TOPIC: {mn._describe(m)}
Already on its timeline:
{timelines[s['matter_id']]}

{item_text(s)}""", stage="review", schema=Third)
        s["terra"], s["terra_reason"] = t.verdict, t.reason
        s["topic"] = m["title"]

    (OUT / "results.json").write_text(json.dumps(sample, default=str, indent=1))
    print(json.dumps({
        "accepted": {"n": sum(s["group"] == "accepted" for s in judged),
                     "new_keeps": sum(s["group"] == "accepted" and s["new"] >= BAR for s in judged)},
        "turned_down": {"n": sum(s["group"] == "turned_down" for s in judged),
                        "new_accepts": sum(s["group"] == "turned_down" and s["new"] >= BAR for s in judged)},
        "disagreements": len(disagree),
        "terra_sides_with_new": sum((s["terra"] != "unrelated") == (s["new"] >= BAR) for s in disagree),
    }, indent=1))


if __name__ == "__main__":
    main()
