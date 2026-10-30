import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, it, vi } from "vitest";
import {
  getPropertiesForItems,
  getPropertiesForMatter,
  getPropertiesIndex,
  getPropertyBySlug,
  getPropertyPinsByMatter,
} from "~/services/properties";
import { sitemapEntries } from "~/services/sitemap.server";

// A resident's home known only from public input (hidden) beside a rezoning site on the same street.
const geo = { lat: 48.45, lng: -123.5, precision: "address" };
const visible = { id: 1, slug: "2750-leigh-road", address: "2750 Leigh Road", civic_number: "2750", street: "Leigh Road", geo, meta: {}, hidden: false, municipality_id: 1 };
const home = { id: 2, slug: "2754-leigh-road", address: "2754 Leigh Road", civic_number: "2754", street: "Leigh Road", geo: { ...geo, lat: 48.4501 }, meta: {}, hidden: true, municipality_id: 1 };
const street = { id: 3, slug: "leigh-road", address: "Leigh Road", civic_number: "", street: "Leigh Road", geo: null, meta: {}, hidden: false, municipality_id: 1 };
const rezoning = { id: 50, title: "Rezoning", category: "Land use", meetings: { id: 7, slug: "council", title: "Council", meeting_date: "2026-05-01" } };
const letter = { id: 51, title: "Correspondence", category: "Public input", meetings: { id: 7, slug: "council", title: "Council", meeting_date: "2026-05-01" } };
const links = [
  { id: 1, property_id: 1, agenda_item_id: 50, matter_id: 10, hidden: false, agenda_items: rezoning, properties: visible },
  { id: 2, property_id: 2, agenda_item_id: 51, matter_id: 10, hidden: false, agenda_items: letter, properties: home },
];

const requests: URL[] = [];
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  requests.push(url);
  const table = url.pathname.split("/").pop()!;
  const single = url.searchParams.has("slug");
  let rows: any[] = [];
  if (table === "properties") {
    rows = [visible, home, street];
    // Honour the filters the code under test sends.
    if (url.searchParams.get("hidden") === "eq.false") rows = rows.filter((p) => !p.hidden);
    if (url.searchParams.get("slug")) rows = rows.filter((p) => `eq.${p.slug}` === url.searchParams.get("slug"));
    if (url.searchParams.get("civic_number") === "neq.") rows = rows.filter((p) => p.civic_number !== "");
    const ids = url.searchParams.get("id")?.match(/^in\.\((.*)\)$/)?.[1];
    if (ids) rows = rows.filter((p) => ids.split(",").includes(String(p.id)));
  } else if (table === "property_links") {
    rows = links;
  } else if (table === "matters") {
    rows = [{ id: 10, slug: "rezoning", title: "Rezoning", status: "Active", first_seen: "2026-05-01", last_seen: "2026-05-01", meta: {} }];
  } else if (table === "agenda_items") {
    rows = [];
  }
  return single ? Response.json(rows[0] ?? null, { status: rows[0] ? 200 : 406 }) : Response.json(rows);
});
const client = createClient("https://example.supabase.co", "synthetic-key", { auth: { persistSession: false }, global: { fetch: fetchMock as typeof fetch } });

beforeEach(() => {
  requests.length = 0;
});

it("has no page for a hidden lot", async () => {
  expect(await getPropertyBySlug(client, home.slug)).toBeNull();
  expect(requests[0].searchParams.get("hidden")).toBe("eq.false");
});

it("leaves hidden lots off the street page and out of nearby", async () => {
  const page = (await getPropertyBySlug(client, street.slug))!;
  expect(page.lots.map((l: any) => l.slug)).toEqual([visible.slug]);
  const lot = (await getPropertyBySlug(client, visible.slug))!;
  expect(JSON.stringify(lot)).not.toContain("2754");
});

it("leaves hidden lots off matter pages, meeting pages, maps and the index", async () => {
  expect((await getPropertiesForMatter(client, 10)).map((p) => p.slug)).toEqual([visible.slug]);
  expect(Object.values(await getPropertiesForItems(client, [50, 51])).flat().map((p) => p.slug)).toEqual([visible.slug]);
  expect([...(await getPropertyPinsByMatter(client, [10])).values()].flat().map((p) => p.address)).toEqual([visible.address]);
  const index = await getPropertiesIndex(client);
  expect(JSON.stringify(index)).not.toContain("2754");
});

it("leaves hidden lots out of the sitemap", async () => {
  fetchMock.mockImplementationOnce(async () => Response.json({ id: 1, slug: "langford" }));
  const entries = await sitemapEntries(client, "properties");
  expect(entries.map((e) => e.path)).not.toContain(`/properties/${home.slug}`);
  expect(requests.find((u) => u.pathname.endsWith("/properties"))?.searchParams.get("hidden")).toBe("eq.false");
});
