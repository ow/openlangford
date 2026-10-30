import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

const migration = (name: string) => readFileSync(new URL(`../../../../supabase/migrations/${name}`, import.meta.url), "utf8");

let db: PGlite;
const rows = async <T = any>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE agenda_items(id bigint PRIMARY KEY, title text, category text);
    CREATE TABLE matters(id bigint PRIMARY KEY, title text, meta jsonb);
    INSERT INTO agenda_items VALUES
      (1, 'Public Participation', null),
      (2, 'Correspondence from residents about the skatepark', null),
      (3, 'Rezoning application for 2750 Leigh Road', 'Land use'),
      (4, 'Letter about parking', 'Public input');
    INSERT INTO matters VALUES (10, 'Rezoning 2750 Leigh Road', '{}'), (11, 'Old merged', '{"canonical_matter_id": 10}');
  `);
  await db.exec(migration("20261025203635_47_23_properties.sql"));
  await db.exec(migration("20261028054538_47_28_property_summaries.sql"));
  await db.exec(`
    INSERT INTO properties(id, slug, address, civic_number, street) VALUES
      (1, '12-oak-street', '12 Oak Street', '12', 'Oak Street'),          -- only a speaker's home
      (2, '2750-leigh-road', '2750 Leigh Road', '2750', 'Leigh Road'),   -- a rezoning (and a letter)
      (3, 'oak-street', 'Oak Street', '', 'Oak Street'),                 -- a street
      (4, '9-elm-street', '9 Elm Street', '9', 'Elm Street'),            -- a letter writer, under a matter
      (5, '7-pine-road', '7 Pine Road', '7', 'Pine Road');               -- public input link an admin hid
    INSERT INTO property_links(property_id, agenda_item_id, matter_id, source, hidden) VALUES
      (1, 1, null, 'item_address', false),
      (1, 2, null, 'item_address', false),
      (2, 3, 10, 'item_title', false),
      (2, 4, null, 'item_address', false),
      (3, 1, null, 'item_address', false),
      (4, 4, 10, 'item_address', false),
      (5, 4, null, 'item_address', true);
  `);
  await db.exec(migration("20261030202000_private_resident_addresses.sql"));
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("BEGIN");
});
afterEach(async () => {
  await db.exec("ROLLBACK");
});

it("hides lots known only from public input, and never streets or lots Council business named", async () => {
  expect(await rows("SELECT id, hidden FROM properties ORDER BY id")).toEqual([
    { id: 1, hidden: true },
    { id: 2, hidden: false },
    { id: 3, hidden: false },
    { id: 4, hidden: true },
    { id: 5, hidden: true },
  ]);
});

it("keeps hidden lots out of what the public key can read", async () => {
  await db.exec("SET LOCAL ROLE anon");
  expect(await rows("SELECT id FROM properties ORDER BY id")).toEqual([{ id: 2 }, { id: 3 }]);
  expect((await rows("SELECT DISTINCT property_id FROM property_links ORDER BY 1")).map((r) => r.property_id)).toEqual([2, 3]);
  await expect(db.query("UPDATE properties SET hidden = false")).rejects.toThrow(/permission denied/);
});

it("starts new lots hidden, and shows a lot once Council business names it", async () => {
  await db.exec(`INSERT INTO properties(id, slug, address, civic_number, street) VALUES (6, '1-new-road', '1 New Road', '1', 'New Road')`);
  expect(await rows("SELECT hidden FROM properties WHERE id = 6")).toEqual([{ hidden: true }]);
  await db.exec(`INSERT INTO property_links(property_id, agenda_item_id, matter_id, source) VALUES (6, 3, 10, 'item_title'), (1, 3, 10, 'item_title')`);
  expect(await rows("SELECT refresh_property_privacy(true) s")).toEqual([{ s: { dry_run: true, hidden: 2, changed: 2 } }]);
  expect(await rows("SELECT hidden FROM properties WHERE id IN (1, 6)")).toEqual([{ hidden: true }, { hidden: true }]);
  expect(await rows("SELECT refresh_property_privacy() s")).toEqual([{ s: { dry_run: false, hidden: 2, changed: 2 } }]);
  expect(await rows("SELECT id FROM properties WHERE hidden ORDER BY id")).toEqual([{ id: 4 }, { id: 5 }]);
});

it("can't be run by visitors or signed-in accounts", async () => {
  await db.exec("SET LOCAL ROLE authenticated");
  await expect(db.query("SELECT refresh_property_privacy()")).rejects.toThrow(/permission denied/);
});
