import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Moving an agenda item to another topic and merging duplicate topics, done by the fix agent in its own request. The
 * pipeline does the same for the one move it keeps, re-filing an item the way ingest files it
 * (apps/pipeline/pipeline/ingestion/staff_fixes.py move_item, matter_resolver.merge_flat, matter_lifecycle).
 *
 * A moved item carries a lock, agenda_items.meta.staff_matter ({matter_id, by, at, reason, from}), which the ingester
 * and the history step respect: re-processing a meeting never files it back.
 */

/** File one agenda item under another topic (or none) and lock it there. */
export async function moveItem(supabase: SupabaseClient, itemId: number, toMatterId: number | null, by: string, reason: string) {
  const { data: item, error } = await supabase.from("agenda_items").select("id, matter_id, meeting_id, meta").eq("id", itemId).single();
  if (error || !item) throw new Error(`item ${itemId} couldn't be found`);
  if (toMatterId !== null) {
    const { data: target } = await supabase.from("matters").select("id, merged_into").eq("id", toMatterId).single();
    if (!target) throw new Error(`topic ${toMatterId} couldn't be found`);
    toMatterId = target.merged_into || toMatterId;
  }
  const meta = { ...(item.meta || {}), staff_matter: { matter_id: toMatterId, by, at: new Date().toISOString(), reason: reason.slice(0, 300), from: item.matter_id } };
  const { error: moveError } = await supabase.from("agenda_items").update({ matter_id: toMatterId, meta }).eq("id", itemId);
  if (moveError) throw new Error(moveError.message);
  // The item's addresses go with it, so the old topic's map and property pages drop them now.
  await supabase.from("property_links").update({ matter_id: toMatterId }).eq("agenda_item_id", itemId);
  return { from: item.matter_id as number | null, to: toMatterId, meetingId: item.meeting_id as number };
}

/** Merge topics into one with the database's merge_matters(), which moves every item and link onto the canonical and
 * records what moved in matter_merges. A topic already merged elsewhere is merged through its current canonical. */
export async function mergeFlat(supabase: SupabaseClient, ids: number[], canonical: number) {
  const { data: rows } = await supabase.from("matters").select("id, merged_into").in("id", ids);
  const byId = new Map(((rows || []) as any[]).map((r) => [r.id as number, r]));
  canonical = byId.get(canonical)?.merged_into || canonical;
  const aliases = [...new Set(ids.filter((i) => byId.has(i)).map((i) => byId.get(i).merged_into || i))].filter((i) => i !== canonical).sort((a, b) => a - b);
  if (!aliases.length) return { canonical, aliases: [] as number[] };
  const { data, error } = await supabase.rpc("merge_matters", { p_canonical: canonical, p_aliases: aliases, p_reason: "staff", p_by: "pipeline" });
  if (error) throw new Error(error.message);
  return { canonical, aliases: ((data as any)?.aliases as number[] | undefined) || aliases };
}

// --- Lifecycle (pipeline matter_lifecycle.py): only an explicit final action on all of a topic's bylaws changes its status.

const RULE_VERSION = "bylaw-final-action-v1";

/** Pipeline matter_matching.bylaw_identifiers: only explicit bylaw labels. */
export function bylawIdentifiers(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const m of text.matchAll(/\bBylaws?\s+(?:Nos?\.?\s*)?(\d+(?:-\d+)?)/gi)) out.add(`Bylaw ${m[1]}`);
  for (const m of text.matchAll(/\bBylaws?\s+Nos\.?\s+(\d+(?:\s*(?:,|&|and)\s*\d+)*)/gi)) {
    for (const n of m[1].match(/\d+/g) || []) out.add(`Bylaw ${n}`);
  }
  return out;
}

/** The bylaw parts of a compound identifier (pipeline matter_matching.parse_compound_identifier, bylaws only). */
export function identifierBylaws(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (raw || "").split(";")) {
    const bare = part.trim();
    if (/^\d{3,4}$/.test(bare) && !(Number(bare) >= 2000 && Number(bare) <= 2035)) { out.add(`Bylaw ${bare}`); continue; }
    const plural = bare.match(/^Bylaws?\s+Nos?\.?\s*(\d+(?:-\d+)?(?:\s*(?:,|&|and)\s*\d+(?:-\d+)?)*)$/i);
    if (plural && /,|&|\band\b/.test(plural[1])) { for (const n of plural[1].match(/\d+(?:-\d+)?/g) || []) out.add(`Bylaw ${n}`); continue; }
    const single = bare.match(/^(?:Amendment\s+)?Bylaws?\s+(?:Nos?\.?\s*)?(\d+(?:-\d+)?)/i);
    const normalized = single ? `Bylaw ${single[1]}` : bare.split(/\s+/).filter(Boolean).join(" ");
    if (normalized.length > 2 && normalized.startsWith("Bylaw ")) out.add(normalized);
  }
  return out;
}

