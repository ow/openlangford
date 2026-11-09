import type { SupabaseClient } from "@supabase/supabase-js";
import { splitLead, withClosing } from "../lib/property-lead";
import type { TopicEditState } from "../lib/topic-edit";

/**
 * Staff edits to an address page's lead (the review bar's pencil, the same one topic pages have). The lead is
 * properties.meta.summary; an edit locks it (meta.summary_locked, the lock the fix agent's rewrites use too), so the
 * pipeline's property-summaries stage leaves it alone and keeps its own latest version in `auto`. "Reset to automatic"
 * puts that back. `links` is the ids of the address's links at the last edit: links added since are shown to staff,
 * to decide whether the edit still holds. The closing "Mentioned in council meetings…" line is kept, not edited.
 */
export const LEAD_HAND_MAX = 1200;

type Lock = { by?: string; at?: string; auto?: string | null; hand?: boolean; links?: number[] };

async function load(supabase: SupabaseClient, propertyId: number) {
  const { data, error } = await supabase.from("properties").select("id, address, meta").eq("id", propertyId).single();
  if (error || !data) throw new Error("Could not load this address.");
  return data as { id: number; address: string; meta: Record<string, any> | null };
}

async function linkIds(supabase: SupabaseClient, propertyId: number): Promise<number[]> {
  const { data } = await supabase.from("property_links").select("id").eq("property_id", propertyId).eq("hidden", false).limit(2000);
  return ((data || []) as { id: number }[]).map((r) => r.id).sort((a, b) => a - b);
}

/** What the edit panel shows for an address: only the lead is editable. */
export async function propertyEditState(supabase: SupabaseClient, propertyId: number): Promise<TopicEditState> {
  const property = await load(supabase, propertyId);
  const lock = (property.meta?.summary_locked || null) as Lock | null;
  let newEntries = 0;
  if (lock?.links) {
    const before = new Set(lock.links);
    newEntries = (await linkIds(supabase, propertyId)).filter((id) => !before.has(id)).length;
  }
  return {
    noun: "address", fields: ["summary"],
    title: property.address, summary: splitLead(property.meta?.summary).body, statusLine: "", image: null,
    locked: lock ? ["summary"] : [], editedAt: lock?.at ?? null, newEntries, candidates: [],
  };
}

/** Saves the lead a person wrote. Returns whether anything changed. */
export async function savePropertyLead(supabase: SupabaseClient, propertyId: number, text: string, userId: string): Promise<{ changed: boolean }> {
  const property = await load(supabase, propertyId);
  const meta = { ...(property.meta || {}) } as Record<string, any>;
  const body = text.replace(/\s+/g, " ").trim().slice(0, LEAD_HAND_MAX);
  if (!body) throw new Error("Could not save: the summary can't be empty.");
  const next = withClosing(meta.summary, body);
  if (next === meta.summary) return { changed: false };
  const at = new Date().toISOString();
  const lock = (meta.summary_locked || {}) as Lock;
  meta.summary = next;
  meta.summary_updated_at = at;
  meta.summary_locked = { by: userId, at, auto: lock.auto ?? (property.meta?.summary ?? null), hand: true, links: await linkIds(supabase, propertyId) };
  const { error } = await supabase.from("properties").update({ meta }).eq("id", propertyId);
  if (error) throw new Error("Could not save the changes.");
  return { changed: true };
}

/** Puts the pipeline's own latest lead back and lets it write the lead again. */
export async function resetPropertyLead(supabase: SupabaseClient, propertyId: number): Promise<void> {
  const property = await load(supabase, propertyId);
  const meta = { ...(property.meta || {}) } as Record<string, any>;
  const lock = meta.summary_locked as Lock | undefined;
  if (!lock) return;
  if (lock.auto != null) meta.summary = lock.auto;
  else { delete meta.summary; delete meta.summary_inputs; delete meta.summary_version; }  // nothing to go back to: the stage writes a fresh one
  delete meta.summary_locked;
  const { error } = await supabase.from("properties").update({ meta }).eq("id", propertyId);
  if (error) throw new Error("Could not reset that field.");
}

/** Keeps the edit after new links came in: the "since your edit" count starts again from now. */
export async function confirmPropertyEdit(supabase: SupabaseClient, propertyId: number): Promise<void> {
  const property = await load(supabase, propertyId);
  const meta = { ...(property.meta || {}) } as Record<string, any>;
  if (!meta.summary_locked) return;
  meta.summary_locked = { ...meta.summary_locked, links: await linkIds(supabase, propertyId) };
  const { error } = await supabase.from("properties").update({ meta }).eq("id", propertyId);
  if (error) throw new Error("Could not save that.");
}
