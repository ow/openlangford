import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { sitemapEntries, sitemapIndexEntries } from "../../app/services/sitemap.server";

// Bulk backfills touched updated_at on every matter and property; lastmod must follow council activity instead.
const tables: Record<string, any[]> = {
  municipalities: [{ id: 1, slug: "langford" }],
  matters: [
    { id: 1, slug: "old-rezoning", first_seen: "2019-02-04", last_seen: "2019-06-17", updated_at: "2026-10-27T18:00:00+00:00" },
    { id: 2, slug: "new-item", first_seen: "2026-09-08", last_seen: null, updated_at: "2026-10-27T18:00:00+00:00" },
  ],
  properties: [
    { id: 10, slug: "2140-caribou-drive", street: "Caribou Drive", civic_number: "2140", updated_at: "2026-10-27T18:00:00+00:00" },
    { id: 11, slug: "caribou-drive", street: "Caribou Drive", civic_number: "", updated_at: "2026-10-27T18:00:00+00:00" },
    { id: 12, slug: "9-nowhere-road", street: "Nowhere Road", civic_number: "9", updated_at: "2026-10-27T18:00:00+00:00" },
  ],
  property_links: [
    { id: 1, property_id: 10, agenda_items: { meetings: { meeting_date: "2024-03-18" } }, matters: null },
    { id: 2, property_id: 10, agenda_items: null, matters: { last_seen: "2025-01-20" } },
  ],
  meetings: [{ id: 7, slug: "2027-01-11-regular-council", meeting_date: "2027-01-11", updated_at: "2026-10-20T03:00:00+00:00" }],
  documents: [], extracted_documents: [], bylaws: [], people: [], elections: [],
};
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const table = new URL(String(input)).pathname.split("/").pop()!;
  if (!(table in tables)) return Response.json({ message: "unexpected" }, { status: 500 });
  return Response.json(table === "municipalities" ? tables[table][0] : tables[table]);
});
beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-27T20:00:00Z")); });
afterAll(() => { vi.useRealTimers(); });
const client = createClient("https://example.supabase.co", "synthetic-key", { auth: { persistSession: false }, global: { fetch: fetchMock as typeof fetch } });

it("dates matters by their latest meeting, not the bulk-touched updated_at", async () => {
  expect(await sitemapEntries(client, "matters")).toMatchObject([
    { path: "/matters/old-rezoning", lastmod: "2019-06-17" },
    { path: "/matters/new-item", lastmod: "2026-09-08" },
  ]);
});

it("dates properties by their latest linked meeting, and streets by their newest lot", async () => {
  const entries = await sitemapEntries(client, "properties");
  expect(entries).toEqual([
    expect.objectContaining({ path: "/properties/2140-caribou-drive", lastmod: "2025-01-20" }),
    expect.objectContaining({ path: "/properties/caribou-drive", lastmod: "2025-01-20" }),
  ]);
});

it("gives the index each section's newest real date, never a future one, and none for failing sections", async () => {
  const index = await sitemapIndexEntries(client, "2026-10-27");
  const lastmod = (section: string) => index.find((s) => s.path === `/sitemaps/${section}.xml`)?.lastmod;
  expect(lastmod("matters")).toBe("2026-09-08");
  expect(lastmod("properties")).toBe("2025-01-20");
  // The only meeting is scheduled; its updated_at (03:00 UTC) is the 19th in Langford.
  expect(lastmod("meetings")).toBe("2026-10-19");
  expect(lastmod("pages")).toBeNull();
});
