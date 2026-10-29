import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calculateAttendance, attendanceState, attendanceEvidence } from "../../app/lib/attendance-evidence";

// Run against an explicitly created disposable local container, never production.
const container = process.env.LANGFORD_TEST_PG_CONTAINER;
const command = (statement: string, database = "langford_attendance_test") => {
  const directory = mkdtempSync(join(tmpdir(), "langford-sql-"));
  const file = join(directory, "query.sql");
  const remote = `/tmp/${basename(directory)}.sql`;
  // A file avoids Docker's interactive stdin occasionally remaining open after large fixtures.
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
const literal = (value: unknown) => value == null ? "NULL" : "'" + String(value).replaceAll("'", "''") + "'";
const records: any[] = [];
const meetings: any[] = [];
const people = [
  { id: 1, memberships: [{ organization_id: 10, start_date: "2016-01-01", end_date: "2021-12-31" }, { organization_id: 10, start_date: "2022-11-07", end_date: null }] },
  { id: 2, memberships: [{ organization_id: 10, start_date: "2018-01-01", end_date: "2020-12-31" }, { organization_id: 10, start_date: "2024-01-01", end_date: null }] },
  { id: 3, memberships: [{ organization_id: 10, start_date: "2026-11-02", end_date: null }] },
  { id: 4, memberships: [{ organization_id: 10, start_date: null, end_date: null }] },
];
const terms = [{ id: 11, start: "2016-01-01", end: "2022-11-06" }, { id: 12, start: "2022-11-07", end: "2026-11-01" }, { id: 13, start: "2026-11-02", end: "2030-11-01" }];
const evidence = (person: number, meeting: number, date: string, state = "present", extra = {}) => JSON.stringify({ schema: "council-attendance/v1", method: "original_roster", person_id: person, meeting_id: meeting, local_date: date, state, source_url: "https://langford.ca/minutes.pdf", source_sha256: "a".repeat(64), source_page: 1, source_quote: "Present", ...extra });
const add = (date: string, overrides = {}) => { const m = { id: meetings.length + 1, organization_id: 10, municipality_id: 1, meeting_date: date, status: "Completed", has_minutes: true, ...overrides }; meetings.push(m); return m; };

describe.skipIf(!container)("Postgres attendance aggregation parity and transfer", () => {
  beforeAll(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    command("DROP DATABASE IF EXISTS langford_attendance_test; CREATE DATABASE langford_attendance_test;", "postgres");
    command("DO $roles$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $roles$;", "postgres");
    sql(`
      CREATE TABLE organizations(id bigint, municipality_id bigint, classification text);
      CREATE TABLE memberships(person_id bigint, organization_id bigint, start_date date, end_date date);
      CREATE TABLE council_terms(id bigint, municipality_id bigint, start_date date, end_date date);
      CREATE TABLE meetings(id bigint, organization_id bigint, municipality_id bigint, meeting_date date, status text, has_agenda boolean, has_minutes boolean, has_transcript boolean, summary text);
      CREATE TABLE attendance(id bigint, meeting_id bigint, person_id bigint, attendance_mode text, notes text);
      INSERT INTO organizations VALUES(10,1,'Council'),(20,2,'Council');
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;`);
    const migration = readFileSync(new URL("../../../../supabase/migrations/20261021041012_47_17_council_attendance_summaries.sql", import.meta.url), "utf8");
    sql(migration); sql(migration); // Applying the additive definition twice is safe.
    const old = add("2016-01-01"), gap = add("2022-05-01"), start = add("2022-11-07"), current = add("2026-01-01"), missing = add("2026-02-01");
    add("2026-03-01", { status: "Cancelled" }); add("2026-03-02", { status: "cAnCeLeD" }); add("2026-11-02");
    add("2026-04-01", { has_minutes: false }); add("2026-04-02", { organization_id: 20, municipality_id: 2 });
    records.push({ person_id: 1, meeting_id: old.id, attendance_mode: "In Person", notes: evidence(1, old.id, old.meeting_date) },
      { person_id: 1, meeting_id: gap.id, attendance_mode: "In Person", notes: evidence(1, gap.id, gap.meeting_date) },
      { person_id: 1, meeting_id: start.id, attendance_mode: "In Person", notes: "" },
      { person_id: 1, meeting_id: current.id, attendance_mode: "Absent", notes: evidence(1, current.id, current.meeting_date, "absent") },
      { person_id: 2, meeting_id: current.id, attendance_mode: "In Person", notes: "" },
      { person_id: 2, meeting_id: current.id, attendance_mode: "Absent", notes: "" });
    // Include a large source history without changing this member's evidence results.
    for (let i = 0; i < 1200; i++) records.push({ person_id: 4, meeting_id: missing.id, attendance_mode: "Unknown", notes: "unverified source note ".repeat(100) });
    let setup = "";
    for (const person of people) for (const m of person.memberships) setup += `INSERT INTO memberships VALUES(${person.id},${m.organization_id},${literal(m.start_date)},${literal(m.end_date)});`;
    setup += "INSERT INTO memberships VALUES(9,20,'2016-01-01',NULL);";
    for (const t of terms) setup += `INSERT INTO council_terms VALUES(${t.id},1,${literal(t.start)},${literal(t.end)});`;
    for (const m of meetings) setup += `INSERT INTO meetings VALUES(${m.id},${m.organization_id},${m.municipality_id},${literal(m.meeting_date)},${literal(m.status)},false,${m.has_minutes},false,NULL);`;
    for (let i = 0; i < records.length; i++) { const r = records[i]; setup += `INSERT INTO attendance VALUES(${i + 1},${r.meeting_id},${r.person_id},${literal(r.attendance_mode)},${literal(r.notes)});`; }
    sql(setup);
  }, 30_000);
  afterAll(() => vi.useRealTimers());

  it("returns the same all-time and term results as the existing JS evidence calculation", () => {
    const rows = JSON.parse(sql("SELECT coalesce(json_agg(s),'[]') FROM council_attendance_summaries(1,'2026-10-21') s;"));
    const ready = meetings.filter(m => m.has_minutes);
    for (const person of people) for (const period of [...terms, { id: "all", start: "0001-01-01", end: "2026-10-21" }]) {
      const row = rows.find((r: any) => r.person_id === person.id && r.term_key === String(period.id));
      const { person_id, term_key, ...actual } = row;
      expect(actual).toEqual(calculateAttendance(person as any, ready as any, records as any, 10, { start: period.start, end: period.end < "2026-10-21" ? period.end : "2026-10-21" }));
    }
    expect(rows).toHaveLength(16);
    expect(rows.some((r: any) => r.person_id === 9)).toBe(false);
  });

  it("matches malformed, date-mismatched, coerced and whitespace source evidence without changing unknowns", () => {
    const base = evidence(1, 1, "2026-01-01");
    let deeplyNested: any = "https://langford.ca/source";
    for (let i = 0; i < 1000; i++) deeplyNested = [deeplyNested];
    const notes = [evidence(1, 1, "2026-01-01", "present", { source_url: deeplyNested }), null, "", "  \t\n", "legacy AI notes", "{bad", "null", "[]", base,
      evidence(1, 1, "2026-01-02"), evidence(1, 1, "2026-01-01", "absent"), evidence(2, 1, "2026-01-01"),
      ...["1", 0, 1.5, null].map(source_page => evidence(1, 1, "2026-01-01", "present", { source_page })),
      ...["", "\u00a0\ufeff\t", "\u0000", "\\u0000", "\ud800\udc00", 4].map(source_quote => evidence(1, 1, "2026-01-01", "present", { source_quote })),
      evidence(1, 1, "2026-01-01", "present", { source_url: ["https://langford.ca/source"], source_sha256: [["a".repeat(64)]] }),
    ];
    const cases = notes.flatMap(note => ["In Person", "Absent", "Regrets", "Remote", "Unknown"].map(mode => ({ note, mode })));
    const query = cases.map((c, i) => `SELECT ${i} AS n,s.* FROM _council_attendance_state(${literal(c.note)},${literal(c.mode)},1,1,'2026-01-01') s`).join(" UNION ALL ");
    const rows = JSON.parse(sql(`SET DateStyle = 'SQL, DMY'; SELECT json_agg(t ORDER BY n) FROM (${query}) t;`));
    for (let i = 0; i < cases.length; i++) {
      const record = { notes: cases[i].note, attendance_mode: cases[i].mode, person_id: 1, meeting_id: 1 } as any;
      expect(rows[i].state, `case ${i}`).toBe(attendanceState(record, "2026-01-01"));
      expect(rows[i].verified, `case ${i}`).toBe(attendanceEvidence(record)?.local_date === "2026-01-01");
    }
  }, 30_000);

  it("transfers compact SQL results rather than history and leaves records unchanged", () => {
    const before = sql("SELECT md5(json_agg(a ORDER BY id)::text) FROM attendance a;");
    const rows = sql("SET ROLE service_role; SELECT json_agg(s) FROM council_attendance_summaries(1,'2026-10-21') s;");
    const rawBytes = Number(sql("SELECT octet_length(json_agg(a)::text) FROM attendance a;"));
    expect(Buffer.byteLength(rows)).toBeLessThan(5000); expect(rawBytes).toBeGreaterThan(2_000_000);
    console.info(JSON.stringify({ sqlSummaryBytes: Buffer.byteLength(rows), rawHistoryBytes: rawBytes }));
    expect(sql("SELECT md5(json_agg(a ORDER BY id)::text) FROM attendance a;")).toBe(before);
    expect(() => sql("SET ROLE anon; SELECT * FROM council_attendance_summaries(1,'2026-10-21');")).toThrow();
  }, 30_000);
  it.skipIf(!process.env.LANGFORD_ATTENDANCE_FIXTURE_PATH)("matches the captured public council dataset without sending its attendance history back", () => {
    const fixture = JSON.parse(readFileSync(process.env.LANGFORD_ATTENDANCE_FIXTURE_PATH!, "utf8"));
    const raw = fixture.rawData;
    sql("TRUNCATE organizations,memberships,council_terms,meetings,attendance;");
    let setup = `INSERT INTO organizations VALUES(${raw.councilId},1,'Council');`;
    for (const person of raw.people) for (const m of person.memberships) setup += `INSERT INTO memberships VALUES(${person.id},${m.organization_id},${literal(m.start_date)},${literal(m.end_date)});`;
    for (const t of fixture.terms) setup += `INSERT INTO council_terms VALUES(${t.id},1,${literal(t.start_date)},${literal(t.end_date)});`;
    for (const m of raw.meetings) setup += `INSERT INTO meetings VALUES(${m.id},${m.organization_id},1,${literal(m.meeting_date)},${literal(m.status)},false,true,false,NULL);`;
    for (let i = 0; i < raw.attendance.length; i++) { const r = raw.attendance[i]; setup += `INSERT INTO attendance VALUES(${i+1},${r.meeting_id},${r.person_id},${literal(r.attendance_mode)},${literal(r.notes)});`; }
    sql(setup);
    vi.setSystemTime(new Date(`${fixture.today}T20:00:00Z`));
    const result = sql(`SELECT json_agg(s) FROM council_attendance_summaries(1,${literal(fixture.today)}) s;`);
    const rows = JSON.parse(result);
    let checked = 0;
    for (const person of raw.people) for (const term of [...fixture.terms, { id: "all", start_date: "0001-01-01", end_date: fixture.today }]) {
      const row = rows.find((r: any) => r.person_id === person.id && r.term_key === String(term.id));
      const { person_id, term_key, ...actual } = row;
      expect(actual).toEqual(calculateAttendance(person,raw.meetings,raw.attendance,raw.councilId,{start:term.start_date,end:term.end_date && term.end_date < fixture.today ? term.end_date : fixture.today}));
      checked++;
    }
    console.info(JSON.stringify({ capturedMemberTermsMatched: checked, sqlResponseBytes: Buffer.byteLength(result), sourceHistoryJsonBytes: Buffer.byteLength(JSON.stringify(raw.attendance)) }));
  }, 30_000);

});
