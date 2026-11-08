import type { SupabaseClient } from "@supabase/supabase-js";
import type { Suggestion } from "./page-links.server";

/**
 * "Find missing" for a property page: the records that name the address but aren't linked to it. The pipeline
 * links an address from item titles and extracted addresses; a budget line, a motion or a report that names the
 * lot, and a topic titled with it, can slip past. The search is plain text matching on the City's records (no
 * model), run when staff press Check on the page; what it finds waits in properties.meta.suggestions for a 👍
 * (which links it, source "admin", which the pipeline's properties stage keeps) or a 👎.
 */

const TYPE_FORMS: Record<string, string[]> = {
  highway: ["highway", "hwy"], road: ["road", "rd"], avenue: ["avenue", "ave"], drive: ["drive", "dr"], street: ["street", "st"],
  place: ["place", "pl"], crescent: ["crescent", "cres"], court: ["court", "crt", "ct"], parkway: ["parkway", "pkwy"],
  boulevard: ["boulevard", "blvd"], terrace: ["terrace", "terr"], lane: ["lane", "ln"], close: ["close", "cl"], trail: ["trail"], way: ["way"],
};

/** ILIKE patterns for an address as the records write it: "3680 Trans-Canada Highway", "3680 Trans Canada Hwy",
 * "3680 TRANS-CANADA HWY". The street's words may be joined by a space or a hyphen; the type may be abbreviated
 * or missing. Exported for tests. */
export function addressPatterns(civic: string, street: string): string[] {
  const words = street.trim().split(/[\s-]+/).filter(Boolean);
  if (!civic || !words.length) return [];
  const last = words[words.length - 1].toLowerCase();
  const forms = TYPE_FORMS[last];
  const name = (forms ? words.slice(0, -1) : words).map((w) => w.replace(/[%_]/g, "")).join("%");
  if (!name) return [];
  const heads = forms ? forms.map((f) => `${name}%${f}`) : [name];
  // The name alone too ("3680 Trans-Canada" in a budget line), when it has a type to drop.
  if (forms) heads.push(name);
  return [...new Set(heads.map((h) => `%${civic} ${h}%`))];
}

type Found = { kind: "item" | "topic"; id: number; title: string; date: string | null; href: string | null; foundIn: "item" | "spoken" | "document" | "topic"; reason: string };
export type PropertySuggestion = Found & { status: "pending" | "accepted" | "rejected"; decided_by?: string; decided_at?: string };

const CAP = 40;

/** Search the records for the address and store what isn't linked yet in properties.meta.suggestions. Returns how
 * many are waiting. Earlier decisions (accepted, rejected) are kept. */
