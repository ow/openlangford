import type { SupabaseClient } from "@supabase/supabase-js";
import type { TimelineEntry } from "../components/property/property-timeline";
import { closedReasons, type ClosedSessionMeta } from "../lib/closed-sessions";
import { displayTitle, matterTitle } from "../lib/display-text";
import { sourceLabel, tidyQuote } from "../lib/sources";
import { meetingPath } from "../lib/paths";
import { getMatterReportMentions } from "./matters";
import { sourcesFor, sourcesForMatters } from "./sources.server";

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

export async function propertyTimeline(supabase: SupabaseClient, propertyId: number, matters: any[], items: any[]): Promise<TimelineEntry[]> {
  const matterIds = matters.map((m) => m.id as number);
  const byMatter = new Map<number, any>(matters.map((m) => [m.id, m]));
  const [steps, ownSources, topicSources, reports] = await Promise.all([
    matterIds.length
      ? supabase.from("agenda_items")
          .select("id, title, matter_id, meeting_id, plain_english_summary, motions(result), meetings!inner(id, slug, title, meeting_date, type, closed_session:meta->closed_session)")
          .in("matter_id", matterIds).order("id").limit(400)
      : Promise.resolve({ data: [] as any[] }),
    sourcesFor(supabase, { propertyId }),
    sourcesForMatters(supabase, matterIds),
    matterIds.length ? getMatterReportMentions(supabase, matterIds) : Promise.resolve([]),
  ]);
  const entries: TimelineEntry[] = [];
  const meetingsSeen = new Map<number, Meeting>();
  const one = <T,>(v: T | T[] | null | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

  for (const it of ((steps as any).data || []) as any[]) {
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
      headline: headline || displayTitle(it.title), detail: headline ? null : it.plain_english_summary || null,
      href: `${meetingPath(meeting)}#item-${it.id}`, topic: { slug: m.slug, title: matterTitle(m) }, outcome,
    });
  }
  for (const it of items as any[]) {
    const meeting = it.meetings as Meeting | null;
    if (!meeting?.meeting_date) continue;
    entries.push({
      key: `item-${it.id}`, date: meeting.meeting_date, kind: "mention", label: "Came up at the meeting",
      headline: displayTitle(it.title), detail: it.plain_english_summary || null, href: `${meetingPath(meeting)}#item-${it.id}`, reviewKey: `item-${it.id}`,
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
