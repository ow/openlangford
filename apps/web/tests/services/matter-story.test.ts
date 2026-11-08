import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";
import { getMatterStory } from "../../app/services/matters";

it("reconstructs one-hop background with provenance, preserving cities, hidden links, ownership and source dates", async () => {
  const matter = (id: number, municipality_id = 1) => ({ id, municipality_id, title: `Matter ${id}`, slug: `matter-${id}`, meta: {}, first_seen: "2026-06-29" });
  const item = (id: number, matter_id: number | null, city = 1, date = "2026-06-29") => ({ id, matter_id, meeting_id: 50, title: `Item ${id}`, meetings: { municipality_id: city, meeting_date: date, slug: "2026-06-29-special-council" } });
  const tables: Record<string, any[]> = {
    // 1685 and 208 are one project (the same bylaw); 1126 is related to 208 only.
    matters: [{ ...matter(1685), identifier: "Bylaw No. 1990" }, { ...matter(208), identifier: "Bylaw No. 1990; Z26-0001" }, matter(1126), matter(999, 2)],
    matter_links: [
      { kind: "related_matter", matter_id: 1685, related_matter_id: 208, hidden: false },
      { kind: "related_matter", matter_id: 208, related_matter_id: 1126, hidden: false },
      { kind: "related_matter", matter_id: 1685, related_matter_id: 1126, hidden: true },
      { kind: "related_matter", matter_id: 1685, related_matter_id: 999, hidden: false },
      { kind: "mention", matter_id: 208, agenda_item_id: 1368, hidden: false },
      { kind: "mention", matter_id: 208, agenda_item_id: 900, hidden: false },
      { kind: "mention", matter_id: 1685, agenda_item_id: 900, hidden: false },
      { kind: "mention", matter_id: 208, agenda_item_id: 901, hidden: true },
      { kind: "mention", matter_id: 208, agenda_item_id: 902, hidden: false },
      { kind: "mention", matter_id: 208, agenda_item_id: 6716, hidden: false },
    ],
    agenda_items: [item(1368, null), item(1369, 208), item(900, null), item(901, null), item(902, null, 2), item(6716, 1685), item(4450, 1126, 1, "2022-02-22"),
      { ...item(1399, 208, 1, "2026-07-20"), title: "Report describing consultation on July 14" }, ...Array.from({ length: 501 }, (_, i) => item(10000 + i, 208))],
  };
  const ids = (value: string) => value.slice(value.indexOf("(") + 1, -1).split(",").map(Number);
  const client = createClient("https://example.supabase.co", "synthetic-test-key", { auth: { persistSession: false }, global: { fetch: async input => {
    const url = new URL(String(input));
    let rows = tables[url.pathname.split("/").pop()!] || [];
    for (const [key, value] of url.searchParams) {
      if (value.startsWith("eq.")) rows = rows.filter(row => String(key === "meetings.municipality_id" ? row.meetings.municipality_id : row[key]) === value.slice(3));
      if (value.startsWith("in.(")) rows = rows.filter(row => ids(value).includes(row[key]));
      if (key === "or") {
        const alternatives = [...value.matchAll(/(\w+)\.(eq\.\d+|in\.\([\d,]+\))/g)];
        rows = rows.filter(row => alternatives.some(([, field, rule]) => rule.startsWith("eq.") ? row[field] === Number(rule.slice(3)) : ids(rule).includes(row[field])));
      }
    }
    const offset = Number(url.searchParams.get("offset") || 0);
    return Response.json(rows.slice(offset, offset + Number(url.searchParams.get("limit") || 1000)));
  } } });
  const story = await getMatterStory(client, 1685);
  expect(story.related.map(row => row.id)).toEqual([208]);
  expect(story.mentions.map(row => row.id)).toEqual([900]);
  expect(story.background.filter(row => row.id < 10000).map(row => [row.id, row.relatedMatter.id])).toEqual([[1368, 208], [1369, 208], [1399, 208]]);
  expect(story.background.find(row => row.id === 1399)?.meetings.meeting_date).toBe("2026-07-20");
  expect(story.background.find(row => row.id === 1369)?.matter_id).toBe(208);
  expect(story.background).toHaveLength(504);
  expect(story.background.at(-1)?.id).toBe(10500);
});

