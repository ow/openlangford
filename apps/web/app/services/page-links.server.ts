import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Staff fixes to a topic page's timeline from the page review bar: remove an entry that doesn't belong, ask the
 * pipeline to search again for what's missing (a find_matter_links job), and accept or reject what it suggests.
 * Every decision is kept on the link (review, reviewed_by, reviewed_at): the pipeline never re-adds, re-checks or
 * deletes a decided link, and shows its next judgments the latest decisions as examples.
 */

export type Suggestion = {
  table: "matter_links" | "matter_report_mentions";
  id: number;
  kind: "mention" | "related" | "report";
  date: string | null;
  title: string;
  quote: string | null;
  href: string | null;
  /** The reviewer model's reason, and where the topic's name was found. */
  reason: string | null;
  /** The Decisions API's probability that it belongs (items only), for sorting and later comparison. */
  score: number | null;
  foundIn: "item" | "document" | "spoken" | "report" | "topic" | "similar" | null;
  /** Staff said yes (👍): accepted but still hidden, to be added by the fix agent on the next Fix. */
  agreed: boolean;
  /** For a meeting item: its agenda item id (its entry will be "mention-<id>"). */
  itemId: number | null;
};
export type FindJob = { id: string; status: string; requested_at: string; finished_at: string | null; suggested: number | null };

/** The topic a /matters/<slug> path shows (its canonical matter), or null for any other page. */
export async function matterForPath(supabase: SupabaseClient, path: string): Promise<number | null> {
  const slug = path.match(/^\/matters\/([^/]+)$/)?.[1];
  if (!slug) return null;
  const { data } = await supabase.from("matters").select("id, meta").eq("slug", slug).maybeSingle();
  if (!data) return null;
  const canonical = Number((data.meta as Record<string, unknown> | null)?.canonical_matter_id);
  return Number.isSafeInteger(canonical) && canonical > 0 ? canonical : data.id;
}

const decided = (userId: string, review: "removed" | "accepted" | "rejected") => ({
  review, reviewed_by: userId, reviewed_at: new Date().toISOString(),
});

/** Which timeline entries can be removed here: links found for this topic. An item filed under the topic itself
 * is moved in the pipeline's matter tools, not here. */
export function removableKey(key: string | null | undefined) {
  return !!key && /^(mention|background|report)-\d+$/.test(key);
}

/** Remove one timeline entry from a topic page. Returns what was removed, in words, for the bar. */
export async function removeEntry(supabase: SupabaseClient, matterId: number, key: string, userId: string): Promise<string> {
  const [, kind, raw] = key.match(/^(mention|background|report)-(\d+)$/) || [];
  const id = Number(raw);
  if (!kind || !Number.isSafeInteger(id)) throw new Error("That entry can't be removed here.");

  if (kind === "mention") {
    const { data, error } = await supabase.from("matter_links").update({ hidden: true, ...decided(userId, "removed") })
      .eq("matter_id", matterId).eq("agenda_item_id", id).eq("kind", "mention").select("id");
    if (error || !data?.length) throw new Error("Could not remove that entry.");
    return "Removed the entry from this page.";
  }
  if (kind === "report") {
    const { data, error } = await supabase.from("matter_report_mentions").update({ hidden: true, ...decided(userId, "removed") })
      .eq("matter_id", matterId).eq("id", id).select("id");
    if (error || !data?.length) throw new Error("Could not remove that entry.");
    return "Removed the annual report page from this topic.";
  }
  // A background entry belongs to a related topic: removing it unlinks that topic (and all its entries) here.
  const owner = await relatedOwner(supabase, matterId, id);
  if (!owner) {
    // Its source can't be traced (it reached this page some other way): hide just this entry here.
    const { data: m } = await supabase.from("matters").select("meta").eq("id", matterId).single();
    const meta = (m?.meta || {}) as Record<string, any>;
    const { error } = await supabase.from("matters").update({ meta: { ...meta, hidden_duplicates: {
      ...(meta.hidden_duplicates || {}), [String(id)]: { reason: "removed from this page", by: userId, at: new Date().toISOString() } } } })
      .eq("id", matterId);
    if (error) throw new Error("Could not remove that entry.");
    return "Removed the entry from this page.";
  }
  const { error } = await supabase.from("matter_links").update({ hidden: true, ...decided(userId, "removed") })
    .eq("kind", "related_matter")
    .or(`and(matter_id.eq.${matterId},related_matter_id.eq.${owner}),and(matter_id.eq.${owner},related_matter_id.eq.${matterId})`);
  if (error) throw new Error("Could not unlink the related topic.");
  return "Unlinked the related topic, with all of its entries, from this page.";
}

