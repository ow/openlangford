// Times the old (supabase-js) and new (Kysely) implementations, 3 runs each, read-only.
//   DATABASE_URL=... SUPABASE_URL=... SUPABASE_SECRET_KEY=... npx tsx scripts/measure-sql-path.ts
import { createClient } from "@supabase/supabase-js";
import { getDb } from "../app/db/index.server";
import { getVotingAlignment } from "../app/services/analytics";
import { getVotingAlignmentSql } from "../app/services/analytics-sql.server";
import { recentMotions } from "../app/services/site";
import { recentMotionsSql } from "../app/services/site-sql.server";

const supabase = createClient(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
const time = async (fn: () => Promise<unknown>) => { const t = performance.now(); await fn(); return Math.round(performance.now() - t); };
const cases: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
  ["voting alignment", () => getVotingAlignment(supabase as never, 1), async () => { const db = getDb({ DATABASE_URL: process.env.DATABASE_URL }); try { await getVotingAlignmentSql(db, 1); } finally { await db.destroy(); } }],
  ["home recent motions", () => recentMotions(supabase as never, 1), async () => { const db = getDb({ DATABASE_URL: process.env.DATABASE_URL }); try { await recentMotionsSql(db, 1); } finally { await db.destroy(); } }],
];
for (const [name, old, next] of cases) {
  const o: number[] = [], n: number[] = [];
  for (let i = 0; i < 3; i++) { o.push(await time(old)); n.push(await time(next)); }
  console.log(`${name}: old ${o.join("/")} ms, new ${n.join("/")} ms (new includes connect + close)`);
}
