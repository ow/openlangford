"""Merge the 16 duplicate agenda_items created by the 2026-10-29 forced transcript backfill.

The exact order+title matcher (fixed in aa3316dc) did not recognize items the AI re-rendered
("1. CALL TO ORDER", "a) ...", swapped 5.4/5.5, "Hocklev"/"Hockley", "ADOPTION OF THE MINUTES — ..."),
so the re-ingest inserted a second row beside the original. For each duplicate:

  * every row referencing it through ANY foreign key to agenda_items (enumerated from pg_catalog)
    is re-pointed to the original. Where the original already has the same child (a property link
    with the same property; a key statement with the same text) the duplicate's child is deleted
    instead of creating a second copy;
  * moved key statements keep a valid proof: meetings.meta.key_statement_evidence entries are keyed
    by sha256(meeting_id, agenda_item_id, source_segment_ids, quote_sha256), computed exactly as
    publish_source_bound_key_statement does, so each moved proof is re-keyed to the original item
    (with merged_from_agenda_item_id recorded) and a deleted statement's proof is removed;
  * columns the original lacks (null/empty) are filled from the duplicate (timing as a pair);
    identity columns (id, meeting_id, slug, item_order, title, created_at) and a set matter_id stay;
  * the duplicate row is deleted once nothing references it.

The mapping is fixed below and re-derived at run time with the fixed matcher; any disagreement
aborts. Dry run by default (prints the plan); --apply writes a JSON backup of every touched row to
research/data-integrity/2026-10-30/ and applies everything in one transaction.
"""
import datetime
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps/pipeline"))
from pipeline import config  # noqa: E402,F401  (loads the main checkout .env into this process)
from pipeline.ingestion.agenda_identity import existing_agenda_item  # noqa: E402
import os  # noqa: E402
import psycopg2  # noqa: E402
import psycopg2.extras  # noqa: E402

DUPLICATE_TO_ORIGINAL = {
    13080: 7740, 13081: 7741,                      # 593: 5.4/5.5 swapped (Walfred / Jacklin)
    13085: 12839,                                  # 875: "Hockley" vs OCR "Hocklev"
    13089: 12972, 13090: 12970, 13091: 12971,      # 888: 6.1-6.3 permuted
    13092: 7970, 13093: 7971, 13094: 7972, 13095: 7973, 13096: 7974,
    13097: 7975, 13098: 7976, 13099: 7977, 13100: 7978,  # 622: "1. CALL TO ORDER", "a) ..."
    13102: 8063,                                   # 631: header + child title merged
}
BACKFILL_START = "2026-10-29"
ALERT_GUARD_DATE = "2026-10-15"
KEEP = {"id", "meeting_id", "slug", "item_order", "title", "created_at", "updated_at", "matter_id"}
TIMING = ("discussion_start_time", "discussion_end_time")
OUT = ROOT / "research/data-integrity/2026-10-30"

PROOF_KEY = """encode(sha256(convert_to(jsonb_build_object('meeting_id',(p->>'meeting_id')::bigint,
  'agenda_item_id',(p->>'agenda_item_id')::bigint,'source_segment_ids',p->'source_segment_ids',
  'quote_sha256',p->>'source_quote_sha256')::text,'UTF8')),'hex')"""


def empty(value):
    return value is None or value == "" or value == [] or value == {}


