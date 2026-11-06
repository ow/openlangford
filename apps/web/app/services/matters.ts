import { writtenLetters } from "../lib/written";
import { showsInTimeline } from "../lib/timeline-story";
import { getPropertyPinsByMatter, type Pin } from "./properties";
import { parseRelatedAddresses } from "../lib/addresses";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Matter, Municipality, AgendaItem } from "../lib/types";

const DEFAULT_MUNICIPALITY = { id: 1 } as Municipality;

function isMunicipality(value: unknown): value is Municipality {
  return !!value && typeof value === "object" && "id" in value;
}

function resolveMunicipalityAndId(
  municipalityOrId: Municipality | string,
  id?: string,
): [Municipality, string] {
  if (isMunicipality(municipalityOrId)) {
    if (!id) throw new Error("Missing id");
    return [municipalityOrId, id];
  }
  return [DEFAULT_MUNICIPALITY, municipalityOrId];
}

function resolveMunicipalityAndIds(
  municipalityOrIds: Municipality | number[],
  ids?: number[],
): [Municipality, number[]] {
  if (isMunicipality(municipalityOrIds)) {
    return [municipalityOrIds, ids || []];
  }
  return [DEFAULT_MUNICIPALITY, municipalityOrIds];
}

/** What the index page's counts, categories and page links need: one narrow row per public matter, newest activity first. */
export type MatterIndexRow = { id: number; title: string; category: string | null; status: string; last_seen: string | null };

/** The public matter list's order and filters, shared by the narrow index and the full rows so a page of ids lines up. */
function publicMatters(supabase: SupabaseClient, municipality: Municipality, columns: string) {
  return supabase
    .from("matters")
    .select(columns)
    .eq("municipality_id", municipality.id)
    .is("merged_into", null)
    .is("meta->>hidden", null)
    .order("last_seen", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false });
}

/** Narrow rows (no agenda-item join, no pins) for every public matter: cheap enough to rebuild often. */
export async function getMatterIndex(supabase: SupabaseClient, municipality: Municipality = DEFAULT_MUNICIPALITY): Promise<MatterIndexRow[]> {
  const rows: MatterIndexRow[] = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await publicMatters(supabase, municipality, "id, title, category, status, last_seen").range(start, start + 999);
    if (error) throw error;
    rows.push(...((data || []) as unknown as MatterIndexRow[]));
    if (!data || data.length < 1000) return rows;
  }
}

