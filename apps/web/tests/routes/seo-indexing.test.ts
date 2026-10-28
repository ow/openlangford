import { describe, expect, it, vi } from "vitest";
import { createRoutesStub, Meta } from "react-router";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

const mattersList = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, slug: `matter-${i + 1}`, title: i === 0 ? "Adjournment" : `Matter ${i + 1}`, status: i % 2 ? "Active" : "Adopted", category: i % 3 ? "Development" : "Finance" }));
vi.mock("../../app/services/computed-cache.server", () => ({ HOURLY_SHARED: {}, cachedCompute: async () => mattersList }));
vi.mock("../../app/services/municipality", () => ({ getMunicipality: async () => ({ id: 1, slug: "langford" }) }));
vi.mock("../../app/lib/supabase.server", () => ({ getSupabaseAdminClient: () => ({}), createSupabaseServerClient: () => ({ supabase: {} }) }));

import { canonicalUrl } from "../../app/lib/canonical";
import { clip, fitTitle, metaDescription } from "../../app/lib/page-meta";
import { breadcrumbList, jsonLd, meetingEvent, propertyPlace } from "../../app/lib/structured-data";
import { loaderFailure, unavailable } from "../../app/lib/loader-errors";
import { resolveSlugParam } from "../../app/lib/slug-params.server";
import { meta as rootMeta, headers as rootHeaders } from "../../app/root";
import { meta as homeMeta } from "../../app/routes/home";
import { meta as matterMeta } from "../../app/routes/matter-detail";
import { meta as bylawMeta } from "../../app/routes/bylaw-detail";
import { meta as propertyMeta } from "../../app/routes/property-detail";
import { meta as meetingsMeta } from "../../app/routes/meetings";
import { meta as meetingMeta } from "../../app/routes/meeting-detail";
import { meta as personMeta } from "../../app/routes/person-profile";
import Matters, { loader as mattersLoader, meta as mattersMeta } from "../../app/routes/matters";

const value = (meta: any[], name: string) => meta.find((m) => m?.name === name || m?.property === name)?.content;
const title = (meta: any[]) => meta.find((m) => m?.title)?.title as string;
const ld = (meta: any[]) => meta.find((m) => m?.["script:ld+json"])?.["script:ld+json"];
const types = (meta: any[]) => { const data = ld(meta); return (data["@graph"] || [data]).map((t: any) => t["@type"]); };

describe("canonical URLs", () => {
  it("drops filters and trailing slashes but keeps listing pages and year views", () => {
    expect(canonicalUrl("/", "?utm_source=x")).toBe("https://openlangford.ca/");
    expect(canonicalUrl("/bylaws/", "?q=zoning")).toBe("https://openlangford.ca/bylaws");
    expect(canonicalUrl("/matters", "?page=2&q=x")).toBe("https://openlangford.ca/matters?page=2");
    expect(canonicalUrl("/matters", "?page=1")).toBe("https://openlangford.ca/matters");
    expect(canonicalUrl("/matters", "?page=abc")).toBe("https://openlangford.ca/matters");
    expect(canonicalUrl("/meetings", "?year=2019&view=calendar&month=3", 2026)).toBe("https://openlangford.ca/meetings?year=2019");
    expect(canonicalUrl("/meetings", "?year=2026", 2026)).toBe("https://openlangford.ca/meetings");
    expect(canonicalUrl("/properties", "?year=2019", 2026)).toBe("https://openlangford.ca/properties");
  });
});

