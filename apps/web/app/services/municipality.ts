import type { SupabaseClient } from "@supabase/supabase-js";
import type { Municipality } from "../lib/types";
import { publicData } from "./public-data-cache.server";

export async function getMunicipality(
  supabase: SupabaseClient,
  slug = "langford",
): Promise<Municipality> {
  // Public row, the same for every visitor; errors (not found) are thrown, never stored.
  return publicData(`municipality:${slug}`, () => loadMunicipality(supabase, slug), () => true, undefined, { shareWithSignedIn: true });
}

async function loadMunicipality(supabase: SupabaseClient, slug: string): Promise<Municipality> {
  const { data, error } = await supabase
    .from("municipalities")
    .select(
      "id, slug, name, short_name, province, classification, website_url, rss_url, contact_email, map_center_lat, map_center_lng, ocd_id, meta, created_at, updated_at",
    )
    .eq("slug", slug)
    .single();

  if (error || !data) {
    throw new Error(`Municipality not found: ${slug}`);
  }

  return data as Municipality;
}
