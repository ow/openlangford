import { describe, expect, it } from "vitest";
import { canonicalRedirect } from "../../workers/canonical-redirect";
import { meta as propertyMeta } from "../../app/routes/property-detail";
import { isPublicInput, residentOnly } from "../../app/lib/public-input";

const redirect = (url: string, method = "GET") => canonicalRedirect(new Request(url, { method }), new URL(url));
const value = (meta: any[], name: string) => meta.find((m) => m.name === name || m.property === name)?.content;

describe("canonical redirects", () => {
  it("sends www and trailing slashes to the one URL, keeping the query", () => {
    expect(redirect("https://www.openlangford.ca/meetings?year=2024")?.headers.get("location")).toBe("https://openlangford.ca/meetings?year=2024");
    const slash = redirect("https://openlangford.ca/properties/latoria-road/");
    expect(slash?.status).toBe(301);
    expect(slash?.headers.get("location")).toBe("https://openlangford.ca/properties/latoria-road");
    expect(redirect("https://www.openlangford.ca/")?.headers.get("location")).toBe("https://openlangford.ca/");
  });
  it("leaves canonical URLs and non-GET requests alone", () => {
    expect(redirect("https://openlangford.ca/")).toBeNull();
    expect(redirect("https://openlangford.ca/meetings")).toBeNull();
    expect(redirect("https://openlangford.ca/meetings/", "POST")).toBeNull();
  });
});

describe("property pages", () => {
  const property = { id: 1, slug: "latoria-road", address: "Latoria Road", civic_number: "", street: "Latoria Road", geo: null,
    meta: { summary: "In 2024 Council backed grants for walking and cycling upgrades on Latoria Road. Mentioned in council meetings 143 times since 2009." } };

  it("uses the page's summary as its search description, with Langford in the title", () => {
    const tags = propertyMeta({ data: { property, matters: [], isStreet: true, noindex: false } } as any) as any[];
    expect(tags.find((m) => m.title)?.title).toBe("Latoria Road, Langford | Open Langford");
    expect(value(tags, "description")).toMatch(/^In 2024 Council backed grants/);
    expect(value(tags, "robots")).toBeUndefined();
  });

  it("keeps a resident's home address and empty pages out of search", () => {
    const tags = propertyMeta({ data: { property: { ...property, slug: "848-walfred-road", address: "848 Walfred Road", civic_number: "848", meta: {} },
      matters: [], isStreet: false, noindex: true } } as any) as any[];
    expect(value(tags, "robots")).toBe("noindex, follow");
    expect(value(tags, "description")).not.toMatch(/matters|records/i);
  });

  it("recognizes public input by category or title", () => {
    expect(isPublicInput({ title: "Mr. A Resident, of 848 Walfred Rd", category: "Public Input" })).toBe(true);
    expect(residentOnly([{ agenda_items: { title: "PUBLIC PARTICIPATION" } }])).toBe(true);
    expect(residentOnly([{ agenda_items: { title: "PUBLIC PARTICIPATION" } }, { agenda_items: { title: "Rezoning", category: "Land Use" } }])).toBe(false);
    expect(residentOnly([])).toBe(false);
  });
});
