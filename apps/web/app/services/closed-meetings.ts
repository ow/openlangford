import type { SupabaseClient } from "@supabase/supabase-js";
import type { CouncilTerm } from "../lib/types";
import { recentClosed, summariseTerms, summariseYears, type ClosedRow, type TermSummary, type YearSummary } from "../lib/closed-sessions";

export interface ClosedMeetingsData {
  terms: TermSummary[];
  years: YearSummary[];
  recent: ClosedRow[];
  /** Terms elected but not yet in office (no meetings to count). */
  upcoming: { name: string; start_date: string }[];
  through: string;
  complete: boolean;
}

/** Council meetings (Regular, Special, Committee of the Whole) with their closed-session data. */
async function councilMeetingRows(supabase: SupabaseClient, municipalityId: number, through: string): Promise<ClosedRow[]> {
  const rows: ClosedRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("meetings")
      .select("id, slug, title, meeting_date, status, closed:meta->closed_session, organization:organizations!inner(classification)")
      .eq("municipality_id", municipalityId)
      .eq("organization.classification", "Council")
      .lte("meeting_date", through)
      .order("meeting_date")
      .range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) {
      if (r.status === "Cancelled" || r.status === "Planned") continue;
      rows.push({ id: r.id, slug: r.slug, title: r.title, meeting_date: r.meeting_date, closed: (r.closed as any) ?? null });
    }
    if (!data || data.length < 1000) return rows;
  }
}

export async function getClosedMeetingsData(supabase: SupabaseClient, municipalityId: number, terms: CouncilTerm[], today: string): Promise<ClosedMeetingsData> {
  const rows = await councilMeetingRows(supabase, municipalityId, today);
  return {
    terms: summariseTerms(rows, terms, today).reverse(),
    years: summariseYears(rows),
    recent: recentClosed(rows, 12),
    upcoming: terms.filter((t) => t.start_date > today).map((t) => ({ name: t.name, start_date: t.start_date })),
    through: today,
    // Meetings not yet analysed have no closed_session key; don't cache a half-filled page for long.
    complete: rows.every((r) => r.closed != null || r.meeting_date >= today),
  };
}
