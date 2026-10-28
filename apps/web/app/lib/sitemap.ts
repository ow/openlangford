/** Sitemap XML (sitemaps.org protocol). Pure helpers so they can be unit tested. */

export interface SitemapEntry {
  path: string;
  lastmod?: string | null;
  changefreq?: "daily" | "weekly" | "monthly" | "yearly";
  priority?: number;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
export const xmlEscape = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const CIVIC_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * W3C date (YYYY-MM-DD) from a date or timestamp string; null if unparseable. Date-only values are
 * civic dates already; a zoned timestamp is converted to its Langford (America/Vancouver) date.
 */
export function sitemapDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const zoned = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::[\d.]+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (match && !zoned) return match[1];
  const date = new Date(zoned ? value.replace(" ", "T") : value);
  return Number.isNaN(date.getTime()) ? null : CIVIC_DATE.format(date);
}

/** Latest of several dates (for "last modified" across related records). */
export function latestDate(...values: (string | null | undefined)[]): string | null {
  return values.map(sitemapDate).filter((v): v is string => Boolean(v)).sort().pop() ?? null;
}

export function urlset(origin: string, entries: SitemapEntry[]): string {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const entry of entries) {
    if (!entry.path || seen.has(entry.path)) continue;
    seen.add(entry.path);
    const parts = [`<loc>${xmlEscape(origin + entry.path)}</loc>`];
    const lastmod = sitemapDate(entry.lastmod);
    if (lastmod) parts.push(`<lastmod>${lastmod}</lastmod>`);
    if (entry.changefreq) parts.push(`<changefreq>${entry.changefreq}</changefreq>`);
    if (entry.priority != null) parts.push(`<priority>${entry.priority.toFixed(1)}</priority>`);
    rows.push(`<url>${parts.join("")}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join("\n")}\n</urlset>\n`;
}

export function sitemapIndex(origin: string, sitemaps: { path: string; lastmod?: string | null }[]): string {
  const rows = sitemaps.map((s) => {
    const lastmod = sitemapDate(s.lastmod);
    return `<sitemap><loc>${xmlEscape(origin + s.path)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</sitemap>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join("\n")}\n</sitemapindex>\n`;
}

/** Protocol limit is 50,000 URLs per file; sections split into numbered pages beyond this. */
export const SITEMAP_PAGE_SIZE = 45_000;
