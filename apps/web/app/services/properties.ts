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
  const { data: own, error } = await supabase.from("property_links").select("property_id").eq("matter_id", matterId).eq("hidden", false);
  if (error || !own?.length) {
    if (error) console.error("Error fetching matter properties:", error);
    return [];
  }
  const propertyIds = [...new Set(own.map((l) => l.property_id))];
  const [{ data: properties }, { data: links }] = await Promise.all([
    supabase.from("properties").select("id, slug, address, geo").in("id", propertyIds),
    supabase.from("property_links").select("property_id, matter_id").in("property_id", propertyIds).not("matter_id", "is", null).neq("matter_id", matterId).eq("hidden", false),
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
    .eq("property_id", property.id)
    .eq("hidden", false);
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
    // Lots on the same street (a street page lists them all; a lot shows its nearest neighbours).
    supabase.from("properties").select("id, slug, address, civic_number, geo").ilike("street", property.street).neq("civic_number", "").neq("id", property.id).limit(1000),
  ]);
  if (mattersError) throw mattersError;
  if (itemsError) throw itemsError;
  const isStreet = property.civic_number === "";
  const number = parseInt(property.civic_number, 10);
  // How many matters each lot on a street page has, for "3 matters" beside each address.
  const lotCounts = new Map<number, number>();
  if (isStreet && neighbours?.length) {
    const lotIds = neighbours.map((n) => n.id);
    for (let i = 0; i < lotIds.length; i += 300) {
      const { data } = await supabase.from("property_links").select("property_id, matter_id, agenda_item_id").in("property_id", lotIds.slice(i, i + 300)).eq("hidden", false);
      const seen = new Map<number, Set<string>>();
      for (const l of data || []) {
        const set = seen.get(l.property_id) || new Set<string>();
        set.add(l.matter_id ? `m${l.matter_id}` : `i${l.agenda_item_id}`);
        seen.set(l.property_id, set);
      }
      for (const [id, set] of seen) lotCounts.set(id, set.size);
    }
  }
  const slugOfStreet = property.street.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const streetSlug = isStreet
    ? null
    : (await supabase.from("properties").select("slug").eq("slug", slugOfStreet).maybeSingle()).data?.slug ?? null;
  return {
    isStreet,
    streetSlug,
    lots: isStreet
      ? (neighbours || [])
          .map((n) => ({ ...n, records: lotCounts.get(n.id) || 0 }))
          .sort((a, b) => parseInt(a.civic_number, 10) - parseInt(b.civic_number, 10))
      : [],
    property,
    matters: (matters || [])
      .filter(visible)
      .sort((a, b) => String(b.last_seen || b.first_seen).localeCompare(String(a.last_seen || a.first_seen))),
    items: (items || []).sort((a: any, b: any) => String(b.meetings?.meeting_date).localeCompare(String(a.meetings?.meeting_date))),
    neighbours: (isStreet ? [] : neighbours || [])
      .sort((a, b) => Math.abs(parseInt(a.civic_number, 10) - number) - Math.abs(parseInt(b.civic_number, 10) - number))
      .slice(0, 8),
  };
}

/** Agenda item id -> the properties (lots and streets) it names, for linking addresses on meeting pages. */
export async function getPropertiesForItems(supabase: SupabaseClient, itemIds: number[]) {
  const byItem: Record<number, { slug: string; address: string }[]> = {};
  if (!itemIds.length) return byItem;
  const { data, error } = await supabase
    .from("property_links")
    .select("agenda_item_id, properties(slug, address, civic_number)")
    .in("agenda_item_id", itemIds)
    .eq("hidden", false);
  if (error) {
    console.error("Error fetching item properties:", error);
    return byItem;
  }
  for (const row of data || []) {
    const p = row.properties as any;
    if (!p || row.agenda_item_id == null) continue;
    (byItem[row.agenda_item_id] ||= []).push({ slug: p.slug, address: p.address });
  }
  return byItem;
}

export function propertyPath(property: { slug: string }) {
  return `/properties/${property.slug}`;
}
