import { SITE_ORIGIN } from "../lib/og";
import { sitemapIndex } from "../lib/sitemap";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { sitemapIndexEntries } from "../services/sitemap.server";
import { PUBLIC_EDGE_DAY } from "../lib/cache-policy";

/** GET /sitemap.xml — index of per-section sitemaps (robots.txt points here); lastmod = newest entry in each. */
export async function loader() {
  const xml = sitemapIndex(SITE_ORIGIN, await sitemapIndexEntries(getSupabaseAdminClient()));
  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": PUBLIC_EDGE_DAY },
  });
}
