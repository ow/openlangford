import type { SupabaseClient } from "@supabase/supabase-js";
import { NOT_HELD_STATUSES, todayKey } from "../lib/pipeline-status";
import type { UnplacedDocument } from "../lib/written";
import { getAiUsageDashboard } from "./ai-usage-admin.server";
import { getMunicipality } from "./municipality";
import { getFailureResolutions } from "./pipeline-admin.server";
import { reviewBurndown } from "./page-reviews.server";
import { getSiteTraffic, type DailyPoint } from "./site-traffic.server";

const DAY = 86_400_000;
/** Charts cover this many days; week-on-week comparisons need the 14 before "now". */
export const OVERVIEW_DAYS = 30;

/** One section's failure must not take down the whole overview. */
async function section<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.error("Admin overview section failed:", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

async function count(query: any) {
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

async function rows<T = any>(query: any): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as T[];
}

/** Daily counts in Langford's time zone, oldest first, with empty days filled in. */
function daily(timestamps: (string | null | undefined)[], now: Date, days = OVERVIEW_DAYS): DailyPoint[] {
  const counts = new Map<string, number>();
  for (const at of timestamps) {
    if (!at) continue;
    const key = todayKey(new Date(at));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from({ length: days }, (_, i) => {
    const day = todayKey(new Date(now.getTime() - (days - 1 - i) * DAY));
    return { day, value: counts.get(day) ?? 0 };
  });
}

/** What waits in each admin tool, keyed by tool. null means the count couldn't be read. */
async function getQueues(supabase: SupabaseClient, municipalityId: number | null) {
  const head = { count: "exact" as const, head: true };
  const [contact, names, letters, merges, profiles, pages, failedJobs] = await Promise.all([
    section(async () => {
      const { data, count, error } = await supabase
        .from("contact_messages")
        .select("created_at", { count: "exact" })
        .is("handled_at", null)
        .order("created_at", { ascending: true })
        .limit(1);
      if (error) throw error;
      return { count: count ?? 0, oldest: (data?.[0]?.created_at as string | undefined) ?? null };
    }),
    // One card per introduced name on /admin/names, so count distinct names.
    section(async () => {
      const data = await rows<{ name_key: string }>(
        supabase.from("public_speaker_names").select("name_key").eq("status", "review").is("decided_at", null),
      );
      return new Set(data.map((row) => row.name_key)).size;
    }),
    section(async () => {
      const data = await rows(supabase.from("meetings").select("id, unplaced:meta->written_unplaced").not("meta->written_unplaced", "is", null));
      const letters = data.reduce(
        (n, m: any) =>
          n + Object.values((m.unplaced || {}) as Record<string, UnplacedDocument>).reduce((k, doc) => k + (doc.letters?.length || 0), 0),
        0,
      );
      return { letters, meetings: data.length };
    }),
    section(() => count(supabase.from("matter_merge_proposals").select("id", head).eq("status", "pending"))),
    section(() => count(supabase.from("councillor_highlights").select("person_id", head).not("draft_generated_at", "is", null))),
    section(() => count(supabase.from("page_reviews").select("path", head).eq("status", "needs_work"))),
    section(async () => {
      if (municipalityId == null) return null;
      const resolutions = await getFailureResolutions(supabase, municipalityId);
      return [...resolutions.values()].filter((r) => !r.resolved).length;
    }),
  ]);
  return { contact, names, letters, merges, profiles, pages, failedJobs };
}

async function getAudience(supabase: SupabaseClient, now: Date) {
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  const users = data.users;
  const within = (value: string | null | undefined, days: number) =>
    Boolean(value) && new Date(value!).getTime() >= now.getTime() - days * DAY;
  const since = new Date(now.getTime() - OVERVIEW_DAYS * DAY).toISOString();

  const [active, added] = await Promise.all([
    rows<{ user_id: string; type: string }>(supabase.from("subscriptions").select("user_id, type").eq("is_active", true).limit(10000)),
    rows<{ created_at: string }>(supabase.from("subscriptions").select("created_at").gte("created_at", since).limit(10000)),
  ]);
  const byType = new Map<string, number>();
  for (const s of active) byType.set(s.type, (byType.get(s.type) ?? 0) + 1);

  return {
    total: data.total ?? users.length,
    signedIn7: users.filter((u) => within(u.last_sign_in_at, 7)).length,
    unconfirmed: users.filter((u) => !u.email_confirmed_at).length,
    signups: daily(users.map((u) => u.created_at), now),
    followers: new Set(active.map((s) => s.user_id)).size,
    alerts: active.length,
    alertsAdded: daily(added.map((s) => s.created_at), now),
    alertTypes: [...byType.entries()].sort((a, b) => b[1] - a[1]),
    recent: [...users]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 6)
      .map((u) => ({ id: u.id, email: u.email ?? null, createdAt: u.created_at, confirmed: Boolean(u.email_confirmed_at) })),
  };
}

async function getEmail(supabase: SupabaseClient, now: Date) {
  const { data, error } = await supabase
    .from("email_messages")
    .select("status, created_at")
    .eq("is_test", false)
    .gte("created_at", new Date(now.getTime() - 7 * DAY).toISOString())
    .limit(10000);
  if (error) {
    if (error.code === "PGRST205" || error.code === "42P01") return null;
    throw error;
  }
  const week = data ?? [];
  return {
    sent7: week.length,
    problems7: week.filter((r) => ["failed", "bounced", "complained", "suppressed"].includes(r.status)).length,
  };
}

async function getAsk(supabase: SupabaseClient, now: Date) {
  // One "answer" call per question a resident asks; the other web calls serve it.
  const data = await rows<{ created_at: string }>(
    supabase
      .from("ai_usage")
      .select("created_at")
      .eq("source", "web")
      .eq("stage", "answer")
      .gte("created_at", new Date(now.getTime() - OVERVIEW_DAYS * DAY).toISOString())
      .limit(10000),
  );
  return daily(data.map((r) => r.created_at), now);
}

async function getCalendar(supabase: SupabaseClient, municipalityId: number | null) {
  const today = todayKey();
  let upcoming = supabase
    .from("source_meetings")
    .select("id, title, meeting_date")
    .gte("meeting_date", today)
    .not("status", "in", `(${NOT_HELD_STATUSES.join(",")})`)
    .order("meeting_date")
    .limit(12);
  if (municipalityId != null) upcoming = upcoming.eq("municipality_id", municipalityId);
  const [latest, next] = await Promise.all([
    rows(supabase.from("meetings").select("id, slug, title, meeting_date, summary").lte("meeting_date", today).order("meeting_date", { ascending: false }).limit(1)),
    rows(upcoming),
  ]);
  // The source sometimes lists the same meeting twice.
  const seen = new Set<string>();
  const meeting = latest[0] ?? null;
  return {
    latest: meeting ? { id: meeting.id, slug: meeting.slug, title: meeting.title, date: meeting.meeting_date, hasSummary: Boolean(meeting.summary) } : null,
    upcoming: next
      .filter((m) => {
        const key = `${m.meeting_date?.slice(0, 10)}|${m.title}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 5)
      .map((m) => ({ id: m.id, title: m.title, date: m.meeting_date })),
  };
}

export async function getAdminOverview(supabase: SupabaseClient, env: Record<string, unknown>, now = new Date(),
  waitUntil?: (p: Promise<unknown>) => void) {
  const municipalityId = await section(async () => (await getMunicipality(supabase)).id as number);
  const [queues, audience, email, questions, ai, calendar, traffic, reviews] = await Promise.all([
    getQueues(supabase, municipalityId),
    section(() => getAudience(supabase, now)),
    section(() => getEmail(supabase, now)),
    section(() => getAsk(supabase, now)),
    getAiUsageDashboard(supabase, { windows: [7], now }),
    section(() => getCalendar(supabase, municipalityId)),
    getSiteTraffic(env, waitUntil),
    section(() => reviewBurndown(supabase, now)),
  ]);
  return {
    generatedAt: now.toISOString(),
    queues,
    audience,
    email,
    questions,
    // What residents' questions and searches cost; pipeline spend is on /admin/pipeline.
    askCost7: ai.available
      ? ai.windows[0].stages.filter((s) => s.source === "web").reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
      : null,
    calendar,
    traffic,
    reviews,
  };
}

export type AdminOverview = Awaited<ReturnType<typeof getAdminOverview>>;
