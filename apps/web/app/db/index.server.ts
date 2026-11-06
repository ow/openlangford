/**
 * The typed SQL path: Kysely over postgres.js, for reads PostgREST can't express (aggregates, self-joins,
 * limit-then-aggregate). Use supabase-js for everything else. See docs/db-sql-path.md.
 *
 * WARNING: this connects as the database role, so it BYPASSES RLS like the admin client. Every query must
 * apply the privacy rules itself (properties.hidden, merged_into IS NULL, meta->>'hidden', future meetings).
 *
 * The connection string is read at runtime from the request `env` (`wrangler secret put DATABASE_URL`), never
 * inlined at build time. A Hyperdrive binding (`env.HYPERDRIVE`) takes over when one is configured.
 */
import postgres from "postgres";
import { Kysely, sql } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import type { DB } from "./schema";

export interface SqlEnv {
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
}

export type Db = Kysely<DB>;

/** The one place the connection string is chosen: Hyperdrive when bound, otherwise the DATABASE_URL secret. */
export function connectionString(env: SqlEnv): string {
  const url = env.HYPERDRIVE?.connectionString || env.DATABASE_URL;
  if (!url) throw new Error("No database connection: set the DATABASE_URL Worker secret (or bind HYPERDRIVE)");
  return url;
}

/**
 * A short-lived postgres.js client: one connection, no prepared statements (transaction-mode pooling forbids
 * them), closed soon after it goes idle. bigint and numeric come back as numbers, as PostgREST returns them.
 */
export function getSql(env: SqlEnv) {
  return postgres(connectionString(env), {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 10,
    fetch_types: false,
    types: {
      bigint: { to: 20, from: [20], parse: (v: string) => Number(v), serialize: (v: unknown) => String(v) },
      numeric: { to: 1700, from: [1700], parse: (v: string) => Number(v), serialize: (v: unknown) => String(v) },
    },
  });
}

export function getDb(env: SqlEnv): Db {
  return new Kysely<DB>({ dialect: new PostgresJSDialect({ postgres: getSql(env) }) });
}

/** Run `fn` with a Kysely instance, then close the connection after the response (ctx.waitUntil). */
export async function withDb<T>(
  env: SqlEnv,
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const db = getDb(env);
  try {
    return await fn(db);
  } finally {
    const closing = db.destroy().catch(() => {});
    if (ctx) ctx.waitUntil(closing);
  }
}

/** A trivial query, used by the connectivity test. */
export async function health(db: Db): Promise<boolean> {
  const { rows } = await sql<{ ok: number }>`select 1 as ok`.execute(db);
  return rows[0]?.ok === 1;
}