async function relatedOwner(supabase: SupabaseClient, matterId: number, itemId: number): Promise<number | null> {
  const { data: links } = await supabase.from("matter_links").select("matter_id, related_matter_id")
    .eq("kind", "related_matter").eq("hidden", false).or(`matter_id.eq.${matterId},related_matter_id.eq.${matterId}`);
  const related = new Set((links || []).map((l) => (l.matter_id === matterId ? l.related_matter_id : l.matter_id)));
  const { data: item } = await supabase.from("agenda_items").select("matter_id").eq("id", itemId).maybeSingle();
  if (item?.matter_id && related.has(item.matter_id)) return item.matter_id;
  const { data: mentions } = await supabase.from("matter_links").select("matter_id")
    .eq("kind", "mention").eq("agenda_item_id", itemId).eq("hidden", false);
  return (mentions || []).map((m) => m.matter_id).find((id) => related.has(id)) ?? null;
}

/** Ask the pipeline to search again for this topic; suggestions arrive when the worker has run it. */
export async function requestFindMissing(supabase: SupabaseClient, matterId: number, userId: string) {
  const { data: municipality } = await supabase.from("municipalities").select("id").order("id").limit(1).maybeSingle();
  const { error } = await supabase.from("pipeline_jobs").insert({
    municipality_id: municipality?.id ?? 1, job_type: "find_matter_links", args: { matter_id: matterId },
    requested_by: userId, max_attempts: 1,
  });
  if (error) throw new Error("Could not start the search.");
}

