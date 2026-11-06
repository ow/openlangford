/**
 * The homepage's recent decisions on the typed SQL path (see app/db and docs/db-sql-path.md).
 *
 * This connection bypasses RLS. Every row here is a decided, non-procedural motion on a meeting in the
 * municipality; votes are aggregated only for the 15 motions that survive the limit.
 * NOTE: Do NOT use motions.yes_votes/no_votes (always 0): count the votes rows.
 */
import { sql } from "kysely";
import type { Db } from "../db/index.server";

export interface RecentMotionRow {
  id: number;
  plain_english_summary: string | null;
  text_content: string | null;
  result: string | null;
  disposition: string | null;
  financial_cost: number | null;
  meeting_id: number;
  vote_coverage: string | null;
  headline: string | null;
  meetings: { slug: string; id: number; meeting_date: string; title: string };
  votes: { vote: string }[];
}

export async function recentMotionsSql(db: Db, municipalityId: number, limit = 15): Promise<RecentMotionRow[]> {
  const rows = await db
    .with("latest", (qb) =>
      qb
        .selectFrom("motions as m")
        .innerJoin("meetings as mt", "mt.id", "m.meeting_id")
        .select(["m.id", "mt.meeting_date"])
        .where("mt.municipality_id", "=", municipalityId)
        .where("m.result", "is not", null)
        // Same as PostgREST's neq: a motion with no disposition at all is left out too.
        .where("m.disposition", "<>", "Procedural")
        .orderBy("mt.meeting_date", "desc")
        .orderBy("m.id", "desc")
        .limit(limit),
    )
    .selectFrom("latest")
    .innerJoin("motions as m", "m.id", "latest.id")
    .innerJoin("meetings as mt", "mt.id", "m.meeting_id")
    .select([
      "m.id",
      "m.plain_english_summary",
      "m.text_content",
      "m.result",
      "m.disposition",
      "m.financial_cost",
      "m.meeting_id",
      sql<string | null>`m.meta->>'individual_vote_coverage'`.as("vote_coverage"),
      sql<string | null>`m.meta->>'headline'`.as("headline"),
      sql<RecentMotionRow["meetings"]>`jsonb_build_object(
        'slug', mt.slug, 'id', mt.id, 'meeting_date', mt.meeting_date, 'title', mt.title)`.as("meetings"),
      sql<RecentMotionRow["votes"]>`coalesce((select jsonb_agg(jsonb_build_object('vote', v.vote))
        from votes v where v.motion_id = m.id), '[]'::jsonb)`.as("votes"),
    ])
    .orderBy("mt.meeting_date", "desc")
    .orderBy("m.id", "desc")
    .execute();
  return rows as unknown as RecentMotionRow[];
}
