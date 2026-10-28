import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Properties: one civic address (one lot) and every matter and agenda item that
 * named it. Written by the pipeline's properties stage (property_links).
 */

export type PropertyRef = { id: number; slug: string; address: string; civic_number: string; geo: any };

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
    supabase.from("properties").select("id, slug, address, civic_number, geo").in("id", propertyIds),
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
  const { data: property, error } = await supabase.from("properties").select("id, slug, address, civic_number, street, geo, meta").eq("slug", slug).maybeSingle();
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
    nearby: isStreet
      ? []
      : await getNearbyMatters(supabase, property, new Set(matterIds), (neighbours || []).sort(
          (a, b) => Math.abs(parseInt(a.civic_number, 10) - number) - Math.abs(parseInt(b.civic_number, 10) - number),
        )),
  };
}

const NEARBY_METRES = 500;

function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.round(Math.sqrt(x * x + y * y) * 6371000);
}

/**
 * What else Council has considered around a lot: matters at other lots within NEARBY_METRES, closest
 * first (a matter spanning several lots counts once, at its closest). Lots without a map pin fall back
 * to their neighbours on the same street, by civic number.
 */
async function getNearbyMatters(
  supabase: SupabaseClient,
  property: { id: number; geo: any },
  own: Set<number>,
  sameStreet: { id: number; slug: string; address: string }[],
) {
  let lots: { id: number; slug: string; address: string; distance: number | null }[] = [];
  // Distances only between real pins; a pin shared with other lots is the street, not the lot.
  const exact = (geo: any) => geo?.lat && geo?.lng && geo.precision !== "street";
  if (exact(property.geo)) {
    const all: any[] = [];
    for (let start = 0; ; start += 1000) {
      const { data, error } = await supabase
        .from("properties")
        .select("id, slug, address, geo")
        .neq("civic_number", "")
        .not("geo", "is", null)
        .order("id")
        .range(start, start + 999);
      if (error) {
        console.error("Error fetching nearby properties:", error);
        return [];
      }
      all.push(...(data || []));
      if ((data || []).length < 1000) break;
    }
    lots = all
      .filter((p) => p.id !== property.id && exact(p.geo))
      .map((p) => ({ id: p.id, slug: p.slug, address: p.address, distance: metres(property.geo, p.geo) }))
      .filter((p) => p.distance <= NEARBY_METRES)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 40);
  } else {
    lots = sameStreet.slice(0, 15).map((p) => ({ ...p, distance: null }));
  }
  if (!lots.length) return [];
  const { data: links } = await supabase
    .from("property_links")
    .select("property_id, matter_id")
    .in("property_id", lots.map((l) => l.id))
    .not("matter_id", "is", null)
    .eq("hidden", false);
  const lotById = new Map(lots.map((l, i) => [l.id, { ...l, rank: i }]));
  const nearest = new Map<number, (typeof lots)[number] & { rank: number }>();
  for (const link of links || []) {
    if (own.has(link.matter_id)) continue;
    const lot = lotById.get(link.property_id)!;
    const known = nearest.get(link.matter_id);
    if (!known || lot.rank < known.rank) nearest.set(link.matter_id, lot);
  }
  if (!nearest.size) return [];
  const { data: matters } = await supabase.from("matters").select(MATTER_FIELDS).in("id", [...nearest.keys()]);
  return (matters || [])
    .filter(visible)
    .map((m) => ({ ...m, lot: nearest.get(m.id)! }))
    .sort((a, b) => a.lot.rank - b.lot.rank || String(b.last_seen || b.first_seen).localeCompare(String(a.last_seen || a.first_seen)))
    .slice(0, 8);
}

export type Pin = { lat: number; lng: number; address: string };

/** A lot's pin when it's trustworthy: geocoded to the lot or its block, not a street fallback. */
export function propertyPin(p: { address: string; civic_number?: string | null; geo: any }): Pin | null {
  const g = p.geo;
  if (!p.civic_number || !g?.lat || !g?.lng || g.precision === "street") return null;
  return { lat: g.lat, lng: g.lng, address: p.address };
}

/**
 * Matter id -> map pins from its properties (BC-geocoded lots), for every matter or just some. Pins
 * agenda items got at ingest were often a street fallback; these replace them wherever a matter has one.
 */
