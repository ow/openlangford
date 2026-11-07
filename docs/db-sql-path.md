# The typed SQL path (Kysely over postgres.js)

A second way to read the database, for queries PostgREST (supabase-js) handles badly: aggregates, self-joins, "limit first, then aggregate", and anything that would otherwise page a whole table into the Worker or need a SQL function shipped by migration. Everything else (simple reads, writes, auth, realtime) stays on supabase-js.

Code: `apps/web/app/db/` (`getSql(env)`, `getDb(env)`, `withDb(env, ctx, fn)`, generated `schema.d.ts`). Queries live in `app/services/*-sql.server.ts`. Moved so far: voting alignment (`analytics-sql.server.ts`, `/alignment`) and the homepage's recent decisions (`site-sql.server.ts`). Both fall back to the PostgREST version if no connection is configured or the query fails. Alignment runs on either `DATABASE_URL` or a Hyperdrive binding. The homepage query runs **only with a Hyperdrive binding** (`sqlPathAvailable(env, { requireWarmPool: true })`): a per-request connect to the pooler costs about 350 ms, more than the PostgREST path it replaces (about 170 ms), so it only pays off on a warm pooled connection.

## When to use which

- Use SQL when the query needs a join PostgREST can't express, a GROUP BY, a window, or an ordering by a related table's column (which makes PostgREST aggregate everything before the limit).
- Use supabase-js for simple selects and embeds, every write, auth and realtime.
- Don't write a new SQL function by migration just to give PostgREST an aggregate: write the query here.

## RLS warning

This path connects as the database role, so it **bypasses RLS exactly like `getSupabaseAdminClient()`**. Every query must apply the privacy rules itself: `properties.hidden = false` (also on any joined properties), `merged_into IS NULL` and `meta->>'hidden' IS NULL` for matters, hidden pages, the municipality filter, and no future meetings where the page shouldn't show them. Never use it for per-user data without filtering by the user's id yourself. Don't expose its rows to a route without checking them against what the public client could see.

## Connection

`getSql(env)` opens a short-lived postgres.js connection: `max: 1`, `prepare: false` (required by Supavisor transaction pooling), `idle_timeout: 5`. bigint and numeric are parsed to JavaScript numbers, as PostgREST returns them. `withDb` closes the connection with `ctx.waitUntil` after the response. Never run a plain `SET` over this URL (see CLAUDE.md, Database Gotchas).

The string is read at runtime from the request `env`, never inlined by Vite: `env.HYPERDRIVE?.connectionString || env.DATABASE_URL`. Without either, the callers fall back to supabase-js. `sqlPathAvailable(env, { requireWarmPool })` is the one check callers use: pass `requireWarmPool: true` for queries that are already fast over PostgREST, so they don't run on a per-request connection.

## Owner steps

1. `cd apps/web && npx wrangler secret put DATABASE_URL`, with the Supavisor **transaction pooler** URL (port 6543), the same host the pipeline uses. Until this is set, nothing changes in production.
2. Cloudflare Build Configuration needs nothing new (the value is runtime-only).
3. Optional, later: create a Hyperdrive config for the same database and add to `wrangler.toml`
   ```toml
   [[hyperdrive]]
   binding = "HYPERDRIVE"
   id = "<config id>"
   ```
   `getSql` prefers `env.HYPERDRIVE.connectionString` automatically, and this is what switches the homepage query onto SQL; keep the pool small (the database has `max_connections = 60` and PostgREST holds up to 20). Hyperdrive replaces per-request connection setup (about 300 ms from a laptop) with a warm pooled connection.
4. Local dev: `pnpm dev` runs the binding against `DATABASE_URL` from the root `.env` (set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` to use another database). Bindings stay local unless `CF_REMOTE_BINDINGS=true`.

## Types

`pnpm --filter web db:kysely-types` regenerates `app/db/schema.d.ts` from the live database (kysely-codegen, then `scripts/patch-kysely-types.mjs`, which types bigint and numeric as numbers to match the client). `web-types.yml` fails when it's stale. Migrations stay in `supabase/migrations/`; there is no Kysely migration tooling.

## Parity tests

- `tests/db/sql-path-parity.test.ts`: runs the old and new implementations against a database and deep-equals them. Skipped unless `LANGFORD_PARITY_DATABASE_URL`, `LANGFORD_PARITY_SUPABASE_URL` and `LANGFORD_PARITY_SUPABASE_KEY` are set. Read-only.
- `tests/services/postgres-alignment-sql.test.ts`: privacy and filter rules on a throwaway Postgres (`LANGFORD_TEST_PG_URL`, see the file header).
- `scripts/measure-sql-path.ts`: old-vs-new timings.

Each query you move should get a parity case before the route switches.
