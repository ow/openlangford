# Linking question experiment (2026-11-02)

Does asking the main linking step "is this item part of THIS topic's story?" (with the topic's timeline as context)
beat today's "how does this item involve <name>?"? Both on the Decisions API (gpt-6-luna). `experiment.py`,
results in `results.json`. 200 published name links + 200 candidates the pipeline found by name but didn't link.
Disagreements at the 0.85 bar got a third opinion from gpt-6.1-terra.

## Result: don't switch

| | Old question | New question |
|---|---|---|
| Published links kept (of 200) | 172 re-scored ≥ 0.85 | 109 |
| Turned-down candidates accepted (of 200) | 120 | 17 |

- **The new question is too strict.** Of the 73 published links it would drop, Terra says 66 belong: bylaw
  readings for the same property ("Bylaw 1344 … (671 Hoylake Avenue)"), a related rezoning. Only 7 were real
  errors: a speaker's home address on the same street, a passing compliment, an unrelated older bylaw.
- **Published links look accurate**: about 7 errors in 200 (3.5%) by this check.
- **The old question is permissive on its own** (re-scores 120 of 200 turned-down candidates ≥ 0.85); the
  second check is what filters. Terra thinks a third of what that filter drops belongs (e.g. "Bylaw 2027 …
  (629 Rockingham Road)" for that property's setback variance; the OCP amendment adding the Regional Context
  Statement for the Regional Growth Strategy topic). Terra is generous with "mentioned" (a budget line), so
  this is an upper bound.

## So the gap is recall, not precision

The main linking publishes few wrong links but misses real ones. Better levers than rewording the question:
staff "Find missing" (Terra suggestions, a person decides), possibly in bulk; or loosening the second check for
items that share a file number or civic address with the topic's own items.

## Follow-up: skipping the second check on strong evidence

Rule tested on the 200 turned-down candidates: keep a link without the second check when the item's own title
names the topic's permit/file number or one of its civic addresses. It rescued 42, all by address; Terra: 14
belong, 10 mention, 18 unrelated (different applications on the same property, e.g. Western Speedway's licensed
area vs an OCP amendment at 2207 Millstream Road). Shipped only the permit-number half (same application number =
same application); address matches still go through the check.