describe("titles and descriptions", () => {
  it("cuts descriptions at a word boundary with an ellipsis", () => {
    const long = "Council considered a rezoning application ".repeat(10);
    const cut = metaDescription(long);
    expect(cut.length).toBeLessThanOrEqual(155);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toMatch(/\s…$/);
    expect(metaDescription("Short.")).toBe("Short.");
    expect(clip("one two three", 9)).toBe("one two…");
  });
  it("keeps the whole name, dropping the context label before cutting a name", () => {
    expect(fitTitle("Short matter", "Langford Council")).toBe("Short matter | Langford Council | Open Langford");
    expect(fitTitle("Amenity Cost Charge Bylaw (No. 2275)", "Langford Bylaw")).toBe("Amenity Cost Charge Bylaw (No. 2275) | Open Langford");
    const long = fitTitle("Official Community Plan Amendment and Rezoning for 2140 Caribou Drive and the surrounding Area Plan lands", "Langford Council");
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.endsWith("… | Open Langford")).toBe(true);
  });
  it("gives the home page its search title and site-wide structured data", () => {
    const meta = homeMeta({ data: {} } as any) as any[];
    expect(title(meta)).toBe("Langford Council Meetings, Bylaws & Records | Open Langford");
    expect(types(meta)).toEqual(["WebSite", "Organization"]);
    expect(ld(meta)["@graph"][0].potentialAction.target.urlTemplate).toBe("https://openlangford.ca/search?q={search_term_string}");
  });
  it("names Langford on matter pages with twitter tags and breadcrumbs", () => {
    const meta = matterMeta({ data: { matter: { id: 1, slug: "caribou", title: "Rezoning application for 2140 Caribou Drive to permit a six storey apartment building", status: "Active", plain_english_summary: "x ".repeat(120) } } } as any) as any[];
    expect(title(meta)).toMatch(/^Rezoning application for 2140 Caribou Drive to permit a six storey\b.*… \| Open Langford$/);
    expect(title(meta).length).toBeLessThanOrEqual(90);
    expect(value(meta, "twitter:title")).toBe(title(meta));
    expect(value(meta, "twitter:description")).toBe(value(meta, "description"));
    expect(value(meta, "twitter:image")).toMatch(/^https:/);
    expect(value(meta, "description").length).toBeLessThanOrEqual(155);
    expect(types(meta)).toEqual(["BreadcrumbList"]);
  });
  it("describes bylaws as Langford legislation", () => {
    const meta = bylawMeta({ data: { bylaw: { id: 3, slug: "bylaw-300", title: "Zoning Bylaw", bylaw_number: "300", year: 1999, status: "Active" } } } as any) as any[];
    expect(title(meta)).toBe("Zoning Bylaw (No. 300) | Langford Bylaw | Open Langford");
    const [legislation, crumbs] = ld(meta)["@graph"];
    expect(legislation).toMatchObject({ "@type": "Legislation", legislationIdentifier: "Bylaw No. 300", legislationDate: "1999", name: "Zoning Bylaw" });
    expect(crumbs.itemListElement.map((c: any) => c.name)).toEqual(["Home", "Bylaws", "Zoning Bylaw (No. 300)"]);
  });
  it("titles properties with the site pattern and a geocoded Place", () => {
    const meta = propertyMeta({ data: { property: { slug: "2140-caribou-drive", address: "2140 Caribou Drive", civic_number: "2140", geo: { lat: 48.45, lng: -123.5 } }, matters: [], isStreet: false } } as any) as any[];
    expect(title(meta)).toBe("2140 Caribou Drive, Langford | Open Langford");
    expect(value(meta, "og:title")).toBe(title(meta));
    expect(value(meta, "twitter:title")).toBe(title(meta));
    expect(ld(meta)["@graph"][0]).toMatchObject({
      "@type": "Place",
      address: { "@type": "PostalAddress", streetAddress: "2140 Caribou Drive", addressLocality: "Langford", addressRegion: "BC", addressCountry: "CA" },
      geo: { "@type": "GeoCoordinates", latitude: 48.45, longitude: -123.5 },
    });
  });
  it("keeps the year out of the plain meetings title", () => {
    const plain = meetingsMeta({ data: { selectedYear: 2026, currentYear: 2026 }, location: { search: "" }, matches: [] } as any) as any[];
    expect(title(plain)).toBe("Langford Council Meetings | Open Langford");
    const year = meetingsMeta({ data: { selectedYear: 2019, currentYear: 2026 }, location: { search: "?year=2019" }, matches: [] } as any) as any[];
    expect(title(year)).toBe("Langford Council Meetings in 2019 | Open Langford");
    expect(value(year, "og:url")).toBe("https://openlangford.ca/meetings?year=2019");
  });
  it("marks meetings up as City Hall events", () => {
    const meta = meetingMeta({ data: { meeting: { id: 1, slug: "2026-05-19-regular-council", title: "Regular Council", meeting_date: "2026-05-19", status: "Cancelled" } } } as any) as any[];
    expect(ld(meta)["@graph"][0]).toMatchObject({
      "@type": "Event", startDate: "2026-05-19", eventStatus: "https://schema.org/EventCancelled",
      location: { name: "Langford City Hall", address: { streetAddress: "877 Goldstream Ave", addressLocality: "Langford" } },
      organizer: { name: "City of Langford" },
    });
  });
  it("describes council members by role and term years", () => {
    const council = { id: 1, name: "Langford Council", classification: "Council" };
    const meta = personMeta({
      data: { person: { id: 9, name: "Alex Councillor", slug: "alex-councillor", is_councillor: true, memberships: [{ id: 1, organization_id: 1, role: "Councillor", start_date: "2018-11-05", end_date: null, organization: council }] } },
      matches: [],
    } as any) as any[];
    expect(value(meta, "description")).toContain("Councillor, 2018–present");
    expect(ld(meta)["@graph"][0]).toMatchObject({ "@type": "Person", name: "Alex Councillor", jobTitle: "Councillor" });
  });
});

