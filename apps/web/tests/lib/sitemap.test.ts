import { describe, expect, it } from "vitest";
import { latestDate, sitemapDate, sitemapIndex, urlset, xmlEscape } from "../../app/lib/sitemap";

describe("sitemap xml", () => {
  it("escapes XML special characters", () => {
    expect(xmlEscape(`a&b<c>"d'`)).toBe("a&amp;b&lt;c&gt;&quot;d&apos;");
  });
  it("normalizes dates to YYYY-MM-DD", () => {
    expect(sitemapDate("2026-10-19T15:42:58.373Z")).toBe("2026-10-19");
    expect(sitemapDate("2024-03-18")).toBe("2024-03-18");
    expect(sitemapDate("not a date")).toBeNull();
    expect(sitemapDate(null)).toBeNull();
    expect(latestDate("2024-01-01", null, "2025-06-30T12:00:00Z")).toBe("2025-06-30");
  });
  it("uses Langford's civic date for zoned timestamps, and leaves date-only values alone", () => {
    expect(sitemapDate("2025-06-30T01:00:00Z")).toBe("2025-06-29");
    expect(sitemapDate("2026-10-27T03:15:00.123+00:00")).toBe("2026-10-26");
    expect(sitemapDate("2026-01-01T07:59:00+00:00")).toBe("2025-12-31");
    expect(sitemapDate("2026-01-01")).toBe("2026-01-01");
    expect(sitemapDate("2026-01-01T03:00:00")).toBe("2026-01-01");
  });
  it("builds a urlset with absolute, deduplicated locations", () => {
    const xml = urlset("https://openlangford.ca", [
      { path: "/matters/a&b", lastmod: "2026-01-02T20:00:00Z", changefreq: "weekly", priority: 0.7 },
      { path: "/matters/a&b" },
      { path: "" },
    ]);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.match(/<url>/g)).toHaveLength(1);
    expect(xml).toContain("<loc>https://openlangford.ca/matters/a&amp;b</loc><lastmod>2026-01-02</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>");
  });
  it("builds a sitemap index", () => {
    const xml = sitemapIndex("https://openlangford.ca", [{ path: "/sitemaps/pages.xml", lastmod: "2026-10-20" }]);
    expect(xml).toContain("<sitemap><loc>https://openlangford.ca/sitemaps/pages.xml</loc><lastmod>2026-10-20</lastmod></sitemap>");
  });
});