export async function latestFindJob(supabase: SupabaseClient, matterId: number): Promise<FindJob | null> {
  const { data } = await supabase.from("pipeline_jobs").select("id, status, requested_at, finished_at, result")
    .eq("job_type", "find_matter_links").eq("args->>matter_id", String(matterId))
    .order("requested_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const suggested = Number((data.result as Record<string, unknown> | null)?.suggested);
  return { id: String(data.id), status: data.status, requested_at: data.requested_at, finished_at: data.finished_at,
    suggested: Number.isFinite(suggested) ? suggested : null };
}

/** Suggestions waiting for a decision on this topic. */
export async function listSuggestions(supabase: SupabaseClient, matterId: number): Promise<Suggestion[]> {
  const [mentions, related, pages] = await Promise.all([
    supabase.from("matter_links").select("id, agenda_item_id, review, quote, confidence, suggest_reason, found_in, agenda_items(title, meetings(slug, meeting_date))")
      .eq("matter_id", matterId).eq("kind", "mention").not("suggested_at", "is", null).eq("hidden", true).or("review.is.null,review.eq.accepted").limit(50),
    supabase.from("matter_links").select("id, matter_id, related_matter_id, suggest_reason, review")
      .eq("kind", "related_matter").not("suggested_at", "is", null).eq("hidden", true).or("review.is.null,review.eq.accepted")
      .or(`matter_id.eq.${matterId},related_matter_id.eq.${matterId}`).limit(20),
    supabase.from("matter_report_mentions").select("id, page, quote, suggest_reason, review, public_reports(year, title)")
      .eq("matter_id", matterId).not("suggested_at", "is", null).eq("hidden", true).or("review.is.null,review.eq.accepted").limit(20),
  ]);
  const otherIds = (related.data || []).map((l) => (l.matter_id === matterId ? l.related_matter_id : l.matter_id));
  const { data: others } = otherIds.length
    ? await supabase.from("matters").select("id, slug, title, meta, first_seen").in("id", otherIds)
    : { data: [] as any[] };
  const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;
  return [
    ...(mentions.data || []).map((l: any) => {
      const item = one(l.agenda_items) as any;
      const meeting = one(item?.meetings) as any;
      return { table: "matter_links" as const, id: l.id, kind: "mention" as const, date: meeting?.meeting_date ?? null,
        title: item?.title?.split("\n")[0] || "Agenda item", quote: l.quote, href: meeting?.slug ? `/meetings/${meeting.slug}` : null,
        reason: l.suggest_reason ?? null, score: l.confidence ?? null, foundIn: l.found_in ?? null,
        agreed: l.review === "accepted", itemId: l.agenda_item_id ?? null };
    }),
    ...(related.data || []).map((l: any) => {
      const other = (others || []).find((m: any) => m.id === (l.matter_id === matterId ? l.related_matter_id : l.matter_id));
      return { table: "matter_links" as const, id: l.id, kind: "related" as const, date: other?.first_seen ?? null,
        title: other?.meta?.display_title || other?.title || "A related topic", quote: null, href: other?.slug ? `/matters/${other.slug}` : null,
        reason: l.suggest_reason ?? null, score: null, foundIn: "topic" as const, agreed: l.review === "accepted", itemId: null };
    }),
    ...(pages.data || []).map((p: any) => {
      const report = one(p.public_reports) as any;
      return { table: "matter_report_mentions" as const, id: p.id, kind: "report" as const, date: report ? `${report.year}-12-31` : null,
        title: `${report?.year ?? ""} annual report, page ${p.page}`.trim(), quote: p.quote, href: null,
        reason: p.suggest_reason ?? null, score: null, foundIn: "report" as const, agreed: p.review === "accepted", itemId: null };
    }),
  ].sort((a, b) => (b.score ?? 0.5) - (a.score ?? 0.5) || String(b.date).localeCompare(String(a.date)));
}

/** Staff's 👍 on a suggestion (or taking it back): marked accepted but left hidden; the fix agent publishes it on the
 * next Fix, with the page's other fixes and one summary rewrite. */
export async function agreeSuggestion(supabase: SupabaseClient, matterId: number, table: Suggestion["table"], id: number,
  agree: boolean, userId: string) {
  let query = supabase.from(table).update(agree ? decided(userId, "accepted") : { review: null, reviewed_by: null, reviewed_at: null })
    .eq("id", id).eq("hidden", true).not("suggested_at", "is", null);
  query = table === "matter_report_mentions" ? query.eq("matter_id", matterId)
    : query.or(`matter_id.eq.${matterId},related_matter_id.eq.${matterId}`);
  const { data, error } = await query.select("id");
  if (error || !data?.length) throw new Error("Could not save that.");
}

/** Accept (publish) or reject (keep hidden for good) one suggestion on this topic. */
export async function decideSuggestion(supabase: SupabaseClient, matterId: number, table: Suggestion["table"], id: number,
  accept: boolean, userId: string) {
  let query = supabase.from(table).update({ hidden: !accept, ...decided(userId, accept ? "accepted" : "rejected") })
    .eq("id", id).not("suggested_at", "is", null);
  query = table === "matter_report_mentions" ? query.eq("matter_id", matterId)
    : query.or(`matter_id.eq.${matterId},related_matter_id.eq.${matterId}`);
  const { data, error } = await query.select("id");
  if (error || !data?.length) throw new Error("Could not save that decision.");
}

/** Hide a topic page from the public (or show it again): staff's call that the page shouldn't exist, like a lone
 * agenda line with nothing behind it. Lists, links and the sitemap skip it; the page is "not found" for the public. */
export async function setTopicHidden(supabase: SupabaseClient, matterId: number, hidden: boolean, userId: string) {
  const { data } = await supabase.from("matters").select("meta").eq("id", matterId).single();
  const meta = { ...((data?.meta || {}) as Record<string, unknown>) };
  if (hidden) Object.assign(meta, { hidden: "staff", hidden_by: userId, hidden_at: new Date().toISOString() });
  else if (meta.hidden === "staff") { delete meta.hidden; delete meta.hidden_by; delete meta.hidden_at; }
  const { error } = await supabase.from("matters").update({ meta }).eq("id", matterId);
  if (error) throw new Error("Could not change whether the page is hidden.");
}

export async function topicHidden(supabase: SupabaseClient, matterId: number) {
  const { data } = await supabase.from("matters").select("meta").eq("id", matterId).maybeSingle();
  return (data?.meta as Record<string, unknown> | null)?.hidden === "staff";
}
