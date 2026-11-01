import type { SupabaseClient } from "@supabase/supabase-js";
import { NOT_HELD_STATUSES, todayKey } from "../lib/pipeline-status";
import type { UnplacedDocument } from "../lib/written";
import { getAiUsageDashboard } from "./ai-usage-admin.server";
import { getMunicipality } from "./municipality";
import { getSiteTraffic } from "./site-traffic.server";

const DAY = 86_400_000;

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

export type ActionItem = {
  key: string;
  label: string;
  /** null when the count could not be read. */
  count: number | null;
  href: string;
  detail?: string;
  tone: "urgent" | "review";
};

async function getActions(supabase: SupabaseClient): Promise<ActionItem[]> {
  const head = { count: "exact" as const, head: true };
  const [contact, names, letters, merges, profiles, pageReviews] = await Promise.all([
    section(async () => {
      const { data, count, error } = await supabase
        .from("contact_messages")
        .select("created_at", { count: "exact" })
        .is("handled_at", null)
        .order("created_at", { ascending: true })
        .limit(1);
      if (error) throw error;
      return { count: count ?? 0, oldest: data?.[0]?.created_at as string | undefined };
    }),
    section(async () => {
      // One card per introduced name on /admin/names, so count distinct names.
      const { data, error } = await supabase
        .from("public_speaker_names")
        .select("name_key")
        .eq("status", "review")
        .is("decided_at", null);
      if (error) throw error;
      return new Set((data ?? []).map((row) => row.name_key)).size;
    }),
    section(async () => {
      const { data, error } = await supabase
        .from("meetings")
        .select("id, unplaced:meta->written_unplaced")
        .not("meta->written_unplaced", "is", null);
      if (error) throw error;
      const letters = (data ?? []).reduce(
        (n, m: any) =>
          n + Object.values((m.unplaced || {}) as Record<string, UnplacedDocument>).reduce((k, doc) => k + (doc.letters?.length || 0), 0),
        0,
      );
      return { letters, meetings: (data ?? []).length };
    }),
    section(() => count(supabase.from("matter_merge_proposals").select("id", head).eq("status", "pending"))),
    section(async () => {
      const { data, error } = await supabase.from("councillor_highlights").select("draft_generated_at").not("draft_generated_at", "is", null);
      if (error) throw error;
      return (data ?? []).length;
    }),
    section(() => count(supabase.from("page_reviews").select("path", head).eq("status", "needs_work"))),
  ]);

  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  return [
    {
      key: "contact",
      label: "Contact messages to answer",
      count: contact?.count ?? null,
      href: "/admin/contact",
      detail: contact?.oldest ? `oldest from ${contact.oldest}` : undefined,
      tone: "urgent",
    },
    { key: "names", label: "Speaker names to confirm", count: names, href: "/admin/names", tone: "review" },
    {
      key: "letters",
      label: "Letters to place",
      count: letters?.letters ?? null,
      href: "/admin/letters",
      detail: letters?.meetings ? `across ${plural(letters.meetings, "meeting")}` : undefined,
      tone: "review",
    },
    { key: "merges", label: "Possible duplicate issues", count: merges, href: "/admin/matters", tone: "review" },
    { key: "profiles", label: "Councillor profile drafts", count: profiles, href: "/admin/profiles", tone: "review" },
    { key: "pages", label: "Pages marked as needing work", count: pageReviews, href: "/admin/reviews?show=needs_work", tone: "review" },
  ];
}

