import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { sameSiteTopics } from "~/services/properties";

// 887 Klahanie Drive: a six-lot rezoning (2019), the same land rezoned again for 11 lots (2021), and a tax-exemption
// list that names the lot among many others. A resident's home (hidden) next door has its own topic too.
const lot = { id: 1, address: "887 Klahanie Drive", civic_number: "887", hidden: false };
const home = { id: 2, address: "889 Klahanie Drive", civic_number: "889", hidden: true };
const others = [3, 4, 5, 6, 7].map((id) => ({ id, address: `${id}00 Other Road`, civic_number: `${id}00`, hidden: false }));
const matters = [
  { id: 10, slug: "six-lots", title: "Rezoning", status: "Adopted", first_seen: "2018-11-06", last_seen: "2019-07-15", meta: { display_title: "Six lots (2019)" } },
  { id: 11, slug: "eleven-lots", title: "Bylaw 1982", status: "Adopted", first_seen: "2021-06-14", last_seen: "2021-09-07", meta: { display_title: "11 lots (2021)" } },
  { id: 12, slug: "tax", title: "Tax exemptions", status: "Adopted", first_seen: "2020-01-01", last_seen: "2020-02-01", meta: {} },
  { id: 13, slug: "home", title: "Fence variance", status: "Approved", first_seen: "2022-01-01", last_seen: "2022-01-01", meta: {} },
  { id: 14, slug: "merged", title: "Old copy", status: "Adopted", first_seen: "2021-06-14", last_seen: "2021-06-14", merged_into: 11, meta: {} },
];
const links = [
  { property_id: 1, matter_id: 10 }, { property_id: 1, matter_id: 11 }, { property_id: 1, matter_id: 14 },
  { property_id: 1, matter_id: 12 }, ...others.map((p) => ({ property_id: p.id, matter_id: 12 })),
  { property_id: 2, matter_id: 13 }, { property_id: 2, matter_id: 10 },
].map((l) => ({ ...l, hidden: false }));

function filter(rows: any[], params: URLSearchParams) {
  for (const [key, value] of params) {
    if (["select", "limit", "order"].includes(key)) continue;
    const list = value.match(/^in\.\((.*)\)$/)?.[1]?.split(",");
    rows = rows.filter((r) => {
      const v = r[key];
      if (list) return list.includes(String(v));
      if (value === "not.is.null") return v != null;
      if (value.startsWith("neq.")) return String(v ?? "") !== value.slice(4);
      if (value.startsWith("eq.")) return String(v ?? false) === value.slice(3);
      return true;
    });
  }
  return rows;
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const table = url.pathname.split("/").pop()!;
  const all = table === "properties" ? [lot, home, ...others] : table === "property_links" ? links : matters;
  const rows = filter(all, url.searchParams);
  const single = String((init?.headers as any)?.Accept ?? (init?.headers as any)?.accept ?? "").includes("vnd.pgrst.object");
  return single ? Response.json(rows[0] ?? null) : Response.json(rows);
});
const client = createClient("https://example.supabase.co", "synthetic-key", { auth: { persistSession: false }, global: { fetch: fetchMock as typeof fetch } });

it("links the earlier and later applications for the same land, not lists of many lots", async () => {
  const later = await sameSiteTopics(client, 10);
  expect(later.map((m) => [m.id, m.title, m.when, m.address])).toEqual([[11, "11 lots (2021)", "later", "887 Klahanie Drive"]]);
  const earlier = await sameSiteTopics(client, 11);
  expect(earlier.map((m) => [m.id, m.when])).toEqual([[10, "earlier"]]);
});

it("finds nothing for a topic naming many lots", async () => {
  expect(await sameSiteTopics(client, 12)).toEqual([]);
});