describe("structured data helper", () => {
  it("wraps one node with the schema.org context and several in a graph", () => {
    expect(jsonLd({ "@type": "Thing" })).toEqual({ "script:ld+json": { "@context": "https://schema.org", "@type": "Thing" } });
    expect(jsonLd({ "@type": "A" }, { "@type": "B" })["script:ld+json"]["@graph"]).toHaveLength(2);
    expect(breadcrumbList([["Matters", "/matters"]]).itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: "https://openlangford.ca/" },
      { "@type": "ListItem", position: 2, name: "Matters", item: "https://openlangford.ca/matters" },
    ]);
    expect(propertyPlace({ address: "Goldstream Avenue", geo: null }, "/properties/goldstream-avenue")).not.toHaveProperty("geo");
    expect(meetingEvent({ title: "Council", meeting_date: "2026-01-05" }, "/meetings/x").eventStatus).toBe("https://schema.org/EventScheduled");
  });
  it("is escaped by <Meta> so record text cannot close the script tag", () => {
    const Stub = createRoutesStub([{ path: "/", Component: () => createElement(Meta), meta: () => [jsonLd({ "@type": "Thing", name: "</script><script>alert(1)</script>" })] } as any]);
    const html = renderToString(createElement(Stub, { initialEntries: ["/"] }));
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).not.toContain("</script><script>alert");
    expect(html).toContain("\\u003c/script\\u003e");
  });
});

describe("error responses", () => {
  it("noindexes error pages with a not-found title and passes Retry-After through", () => {
    const meta = rootMeta({ error: { status: 404, statusText: "Not Found", internal: false, data: "" }, matches: [] } as any) as any[];
    expect(title(meta)).toBe("Page not found | Open Langford");
    expect(value(meta, "robots")).toBe("noindex");
    const headers = rootHeaders({ parentHeaders: new Headers(), errorHeaders: new Headers({ "Retry-After": "30" }), loaderHeaders: new Headers(), actionHeaders: new Headers() } as any) as Headers;
    expect(headers.get("Retry-After")).toBe("30");
  });
  it("tells a failed query (503, Retry-After) from a missing row (404)", async () => {
    expect(loaderFailure({ code: "PGRST116", message: "0 rows" }, "Bylaw Not Found").status).toBe(404);
    expect(loaderFailure(new Error("Meeting Not Found"), "Meeting Not Found").status).toBe(404);
    const down = loaderFailure({ message: "fetch failed" }, "Bylaw Not Found");
    expect(down.status).toBe(503);
    expect(down.headers.get("Retry-After")).toBe("30");
    const redirect = new Response(null, { status: 301 });
    expect(loaderFailure(redirect, "x")).toBe(redirect);
    expect(unavailable().status).toBe(503);
  });
  it("never turns a failed slug lookup into a 404", async () => {
    const failing = { from: () => { const q: any = { select: () => q, eq: () => q, limit: () => q, maybeSingle: async () => ({ data: null, error: { message: "upstream timeout" } }) }; return q; } } as any;
    await expect(resolveSlugParam(failing, "bylaws", "bylaw-2275", new Request("https://openlangford.ca/bylaws/bylaw-2275"), (b) => `/bylaws/${b.slug}`)).rejects.toMatchObject({ status: 503 });
  });
});