export function lifecycleEvidence(matter: { identifier?: string | null; title?: string | null }, motion: any) {
  if (!["CARRIED", "PASSED", "ADOPTED"].includes(String(motion.result || "").trim().toUpperCase())) return null;
  if (["procedural", "amended", "amendment"].includes(String(motion.disposition || "").toLowerCase())) return null;
  let identifiers = identifierBylaws(matter.identifier);
  if (!identifiers.size) identifiers = bylawIdentifiers(matter.title);
  if (!identifiers.size) return null;
  const text = String(motion.text_content || "").split(/\s+/).filter(Boolean).join(" ");
  // Recommendations and conditional/future actions do not establish adoption.
  if (/\b(recommend\w*|subject to|if|once|prior to|upon|after|not adopt|not be adopted)\b/i.test(text)) return null;
  const actedOn = new Set<string>();
  let status: string | null = null;
  const clauses: any[] = [];
  for (const clause of text.split(/;|\bAND THAT\b/i)) {
    const action = clause.match(/\bCouncil\s+(adopt|repeal)\s+([\s\S]+)/i);
    if (!action) continue;
    const verb = action[1];
    const directObject = action[2].split(/\b(?:and (?:further )?that|and direct|and authorize|and approve)\b/i)[0];
    const firstBylaw = directObject.search(/\bBylaws?\b/i);
    if (firstBylaw < 0) continue;
    if (/\b(report|resolution|recommendation|pursuant|under|regarding|concerning|direct|prepare|draft|consider|refer|authorize|approve|with respect|in accordance|in relation)\b/i.test(directObject.slice(0, firstBylaw))) continue;
    if (/\b(?:and|to)\s+(?:direct|prepare|draft|consider|refer|authorize|approve|adopt|repeal)\b/i.test(directObject)) continue;
    const candidate = verb.toLowerCase() === "repeal" ? "Repealed" : "Adopted";
    if (status && candidate !== status) return null;
    const objectIds = bylawIdentifiers(directObject);
    status = candidate;
    for (const id of objectIds) actedOn.add(id);
    clauses.push({ action: verb.toLowerCase(), direct_object: directObject.trim(), bylaws: [...objectIds].sort() });
  }
  if (!status || ![...identifiers].every((id) => actedOn.has(id))) return null;
  return { status, motion_id: motion.id ?? null, meeting_id: motion.meeting_id ?? null, rule: RULE_VERSION,
    validation_status: "persisted_motion_only", bylaws: [...identifiers].sort(), source_text: text, clauses };
}

/** Refresh the status of every topic with an item at this meeting from its complete history. */
export async function refreshMeetingLifecycles(supabase: SupabaseClient, meetingId: number) {
  const { data: items } = await supabase.from("agenda_items").select("id, matter_id").eq("meeting_id", meetingId);
  const ids = [...new Set(((items || []) as any[]).map((i) => i.matter_id as number).filter(Boolean))].sort((a, b) => a - b);
  for (const mid of ids) {
    const { data: matter } = await supabase.from("matters").select("id, title, identifier, status, meta").eq("id", mid).single();
    if (!matter) continue;
    const { data: allItems } = await supabase.from("agenda_items").select("id, matter_id, meeting_id").eq("matter_id", mid);
    const itemIds = ((allItems || []) as any[]).map((i) => i.id);
    if (!itemIds.length) continue;
    const meetingIds = [...new Set(((allItems || []) as any[]).map((i) => i.meeting_id))];
    const [{ data: motions }, { data: meetings }] = await Promise.all([
      supabase.from("motions").select("id, agenda_item_id, meeting_id, text_content, result, disposition").in("agenda_item_id", itemIds),
      supabase.from("meetings").select("id, meeting_date").in("id", meetingIds),
    ]);
    const dates = new Map(((meetings || []) as any[]).map((m) => [m.id, m.meeting_date]));
    let latest: any = null;
    for (const motion of (motions || []) as any[]) {
      const evidence: any = lifecycleEvidence(matter, motion);
      if (!evidence) continue;
      evidence.meeting_date = dates.get(motion.meeting_id) ?? null;
      const key = (e: any) => `${String(e.meeting_date || "")}\u0000${String(e.motion_id || 0).padStart(12, "0")}`;
      if (!latest || key(evidence) > key(latest)) latest = evidence;
    }
    if (latest && matter.status !== latest.status) {
      await supabase.from("matters").update({ status: latest.status, meta: { ...(matter.meta || {}), lifecycle_evidence: latest } }).eq("id", mid);
    }
  }
}
