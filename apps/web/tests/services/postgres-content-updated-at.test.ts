import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// matters.content_updated_at triggers (supabase/migrations/20261108100000_matters_content_updated_at.sql), run
// against an explicitly created disposable local container, never production:
//   docker run -d --rm --name langford-pg -e POSTGRES_PASSWORD=pw postgres:17-alpine
//   LANGFORD_TEST_PG_CONTAINER=langford-pg npx vitest run tests/services/postgres-content-updated-at.test.ts
const container = process.env.LANGFORD_TEST_PG_CONTAINER;
const DB = "langford_content_updated_test";
const command = (statement: string, database = DB) => {
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
const root = new URL("../../../../supabase/migrations/", import.meta.url);
const baseline = () => readFileSync(new URL("20261107000000_baseline.sql", root), "utf8");
const migration = () => readFileSync(new URL("20261108100000_matters_content_updated_at.sql", root), "utf8");

/** The live definitions of the existing functions/triggers these tables carry, so the test runs against them. */
function baselinePieces() {
  const text = baseline();
  const fn = (name: string) => {
    const start = text.indexOf(`CREATE FUNCTION public.${name}(`);
    if (start < 0) throw new Error(`baseline has no ${name}`);
    return text.slice(start, text.indexOf("\n--\n", start)) + "\n";
  };
  const triggers = text.split("\n").filter((line) =>
    /^CREATE TRIGGER (set_timestamp_matters|flatten_matter_merge|redirect_merged_matter|drop_own_mention) /.test(line)
    && / ON public\.(matters|agenda_items|matter_links|matter_evidence|matter_report_mentions) /.test(line));
  expect(triggers.length).toBe(7);
  return [
    ...["update_timestamp", "matter_root", "redirect_merged_matter", "redirect_merged_matter_link", "flatten_matter_merge", "drop_own_mention"].map(fn),
    ...triggers,
  ].join("\n");
}

const stamp = (id: number) => sql(`SELECT content_updated_at::date FROM matters WHERE id = ${id};`);
const OLD = "2020-01-01";
/** Put every topic's stamp back in the past, so a fresh bump shows as today. */
const reset = () => sql(`UPDATE matters SET content_updated_at = '${OLD}';`);
const today = () => sql("SELECT now()::date;");

// Each statement is a docker exec, so a test takes a few seconds and longer when the suite runs in parallel.
describe.skipIf(!container)("matters.content_updated_at triggers", { timeout: 30_000 }, () => {
  beforeAll(() => {
    command(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB};`, "postgres");
    command("DO $roles$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $roles$;", "postgres");
    // The columns the triggers read, typed as in the baseline (embedding and text_search left out: they need pgvector).
    sql(`
      CREATE TABLE matters(id bigint PRIMARY KEY, title text NOT NULL, identifier text, description text, plain_english_summary text,
        category text, status text DEFAULT 'Active', first_seen date, last_seen date, meta jsonb,
        created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL, slug text NOT NULL,
        bylaw_id bigint, merged_into bigint REFERENCES matters(id) ON DELETE SET NULL);
      CREATE TABLE agenda_items(id bigint PRIMARY KEY, matter_id bigint REFERENCES matters(id) ON DELETE SET NULL, title text, updated_at timestamptz DEFAULT now());
      CREATE TABLE matter_links(id bigserial PRIMARY KEY, matter_id bigint NOT NULL REFERENCES matters(id) ON DELETE CASCADE, kind text NOT NULL,
        related_matter_id bigint REFERENCES matters(id) ON DELETE CASCADE, agenda_item_id bigint, quote text, hidden boolean DEFAULT false NOT NULL);
      CREATE TABLE matter_evidence(id bigserial PRIMARY KEY, matter_id bigint NOT NULL REFERENCES matters(id) ON DELETE CASCADE, agenda_item_id bigint,
        document_section_id bigint, hidden boolean DEFAULT false NOT NULL, reason text, updated_at timestamptz DEFAULT now());
      CREATE TABLE matter_report_mentions(id bigserial PRIMARY KEY, matter_id bigint NOT NULL REFERENCES matters(id) ON DELETE CASCADE, report_id bigint NOT NULL,
        page integer NOT NULL, quote text NOT NULL, hidden boolean DEFAULT false NOT NULL, confidence real);
      INSERT INTO matters(id, title, slug, first_seen, last_seen, created_at) VALUES
        (1, 'Rezoning A', 'a', '2024-01-08', '2025-03-03', '2023-06-01'), (2, 'Rezoning B', 'b', '2022-05-02', NULL, '2023-06-01'),
        (3, 'Rezoning C', 'c', NULL, NULL, '2023-06-01T12:00:00Z');
      INSERT INTO agenda_items(id, matter_id) VALUES (10, 1), (11, 1);
      ${baselinePieces()}
    `);
    sql(migration());
    sql(migration()); // Re-running the definitions is harmless.
  }, 60_000);

  it("backfills from the meeting dates, not today", () => {
    // Re-applying the migration leaves earlier values alone, so these are from the first run.
    expect(sql("SELECT string_agg(id || '=' || (content_updated_at AT TIME ZONE 'UTC')::date, ',' ORDER BY id) FROM matters;"))
      .toBe("1=2025-03-03,2=2022-05-02,3=2023-06-01");
  });

  it("stamps a new topic on insert", () => {
    sql("INSERT INTO matters(id, title, slug) VALUES (4, 'New', 'new');");
    expect(stamp(4)).toBe(today());
  });

  it("bumps on a summary change but not on a version stamp, an unchanged write or bookkeeping", () => {
    reset();
    sql(`UPDATE matters SET meta = '{"summary_version": 3, "images_version": 2, "summary_check": {"problems": 0}}' WHERE id = 1;`);
    sql("UPDATE matters SET title = title, updated_at = now() WHERE id = 1;");
    expect(stamp(1)).toBe(OLD);
    sql("UPDATE matters SET plain_english_summary = 'Council approved the rezoning.' WHERE id = 1;");
    expect(stamp(1)).toBe(today());
  });

  it("bumps on the visible parts of meta", () => {
    for (const change of [`'{"display_title": "Short"}'`, `meta || '{"status_line": "Adopted May 2026"}'`, `meta || '{"timeline_headlines": {"10": "Approved"}}'`, `meta || '{"hidden": "staff"}'`]) {
      reset();
      sql(`UPDATE matters SET meta = ${change} WHERE id = 2;`);
      expect(stamp(2), change).toBe(today());
    }
    reset();
    // Same visible content in a different key order, plus a new version stamp: no change a reader sees.
    sql(`UPDATE matters SET meta = '{"hidden": "staff", "timeline_headlines": {"10": "Approved"}, "status_line": "Adopted May 2026", "display_title": "Short", "summary_version": 9}' WHERE id = 2;`);
    expect(stamp(2)).toBe(OLD);
  });

  it("bumps both topics when an agenda item moves, and on adding or removing one", () => {
    reset();
    sql("UPDATE agenda_items SET matter_id = 2 WHERE id = 10;");
    expect([stamp(1), stamp(2), stamp(3)]).toEqual([today(), today(), OLD]);
    reset();
    sql("UPDATE agenda_items SET title = 'Renamed' WHERE id = 10;");
    expect([stamp(1), stamp(2)]).toEqual([OLD, OLD]);
    sql("INSERT INTO agenda_items(id, matter_id) VALUES (12, 3);");
    expect(stamp(3)).toBe(today());
    reset();
    sql("DELETE FROM agenda_items WHERE id = 12;");
    expect(stamp(3)).toBe(today());
  });

  it("bumps when a link is hidden or added, on both sides of a related-topic link, but not for hidden rows", () => {
    reset();
    sql("INSERT INTO matter_links(matter_id, kind, agenda_item_id, quote, hidden) VALUES (1, 'mention', 99, 'Suggested', true);");
    expect(stamp(1)).toBe(OLD);
    sql("INSERT INTO matter_links(matter_id, kind, related_matter_id) VALUES (1, 'related_matter', 3);");
    expect([stamp(1), stamp(3)]).toEqual([today(), today()]);
    reset();
    sql("UPDATE matter_links SET hidden = true WHERE kind = 'related_matter';");
    expect([stamp(1), stamp(3)]).toEqual([today(), today()]);
    reset();
    sql("DELETE FROM matter_links WHERE hidden;");
    expect([stamp(1), stamp(3)]).toEqual([OLD, OLD]);
  });

  it("bumps for evidence and report mentions, and follows a merged topic's redirect", () => {
    reset();
    sql("INSERT INTO matter_evidence(matter_id, agenda_item_id) VALUES (2, 11);");
    expect(stamp(2)).toBe(today());
    reset();
    sql("UPDATE matter_evidence SET reason = 'note' WHERE matter_id = 2;");
    expect(stamp(2)).toBe(OLD);
    sql("UPDATE matter_evidence SET hidden = true WHERE matter_id = 2;");
    expect(stamp(2)).toBe(today());
    reset();
    sql("INSERT INTO matter_report_mentions(matter_id, report_id, page, quote) VALUES (3, 1, 4, 'Rezoning C');");
    expect(stamp(3)).toBe(today());
    reset();
    sql("UPDATE matter_report_mentions SET confidence = 0.9;");
    expect(stamp(3)).toBe(OLD);
    // Topic 4 merged into 1 (that bumps 4 itself); a mention filed under 4 lands on 1 and bumps 1.
    sql("UPDATE matters SET merged_into = 1 WHERE id = 4;");
    expect(stamp(4)).toBe(today());
    reset();
    sql("INSERT INTO matter_report_mentions(matter_id, report_id, page, quote) VALUES (4, 2, 1, 'New');");
    expect([stamp(1), stamp(4)]).toEqual([today(), OLD]);
  });

  it("deleting a topic still works and bumps the topics that listed it", () => {
    reset();
    sql("INSERT INTO matter_links(matter_id, kind, related_matter_id) VALUES (2, 'related_matter', 3);");
    reset();
    sql("DELETE FROM matters WHERE id = 3;");
    expect([stamp(1), stamp(2)]).toEqual([OLD, today()]);
  });
});
