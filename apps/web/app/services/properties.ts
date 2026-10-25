import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Properties: one civic address (one lot) and every matter and agenda item that
 * named it. Written by the pipeline's properties stage (property_links).
 */

export type PropertyRef = { id: number; slug: string; address: string; geo: { lat: number; lng: number } | null };

const MATTER_FIELDS = "id, slug, title, status, category, first_seen, last_seen, plain_english_summary, meta";

function visible(matter: any) {
  return matter && !matter.meta?.canonical_matter_id && !matter.meta?.hidden;
}

/** The properties a matter names, each with the other matters at that lot (newest first). */
export async function getPropertiesForMatter(supabase: SupabaseClient, matterId: number) {
  const { data: own, error } = await supabase.from("property_links").select("property_id").eq("matter_id", matterId);
  if (error || !own?.length) {
    if (error) console.error("Error fetching matter properties:", error);
    return [];
  }
  const propertyIds = [...new Set(own.map((l) => l.property_id))];
  const [{ data: properties }, { data: links }] = await Promise.all([
    supabase.from("properties").select("id, slug, address, geo").in("id", propertyIds),
    supabase.from("property_links").select("property_id, matter_id").in("property_id", propertyIds).not("matter_id", "is", null).neq("matter_id", matterId),
  ]);
  const otherIds = [...new Set((links || []).map((l) => l.matter_id as number))];
  const { data: others } = otherIds.length
    ? await supabase.from("matters").select(MATTER_FIELDS).in("id", otherIds)
    : { data: [] as any[] };
  const byId = new Map((others || []).filter(visible).map((m) => [m.id, m]));
  return (properties || [])
    .map((p) => ({
      ...(p as PropertyRef),
      others: [...new Set((links || []).filter((l) => l.property_id === p.id).map((l) => l.matter_id))]
        .map((id) => byId.get(id))
        .filter(Boolean)
        .sort((a: any, b: any) => String(b.last_seen || b.first_seen).localeCompare(String(a.last_seen || a.first_seen))),
    }))
    .sort((a, b) => b.others.length - a.others.length);
}

/** One property: its matters (newest activity first) and agenda items that named it outside any matter. */
export async function getPropertyBySlug(supabase: SupabaseClient, slug: string) {
  const { data: property, error } = await supabase.from("properties").select("id, slug, address, civic_number, street, geo").eq("slug", slug).maybeSingle();
  if (error) throw error;
  if (!property) return null;
  const { data: links, error: linksError } = await supabase
    .from("property_links")
    .select("agenda_item_id, matter_id")
    .eq("property_id", property.id);
  if (linksError) throw linksError;
  const matterIds = [...new Set((links || []).map((l) => l.matter_id).filter(Boolean))] as number[];
  const looseItemIds = (links || []).filter((l) => !l.matter_id && l.agenda_item_id).map((l) => l.agenda_item_id as number);
  const [{ data: matters, error: mattersError }, { data: items, error: itemsError }, { data: neighbours }] = await Promise.all([
    matterIds.length ? supabase.from("matters").select(MATTER_FIELDS).in("id", matterIds) : Promise.resolve({ data: [] as any[], error: null }),
    looseItemIds.length
      ? supabase
          .from("agenda_items")
          .select("id, title, plain_english_summary, meeting_id, meetings(id, slug, title, meeting_date)")
          .in("id", looseItemIds)
      : Promise.resolve({ data: [] as any[], error: null }),
    // Other lots on the same street that council also considered, nearest civic numbers first.
    supabase.from("properties").select("slug, address, civic_number").ilike("street", property.street).neq("id", property.id).limit(200),
  ]);
  if (mattersError) throw mattersError;
  if (itemsError) throw itemsError;
  const number = parseInt(property.civic_number, 10);
  return {
    property,
    matters: (matters || [])
      .filter(visible)
      .sort((a, b) => String(b.last_seen || b.first_seen).localeCompare(String(a.last_seen || a.first_seen))),
    items: (items || []).sort((a: any, b: any) => String(b.meetings?.meeting_date).localeCompare(String(a.meetings?.meeting_date))),
    neighbours: (neighbours || [])
      .sort((a, b) => Math.abs(parseInt(a.civic_number, 10) - number) - Math.abs(parseInt(b.civic_number, 10) - number))
      .slice(0, 8),
  };
}

export function propertyPath(property: { slug: string }) {
  return `/properties/${property.slug}`;
}
