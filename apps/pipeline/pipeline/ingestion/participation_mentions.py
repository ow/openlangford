"""Public comment on a topic's timeline: only the speakers who spoke about it.

A public-participation item (or a hearing, or correspondence) carries many speakers on many subjects. Linked to a
topic as a whole, the topic page showed every speaker who happened to share a word with it (page checks,
2026-11-02: a waste-collection topic showed comments on parking minimums and the YMCA). Each such link is judged
once, speaker by speaker (Decisions API): the speakers about the topic are recorded on the item
(``meta.participation.about_matters[topic id]`` = speaker positions) for the page to show, and a link with no
speaker about the topic is hidden when the item is only public comment. Annual-report and financial-statement
passages that only name a facility or organization while reporting on something else are hidden too.
"""
from __future__ import annotations

import json
import re
from typing import Any

from pipeline import ai

SPEAKER_MIN_PROBABILITY = 0.5
EXCERPT_UNRELATED_PROBABILITY = 0.7
COMMENT_ONLY = re.compile(r"(?i)\b(public participation|public input|delegations?|petitions?|correspondence|letters?|"
                          r"written submissions?|public comments?|question period)\b")
REPORT_ITEM = re.compile(r"(?i)\bannual report\b|\bfinancial (?:statements?|information)\b|\baudited\b")


def comment_only(title: str | None) -> bool:
    """An item that is only public comment: with no speaker about the topic, nothing on it is."""
    return bool(COMMENT_ONLY.search((title or "").split("\n")[0]))


def speaker_questions(topic: str, summary: str, speakers: list[dict]) -> list[dict]:
    return [ai.predicate(f"s{i}", f"Is speaker {i}'s comment about this council topic: \"{topic}\" — {summary[:300]}? "
                                  f"Yes only when the comment is about this specific topic (its property, project, bylaw or "
                                  f"decision). A comment on another subject that shares a word, a street or a broad theme "
                                  f"(housing, parking, taxes) is not.")
            for i in range(len(speakers))]


def speakers_text(speakers: list[dict]) -> str:
    return "\n".join(f"Speaker {i}: {s.get('who') or 'A resident'} — topic: {s.get('topic') or ''} — {s.get('point') or ''}"
                     for i, s in enumerate(speakers))


def pending(cur, link_ids: list[int] | None = None) -> list[dict]:
    """Mention links whose item carries speakers and hasn't been judged for that topic."""
    cur.execute("""select l.id, l.matter_id, l.quote, l.review, a.id, a.title, a.meta->'participation'->'speakers',
                          coalesce(m.meta->>'display_title', m.title), coalesce(m.plain_english_summary, '')
                   from matter_links l join agenda_items a on a.id = l.agenda_item_id join matters m on m.id = l.matter_id
                   where l.kind = 'mention' and not l.hidden and a.matter_id is distinct from l.matter_id
                     and jsonb_typeof(a.meta->'participation'->'speakers') = 'array'
                     and jsonb_array_length(a.meta->'participation'->'speakers') > 0
                     and not coalesce(a.meta->'participation'->'about_matters', '{}'::jsonb) ? l.matter_id::text
                     and (%(ids)s::bigint[] is null or l.id = any(%(ids)s))""", {"ids": link_ids})
    return [{"link": r[0], "matter": r[1], "quote": r[2], "review": r[3], "item": r[4], "title": r[5], "speakers": r[6] or [],
             "topic": r[7], "summary": r[8]} for r in cur.fetchall()]


def judge(links: list[dict]) -> dict[int, list[int] | None]:
    """Link id -> positions of the speakers about its topic (None when unanswered)."""
    jobs = [(f"PUBLIC COMMENT at an agenda item \"{(l['title'] or '').splitlines()[0][:160]}\":\n{speakers_text(l['speakers'])}",
             speaker_questions(l["topic"], l["summary"], l["speakers"])) for l in links]
    out: dict[int, list[int] | None] = {}
    for start in range(0, len(jobs), 100):
        for l, res in zip(links[start:start + 100], ai.decide_many(jobs[start:start + 100])):
            if isinstance(res, Exception):
                out[l["link"]] = None
                continue
            out[l["link"]] = sorted(int(name[1:]) for name, ans in res.items()
                                    if (getattr(ans, "probability", 0) or 0) >= SPEAKER_MIN_PROBABILITY)
        print(f"  [Comment] judged {min(start + 100, len(jobs))}/{len(jobs)}", flush=True)
    return out


def to_hide(link: dict, about: list[int] | None) -> bool:
    """No speaker about the topic, on an item that is only public comment (or found with no passage of its own).
    Staff-accepted links stay."""
    return about == [] and link.get("review") != "accepted" and (comment_only(link["title"]) or not link.get("quote"))