export async function findPropertyMissing(supabase: SupabaseClient, propertyId: number, userId: string): Promise<number> {
  const { data: property } = await supabase.from("properties").select("id, address, civic_number, street, meta").eq("id", propertyId).single();
  if (!property?.civic_number || !property.street) return 0;
  const patterns = addressPatterns(property.civic_number, property.street);
  if (!patterns.length) return 0;
  // Quoted, so the pattern's spaces survive PostgREST's filter parsing.
  const or = (col: string) => patterns.map((p) => `${col}.ilike."${p.replace(/[,"]/g, "")}"`).join(",");
  const { data: linked } = await supabase.from("property_links").select("agenda_item_id, matter_id").eq("property_id", propertyId);
  const linkedItems = new Set(((linked || []) as any[]).map((l) => l.agenda_item_id).filter(Boolean));
  const linkedTopics = new Set(((linked || []) as any[]).map((l) => l.matter_id).filter(Boolean));
  const [titles, motions, sections, topics] = await Promise.all([
    supabase.from("agenda_items").select("id, title, matter_id, meetings(slug, meeting_date)").or(or("title")).limit(CAP),
    supabase.from("motions").select("agenda_item_id, agenda_items(id, title, matter_id, meetings(slug, meeting_date))").or(or("text_content")).limit(CAP),
    supabase.from("document_sections").select("agenda_item_id, agenda_items(id, title, matter_id, meetings(slug, meeting_date))").not("agenda_item_id", "is", null).or(or("section_text")).limit(CAP * 3),
    supabase.from("matters").select("id, slug, title, first_seen, merged_into, meta").or(or("title")).limit(CAP),
  ]);
  const one = <T,>(v: T | T[] | null | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
  const found = new Map<string, Found>();
  const addItem = (item: any, foundIn: Found["foundIn"], reason: string) => {
    if (!item?.id || linkedItems.has(item.id) || found.has(`item-${item.id}`)) return;
    const meeting = one(item.meetings) as any;
    found.set(`item-${item.id}`, { kind: "item", id: item.id, title: String(item.title || "").split("\n")[0].slice(0, 160), date: meeting?.meeting_date ?? null,
      href: meeting?.slug ? `/meetings/${meeting.slug}#item-${item.id}` : null, foundIn, reason });
  };
  for (const i of (titles.data || []) as any[]) addItem(i, "item", "The item's title names this address.");
  for (const m of (motions.data || []) as any[]) addItem(one(m.agenda_items), "spoken", "A decision at this item names this address.");
  for (const s of (sections.data || []) as any[]) addItem(one(s.agenda_items), "document", "A report or minutes attached to this item names this address.");
  for (const t of (topics.data || []) as any[]) {
    if (t.merged_into || t.meta?.hidden || linkedTopics.has(t.id) || found.has(`topic-${t.id}`)) continue;
    found.set(`topic-${t.id}`, { kind: "topic", id: t.id, title: t.meta?.display_title || t.title, date: t.first_seen ?? null, href: `/matters/${t.slug}`, foundIn: "topic", reason: "The topic's title names this address." });
  }
  const meta = { ...((property.meta || {}) as Record<string, any>) };
  const earlier = (Array.isArray(meta.suggestions) ? meta.suggestions : []) as PropertySuggestion[];
  const decided = new Map(earlier.filter((s) => s.status !== "pending").map((s) => [`${s.kind}-${s.id}`, s]));
  const suggestions: PropertySuggestion[] = [...found.values()]
    .map((f) => decided.get(`${f.kind}-${f.id}`) ?? { ...f, status: "pending" as const })
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  // Keep decisions on things the search no longer finds, so a rejected entry stays rejected.
  for (const s of earlier) if (s.status !== "pending" && !found.has(`${s.kind}-${s.id}`)) suggestions.push(s);
  await supabase.from("properties").update({ meta: { ...meta, suggestions, suggestions_searched_at: new Date().toISOString(), suggestions_searched_by: userId } }).eq("id", propertyId);
  return suggestions.filter((s) => s.status === "pending").length;
}

/** The pending suggestions as the review bar lists them. */
export async function listPropertySuggestions(supabase: SupabaseClient, propertyId: number): Promise<{ suggestions: Suggestion[]; searchedAt: string | null }> {
  const { data } = await supabase.from("properties").select("meta").eq("id", propertyId).single();
  const meta = (data?.meta || {}) as Record<string, any>;
  const all = (Array.isArray(meta.suggestions) ? meta.suggestions : []) as PropertySuggestion[];
  return {
    searchedAt: meta.suggestions_searched_at ?? null,
    suggestions: all.filter((s) => s.status === "pending").map((s) => ({
      table: s.kind === "topic" ? "property_matters" : "property_items", id: s.id, kind: s.kind === "topic" ? "related" : "mention",
      date: s.date, title: s.title, quote: null, href: s.href, reason: s.reason, score: null, foundIn: s.foundIn, agreed: false, itemId: s.kind === "item" ? s.id : null,
    })),
  };
}

/** 👍 links the entry to the address now (source "admin", kept by the pipeline); 👎 keeps it off for good. */
export async function decidePropertySuggestion(supabase: SupabaseClient, propertyId: number, table: string, id: number, accept: boolean, userId: string) {
  const kind = table === "property_matters" ? "topic" : table === "property_items" ? "item" : null;
  if (!kind || !Number.isSafeInteger(id)) throw new Error("Unknown suggestion.");
  const { data } = await supabase.from("properties").select("meta").eq("id", propertyId).single();
  const meta = { ...((data?.meta || {}) as Record<string, any>) };
  const all = (Array.isArray(meta.suggestions) ? meta.suggestions : []) as PropertySuggestion[];
  if (!all.some((s) => s.kind === kind && s.id === id)) throw new Error("That suggestion is no longer listed.");
  if (accept) {
    const column = kind === "topic" ? "matter_id" : "agenda_item_id";
    const { data: existing } = await supabase.from("property_links").select("id, hidden").eq("property_id", propertyId).eq(column, id).limit(1);
    if (existing?.length) await supabase.from("property_links").update({ hidden: false, source: "admin" }).eq("id", existing[0].id);
    else {
      const { error } = await supabase.from("property_links").insert({ property_id: propertyId, [column]: id, source: "admin", hidden: false });
      if (error) throw new Error("Could not link that entry.");
    }
  }
  const at = new Date().toISOString();
  meta.suggestions = all.map((s) => (s.kind === kind && s.id === id ? { ...s, status: accept ? "accepted" : "rejected", decided_by: userId, decided_at: at } : s));
  const { error } = await supabase.from("properties").update({ meta }).eq("id", propertyId);
  if (error) throw new Error("Could not save that decision.");
}
