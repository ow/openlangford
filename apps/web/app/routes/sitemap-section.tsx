import type { Route } from "./+types/sitemap-section";
import { SITE_ORIGIN } from "../lib/og";
import { urlset } from "../lib/sitemap";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { SITEMAP_SECTIONS, sitemapEntries, type SitemapSection } from "../services/sitemap.server";
import { PUBLIC_EDGE_DAY } from "../lib/cache-policy";

/** GET /sitemaps/<section>.xml — URLs for one content type. */
export async function loader({ params }: Route.LoaderArgs) {
  const section = (params.section || "").replace(/\.xml$/, "") as SitemapSection;
  if (!SITEMAP_SECTIONS.includes(section)) throw new Response("Not Found", { status: 404 });
  const entries = await sitemapEntries(getSupabaseAdminClient(), section);
  return new Response(urlset(SITE_ORIGIN, entries), {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": PUBLIC_EDGE_DAY },
  });
}
