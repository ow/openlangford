import { SITE_ORIGIN } from "../lib/og";
import { sitemapIndex } from "../lib/sitemap";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { sitemapIndexEntries } from "../services/sitemap.server";

/** GET /sitemap.xml — index of per-section sitemaps (robots.txt points here); lastmod = newest entry in each. */
export async function loader() {
  const xml = sitemapIndex(SITE_ORIGIN, await sitemapIndexEntries(getSupabaseAdminClient()));
  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=86400" },
  });
}
