"""Undo matter churn from the 2026-10-30 agenda-fix re-ingests.

A forced re-ingest re-resolved matters for agenda rows it refreshed (fixed in the
pipeline afterwards: an existing matter_id is now kept). On the re-run meetings this
re-pointed seven curated links to other or brand-new matters. This restores them to
the matters they had before the re-run (values captured in the pre-run listing, or the
matter left with no agenda items by the re-run), then deletes matters created by those
re-runs (created 2026-10-30 after 15:00 UTC) that nothing references any more except
stage-generated matter_links rows, which are deleted with them.

Dry run by default; --apply writes a JSON backup to research/data-integrity/2026-10-30/
and applies in one transaction.
"""
import datetime
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps/pipeline"))
from pipeline import config  # noqa: E402,F401  (loads the main checkout .env)
import psycopg2  # noqa: E402
import psycopg2.extras  # noqa: E402

# agenda_item_id: (matter_id set by the re-run, matter_id before it)
RESTORE = {
    4429: (912, 1295), 4431: (1317, 1020), 4432: (3378, 1269), 4447: (3384, 1296),  # 262
    8108: (1916, 1934),                                                             # 640
    8148: (3391, 1938),                                                             # 645
    8174: (3393, 1941),                                                             # 648
}
RERUN_START = "2026-10-30 15:00+00"
OUT = ROOT / "research/data-integrity/2026-10-30"


def main(apply):
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("select a.id, a.meeting_id, a.matter_id, a.title, m.meeting_date::text d from agenda_items a "
                "join meetings m on m.id=a.meeting_id where a.id = any(%s) for update of a", (list(RESTORE),))
    rows = {r["id"]: r for r in cur.fetchall()}
    for item_id, (now, before) in RESTORE.items():
        row = rows[item_id]
        assert row["d"] < "2026-10-15", row
        assert row["matter_id"] == now, f"{item_id} is {row['matter_id']}, expected {now}; refusing"
        cur.execute("select id from matters where id=%s", (before,))
        assert cur.fetchone(), f"matter {before} missing"
        print(f"[{row['meeting_id']}] item {item_id} {row['title'][:50]!r}: matter {now} -> {before}")

    # FKs into matters, from the catalog.
    cur.execute("""select c.conrelid::regclass::text tbl, a.attname col from pg_constraint c
        join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
        where c.contype='f' and c.confrelid='public.matters'::regclass""")
    fks = cur.fetchall()

    def references(matter_id, ignore_items=()):
        refs = {}
        for fk in fks:
            extra = " and id <> all(%s)" if fk["tbl"] == "agenda_items" and fk["col"] == "matter_id" else ""
            params = (matter_id, list(ignore_items)) if extra else (matter_id,)
            cur.execute(f"select count(*) n from {fk['tbl']} where {fk['col']} = %s{extra}", params)
            n = cur.fetchone()["n"]
            if n:
                refs[f"{fk['tbl']}.{fk['col']}"] = n
        return refs

    cur.execute("select * from matters where created_at >= %s order by id", (RERUN_START,))
    new_matters = cur.fetchall()
    delete = []
    for m in new_matters:
        refs = references(m["id"], ignore_items=[i for i, (now, _) in RESTORE.items() if now == m["id"]])
        refs = {k: v for k, v in refs.items() if not k.startswith("matter_links.")}
        status = "delete (only stage-generated matter_links left)" if not refs else f"keep {refs}"
        print(f"  new matter {m['id']} {m['title'][:55]!r}: {status}")
        if not refs:
            delete.append(m["id"])
    if not apply:
        conn.rollback()
        print("dry run; pass --apply")
        return
    cur.execute("select * from matter_links where matter_id = any(%s) or related_matter_id = any(%s)", (delete, delete))
    links = cur.fetchall()
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"backup-rerun-matter-links-{datetime.datetime.now():%Y%m%d-%H%M%S}.json"
    path.write_text(json.dumps({"restore": RESTORE, "agenda_items": list(rows.values()),
                                "deleted_matters": [m for m in new_matters if m["id"] in delete],
                                "deleted_matter_links": links}, indent=1, default=str))
    print("backup", path.relative_to(ROOT))
    for item_id, (now, before) in RESTORE.items():
        cur.execute("update agenda_items set matter_id=%s where id=%s and matter_id=%s", (before, item_id, now))
        assert cur.rowcount == 1
    for matter_id in delete:
        cur.execute("delete from matter_links where matter_id=%s or related_matter_id=%s", (matter_id, matter_id))
        assert not references(matter_id), matter_id
        cur.execute("delete from matters where id=%s", (matter_id,))
        assert cur.rowcount == 1
    conn.commit()
    print("applied")


if __name__ == "__main__":
    main("--apply" in sys.argv)
