import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Run against an explicitly created disposable local container, never production.
const container = process.env.LANGFORD_TEST_PG_CONTAINER;
const command = (statement: string, database = "langford_participants_test") => {
  const directory = mkdtempSync(join(tmpdir(), "langford-sql-"));
  const file = join(directory, "query.sql");
  const remote = `/tmp/${basename(directory)}.sql`;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
  try {
    writeFileSync(file, statement);
    docker(["cp", file, `${container}:${remote}`]);
    return docker(["exec", container!, "psql", "-U", "postgres", "-d", database, "-Atq", "-v", "ON_ERROR_STOP=1", "-f", remote]).trim();
  } finally {
    try { docker(["exec", container!, "rm", "-f", remote]); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
};
const sql = (statement: string) => command(statement);
const call = (today: string, municipality: number | null = null, person: number | null = null) =>
  JSON.parse(sql(`SELECT public_participant_appearances('${today}', ${municipality ?? "NULL"}, ${person ?? "NULL"});`));

const meetings = [
  { id: 1, slug: "m-1", title: "Council", meeting_date: "2024-01-01", municipality_id: 1, organization_id: 10 },
  { id: 2, slug: "m-2", title: "Committee", meeting_date: "2024-02-01", municipality_id: 1, organization_id: 11 },
  { id: 3, slug: "m-3", title: "Elsewhere", meeting_date: "2024-03-01", municipality_id: 2, organization_id: null },
  { id: 4, slug: "m-4", title: "Future", meeting_date: "2026-11-05", municipality_id: 1, organization_id: 10 },
];
const items = [{ id: 20, title: "Rezoning", category: "Land Use" }, { id: 21, title: "Budget", category: null }];
// [id, person, meeting, agenda item, start, end]
const segments: [number, number | null, number, number | null, string, string][] = [
  [1, 5, 1, 21, "900.5", "960.25"], [2, 5, 1, 20, "100.1", "160.2"], [3, 5, 1, 20, "50.3", "70.7"],
  [4, 5, 1, 20, "200", "200"], [5, 5, 1, 20, "300", "250"], [6, 5, 1, 20, "'NaN'", "'NaN'"], [7, 5, 1, 20, "0", "'Infinity'"],
  [8, null, 1, 20, "0", "30"], [9, 6, 1, null, "10", "20"], [10, 6, 2, null, "5.5", "9"], [11, 5, 3, null, "1", "2"],
  [12, 5, 4, 20, "1", "2"], [13, 6, 1, null, "0.1", "0.3"], [14, 6, 1, null, "0.2", "0.5"], [15, 7, 1, 20, "400", "400"],
];

describe.skipIf(!container)("public_participant_appearances against Postgres", () => {
  beforeAll(() => {
    command("DROP DATABASE IF EXISTS langford_participants_test; CREATE DATABASE langford_participants_test;", "postgres");
    command("DO $roles$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $roles$;", "postgres");
    sql(`
      CREATE TABLE meetings(id bigint PRIMARY KEY, slug text NOT NULL, title text NOT NULL, meeting_date date NOT NULL, municipality_id bigint, organization_id bigint);
      CREATE TABLE agenda_items(id bigint PRIMARY KEY, title text NOT NULL, category text);
      CREATE TABLE transcript_segments(id bigint PRIMARY KEY, person_id bigint, meeting_id bigint NOT NULL, agenda_item_id bigint,
        start_time double precision NOT NULL, end_time double precision NOT NULL, text_content text);
      CREATE INDEX ON transcript_segments(person_id);
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
      ${meetings.map(m => `INSERT INTO meetings VALUES(${m.id},'${m.slug}','${m.title}','${m.meeting_date}',${m.municipality_id},${m.organization_id ?? "NULL"});`).join("")}
      ${items.map(i => `INSERT INTO agenda_items VALUES(${i.id},'${i.title}',${i.category ? `'${i.category}'` : "NULL"});`).join("")}
      ${segments.map(([id, person, meeting, item, start, end]) =>
        `INSERT INTO transcript_segments VALUES(${id},${person ?? "NULL"},${meeting},${item ?? "NULL"},${start},${end},'words');`).join("")}`);
    const migration = readFileSync(new URL("../../../../supabase/migrations_archive/20261104100000_public_participant_appearances.sql", import.meta.url), "utf8");
    sql(migration); sql(migration); // Re-applying the definition is safe.
  }, 30_000);

  it("groups identified, finite, positive-length past segments into appearances in first-segment order", () => {
    const rows = call("2026-11-03", 1);
    expect(rows.map((r: any) => [r.person_id, r.meeting_id, r.agenda_item_id, r.segments, r.first_start])).toEqual([
      [5, 1, 21, 1, 900.5], [5, 1, 20, 2, 50.3], [6, 1, null, 3, 0.1], [6, 2, null, 1, 5.5]]);
    // Seconds are summed in segment id order, as the web code summed them.
    expect(rows.map((r: any) => r.seconds)).toEqual([960.25 - 900.5, (160.2 - 100.1) + (70.7 - 50.3), (20 - 10) + (0.3 - 0.1) + (0.5 - 0.2), 9 - 5.5]);
    expect(rows[0]).toEqual({ person_id: 5, meeting_id: 1, agenda_item_id: 21, seconds: 960.25 - 900.5, segments: 1, first_start: 900.5,
      meeting_slug: "m-1", meeting_title: "Council", meeting_date: "2024-01-01", municipality_id: 1, organization_id: 10,
      agenda_title: "Budget", category: null });
    expect(rows[3]).toMatchObject({ meeting_title: "Committee", organization_id: 11, agenda_title: null, category: null });
  });

  it("returns seconds at full double precision whatever the session's float output setting", () => {
    const rows = JSON.parse(sql(`BEGIN; INSERT INTO transcript_segments VALUES(16, 8, 1, NULL, 0.1, 0.3, 'words');
      SET LOCAL extra_float_digits = 0; SELECT public_participant_appearances('2026-11-03', 1, 8); ROLLBACK;`));
    // 0.3 - 0.1 is 0.19999999999999998; 15-digit output would round it to 0.2.
    expect(rows.map((r: any) => r.seconds)).toEqual([0.3 - 0.1]);
  });

  it("scopes by civic day, municipality and person", () => {
    const all = call("2026-11-03", 1);
    expect(call("2026-11-05", 1).map((r: any) => r.meeting_id)).toContain(4);
    expect(call("2024-01-31", 1).map((r: any) => r.meeting_id)).toEqual([1, 1, 1]);
    expect(call("2026-11-03").map((r: any) => r.meeting_id)).toEqual([1, 1, 1, 2, 3]);
    expect(call("2026-11-03", 2)).toEqual([{ person_id: 5, meeting_id: 3, agenda_item_id: null, seconds: 1, segments: 1, first_start: 1,
      meeting_slug: "m-3", meeting_title: "Elsewhere", meeting_date: "2024-03-01", municipality_id: 2, organization_id: null, agenda_title: null, category: null }]);
    for (const person of [5, 6]) expect(call("2026-11-03", 1, person)).toEqual(all.filter((r: any) => r.person_id === person));
    expect(call("2026-11-03", 1, 7)).toEqual([]);
    expect(call("2026-11-03", 1, 999)).toEqual([]);
  });

  it("is callable by the service role only and changes nothing", () => {
    const before = sql("SELECT md5(json_agg(t ORDER BY id)::text) FROM transcript_segments t;");
    expect(JSON.parse(sql("SET ROLE service_role; SELECT public_participant_appearances('2026-11-03', 1, NULL);"))).toHaveLength(4);
    for (const role of ["anon", "authenticated"]) {
      expect(() => sql(`SET ROLE ${role}; SELECT public_participant_appearances('2026-11-03', 1, NULL);`)).toThrow(/permission denied/);
    }
    expect(sql("SELECT provolatile FROM pg_proc WHERE proname = 'public_participant_appearances';")).toBe("s");
    expect(sql("SELECT md5(json_agg(t ORDER BY id)::text) FROM transcript_segments t;")).toBe(before);
  });
});