export async function getPropertyPinsByMatter(supabase: SupabaseClient, matterIds?: number[]) {
  const pins = new Map<number, Pin[]>();
  const rows: any[] = [];
  if (matterIds) {
    for (let i = 0; i < matterIds.length; i += 300) {
      const { data, error } = await supabase
        .from("property_links")
        .select("matter_id, properties(address, civic_number, geo)")
        .in("matter_id", matterIds.slice(i, i + 300))
        .eq("hidden", false);
      if (error) throw error;
      rows.push(...(data || []));
    }
  } else {
    for (let start = 0; ; start += 1000) {
      const { data, error } = await supabase
        .from("property_links")
        .select("matter_id, properties(address, civic_number, geo)")
        .not("matter_id", "is", null)
        .eq("hidden", false)
        .order("id")
        .range(start, start + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if ((data || []).length < 1000) break;
    }
  }
  for (const row of rows) {
    const pin = row.properties ? propertyPin(row.properties) : null;
    if (!pin || !row.matter_id) continue;
    const list = pins.get(row.matter_id) || [];
    if (!list.some((p) => p.address === pin.address)) list.push(pin);
    pins.set(row.matter_id, list);
  }
  return pins;
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

/** `years`: the years Council considered the address (newest first), for the map's year filter. */
export type PropertyIndexEntry = { slug: string; address: string; records: number; years: number[]; geo: { lat: number; lng: number } | null };
export type RecentPropertyItem = {
  key: string;
  href: string;
  /** What is happening, in plain language (the matter's summary, else the item's). */
  summary: string;
  /** Where it stands ("Rezoning bylaw adopted Sep 21, 2026."), when the matter records it. */
  status: string | null;
  date: string;
  meetingTitle: string;
  properties: { slug: string; address: string }[];
};

// Public input items are left out of "recent": their addresses are often residents' homes.
const PUBLIC_INPUT = /public\s+(?:participation|input|comment|hearing\s+submission)|correspondence|delegation|written\s+submission|petition/i;

/**
 * Every address and street with at least one visible record (a matter, or an agenda
 * item outside any matter), most records first, plus what Council most recently
 * considered at an address. Records count the same way as the street page's "3 records".
 */
export async function getPropertiesIndex(supabase: SupabaseClient, recentCount = 8) {
  // First page carries the total, the rest are fetched together (the link join is the slow part).
  const pageAll = async <T,>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any; count?: number | null }>) => {
    const first = await build(0, 999);
    if (first.error) throw first.error;
    const rest = await Promise.all(
      Array.from({ length: Math.max(0, Math.ceil((first.count ?? 0) / 1000) - 1) }, (_, i) => build((i + 1) * 1000, (i + 1) * 1000 + 999)),
    );
    const failed = rest.find((page) => page.error);
    if (failed) throw failed.error;
    return [first, ...rest].flatMap((page) => page.data || []);
  };
  const [properties, links] = await Promise.all([
    pageAll<any>((from, to) => supabase.from("properties").select("id, slug, address, civic_number, street, geo", { count: "exact" }).order("id").range(from, to)),
    pageAll<any>((from, to) =>
      supabase
        .from("property_links")
        .select("id, property_id, matter_id, agenda_item_id, agenda_items(id, title, plain_english_summary, meetings(id, slug, title, meeting_date))", { count: "exact" })
        .eq("hidden", false)
        .order("id")
        .range(from, to),
    ),
  ]);
  const records = new Map<number, Set<string>>();
  const years = new Map<number, Set<number>>();
  for (const l of links) {
    const set = records.get(l.property_id) || new Set<string>();
    set.add(l.matter_id ? `m${l.matter_id}` : `i${l.agenda_item_id}`);
    records.set(l.property_id, set);
    const date = l.agenda_items?.meetings?.meeting_date;
    if (date) years.set(l.property_id, (years.get(l.property_id) || new Set<number>()).add(Number(date.slice(0, 4))));
  }
  // Five decimals is about a metre: plenty for a pin, and a smaller page payload.
  const round = (n: number) => Math.round(n * 1e5) / 1e5;
  const entry = (p: any): PropertyIndexEntry => ({
    slug: p.slug,
    address: p.address,
    records: records.get(p.id)?.size || 0,
    years: [...(years.get(p.id) || [])].sort((a, b) => b - a),
    geo: p.geo?.lat != null && p.geo?.lng != null ? { lat: round(p.geo.lat), lng: round(p.geo.lng) } : null,
  });
  const byRecords = (a: PropertyIndexEntry, b: PropertyIndexEntry) => b.records - a.records || a.address.localeCompare(b.address);
  const lotRows = properties.filter((p) => p.civic_number !== "" && records.has(p.id));
  const lots = lotRows.map(entry).sort(byRecords);
  const lotsPerStreet = new Map<string, number>();
  for (const lot of lotRows) lotsPerStreet.set(String(lot.street).toLowerCase(), (lotsPerStreet.get(String(lot.street).toLowerCase()) || 0) + 1);
  const streetRows = properties
    .filter((p) => p.civic_number === "")
    .map((p) => ({ street: String(p.street).toLowerCase(), entry: { ...entry(p), lots: lotsPerStreet.get(String(p.street).toLowerCase()) || 0 } }))
    .filter((s) => s.entry.records > 0 || s.entry.lots > 0);
  const streets = streetRows.map((s) => s.entry).sort((a, b) => a.address.localeCompare(b.address));
  // Every address must be one plain link from /properties: street pages list their lots, so only
  // lots on a street without its own page need listing directly.
  const streetsWithPages = new Set(streetRows.map((s) => s.street));
  const unlisted = lotRows
    .filter((p) => !streetsWithPages.has(String(p.street).toLowerCase()))
    .map((p) => ({ slug: p.slug as string, address: p.address as string }))
    .sort((a, b) => a.address.localeCompare(b.address, "en", { numeric: true }));

  return { lots, streets, unlisted, recent: await recentAtAddresses(supabase, properties, links, recentCount) };
}

