import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, health } from "../../app/db/index.server";
import { getVotingAlignment } from "../../app/services/analytics";
import { getVotingAlignmentSql } from "../../app/services/analytics-sql.server";
import { recentMotions } from "../../app/services/site";
import { recentMotionsSql } from "../../app/services/site-sql.server";

// Runs old (supabase-js) and new (Kysely) implementations against a real database, read-only. Skipped unless
//   LANGFORD_PARITY_DATABASE_URL (pooler URL), LANGFORD_PARITY_SUPABASE_URL and LANGFORD_PARITY_SUPABASE_KEY
// are set. Bracket access keeps vitest's `define` from replacing the names.
const env = (name: string) => process.env[name];
const databaseUrl = env("LANGFORD_PARITY_DATABASE_URL");
const supabaseUrl = env("LANGFORD_PARITY_SUPABASE_URL");
const supabaseKey = env("LANGFORD_PARITY_SUPABASE_KEY");
const enabled = !!(databaseUrl && supabaseUrl && supabaseKey);

const byKey = <T>(rows: T[], key: (row: T) => string) => [...rows].sort((a, b) => key(a).localeCompare(key(b)));
/** Object key order differs between PostgREST and jsonb: compare with keys sorted. */
const canon = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canon)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canon(v)]))
  : value;

describe.skipIf(!enabled)("SQL path parity against the database", () => {
  const supabase = enabled ? createClient(supabaseUrl!, supabaseKey!) : (undefined as never);
  const db = enabled ? getDb({ DATABASE_URL: databaseUrl }) : (undefined as never);
  afterAll(async () => { await db?.destroy(); });

  it("connects", async () => { expect(await health(db)).toBe(true); });

  it("voting alignment matches", async () => {
    const [old, next] = await Promise.all([getVotingAlignment(supabase as never, 1), getVotingAlignmentSql(db, 1)]);
    expect(next.votes.length).toBeGreaterThan(0);
    expect(canon(byKey(next.people, (p) => String(p.id)))).toEqual(canon(byKey(old.people, (p: any) => String(p.id))));
    expect(canon(byKey(next.votes, (v) => `${v.motion_id}:${v.person_id}:${v.vote}`)))
      .toEqual(canon(byKey(old.votes, (v: any) => `${v.motion_id}:${v.person_id}:${v.vote}`)));
    const normal = (rows: any[]) => canon(byKey(rows, (m) => String(m.id)).map((m) => ({ ...m, votes: byKey(m.votes, (v: any) => String(v.id)) })));
    expect(normal(next.motions)).toEqual(normal(old.motions));
    expect(canon(byKey(next.memberships, (m: any) => String(m.id)))).toEqual(canon(byKey(old.memberships, (m: any) => String(m.id))));
  }, 120_000);

  it("homepage recent motions match, in order", async () => {
    const old = await recentMotions(supabase as never, 1);
    expect(old.error).toBeNull();
    const next = await recentMotionsSql(db, 1);
    expect(next).toHaveLength(15);
    const normal = (rows: any[]) => canon(rows.map((m) => ({ ...m, votes: byKey(m.votes, (v: any) => v.vote) })));
    expect(normal(next)).toEqual(normal(old.data as any[]));
  }, 60_000);
});