describe("matters list pagination", () => {
  const load = (search = "") => mattersLoader({ request: new Request(`https://openlangford.ca/matters${search}`), params: {}, context: {} } as any);
  it("serves 50 non-procedural matters a page with page counts for the full list", async () => {
    const first = await load();
    expect(first.matters).toHaveLength(50);
    expect(first.matters[0].title).toBe("Matter 2");
    expect(first).toMatchObject({ page: 1, pageCount: 3, total: 119, complete: false });
    expect(first.counts.All).toBe(119);
    const last = await load("?page=3");
    expect(last.matters.map((m: any) => m.slug).at(-1)).toBe("matter-120");
    expect((await load("?q=caribou")).matters).toHaveLength(119);
    await expect(load("?page=9")).rejects.toMatchObject({ status: 404 });
    await expect(load("?page=0")).rejects.toMatchObject({ status: 301 });
  });
  it("links prev/next pages in the head", () => {
    const meta = mattersMeta({ data: { page: 2, pageCount: 3, total: 119 } } as any) as any[];
    expect(title(meta)).toBe("Langford Council Matters — Page 2 | Open Langford");
    expect(value(meta, "og:url")).toBe("https://openlangford.ca/matters?page=2");
    expect(meta.filter((m) => m.tagName === "link").map((m) => [m.rel, m.href])).toEqual([
      ["prev", "https://openlangford.ca/matters"],
      ["next", "https://openlangford.ca/matters?page=3"],
    ]);
  });
  it("server-renders every matter on the page as a plain link, with page links", async () => {
    const loaderData = await load("?page=2");
    const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ path: "matters", Component: () => createElement(Matters as any, { loaderData }) }] } as any]);
    const html = renderToString(createElement(Stub, { initialEntries: ["/matters?page=2"] }));
    const matterLinks = html.match(/href="\/matters\/matter-\d+"/g) || [];
    expect(matterLinks).toHaveLength(50);
    expect(html).toContain('href="/matters/matter-52"'); // page 2 = 51st–100th non-procedural matter
    expect(html).toContain('href="/matters"');
    expect(html).toContain('href="/matters?page=3"');
  });
});

describe("agenda item matter links", () => {
  it("links items to their canonical, visible matter", async () => {
    const { getMatterLinks } = await import("../../app/services/matters");
    const rows = [
      { id: 1, slug: "caribou", title: "Caribou rezoning", hidden: null, canonical: null },
      { id: 2, slug: "caribou-old", title: "Old", hidden: null, canonical: "1" },
      { id: 3, slug: "secret", title: "Hidden", hidden: "true", canonical: null },
    ];
    const db = { from: () => { let ids: number[] = []; const q: any = { select: () => q, in: (_c: string, v: number[]) => { ids = v; return q; }, then: (ok: any) => ok({ data: rows.filter((r) => ids.includes(r.id)), error: null }) }; return q; } } as any;
    expect(await getMatterLinks(db, [1, 2, 3, null])).toEqual({
      1: { id: 1, slug: "caribou", title: "Caribou rezoning" },
      2: { id: 1, slug: "caribou", title: "Caribou rezoning" },
    });
  });
});
