import type { SupabaseClient } from "@supabase/supabase-js";
import type { TimelineEntry } from "../components/property/property-timeline";
import { closedReasons, type ClosedSessionMeta } from "../lib/closed-sessions";
import { displayTitle, matterTitle } from "../lib/display-text";
import { sourceLabel, tidyQuote } from "../lib/sources";
import { meetingPath } from "../lib/paths";
import { getMatterReportMentions } from "./matters";
import { sourcesFor, sourcesForMatters } from "./sources.server";
import { addressPatterns, spokenAtItem } from "./property-search.server";

/**
 * The chronology of one lot (components/property/property-timeline.tsx): the steps of every topic at the address,
 * the other entries that named it, the City's annual report pages about those topics, sources from outside the
 * record linked to the address or its topics, and the closed meetings Council held about land on nights the
 * address was before it. Built from what getPropertyBySlug already loaded plus three short queries.
 */

type Meeting = { id: number; slug: string | null; title: string | null; meeting_date: string; type?: string | null; closed_session?: ClosedSessionMeta | null };

const LAND = /\bland\b/i;

function outcomeOf(motions: { result?: string | null }[] | null | undefined): TimelineEntry["outcome"] {
  const results = (motions || []).map((m) => m.result || "");
  if (!results.length) return null;
  if (results.some((r) => /defeated|failed|lost/i.test(r))) return { label: "Defeated", variant: "danger" };
  if (results.some((r) => /defer|tabled|postpone|refer/i.test(r))) return { label: "Postponed", variant: "warning" };
  if (results.some((r) => /carried|passed|approved|adopted/i.test(r))) return { label: "Passed", variant: "success" };
  return null;
}

/** Words that make a line worth quoting beyond naming the address: money, a purchase or sale, a recommendation. */
const TELLING = /\b(sale|sell|sold|dispos\w*|purchas\w*|acquir\w*|bought|owed|debt|borrow\w*|recommend\w*|should|open\w*|close\w*)\b|\$|\d{1,3}(?:,\d{3})+/gi;

