import { SITE_ORIGIN } from "./og";

/**
 * One canonical URL per page: openlangford.ca, no trailing slash, and no query string except the
 * few parameters that select a distinct indexable listing (matters page N, a meetings year).
 * Filters, views and searches collapse to the bare path so they aren't indexed as duplicates.
 */
const INDEXABLE: Record<string, (params: URLSearchParams, currentYear: number) => string | null> = {
  "/matters": (params) => {
    const page = Number(params.get("page"));
    return Number.isInteger(page) && page > 1 ? `page=${page}` : null;
  },
  "/meetings": (params, currentYear) => {
    const year = params.get("year") || "";
    return /^\d{4}$/.test(year) && Number(year) !== currentYear ? `year=${year}` : null;
  },
};

export function canonicalUrl(pathname: string, search = "", currentYear = new Date().getFullYear()): string {
  const path = pathname === "/" ? "/" : pathname.replace(/\/+$/, "") || "/";
  const query = INDEXABLE[path]?.(new URLSearchParams(search), currentYear);
  return `${SITE_ORIGIN}${path}${query ? `?${query}` : ""}`;
}
