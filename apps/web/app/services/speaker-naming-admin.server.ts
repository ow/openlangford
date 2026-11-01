import type { SupabaseClient } from "@supabase/supabase-js";

export type SpeakerNamingMeeting = { id: number; slug: string | null; title: string; meeting_date: string; share: number };
export type SpeakerNamingDashboard = {
  meetings: number;
  average: number | null;
  recentAverage: number | null;
  lowest: SpeakerNamingMeeting[];
  awaitingReview: number;
};

const RECENT = 20;

/**
 * How much of each meeting's speech has a name, from the speaker-names stage
 * (meetings.meta.speaker_identity.named_share), plus names waiting in /admin/names.
 */
export async function getSpeakerNamingDashboard(supabase: SupabaseClient): Promise<SpeakerNamingDashboard> {
  const [{ data, error }, review] = await Promise.all([
    supabase.from("meetings")
      .select("id, slug, title, meeting_date, share:meta->speaker_identity->named_share")
      .eq("has_transcript", true).not("meta->speaker_identity->named_share", "is", null)
      .order("meeting_date", { ascending: false }),
    supabase.from("public_speaker_names").select("id", { count: "exact", head: true }).eq("status", "review"),
  ]);
  if (error) console.error("Error loading speaker naming coverage:", error);
  const rows = ((data || []) as any[])
    .map((m) => ({ ...m, share: Number(m.share) }))
    .filter((m) => Number.isFinite(m.share)) as SpeakerNamingMeeting[];
  const mean = (list: SpeakerNamingMeeting[]) => (list.length ? list.reduce((n, m) => n + m.share, 0) / list.length : null);
  return {
    meetings: rows.length,
    average: mean(rows),
    recentAverage: mean(rows.slice(0, RECENT)),
    lowest: [...rows.slice(0, 60)].sort((a, b) => a.share - b.share).slice(0, 8),
    awaitingReview: review.count ?? 0,
  };
}