async function getAudience(supabase: SupabaseClient, now: Date) {
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  const users = data.users;
  const since = (days: number) => now.getTime() - days * DAY;
  const after = (value: string | null | undefined, days: number) => Boolean(value) && new Date(value!).getTime() >= since(days);

  const [subs, recentSubs] = await Promise.all([
    supabase.from("subscriptions").select("user_id, type").eq("is_active", true).limit(10000),
    count(
      supabase
        .from("subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("is_active", true)
        .gte("created_at", new Date(since(7)).toISOString()),
    ),
  ]);
  if (subs.error) throw subs.error;
  const byType = new Map<string, number>();
  for (const s of subs.data ?? []) byType.set(s.type, (byType.get(s.type) ?? 0) + 1);

  return {
    total: data.total ?? users.length,
    new7: users.filter((u) => after(u.created_at, 7)).length,
    new30: users.filter((u) => after(u.created_at, 30)).length,
    active7: users.filter((u) => after(u.last_sign_in_at, 7)).length,
    active30: users.filter((u) => after(u.last_sign_in_at, 30)).length,
    unconfirmed: users.filter((u) => !u.email_confirmed_at).length,
    subscribers: new Set((subs.data ?? []).map((s) => s.user_id)).size,
    subscriptions: (subs.data ?? []).length,
    subscriptions7: recentSubs,
    subscriptionTypes: [...byType.entries()].sort((a, b) => b[1] - a[1]),
    recent: [...users]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 5)
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
  const rows = data ?? [];
  const of = (...statuses: string[]) => rows.filter((r) => statuses.includes(r.status)).length;
  const { data: last } = await supabase
    .from("email_messages")
    .select("created_at")
    .eq("is_test", false)
    .order("created_at", { ascending: false })
    .limit(1);
  return {
    total: rows.length,
    delivered: of("delivered", "accepted"),
    pending: of("queued", "attempting"),
    problems: of("failed", "bounced", "complained", "suppressed"),
    lastSentAt: (last?.[0]?.created_at as string | undefined) ?? null,
  };
}

async function getContent(supabase: SupabaseClient, municipalityId: number | null) {
  const today = todayKey();
  const sources = () => {
    const q = supabase.from("source_meetings").select("id, title, meeting_date, status");
    return municipalityId == null ? q : q.eq("municipality_id", municipalityId);
  };
  const [latest, upcoming] = await Promise.all([
    supabase.from("meetings").select("id, slug, title, meeting_date, summary").lte("meeting_date", today).order("meeting_date", { ascending: false }).limit(1),
    sources()
      .gte("meeting_date", today)
      .not("status", "in", `(${NOT_HELD_STATUSES.join(",")})`)
      .order("meeting_date")
      .limit(12),
  ]);
  if (latest.error) throw latest.error;
  if (upcoming.error) throw upcoming.error;

  // The source sometimes lists the same meeting twice.
  const seen = new Set<string>();
  const next = (upcoming.data ?? [])
    .filter((m) => {
      const key = `${m.meeting_date?.slice(0, 10)}|${m.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);

  const meeting = latest.data?.[0] ?? null;
  return {
    latestMeeting: meeting
      ? { id: meeting.id, slug: meeting.slug, title: meeting.title, date: meeting.meeting_date, hasSummary: Boolean(meeting.summary) }
      : null,
    upcoming: next.map((m) => ({ id: m.id, title: m.title, date: m.meeting_date })),
  };
}

async function getAsk(supabase: SupabaseClient, now: Date) {
  // One "answer" call per question residents ask; the rest of the web calls serve it.
  const since = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  const asked = (days: number) =>
    count(
      supabase
        .from("ai_usage")
        .select("id", { count: "exact", head: true })
        .eq("source", "web")
        .eq("stage", "answer")
        .gte("created_at", since(days)),
    );
  const [asked7, asked30] = await Promise.all([asked(7), asked(30)]);
  return { asked7, asked30 };
}

export async function getAdminOverview(
  supabase: SupabaseClient,
  env: Record<string, unknown>,
  now = new Date(),
) {
  const municipalityId = await section(async () => (await getMunicipality(supabase)).id as number);
  const [actions, audience, email, content, ask, ai, traffic] = await Promise.all([
    getActions(supabase),
    section(() => getAudience(supabase, now)),
    section(() => getEmail(supabase, now)),
    section(() => getContent(supabase, municipalityId)),
    section(() => getAsk(supabase, now)),
    getAiUsageDashboard(supabase, { windows: [7, 30], now }),
    getSiteTraffic(env),
  ]);
  return {
    generatedAt: now.toISOString(),
    actions,
    audience,
    email,
    content,
    ask,
    // Only what residents' questions and searches cost; pipeline spend lives on /admin/pipeline.
    ai: ai.available
      ? {
          windows: ai.windows.map((w) => ({
            days: w.days,
            costUsd: w.stages.filter((st) => st.source === "web").reduce((sum, st) => sum + (st.costUsd ?? 0), 0),
          })),
          recentFailures: ai.failures.filter((f) => f.source === "web" && new Date(f.created_at).getTime() >= now.getTime() - 7 * DAY).length,
        }
      : null,
    traffic,
  };
}

export type AdminOverview = Awaited<ReturnType<typeof getAdminOverview>>;