/** The words around the address in a record, on one line, scored by what they tell. Exported for tests. */
export function addressExcerpt(text: string, civic: string, before = 40, after = 300): { text: string; score: number } {
  const flat = text.replace(/[#|*]/g, " ").replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(`${civic} `.toLowerCase());
  const start = Math.max(0, (at < 0 ? 0 : at) - before);
  const end = Math.min(flat.length, (at < 0 ? 0 : at) + after);
  const window = flat.slice(start, end).trim();
  return { text: (start > 0 ? "…" : "") + window + (end < flat.length ? "…" : ""), score: (window.match(TELLING) || []).length };
}

/** Item id -> the line of its record that names this address (a report or budget table, a decision, a spoken line
 * while the item was on screen): what the row quotes, since an item's own summary rarely mentions one lot. */
async function addressLines(supabase: SupabaseClient, property: { civic_number: string; street: string }, items: { id: number; meeting_id: number | null; discussion_start_time?: number | null; discussion_end_time?: number | null }[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const patterns = addressPatterns(property.civic_number, property.street);
  const ids = items.map((i) => i.id);
  if (!patterns.length || !ids.length) return out;
  const or = (col: string) => patterns.map((p) => `${col}.ilike."${p.replace(/[,"]/g, "")}"`).join(",");
  const timed = items.filter((i) => i.meeting_id && i.discussion_start_time != null && i.discussion_end_time != null) as any[];
  const meetingIds = [...new Set(timed.map((i) => i.meeting_id as number))];
  const [sections, motions, spoken] = await Promise.all([
    supabase.from("document_sections").select("agenda_item_id, section_text").in("agenda_item_id", ids).or(or("section_text")).limit(80),
    supabase.from("motions").select("agenda_item_id, text_content").in("agenda_item_id", ids).or(or("text_content")).limit(30),
    meetingIds.length ? supabase.from("transcript_segments").select("meeting_id, start_time, text_content").in("meeting_id", meetingIds).or(or("text_content")).limit(40) : Promise.resolve({ data: [] as any[] }),
  ]);
  const found = new Map<number, { text: string; score: number }[]>();
  const add = (id: number | null, text: string) => { if (id) (found.get(id) || found.set(id, []).get(id)!).push(addressExcerpt(text, property.civic_number)); };
  for (const r of (sections.data || []) as any[]) add(r.agenda_item_id, r.section_text || "");
  for (const r of (motions.data || []) as any[]) add(r.agenda_item_id, r.text_content || "");
  for (const r of (spoken.data || []) as any[]) {
    const item = spokenAtItem(r, timed);
    if (item) add(item.id, r.text_content || "");
  }
  for (const [id, list] of found) out.set(id, list.sort((a, b) => b.score - a.score)[0].text);
  return out;
}

export async function propertyTimeline(supabase: SupabaseClient, property: { id: number; civic_number: string; street: string }, matters: any[], items: any[]): Promise<TimelineEntry[]> {
  const propertyId = property.id;
  const matterIds = matters.map((m) => m.id as number);
  const byMatter = new Map<number, any>(matters.map((m) => [m.id, m]));
  const [steps, ownSources, topicSources, reports] = await Promise.all([
    matterIds.length
      ? supabase.from("agenda_items")
          .select("id, title, matter_id, meeting_id, plain_english_summary, discussion_start_time, discussion_end_time, motions(result), meetings!inner(id, slug, title, meeting_date, type, closed_session:meta->closed_session)")
          .in("matter_id", matterIds).order("id").limit(400)
      : Promise.resolve({ data: [] as any[] }),
    sourcesFor(supabase, { propertyId }),
    sourcesForMatters(supabase, matterIds),
    matterIds.length ? getMatterReportMentions(supabase, matterIds) : Promise.resolve([]),
  ]);
  const stepRows = ((steps as any).data || []) as any[];
  const lines = await addressLines(supabase, property, [...stepRows, ...items].map((i: any) => ({
    id: i.id, meeting_id: i.meeting_id ?? null, discussion_start_time: i.discussion_start_time ?? null, discussion_end_time: i.discussion_end_time ?? null,
  })));
  const entries: TimelineEntry[] = [];
  const meetingsSeen = new Map<number, Meeting>();
  const one = <T,>(v: T | T[] | null | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

  for (const it of stepRows) {
    const m = byMatter.get(it.matter_id);
    const meeting = one(it.meetings) as Meeting | null;
    if (!m || !meeting?.meeting_date) continue;
    // Entries staff hid as repeats stay off the topic's timeline, so off this one too.
    if ((m.meta?.hidden_duplicates || {})[String(it.id)]) continue;
    meetingsSeen.set(meeting.id, meeting);
    const headline: string | undefined = m.meta?.timeline_headlines?.[String(it.id)];
    const outcome = outcomeOf(it.motions);
    entries.push({
      key: `step-${it.id}`, date: meeting.meeting_date, kind: "step",
      label: outcome ? "Council decision" : /committee|commission|board/i.test(meeting.type || "") ? "Committee" : "Before Council",
      headline: headline || displayTitle(it.title), detail: lines.get(it.id) || (headline ? null : it.plain_english_summary || null), quoted: lines.has(it.id),
      href: `${meetingPath(meeting)}#item-${it.id}`, topic: { slug: m.slug, title: matterTitle(m) }, outcome,
    });
  }
  for (const it of items as any[]) {
    const meeting = it.meetings as Meeting | null;
    if (!meeting?.meeting_date) continue;
    entries.push({
      key: `item-${it.id}`, date: meeting.meeting_date, kind: "mention", label: "Came up at the meeting",
      headline: displayTitle(it.title), detail: lines.get(it.id) || it.plain_english_summary || null, quoted: lines.has(it.id),
      href: `${meetingPath(meeting)}#item-${it.id}`, reviewKey: `item-${it.id}`,
    });
  }
  for (const r of reports) {
    entries.push({ key: `report-${r.id}`, date: `${r.year}-12-31`, kind: "report", label: `City annual report ${r.year}`, headline: tidyQuote(r.quote, 160), detail: null, href: r.url, external: true });
  }
  const seen = new Set<number>();
  for (const s of [...ownSources, ...[...topicSources.values()].flat()]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    entries.push({ key: `source-${s.id}`, date: s.happened_on, kind: "source", label: sourceLabel(s), headline: s.headline, detail: s.quote ? tidyQuote(s.quote) : null, href: s.url, external: !!s.url });
  }
  // A closed meeting about land on a night this address was before Council: the record shows a door closing.
  for (const meeting of meetingsSeen.values()) {
    const reasons = closedReasons(meeting.closed_session);
    if (!reasons.some((r) => LAND.test(r))) continue;
    entries.push({
      key: `closed-${meeting.id}`, date: meeting.meeting_date, kind: "closed", label: "Closed meeting",
      headline: "Council also met behind closed doors about land that night",
      detail: "The minutes record a closed session about " + reasons.join(", ") + ". What was discussed is not public, so the record cannot say whether it was this address.",
      href: meetingPath(meeting),
    });
  }
  return entries;
}
