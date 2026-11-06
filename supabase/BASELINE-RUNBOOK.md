# Schema baseline: one-time steps for the owner

`supabase/migrations/20261107000000_baseline.sql` replaces the 113 earlier migrations (now in
`supabase/migrations_archive/`). Production already records version `20261107000000` as applied (it was the
latest migration, `page_review_check_queue`), so the baseline never runs there. But production's history table
also holds the other 112 versions, and after this PR merges the repo no longer has files for them. `supabase db
push` then refuses to run ("Remote migration versions not found in local migrations directory"). The 112 rows
must be marked reverted once. That only edits `supabase_migrations.schema_migrations`; it does not touch any
table, function or data. Claude did not run any of this. Everything below is yours to run.

Tested end to end on a throwaway Postgres (same repo state): before the repair `db push --dry-run` fails with
`DbPushMissingLocalError`; after it, `db push --dry-run` says "Remote database is up to date" and
`migration list` shows one row, `20261107000000`, local and remote.

Use the same connection string the workflow uses (`SUPABASE_DB_URL`). `--yes` is only needed when the CLI
cannot prompt (CLI 3.x in a non-interactive shell); interactively it asks you to confirm.

## 0. Before you start

- Do not run this if main gained a migration after this branch was cut. Check:
  `git fetch origin && git diff --stat HEAD...origin/main -- supabase/migrations supabase/migrations_archive`
  must print nothing. If it does, the baseline has to be regenerated first (ask Claude).
- Freeze: from step 3 until the PR merges, nobody merges anything that touches `supabase/migrations/` into main,
  and nobody runs `supabase db push` from a checkout of main. In that window main still has the 113 old
  files and production no longer records 112 of them, so a push would try to re-apply them.

## 1. Check the current state (read-only)

From a checkout of main (old files present):

```bash
export SUPABASE_DB_URL='...'   # same value as the GitHub secret
npx supabase migration list --db-url "$SUPABASE_DB_URL"
```

Expect 113 rows, every row with both Local and Remote filled, the last one `20261107000000`. Any row missing
a Local or Remote value: stop.

## 2. Save the history table (read-only, for rollback)

```bash
psql "$SUPABASE_DB_URL" -c "\copy (select * from supabase_migrations.schema_migrations order by version) to 'schema_migrations-2026-11-05.csv' csv header"
```

Keep `schema_migrations-2026-11-05.csv` (do not commit it). `supabase/migrations_archive/applied-versions-2026-11-05.txt`
is the same list of versions.

## 3. Mark the 112 archived versions reverted (the write)

From a checkout of this branch (so `supabase/migrations_archive/` exists). This lists every archived version
except the baseline's own, `20261107000000`, which must stay recorded:

```bash
ls supabase/migrations_archive/*.sql | xargs -n1 basename | cut -d_ -f1 \
  | grep -v '^20261107000000$' | wc -l          # must print 112

ls supabase/migrations_archive/*.sql | xargs -n1 basename | cut -d_ -f1 \
  | grep -v '^20261107000000$' \
  | xargs npx supabase migration repair --status reverted --db-url "$SUPABASE_DB_URL"
```

## 4. Verify, still on this branch

```bash
npx supabase migration list --db-url "$SUPABASE_DB_URL"     # exactly one row: 20261107000000 | 20261107000000
npx supabase db push --dry-run --db-url "$SUPABASE_DB_URL"  # "Remote database is up to date."
```

If either differs, do not merge; use the rollback below.

## 5. Merge the PR

The `Supabase migrations` workflow runs (the paths changed), shows a dry run and applies nothing. If it fails
with "Remote migration versions not found", step 3 was skipped or incomplete: run it, then re-run the workflow
(`workflow_dispatch`). Nothing was applied by the failed run.

## Safer order, if you cannot freeze main

Merge first, then run steps 3 and 4. The workflow run on merge fails harmlessly at its dry-run step (it stops
before applying anything), and the repair plus a manual re-run of the workflow (`workflow_dispatch`) finishes the job.
The cost is one red workflow run. The benefit is there is no window where main and production disagree in the
dangerous direction.

## Rollback

The repair is reversible and touches only the history table.

1. Restore the old files: `git revert` the merge commit (or `git mv supabase/migrations_archive/2026*.sql supabase/migrations/`
   and delete `supabase/migrations/20261107000000_baseline.sql`, keeping `20261107000000_page_review_check_queue.sql`).
2. Re-record the 112 versions as applied:

```bash
ls supabase/migrations/*.sql | xargs -n1 basename | cut -d_ -f1 \
  | grep -v '^20261107000000$' \
  | xargs npx supabase migration repair --status applied --db-url "$SUPABASE_DB_URL"
```

3. `npx supabase migration list --db-url "$SUPABASE_DB_URL"` must show 113 rows, all with Local and Remote.

(The CSV from step 2 is the exact original table if you prefer to restore it with SQL.)
