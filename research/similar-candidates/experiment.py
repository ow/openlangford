"""Does adding embedding candidates (closest items by meaning, any year) to "find missing" help, and does it hurt?

For a sample of topics, runs the suggestion search twice without writing anything: names only, and names plus the
15 most similar agenda items. Compares the judge's verdicts on the same name candidates (did the extra candidates
change them?) and lists what the similar items add.

Run from apps/pipeline:  PYTHONPATH=. uv run python ../../research/similar-candidates/experiment.py [n_topics]
"""
import json
import random
import sys
from pathlib import Path

from pipeline.db import connect
from pipeline.ingestion import matter_names as mn

OUT = Path(__file__).parent
N = int(sys.argv[1]) if len(sys.argv) > 1 else 15
random.seed(20261102)

conn = connect()
conn.set_session(readonly=True)
cur = conn.cursor()
cur.execute("""select m.id from matters m where m.meta->>'canonical_matter_id' is null and m.meta->>'hidden' is null
               and (select count(*) from agenda_items a where a.matter_id = m.id) >= 3""")
topics = random.sample([r[0] for r in cur.fetchall()], N)
conn.rollback()
conn.close()

results = []
for mid in topics:
    base = mn.suggest_links(mid, similar=False, dry_run=True)
    plus = mn.suggest_links(mid, similar=True, dry_run=True)
    key = lambda v: (v["kind"], v["id"])
    base_v = {key(v): v["verdict"] for v in base.get("verdicts", [])}
    plus_v = {key(v): v for v in plus.get("verdicts", [])}
    changed = [{"id": k[1], "before": base_v[k], "after": plus_v[k]["verdict"], "title": plus_v[k]["title"]}
               for k in base_v if k in plus_v and plus_v[k]["verdict"] != base_v[k]]
    added = [v for v in plus.get("verdicts", []) if v.get("where") == "similar" and v["verdict"] != "unrelated"]
    results.append({"matter_id": mid, "names": plus.get("names"), "base_kept": sum(v != "unrelated" for v in base_v.values()),
                    "similar_judged": sum(v.get("where") == "similar" for v in plus.get("verdicts", [])),
                    "similar_kept": added, "name_verdicts_changed": changed})
    print(f"{mid}: names kept {results[-1]['base_kept']}, similar kept {len(added)}/{results[-1]['similar_judged']}, "
          f"name verdicts changed {len(changed)}", flush=True)
(OUT / "results.json").write_text(json.dumps(results, indent=1, default=str))
