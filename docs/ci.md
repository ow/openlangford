# CI gates

`.github/workflows/ci.yml` runs on every pull request and on every push to `main`.
It adds status checks only. **Cloudflare's build and deploy of `main` is unaffected**: it
still builds every push on its own and does not wait for, or depend on, these jobs.

| Check | When | What |
| --- | --- | --- |
| `web` | code changes | `pnpm install --frozen-lockfile`, `pnpm typecheck`, `npx vitest run` in `apps/web`. The two Postgres suites run against a throwaway `supabase/postgres` container. |
| `pipeline` | code changes | `uv sync --frozen`, `uv run pytest -q --no-cov -p no:cacheprovider` in `apps/pipeline` (poppler installed so the original-PDF tests run). |
| `migrations-check` | pull requests touching `supabase/migrations/**` | `.github/scripts/lint-migrations.sh`: name is `<14-digit UTC timestamp>_<snake_name>.sql`, timestamp is above every existing one, no `CONCURRENTLY`, applied files not edited. Lint only; nothing is applied. |

Notes
- Docs-only, `*.md`, `research/**` and `.planning/**` changes skip `web` and `pipeline`. This is done with job-level `if`
  (a `changes` job), not workflow-level `paths-ignore`, because a workflow that never starts leaves a required check
  waiting forever; a skipped job counts as passing.
- `migrations-check` does not apply the file to a scratch Postgres: the existing migrations do not apply from an empty
  database (for example `20260217003829_fix_rpc_search_path.sql` alters a function created outside the migrations).
  Add the apply step once the baseline is fixed.
- Typecheck is expected to be clean on `main` (no baseline is used).

## Protect `main` (owner runs this once, after the first CI run so the check names exist)

"Up to date before merging" is not required, to avoid rebase churn across stacked PRs. No reviews are required here;
add `required_pull_request_reviews` if you want them.

```bash
gh api -X PUT repos/ow/openlangford/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "checks": [
      { "context": "web" },
      { "context": "pipeline" },
      { "context": "migrations-check" }
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

`enforce_admins: false` lets the owner still push straight to `main` in an emergency. Note `gh api` replaces the whole
protection config, so check `gh api repos/ow/openlangford/branches/main/protection` first if any exists.