def main(apply):
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    ids = sorted(set(DUPLICATE_TO_ORIGINAL) | set(DUPLICATE_TO_ORIGINAL.values()))
    cur.execute("select a.*, a.embedding::text as embedding, m.meeting_date::text as meeting_date from agenda_items a "
                "join meetings m on m.id=a.meeting_id where a.id = any(%s) for update of a", (ids,))
    items = {row["id"]: row for row in cur.fetchall()}
    assert len(items) == len(ids), f"missing rows: {set(ids) - set(items)}"
    meetings = sorted({items[d]["meeting_id"] for d in DUPLICATE_TO_ORIGINAL})

    # 1. Guards + re-derive the mapping with the fixed matcher.
    for dup, orig in DUPLICATE_TO_ORIGINAL.items():
        d, o = items[dup], items[orig]
        assert d["meeting_id"] == o["meeting_id"], (dup, orig)
        assert d["meeting_date"] < ALERT_GUARD_DATE, d["meeting_date"]
        assert str(d["created_at"]) >= BACKFILL_START > str(o["created_at"]), (dup, orig)
        cur.execute("select id,item_order,title from agenda_items where meeting_id=%s and created_at < %s",
                    (d["meeting_id"], BACKFILL_START))
        found = existing_agenda_item({"item_order": d["item_order"], "title": d["title"]}, cur.fetchall())
        assert found and found["id"] == orig, f"matcher maps {dup} to {found and found['id']}, expected {orig}"

    # 2. Every FK into agenda_items, from the catalog.
    cur.execute("""select c.conrelid::regclass::text tbl, a.attname col from pg_constraint c
        join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
        where c.contype='f' and c.confrelid='public.agenda_items'::regclass order by 1""")
    fks = cur.fetchall()
    cur.execute("select attname from pg_attribute where attrelid='public.agenda_items'::regclass "
                "and attnum>0 and not attisdropped and attgenerated=''")
    columns = [r["attname"] for r in cur.fetchall()]

    plan, backup = [], {"generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        "mapping": DUPLICATE_TO_ORIGINAL, "agenda_items": [items[i] for i in ids], "children": {}}
    cur.execute("select id, meta->'key_statement_evidence' proofs from meetings where id = any(%s) for update",
                (meetings,))
    backup["meeting_key_statement_evidence"] = {r["id"]: r["proofs"] for r in cur.fetchall()}

    for fk in fks:
        cur.execute(f"select * from {fk['tbl']} where {fk['col']} = any(%s) order by 1",
                    (list(DUPLICATE_TO_ORIGINAL),))
        rows = cur.fetchall()
        if rows:
            backup["children"].setdefault(f"{fk['tbl']}.{fk['col']}", []).extend(rows)
        for row in rows:
            dup = row[fk["col"]]
            orig = DUPLICATE_TO_ORIGINAL[dup]
            action = "repoint"
            if fk["tbl"] == "property_links":
                cur.execute("select id from property_links where agenda_item_id=%s and property_id=%s",
                            (orig, row["property_id"]))
                if cur.fetchone():
                    action = "delete_same_property_on_original"
            elif fk["tbl"] == "key_statements":
                cur.execute("select id from key_statements where agenda_item_id=%s and statement_text=%s",
                            (orig, row["statement_text"]))
                twin = cur.fetchone()
                if twin:
                    action = f"delete_same_text_as_{twin['id']}"
            elif fk["tbl"] not in ("transcript_segments", "motions", "agenda_items", "extracted_documents",
                                   "document_sections"):
                # Not seen in the inventory; refuse rather than guess a uniqueness rule.
                raise SystemExit(f"unhandled child table {fk['tbl']} row {row['id']}")
            plan.append({"table": fk["tbl"], "col": fk["col"], "id": row["id"], "dup": dup, "orig": orig,
                         "action": action})

    fills = {}
    for dup, orig in DUPLICATE_TO_ORIGINAL.items():
        d, o = items[dup], items[orig]
        cols = [c for c in columns if c not in KEEP and c not in TIMING and empty(o.get(c)) and not empty(d.get(c))]
        if all(o.get(t) is None for t in TIMING) and all(d.get(t) is not None for t in TIMING):
            cols += list(TIMING)
        meta_add = {k: v for k, v in (d.get("meta") or {}).items() if k not in (o.get("meta") or {}) and not empty(v)}
        fills[dup] = {"columns": cols, "meta_keys": sorted(meta_add)}

    # 3. Print the plan.
    for dup, orig in DUPLICATE_TO_ORIGINAL.items():
        d, o = items[dup], items[orig]
        print(f"[{d['meeting_id']}] dup {dup} [{d['item_order']}] {d['title'][:50]!r}  ->  orig {orig} [{o['item_order']}] {o['title'][:50]!r}")
        if d["matter_id"] != o["matter_id"]:
            print(f"      matter differs: dup {d['matter_id']} / orig {o['matter_id']} (original kept"
                  f"{'' if o['matter_id'] else '; filled from dup'})")
        if fills[dup]["columns"] or fills[dup]["meta_keys"]:
            print(f"      fill on original: {fills[dup]['columns']} meta {fills[dup]['meta_keys']}")
        for step in plan:
            if step["dup"] == dup:
                print(f"      {step['table']}.{step['col']} #{step['id']}: {step['action']}")
    counts = {}
    for step in plan:
        key = f"{step['table']} {step['action'].split('_as_')[0]}"
        counts[key] = counts.get(key, 0) + 1
    print("summary:", json.dumps(counts), f"; {len(DUPLICATE_TO_ORIGINAL)} duplicate agenda_items to delete")
    if not apply:
        conn.rollback()
        print("dry run; pass --apply")
        return

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"backup-agenda-duplicate-merge-{datetime.datetime.now():%Y%m%d-%H%M%S}.json"
    path.write_text(json.dumps({**backup, "plan": plan, "fills": fills}, indent=1, default=str))
    print("backup", path.relative_to(ROOT))

    # 4. Apply in this one transaction.
    for dup, orig in DUPLICATE_TO_ORIGINAL.items():
        cols = fills[dup]["columns"]
        if items[orig]["matter_id"] is None and items[dup]["matter_id"] is not None:
            cols = cols + ["matter_id"]
        if cols:
            sets = ", ".join(f"{c} = d.{c}" for c in cols)
            cur.execute(f"update agenda_items o set {sets} from agenda_items d where o.id=%s and d.id=%s", (orig, dup))
            assert cur.rowcount == 1
        if fills[dup]["meta_keys"]:
            cur.execute("update agenda_items o set meta = coalesce(o.meta,'{}'::jsonb) || "
                        "(select jsonb_object_agg(k, d.meta->k) from agenda_items d, unnest(%s::text[]) k where d.id=%s) "
                        "where o.id=%s", (fills[dup]["meta_keys"], dup, orig))
    for step in plan:
        if step["action"] == "repoint":
            extra = ""
            if step["table"] == "property_links" and items[step["orig"]]["matter_id"] is not None:
                extra = f", matter_id = {int(items[step['orig']]['matter_id'])}"
            cur.execute(f"update {step['table']} set {step['col']} = %s{extra} where id = %s and {step['col']} = %s",
                        (step["orig"], step["id"], step["dup"]))
        else:
            cur.execute(f"delete from {step['table']} where id = %s and {step['col']} = %s", (step["id"], step["dup"]))
        assert cur.rowcount == 1, step
    # Proofs: drop deleted statements' entries, re-key moved ones.
    deleted = [s["id"] for s in plan if s["table"] == "key_statements" and s["action"] != "repoint"]
    moved = {str(s["id"]): s for s in plan if s["table"] == "key_statements" and s["action"] == "repoint"}
    for mid in meetings:
        cur.execute(f"""
            with e as (select key, value p from meetings, jsonb_each(meta->'key_statement_evidence') where id=%(m)s),
            moved as (select key, p, (p->>'statement_id') sid from e where (p->>'statement_id') = any(%(moved)s)),
            rekeyed as (select sid, jsonb_set(jsonb_set(p, '{{agenda_item_id}}', to_jsonb(k.orig)),
                               '{{merged_from_agenda_item_id}}', p->'agenda_item_id') p
                        from moved join jsonb_to_recordset(%(map)s::jsonb) k(sid text, orig bigint) using (sid)),
            kept as (select key, p from e where (p->>'statement_id') <> all(%(moved)s)
                                         and (p->>'statement_id')::bigint <> all(%(deleted)s)
                     union all select {PROOF_KEY}, p from rekeyed)
            update meetings set meta = jsonb_set(meta, '{{key_statement_evidence}}',
                (select coalesce(jsonb_object_agg(key, p), '{{}}'::jsonb) from kept)) where id=%(m)s
              and meta ? 'key_statement_evidence'""",
                    {"m": mid, "moved": list(moved), "deleted": deleted,
                     "map": json.dumps([{"sid": sid, "orig": s["orig"]} for sid, s in moved.items()])})
    # Every proof must now name its statement's current item and recompute to its key.
    cur.execute(f"""select count(*) bad from meetings m, jsonb_each(m.meta->'key_statement_evidence') e(key, p)
        left join key_statements k on k.id=(p->>'statement_id')::bigint
        where m.id = any(%s) and (k.id is null or k.agenda_item_id <> (p->>'agenda_item_id')::bigint or e.key <> {PROOF_KEY})""",
                (meetings,))
    assert cur.fetchone()["bad"] == 0, "proof ledger inconsistent"
    for fk in fks:
        cur.execute(f"select count(*) n from {fk['tbl']} where {fk['col']} = any(%s)", (list(DUPLICATE_TO_ORIGINAL),))
        assert cur.fetchone()["n"] == 0, fk
    cur.execute("delete from agenda_items where id = any(%s)", (list(DUPLICATE_TO_ORIGINAL),))
    assert cur.rowcount == len(DUPLICATE_TO_ORIGINAL)
    conn.commit()
    print("applied")


if __name__ == "__main__":
    main("--apply" in sys.argv)