def excerpt_pending(cur) -> list[dict]:
    """Annual-report pages, and agenda items that are annual reports or financial statements, on topic timelines."""
    cur.execute("""select 'page', p.id, p.matter_id, p.quote, r.year::text, coalesce(m.meta->>'display_title', m.title),
                          coalesce(m.plain_english_summary, ''), p.review
                   from matter_report_mentions p join public_reports r on r.id = p.report_id join matters m on m.id = p.matter_id
                   where not p.hidden and p.quote is not null""")
    rows = cur.fetchall()
    cur.execute("""select 'link', l.id, l.matter_id, l.quote, a.title, coalesce(m.meta->>'display_title', m.title),
                          coalesce(m.plain_english_summary, ''), l.review
                   from matter_links l join agenda_items a on a.id = l.agenda_item_id join matters m on m.id = l.matter_id
                   where l.kind = 'mention' and not l.hidden and l.quote is not null
                     and a.title ~* '(annual report|financial (statement|information)|audited|statement of financial)'""")
    rows += cur.fetchall()
    return [{"kind": k, "id": i, "matter": mid, "quote": q, "source": src, "topic": t, "summary": s, "review": rv}
            for k, i, mid, q, src, t, s, rv in rows]


def excerpt_question(topic: str, summary: str) -> dict:
    return ai.predicate("unrelated", f"This council topic is \"{topic}\" — {summary[:300]}. Is this passage about something "
                                     f"unrelated to it, that only shares a facility, organization or place name? Example: a "
                                     f"financial-statement note on transferring a recreation centre's assets, on a topic about "
                                     f"that centre's fee bylaw. Progress, completion, costs or results of the same project, "
                                     f"place or program are related, not unrelated.")


def judge_excerpts(rows: list[dict]) -> list[dict]:
    """The rows to hide."""
    jobs = [(f"PASSAGE ({'City annual report ' + r['source'] if r['kind'] == 'page' else (r['source'] or '').splitlines()[0][:120]}): "
             f"{(r['quote'] or '')[:600]}", [excerpt_question(r["topic"], r["summary"])]) for r in rows]
    hide = []
    for start in range(0, len(jobs), 100):
        for r, res in zip(rows[start:start + 100], ai.decide_many(jobs[start:start + 100])):
            if isinstance(res, Exception) or r.get("review") == "accepted":
                continue
            if (getattr(res.get("unrelated"), "probability", 0) or 0) >= EXCERPT_UNRELATED_PROBABILITY:
                hide.append(r)
    return hide


def run(*, dry_run: bool = False, backup_path: str | None = None, link_ids: list[int] | None = None,
        excerpts: bool = False) -> dict[str, Any]:
    """Judge the links not yet judged (all, or ``link_ids``); with ``excerpts``, also re-judge report passages."""
    from pipeline.db import connect, run_write

    c = connect()
    c.set_session(readonly=True)
    try:
        cur = c.cursor()
        links = pending(cur, link_ids)
        rows = excerpt_pending(cur) if excerpts else []
        c.rollback()
    finally:
        c.close()
    verdicts = judge(links) if links else {}
    hide_links = [l for l in links if to_hide(l, verdicts.get(l["link"]))]
    hide_excerpts = judge_excerpts(rows) if rows else []
    result = {"judged": len(links), "kept": sum(1 for v in verdicts.values() if v), "hide": len(hide_links),
              "excerpts_judged": len(rows), "hide_excerpts": len(hide_excerpts),
              "samples": [{"topic": l["topic"], "item": (l["title"] or "")[:80], "about": verdicts.get(l["link"]),
                           "speakers": [s.get("topic") for s in l["speakers"]][:8]} for l in links[:40]],
              "excerpt_samples": [{"topic": r["topic"], "quote": (r["quote"] or "")[:160]} for r in hide_excerpts[:30]]}
    print(f"  [Comment] {len(links)} link(s) judged; hide {len(hide_links)}; report passages: hide {len(hide_excerpts)} of {len(rows)}")
    if dry_run:
        return result
    if backup_path:
        with open(backup_path, "w") as f:
            json.dump({"links": links, "verdicts": verdicts, "hide_links": [l["link"] for l in hide_links],
                       "hide_excerpts": hide_excerpts}, f, default=str)
    by_item: dict[int, dict[str, list[int]]] = {}
    for l in links:
        if verdicts.get(l["link"]) is not None:
            by_item.setdefault(l["item"], {})[str(l["matter"])] = verdicts[l["link"]]

    def write(cur):
        for item, about in by_item.items():
            cur.execute("""update agenda_items set meta = jsonb_set(meta, '{participation,about_matters}',
                             coalesce(meta->'participation'->'about_matters', '{}'::jsonb) || %s::jsonb) where id = %s""",
                        (json.dumps(about), item))
        ids = [l["link"] for l in hide_links] + [r["id"] for r in hide_excerpts if r["kind"] == "link"]
        if ids:
            cur.execute("update matter_links set hidden = true where id = any(%s) and not hidden", (ids,))
        pages = [r["id"] for r in hide_excerpts if r["kind"] == "page"]
        if pages:
            cur.execute("update matter_report_mentions set hidden = true where id = any(%s) and not hidden", (pages,))
    run_write(write)
    return result