export async function getMatters(
  supabase: SupabaseClient,
  municipality: Municipality = DEFAULT_MUNICIPALITY,
  /** Only these matters (a page of the index). Rows come back in the list's usual order. */
  onlyIds?: number[],
) {
  const allData: any[] = [];
  const pageSize = 1000;
  let offset = 0;
  if (onlyIds && !onlyIds.length) return [];

  while (true) {
    let query = publicMatters(
      supabase,
      municipality,
      `
        id,
        slug,
        title,
        identifier,
        category,
        status,
        description,
        plain_english_summary,
        first_seen,
        last_seen,
        geo_location,
        display_title:meta->>display_title,
        lead_image_key:meta->images->lead->>r2_key,
        bylaw:bylaws(slug, title, bylaw_number),
        agenda_items(related_address, geo_location, written:meta->written_participation)
      `,
    );
    if (onlyIds) query = query.in("id", onlyIds);
    const { data, error } = await query.range(offset, offset + pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    allData.push(...data);
    offset += pageSize;

    if (data.length < pageSize) break;
  }

  // Pins from the matters' properties (BC-geocoded) beat the ones agenda items got at ingest.
  const propertyPins = await getPropertyPinsByMatter(supabase, onlyIds).catch((error) => {
    console.error("Error fetching property pins:", error);
    return new Map<number, Pin[]>();
  });

  return allData.map((matter) => {
    // Aggregate addresses from agenda items
    const addresses = new Set<string>();
    (matter.agenda_items || []).forEach((item: any) => {
      parseRelatedAddresses(item.related_address).forEach((addr) => addresses.add(addr));
    });

    // Aggregate locations from matter + agenda items
    const locationsMap = new Map<string, any>();
    const mGeo = matter.geo_location;
    if (mGeo?.lat && mGeo?.lng) {
      locationsMap.set(`${mGeo.lat},${mGeo.lng}`, mGeo);
    }
    (matter.agenda_items || []).forEach((item: any) => {
      const g = item.geo_location;
      if (g?.lat && g?.lng) {
        locationsMap.set(`${g.lat},${g.lng}`, {
          ...g,
          address: parseRelatedAddresses(item.related_address)[0],
        });
      }
    });

    const lots = propertyPins.get(matter.id);

    // The list only renders a row and a pin per matter: drop agenda items
    // and the long description when a plain-English summary exists (keeps the payload small).
    const { agenda_items, geo_location, display_title, description, ...rest } = matter;
    return {
      ...rest,
      description: matter.plain_english_summary ? null : description,
      meta: display_title ? { display_title } : null,
      addresses: Array.from(addresses),
      locations: lots?.length ? lots : Array.from(locationsMap.values()),
      letter_count: (matter.agenda_items || []).reduce(
        (sum: number, item: any) => sum + writtenLetters(item.written).length,
        0,
      ),
    };
  });
}

export async function getMatterById(
  supabase: SupabaseClient,
  id: string,
): Promise<Matter & { agenda_items: (AgendaItem & { meetings: any; motions: any })[] }>;
export async function getMatterById(
  supabase: SupabaseClient,
  municipality: Municipality,
  id: string,
): Promise<Matter & { agenda_items: (AgendaItem & { meetings: any; motions: any })[] }>;
export async function getMatterById(
  supabase: SupabaseClient,
  municipalityOrId: Municipality | string,
  maybeId?: string,
) {
  const [municipality, id] = resolveMunicipalityAndId(
    municipalityOrId,
    maybeId,
  );
  const detailSelection = "id, slug, title, identifier, description, category, plain_english_summary, status, first_seen, last_seen, bylaw_id, merged_into, meta, created_at, bylaw:bylaws(id, slug, title, bylaw_number, year, category, status, plain_english_summary, source_url, created_at), agenda_items(id, meeting_id, item_order, title, description, category, debate_summary, plain_english_summary, is_controversial, is_consent_agenda, discussion_start_time, financial_cost, funding_source, related_address, geo_location, matter_status_snapshot, meta, meetings(slug, id, title, meeting_date, organizations(name)), motions(id, meeting_id, agenda_item_id, mover, seconder, mover_id, seconder_id, text_content, plain_english_summary, result, disposition, yes_votes, no_votes, abstain_votes, absent_votes, meta, votes(id, motion_id, person_id, vote, recusal_reason, person:people(id, name, image_url))))";
  const load = async (matterId: string) => {
    const { data, error } = await supabase.from("matters").select(detailSelection)
      .eq("id", matterId).eq("municipality_id", municipality.id).single();
    if (error) throw error;
    return data;
  };
  let matter = await load(id);
  // A merged topic's address shows the topic it was merged into, which holds all of its entries.
  if (matter.merged_into) matter = await load(String(matter.merged_into));
  // A topic holds one bylaw; topics merged into it can hold others (a follow-up amendment, a second area's bylaw).
  const { data: parts } = await supabase.from("matters")
    .select("bylaw:bylaws(id, slug, title, bylaw_number, year, category, status, plain_english_summary, source_url, created_at)")
    .eq("merged_into", matter.id).not("bylaw_id", "is", null);
  const otherBylaws = [...new Map(((parts || []) as any[]).map((p) => p.bylaw).filter((b) => b && b.id !== (matter as any).bylaw_id)
    .map((b) => [b.id, b])).values()];
  if (otherBylaws.length) (matter as any).other_bylaws = otherBylaws;

  return matter as unknown as Matter & {
    agenda_items: (AgendaItem & {
      meetings: any;
      motions: any;
    })[];
  };
}

export async function getDocumentsForAgendaItems(
  supabase: SupabaseClient,
  agendaItemIds: number[],
): Promise<any[]>;
export async function getDocumentsForAgendaItems(
  supabase: SupabaseClient,
  municipality: Municipality,
  agendaItemIds: number[],
): Promise<any[]>;
export async function getDocumentsForAgendaItems(
  supabase: SupabaseClient,
  municipalityOrAgendaItemIds: Municipality | number[],
  maybeAgendaItemIds?: number[],
) {
  const [, agendaItemIds] = resolveMunicipalityAndIds(
    municipalityOrAgendaItemIds,
    maybeAgendaItemIds,
  );
  if (agendaItemIds.length === 0) return [];
  const { data, error } = await supabase
    .from("extracted_documents")
    .select("id, document_id, agenda_item_id, title, document_type, page_start, page_end")
    .in("agenda_item_id", agendaItemIds)
    .order("agenda_item_id")
    .order("page_start", { ascending: true, nullsFirst: false });
  if (error) {
    console.error("Error fetching documents for agenda items:", error);
    return [];
  }
  return data ?? [];
}

/**
 * The same rows as getDocumentsForAgendaItems for all of a matter's agenda items, in one query that needs
 * only the matter id, so it can start before the matter itself has loaded.
 */
export async function getDocumentsForMatter(supabase: SupabaseClient, matterId: number): Promise<any[]> {
  const { data, error } = await supabase
    .from("extracted_documents")
    .select("id, document_id, agenda_item_id, title, document_type, page_start, page_end, agenda_items!inner(matter_id)")
    .eq("agenda_items.matter_id", matterId)
    .order("agenda_item_id")
    .order("page_start", { ascending: true, nullsFirst: false });
  if (error) {
    console.error("Error fetching documents for matter:", error);
    return [];
  }
  return (data ?? []).map(({ agenda_items: _join, ...row }: any) => row);
}

export async function getMatterEvidence(
  supabase: SupabaseClient,
  matterId: string | number,
) {
  const { data, error } = await supabase
    .from("matter_evidence")
    .select(
      "id, evidence_type, confidence, reason, agenda_item_id, document_section_id, agenda_item:agenda_items(id, meeting_id, item_order, title, meetings(slug, id, title, meeting_date, organizations(name))), document_section:document_sections(id, section_title, section_text, page_start, page_end, document_id, agenda_item_id, document:documents(id, title, meeting_id, meetings(slug, id, title, meeting_date, organizations(name))))",
    )
    .eq("matter_id", Number(matterId))
    .eq("hidden", false)
    .order("confidence", { ascending: false })
    .order("id", { ascending: true })
    .limit(25);

  if (error) {
    console.error("Error fetching matter evidence:", error);
    return [];
  }

  return data ?? [];
}

export async function getHotTopics(
  supabase: SupabaseClient,
  municipality: Municipality = DEFAULT_MUNICIPALITY,
) {
  const { data, error } = await supabase
    .from("agenda_items")
    .select(
      "id, meeting_id, title, description, category, debate_summary, plain_english_summary, is_controversial, discussion_start_time, created_at, meetings!inner(slug, id, title, meeting_date, municipality_id, organizations(name))",
    )
    .eq("is_controversial", true)
    .eq("meetings.municipality_id", municipality.id)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data as any[];
}

export async function getFiscalData(supabase: SupabaseClient) {
  const { data: items, error } = await supabase
    .from("agenda_items")
    .select(
      "id, meeting_id, title, description, category, financial_cost, funding_source, created_at, meetings(slug, id, title, meeting_date, organizations(name))",
    )
    .not("financial_cost", "is", null)
    .order("financial_cost", { ascending: false });

  if (error) throw error;
  return items || [];
}

/**
 * Story context for a matter: other matters that are steps of the same
 * initiative, and mixed-topic agenda items (notices of motion, presentations,
 * public participation) that discussed it. Written by the pipeline's
 * matter_links step.
 */
export async function getMatterStory(supabase: SupabaseClient, matterId: number, municipalityId = 1) {
  const ownIds = [matterId];
  const own = new Set(ownIds);
  const rows = async (build: () => any): Promise<{ data: any[]; error: any }> => {
    const data: any[] = [];
    for (let start = 0; ; start += 500) {
      const result = await build().range(start, start + 499);
      if (result.error) return { data: [], error: result.error };
      data.push(...(result.data || []));
      if ((result.data || []).length < 500) return { data, error: null };
    }
  };
  const empty = { related: [] as any[], mentions: [] as any[], background: [] as any[], reports: [] as any[] };
  const [{ data: links, error }, { data: ownRows }, reports] = await Promise.all([
    rows(() => supabase.from("matter_links")
      .select("kind, matter_id, related_matter_id, agenda_item_id, confidence, source, quote, review")
      .eq("hidden", false).or(`matter_id.in.(${ownIds.join(",")}),related_matter_id.in.(${ownIds.join(",")})`).order("id")),
    rows(() => supabase.from("matters").select("id, identifier").in("id", ownIds)),
    getMatterReportMentions(supabase, ownIds, municipalityId),
  ]);
  empty.reports = reports;
  if (error) { console.error("Error fetching matter links:", error); return empty; }
  const relatedLinks = new Map<number, any>();
  for (const l of (links || []).filter(l => l.kind === "related_matter")) {
    const other = own.has(l.matter_id) ? l.related_matter_id : l.matter_id;
    if (Number.isSafeInteger(other) && other > 0 && !own.has(other) && !relatedLinks.has(other)) relatedLinks.set(other, l);
  }
  const relatedIds = [...relatedLinks.keys()];
  const mentionIds = [...new Set((links || []).filter(l => l.kind === "mention" && own.has(l.matter_id)).map(l => l.agenda_item_id))];
  const selection = "id, matter_id, meeting_id, title, plain_english_summary, meta, meetings!inner(slug, id, meeting_date, title, municipality_id, organizations(name))";
  const [relatedResult, mentionsResult] = await Promise.all([
    relatedIds.length ? rows(() => supabase.from("matters")
      .select("id, slug, title, identifier, status, first_seen, last_seen, meta, plain_english_summary")
      .in("id", relatedIds).eq("municipality_id", municipalityId).is("merged_into", null).order("id"))
      : Promise.resolve({ data: [] as any[], error: null }),
    mentionIds.length ? rows(() => supabase.from("agenda_items").select(selection).in("id", mentionIds)
      .eq("meetings.municipality_id", municipalityId).order("id"))
      : Promise.resolve({ data: [] as any[], error: null }),
  ]);
  if (relatedResult.error || mentionsResult.error) {
    console.error("Error fetching matter story records:", relatedResult.error || mentionsResult.error); return empty;
  }
  const related = (relatedResult.data || []).filter(r => r.meta?.hidden !== "container" && r.meta?.hidden !== "staff")
    .sort((a, b) => String(a.first_seen).localeCompare(String(b.first_seen)));
  // Links found by name carry the passage that names the matter, and say whether the item was about it
  // ("name") or only referred to it ("name_mention").
  const linkFor = new Map((links || []).filter(l => l.kind === "mention" && own.has(l.matter_id)).map(l => [l.agenda_item_id, l]));
  const mentions = (mentionsResult.data || []).map(item => {
    const link = linkFor.get(item.id);
    return { ...item, linkSource: link?.source ?? null, linkQuote: link?.quote ?? null };
  });
  // Only a related topic that is the same project lends its entries to the timeline; the rest stay in the list.
  const ownIdentifiers = ((ownRows || []) as any[]).map((r) => r.identifier);
  const verifiedIds = related.filter(r => showsInTimeline(relatedLinks.get(r.id), ownIdentifiers, r)).map(r => r.id);
  if (!verifiedIds.length) return { related, mentions, background: [] as any[], reports };

  // One hop only: a related matter's direct records/mentions are background,
  // never the current matter's decisions. Do not traverse its related matters.
  const relatedMentions = await rows(() => supabase.from("matter_links").select("matter_id, agenda_item_id, source, quote")
    .in("matter_id", verifiedIds).eq("kind", "mention").eq("hidden", false).order("id"));
  if (relatedMentions.error) { console.error("Error fetching background mentions:", relatedMentions.error); return { related, mentions, background: [] as any[], reports }; }
  const backgroundIds = [...new Set((relatedMentions.data || []).map(l => l.agenda_item_id))]
    .filter(id => Number.isSafeInteger(id) && id > 0);
  const clauses = [`matter_id.in.(${verifiedIds.join(",")})`];
  if (backgroundIds.length) clauses.push(`id.in.(${backgroundIds.join(",")})`);
  const records = await rows(() => supabase.from("agenda_items").select(selection).or(clauses.join(","))
    .eq("meetings.municipality_id", municipalityId).order("id"));
  if (records.error) { console.error("Error fetching background records:", records.error); return { related, mentions, background: [] as any[], reports }; }
  const directIds = new Set(mentions.map(item => item.id));
  const background = (records.data || []).filter(item => !own.has(item.matter_id) && !directIds.has(item.id)).map(item => {
    const link = verifiedIds.includes(item.matter_id) ? null
      : (relatedMentions.data || []).find(link => link.agenda_item_id === item.id);
    const ownerId = link ? link.matter_id : item.matter_id;
    // Found by name for the related matter: its passage says why the item belongs, where the item's own
    // summary ("Public hearings were held") often doesn't.
    return { ...item, relatedMatter: related.find(r => r.id === ownerId), linkSource: link?.source ?? null, linkQuote: link?.quote ?? null };
  }).filter(item => item.relatedMatter);
  return { related, mentions, background, reports };
}

export type ReportMention = { id: number; year: number; title: string; page: number; quote: string; url: string | null };

/** Pages of the City's annual reports that describe a matter (pipeline matter_names step), oldest first. */
export async function getMatterReportMentions(supabase: SupabaseClient, matterId: number | number[], municipalityId = 1): Promise<ReportMention[]> {
  const ids = Array.isArray(matterId) ? matterId : [matterId];
  const { data, error } = await supabase.from("matter_report_mentions")
    .select("id, page, quote, public_reports!inner(year, title, source_url, municipality_id)")
    .in("matter_id", ids).eq("hidden", false).eq("public_reports.municipality_id", municipalityId);
  if (error) { console.error("Error fetching annual report mentions:", error); return []; }
  const seen = new Set<string>();  // several topics passed together can cite the same page
  return (data || []).map((row: any) => {
    const report = Array.isArray(row.public_reports) ? row.public_reports[0] : row.public_reports;
    return { id: row.id, year: report.year, title: report.title, page: row.page, quote: row.quote,
             url: report.source_url ? `${report.source_url}#page=${row.page}` : null };
  }).filter((r) => !seen.has(`${r.year}:${r.page}`) && !!seen.add(`${r.year}:${r.page}`))
    .sort((a, b) => a.year - b.year || a.page - b.page);
}

export type MatterLink = { id: number; slug: string | null; title: string };

/**
 * Matter id -> the public matter page an agenda item belongs to (a merged topic resolves to the one it was merged
 * into; hidden matters are left out), for linking meeting agenda items to their matter.
 */
export async function getMatterLinks(supabase: SupabaseClient, matterIds: (number | null | undefined)[]): Promise<Record<number, MatterLink>> {
  const ids = [...new Set(matterIds.filter((id): id is number => !!id))];
  if (!ids.length) return {};
  const fields = "id, slug, title, hidden:meta->>hidden, canonical:merged_into";
  const { data, error } = await supabase.from("matters").select(fields).in("id", ids);
  if (error) {
    console.error("Error fetching agenda item matters:", error);
    return {};
  }
  const rows = (data || []) as any[];
  const canonicalIds = rows.map((m) => Number(m.canonical) || 0).filter(Boolean);
  const { data: canonical } = canonicalIds.length
    ? await supabase.from("matters").select(fields).in("id", canonicalIds)
    : { data: [] as any[] };
  const byId = new Map(((canonical || []) as any[]).map((m) => [m.id, m]));
  const links: Record<number, MatterLink> = {};
  for (const row of rows) {
    const target = row.canonical ? byId.get(Number(row.canonical)) : row;
    if (!target || target.hidden === "true" || target.hidden === "staff" || target.canonical) continue;
    links[row.id] = { id: target.id, slug: target.slug, title: target.title };
  }
  return links;
}