/** Latest council activity at an address, one entry per matter (or per item outside a matter). */
async function recentAtAddresses(supabase: SupabaseClient, properties: any[], links: any[], count: number): Promise<RecentPropertyItem[]> {
  const byId = new Map(properties.map((p) => [p.id, p]));
  type Group = { key: string; matterId: number | null; item: any; date: string; properties: { slug: string; address: string }[] };
  const groups = new Map<string, Group>();
  for (const l of links) {
    const item = l.agenda_items;
    const property = byId.get(l.property_id);
    if (!item?.meetings?.meeting_date || !item.meetings.slug || !property || property.civic_number === "" || PUBLIC_INPUT.test(item.title || "")) continue;
    const key = l.matter_id ? `m${l.matter_id}` : `i${item.id}`;
    const group: Group = groups.get(key) || { key, matterId: l.matter_id, item, date: item.meetings.meeting_date, properties: [] };
    // The group speaks for its latest agenda item (a later reading, an adoption).
    if (item.meetings.meeting_date > group.date || (item.meetings.meeting_date === group.date && item.id > group.item.id)) {
      group.item = item;
      group.date = item.meetings.meeting_date;
    }
    if (!group.properties.some((p) => p.slug === property.slug)) group.properties.push({ slug: property.slug, address: property.address });
    groups.set(key, group);
  }
  // Each place once, so one busy development doesn't fill the card.
  const shown = new Set<string>();
  const picked = [...groups.values()]
    .sort((a, b) => b.date.localeCompare(a.date) || b.item.id - a.item.id)
    .filter((group) => {
      if (group.properties.every((p) => shown.has(p.slug))) return false;
      group.properties.forEach((p) => shown.add(p.slug));
      return true;
    })
    .slice(0, count);
  const matterIds = picked.map((g) => g.matterId).filter(Boolean) as number[];
  const { data: matters } = matterIds.length
    ? await supabase.from("matters").select("id, slug, title, plain_english_summary, meta").in("id", matterIds)
    : { data: [] as any[] };
  const matterById = new Map((matters || []).filter(visible).map((m) => [m.id, m]));
  return picked.map((group) => {
    const matter = group.matterId ? matterById.get(group.matterId) : null;
    const meeting = group.item.meetings;
    return {
      key: group.key,
      href: matter ? `/matters/${matter.slug || matter.id}` : `/meetings/${meeting.slug}#item-${group.item.id}`,
      summary: (matter?.plain_english_summary || group.item.plain_english_summary || group.item.title || "").trim(),
      status: matter?.meta?.status_line || (matter ? group.item.plain_english_summary : null) || null,
      date: group.date,
      meetingTitle: meeting.title,
      properties: group.properties,
    };
  });
}