it("carries a name-found link's quote and the annual-report pages, hiding hidden ones", async () => {
  const meeting = { municipality_id: 1, meeting_date: "2024-12-16", slug: "2024-12-16-regular-council" };
  const tables: Record<string, any[]> = {
    matter_links: [
      { kind: "mention", matter_id: 374, agenda_item_id: 50, hidden: false, source: "name_mention", quote: "the quiet sale of the North Langford Recreation Center" },
      { kind: "mention", matter_id: 374, agenda_item_id: 51, hidden: false, source: "resolver", quote: null },
    ],
    agenda_items: [{ id: 50, matter_id: 9, meeting_id: 7, title: "Potential Purchase of Westhills Aquatic Centre", meetings: meeting },
      { id: 51, matter_id: null, meeting_id: 7, title: "PUBLIC PARTICIPATION", meetings: meeting }],
    matter_report_mentions: [
      { id: 2, matter_id: 374, page: 24, quote: "The City acquired and completed a $500,000 renovation", hidden: false,
        public_reports: { year: 2015, title: "Annual Report 2015", source_url: "https://gspr.emc2.build/documents/abc", municipality_id: 1 } },
      { id: 3, matter_id: 374, page: 25, quote: "hidden", hidden: true,
        public_reports: { year: 2015, title: "Annual Report 2015", source_url: null, municipality_id: 1 } },
    ],
  };
  const ids = (value: string) => value.slice(value.indexOf("(") + 1, -1).split(",").map(Number);
  const client = createClient("https://example.supabase.co", "synthetic-test-key", { auth: { persistSession: false }, global: { fetch: async input => {
    const url = new URL(String(input));
    let rows = tables[url.pathname.split("/").pop()!] || [];
    for (const [key, value] of url.searchParams) {
      const field = (row: any) => key.includes(".") ? key.split(".").reduce((o, k) => o?.[k], row) : row[key];
      if (value.startsWith("eq.")) rows = rows.filter(row => String(field(row)) === value.slice(3));
      if (value.startsWith("in.(")) rows = rows.filter(row => ids(value).includes(row[key]));
      if (key === "or") rows = rows.filter(row => row.matter_id === 374);
    }
    return Response.json(rows);
  } } });
  const story = await getMatterStory(client, 374);
  expect(story.mentions.map(m => [m.id, m.linkSource, m.linkQuote])).toEqual([
    [50, "name_mention", "the quiet sale of the North Langford Recreation Center"], [51, "resolver", null]]);
  expect(story.reports).toEqual([{ id: 2, matter_id: 374, year: 2015, title: "Annual Report 2015", page: 24,
    quote: "The City acquired and completed a $500,000 renovation", url: "https://gspr.emc2.build/documents/abc#page=24" }]);
});

it("lists a related topic that is another project without borrowing its entries", async () => {
  const meeting = { municipality_id: 1, meeting_date: "2017-08-14", slug: "2017-08-14-regular-council" };
  const tables: Record<string, any[]> = {
    // 2945 Jacklin Road: the 2017 showroom permit and the 2010 cinema variances share only an address.
    matters: [{ id: 1, municipality_id: 1, title: "Showroom", slug: "showroom", identifier: "TUP17-0003", meta: {}, first_seen: "2017-07-10" },
      { id: 2, municipality_id: 1, title: "Cinema variances", slug: "cinema", identifier: "DVP-10-15", meta: {}, first_seen: "2010-09-20" }],
    matter_links: [{ kind: "related_matter", matter_id: 1, related_matter_id: 2, hidden: false, source: "name" }],
    agenda_items: [{ id: 70, matter_id: 2, meeting_id: 3, title: "Cinema variances", meetings: meeting }],
  };
  const ids = (value: string) => value.slice(value.indexOf("(") + 1, -1).split(",").map(Number);
  const client = createClient("https://example.supabase.co", "synthetic-test-key", { auth: { persistSession: false }, global: { fetch: async input => {
    const url = new URL(String(input));
    let rows = tables[url.pathname.split("/").pop()!] || [];
    for (const [key, value] of url.searchParams) {
      if (value.startsWith("eq.") && !key.includes(".")) rows = rows.filter(row => String(row[key]) === value.slice(3));
      if (value.startsWith("in.(")) rows = rows.filter(row => ids(value).includes(row[key]));
    }
    return Response.json(rows);
  } } });
  const story = await getMatterStory(client, 1);
  expect(story.related.map(r => r.id)).toEqual([2]);
  expect(story.background).toEqual([]);
});
