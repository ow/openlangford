/**
 * Voting alignment on the typed SQL path (see app/db and docs/db-sql-path.md). Same return shape as
 * getVotingAlignment in analytics.ts, but the votes and motions come from two joins instead of paging the
 * whole votes and motions tables through PostgREST.
 *
 * This connection bypasses RLS: the municipality filter and the named_only exclusion are applied here.
 */
import { sql } from "kysely";
import type { Db } from "../db/index.server";

type Json<T> = T; // jsonb columns arrive already parsed by postgres.js

export interface AlignmentVote {
  motion_id: number;
  person_id: number;
  vote: string;
  motions: { vote_coverage: string | null; meeting_id: number; meetings: { slug: string; meeting_date: string } };
}

export interface AlignmentMotion {
  id: number;
  result: string | null;
  votes: { id: number }[];
  meetings: { slug: string; meeting_date: string; municipality_id: number };
}

export async function getVotingAlignmentSql(db: Db, municipalityId = 1) {
  const council = await db
    .selectFrom("organizations")
    .select("id")
    .where("classification", "=", "Council")
    .where("municipality_id", "=", municipalityId)
    .limit(2)
    .execute();
  // The supabase-js version uses .single(), which errors (and so yields no council) unless exactly one matches.
  if (council.length !== 1) return { people: [], votes: [], motions: [], memberships: [] };
  const councilId = council[0].id;

  const [people, votes, motions, memberships] = await Promise.all([
    db.selectFrom("people").select(["id", "name", "image_url", "is_councillor"]).execute(),
    // Named-dissent-only recoveries are not complete roll calls and would bias agreement rates.
    db
      .selectFrom("votes as v")
      .innerJoin("motions as m", "m.id", "v.motion_id")
      .innerJoin("meetings as mt", "mt.id", "m.meeting_id")
      .select([
        "v.motion_id",
        "v.person_id",
        "v.vote",
        sql<Json<AlignmentVote["motions"]>>`jsonb_build_object(
          'vote_coverage', m.meta->>'individual_vote_coverage',
          'meeting_id', m.meeting_id,
          'meetings', jsonb_build_object('slug', mt.slug, 'meeting_date', mt.meeting_date))`.as("motions"),
      ])
      .where("mt.municipality_id", "=", municipalityId)
      .where("v.vote", "in", ["Yes", "No", "Opposed", "In Favour"])
      .where(sql<boolean>`coalesce(m.meta->>'individual_vote_coverage', '') <> 'named_only'`)
      .orderBy("v.id")
      .execute(),
    db
      .selectFrom("motions as m")
      .innerJoin("meetings as mt", "mt.id", "m.meeting_id")
      .select([
        "m.id",
        "m.result",
        sql<AlignmentMotion["votes"]>`coalesce((select jsonb_agg(jsonb_build_object('id', v.id) order by v.id)
          from votes v where v.motion_id = m.id), '[]'::jsonb)`.as("votes"),
        sql<Json<AlignmentMotion["meetings"]>>`jsonb_build_object(
          'slug', mt.slug, 'meeting_date', mt.meeting_date, 'municipality_id', mt.municipality_id)`.as("meetings"),
      ])
      .where("mt.municipality_id", "=", municipalityId)
      .orderBy("m.id")
      .execute(),
    db
      .selectFrom("memberships as ms")
      .leftJoin("people as p", "p.id", "ms.person_id")
      .select([
        sql<Record<string, unknown>>`to_jsonb(ms)
          || jsonb_build_object('people', case when p.id is null then null
               else jsonb_build_object('id', p.id, 'name', p.name, 'image_url', p.image_url) end)`.as("row"),
      ])
      .where("ms.organization_id", "=", councilId)
      .execute(),
  ]);

  return {
    people,
    votes: votes as unknown as AlignmentVote[],
    motions: motions as unknown as AlignmentMotion[],
    memberships: memberships.map((m) => m.row),
  };
}
