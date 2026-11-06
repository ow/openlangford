import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, getSql } from "../../app/db/index.server";
import { getVotingAlignmentSql } from "../../app/services/analytics-sql.server";
import { recentMotionsSql } from "../../app/services/site-sql.server";

// Runs against a disposable local Postgres, never production:
//   docker run -d --rm --name langford-sql-test -e POSTGRES_PASSWORD=pw -p 55439:5432 postgres:16
//   LANGFORD_TEST_PG_URL=postgres://postgres:pw@localhost:55439/postgres npx vitest run tests/services/postgres-alignment-sql.test.ts
const url = process.env.LANGFORD_TEST_PG_URL;

describe.skipIf(!url)("typed SQL path on a throwaway Postgres", () => {
  const admin = url ? postgres(url, { max: 1, onnotice: () => {} }) : (undefined as never);
  const db = url ? getDb({ DATABASE_URL: url }) : (undefined as never);
  beforeAll(async () => {
    await admin.unsafe(`
      DROP TABLE IF EXISTS votes, motions, meetings, memberships, people, organizations CASCADE;
      CREATE TABLE organizations(id bigint, municipality_id bigint, classification text);
      CREATE TABLE people(id bigint, name text, image_url text, is_councillor boolean);
      CREATE TABLE memberships(id bigint, person_id bigint, organization_id bigint, start_date date, end_date date);
      CREATE TABLE meetings(id bigint, municipality_id bigint, slug text, title text, meeting_date timestamp);
      CREATE TABLE motions(id bigint, meeting_id bigint, result text, disposition text, text_content text, plain_english_summary text, financial_cost numeric, meta jsonb);
      CREATE TABLE votes(id bigint, motion_id bigint, person_id bigint, vote text);
      INSERT INTO organizations VALUES (10,1,'Council'),(20,2,'Council');
      INSERT INTO people VALUES (1,'A',null,true),(2,'B',null,true);
      INSERT INTO memberships VALUES (1,1,10,'2022-11-07',null),(2,2,10,'2022-11-07',null),(3,1,20,null,null);
      INSERT INTO meetings VALUES (1,1,'m1','One','2026-01-05'),(2,1,'m2','Two','2026-02-02'),(3,2,'other','Other','2026-03-02');
      -- 1 complete roll call, 2 named-dissent-only (excluded from alignment), 3 other municipality, 4 procedural, 5 no result, 6 no disposition
      INSERT INTO motions VALUES
        (1,1,'CARRIED','Passed','x','s',12.5,null),
        (2,2,'CARRIED','Passed','x',null,null,'{"individual_vote_coverage":"named_only","headline":"H"}'),
        (3,3,'CARRIED','Passed','x',null,null,null),
        (4,2,'CARRIED','Procedural','x',null,null,null),
        (5,2,null,'Passed','x',null,null,null),
        (6,2,'CARRIED',null,'x',null,null,null);
      INSERT INTO votes VALUES (1,1,1,'Yes'),(2,1,2,'No'),(3,2,1,'Yes'),(4,2,2,'Yes'),(5,3,1,'Yes'),(6,1,1,'Abstain');
    `);
  });
  afterAll(async () => { await db?.destroy(); await admin?.end(); });

  it("connects through getSql with numbers for bigint", async () => {
    const sql = getSql({ DATABASE_URL: url });
    try { expect((await sql`select 7::bigint as n, 1.5::numeric as d`)[0]).toEqual({ n: 7, d: 1.5 }); } finally { await sql.end(); }
  });

  it("alignment keeps this municipality's complete roll calls only", async () => {
    const result = await getVotingAlignmentSql(db, 1);
    expect(result.votes.map((v) => `${v.motion_id}:${v.person_id}:${v.vote}`)).toEqual(["1:1:Yes", "1:2:No"]);
    expect(result.votes[0].motions).toEqual({ vote_coverage: null, meeting_id: 1, meetings: { slug: "m1", meeting_date: "2026-01-05T00:00:00" } });
    expect(result.motions.map((m) => m.id)).toEqual([1, 2, 4, 5, 6]);
    expect(result.motions[0].votes.map((v) => v.id)).toEqual([1, 2, 6]);
    expect(result.memberships.map((m: any) => m.id)).toEqual([1, 2]);
    expect((result.memberships[0] as any).people).toEqual({ id: 1, name: "A", image_url: null });
  });

  it("alignment is empty without exactly one council", async () => {
    expect(await getVotingAlignmentSql(db, 99)).toEqual({ people: [], votes: [], motions: [], memberships: [] });
  });

  it("recent motions are decided, non-procedural, newest first, with votes", async () => {
    const rows = await recentMotionsSql(db, 1);
    // Motion 6 has no disposition: PostgREST's neq leaves it out, and so does this query.
    expect(rows.map((m) => m.id)).toEqual([2, 1]);
    expect(rows[0].headline).toBe("H");
    expect(rows[0].vote_coverage).toBe("named_only");
    expect(rows[1].financial_cost).toBe(12.5);
    expect(rows[1].votes.map((v) => v.vote).sort()).toEqual(["Abstain", "No", "Yes"]);
    expect(await recentMotionsSql(db, 1, 1)).toHaveLength(1);
  });
});
