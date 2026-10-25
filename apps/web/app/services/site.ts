import { publicData } from "./public-data-cache.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAttendanceInfo } from "../lib/attendance";
import { getSupabasePublicClient } from "../lib/supabase.server";

interface PublicNotice { title: string; link: string; date: string }
const noticesCache = new Map<string, { items: PublicNotice[]; expires: number }>();
const PUBLIC_DATA_CACHE_TTL_MS = 60_000;
const publicAboutCache = new Map<string, { data: Awaited<ReturnType<typeof getAboutStats>>; expires: number }>();

function assertQuerySucceeded(response: { error?: unknown }) {
  if (response.error) throw response.error;
}

function cachePublicValue<T>(cache: Map<string, { data: T; expires: number }>, key: string, data: T): T {
  if (cache.size >= 100) {
    const now = Date.now();
    for (const [cachedKey, entry] of cache) {
      if (entry.expires <= now) cache.delete(cachedKey);
    }
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, { data, expires: Date.now() + PUBLIC_DATA_CACHE_TTL_MS });
  return data;
}

function getCachedPublicValue<T>(cache: Map<string, { data: T; expires: number }>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expires > Date.now()) return entry.data;
  cache.delete(key);
  return undefined;
}

export async function getPublicNotices(rssUrl?: string): Promise<PublicNotice[]> {
  if (!rssUrl) return [];
  const cached = noticesCache.get(rssUrl);
  if (cached && cached.expires > Date.now()) return cached.items;
  try {
    const response = await fetch(rssUrl, { signal: AbortSignal.timeout(3000) });

    if (!response.ok) return [];
    const text = await response.text();

    // Simple regex-based RSS parsing for the environment
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(text)) !== null && items.length < 5) {
      const itemContent = match[1];
      const title = itemContent.match(/<title>(.*?)<\/title>/)?.[1] || "";
      const link = itemContent.match(/<link>(.*?)<\/link>/)?.[1] || "";
      const pubDate = itemContent.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || "";

      items.push({
        title: title.replace(/<!\[CDATA\[(.*?)\]\]>/, "$1").trim(),
        link: link.trim(),
        date: pubDate.trim(),
      });
    }

    noticesCache.set(rssUrl, { items, expires: Date.now() + 5 * 60_000 });
    return items;
  } catch (error) {
    console.error("Error fetching public notices:", error);
    return [];
  }
}


export async function getAboutStats(supabase: SupabaseClient, requireComplete = false) {
  const [meetingsRes, motionsRes, mattersRes, segmentsRes, hoursRes] =
    await Promise.all([
      supabase
        .from("meetings")
        .select("*", { count: "exact", head: true }),
      supabase
        .from("motions")
        .select("*", { count: "exact", head: true }),
      supabase
        .from("matters")
        .select("*", { count: "exact", head: true })
        .is("meta->>canonical_matter_id", null)
        .is("meta->>hidden", null),
      supabase
        .from("transcript_segments")
        .select("*", { count: "exact", head: true }),
      // video_duration_seconds is backfilled from MAX(transcript_segments.end_time) per meeting.
      // The pipeline also sets this after transcript ingestion. If this returns 0,
      // run the backfill SQL in .planning/quick/3-fix-about-page-video-hours-showing-0/
      supabase
        .from("meetings")
        .select("video_duration_seconds")
        .not("video_duration_seconds", "is", null),
    ]);

  if (requireComplete) {
    for (const response of [meetingsRes, motionsRes, mattersRes, segmentsRes, hoursRes]) {
      assertQuerySucceeded(response);
    }
  }

  const totalSeconds = (hoursRes.data || []).reduce(
    (sum: number, m: { video_duration_seconds: number }) =>
      sum + (m.video_duration_seconds || 0),
    0,
  );

  return {
    meetings: meetingsRes.count || 0,
    motions: motionsRes.count || 0,
    matters: mattersRes.count || 0,
    segments: segmentsRes.count || 0,
    hours: Math.round(totalSeconds / 3600),
  };
}

/** Cache complete About stats briefly using the anonymous public client. */
export async function getPublicAboutStats() {
  const cached = getCachedPublicValue(publicAboutCache, "all-municipalities");
  if (cached) return cached;
  const data = await getAboutStats(getSupabasePublicClient(), true);
  return cachePublicValue(publicAboutCache, "all-municipalities", data);
}

async function loadHomeData(supabase: SupabaseClient, municipalityMeta?: any, municipalityId = 1) {
  let complete = true;
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Vancouver",
  });

  // ── Batch 1: Independent queries in parallel ──

  let recentMeeting: any = null;
  let earlierMeetings: any[] = [];
  let upcomingMeeting: any = null;
  let laterMeetings: any[] = [];
  let activeMattersRaw: any[] = [];
  let recentMotionsRaw: any[] = [];

  try {
    const [
      recentMeetingRes,
      upcomingMeetingRes,
      activeMattersRes,
      recentMotionsRes,
    ] = await Promise.all([
      // 1. Most recent fully processed meeting (transcript + summary), so the
      //    home card never shows a half-processed record
      supabase
        .from("meetings")
        .select(
          "id, slug, title, type, meeting_date, summary, video_duration_seconds, organizations(name)",
        )
        .eq("municipality_id", municipalityId)
        .eq("has_transcript", true)
        .not("summary", "is", null)
        .order("meeting_date", { ascending: false })
        .limit(3),

      // 2. Next few upcoming meetings; the first is featured
      supabase
        .from("meetings")
        .select(
          "id, slug, calendar_source_id, status, title, meeting_date, type, has_agenda, meta, organizations(name)",
        )
        .eq("municipality_id", municipalityId)
        .gte("meeting_date", today)
        .neq("status", "Cancelled")
        .order("meeting_date", { ascending: true })
        .order("id", { ascending: true })
        .limit(4),

      // 3. Active matters (6, ordered by last_seen)
      // NOTE: Do NOT select plain_english_summary from matters (always null)
      supabase
        .from("matters")
        .select("id, slug, title, category, status, first_seen, last_seen, meta, plain_english_summary")
        .eq("municipality_id", municipalityId)
        .eq("status", "Active")
        .is("meta->>canonical_matter_id", null)
        .is("meta->>hidden", null)
        .order("last_seen", { ascending: false, nullsFirst: false })
        .limit(6),

      // 4. Recent non-procedural motions with vote data (15)
      // NOTE: Do NOT use motions.yes_votes/no_votes (always 0) — use nested votes(vote)
      supabase
        .from("motions")
        .select(
          "id, plain_english_summary, text_content, result, disposition, financial_cost, meeting_id, vote_coverage:meta->>individual_vote_coverage, meetings!inner(slug, id, meeting_date, title), votes(vote)",
        )
        .eq("meetings.municipality_id", municipalityId)
        .not("result", "is", null)
        .neq("disposition", "Procedural")
        // Order parent motions through the many-to-one meeting relationship.
        // referencedTable would only sort the embedded meeting rows.
        .order("meetings(meeting_date)", { ascending: false })
        .order("id", { ascending: false })
        .limit(15),
    ]);

    for (const response of [recentMeetingRes, upcomingMeetingRes, activeMattersRes, recentMotionsRes]) {
      if (response.error) complete = false;
    }

    recentMeeting = recentMeetingRes.data?.[0] ?? null;
    earlierMeetings = (recentMeetingRes.data ?? []).slice(1);
    upcomingMeeting = upcomingMeetingRes.data?.[0] ?? null;
    laterMeetings = (upcomingMeetingRes.data ?? []).slice(1);
    activeMattersRaw = activeMattersRes.data || [];
    recentMotionsRaw = recentMotionsRes.data || [];
  } catch (error) {
    complete = false;
    console.error("Error in home data batch 1:", error);
  }

  // ── Batch 2: Dependent queries ──

  let agendaPreview: Array<{ title: string; category: string; summary: string | null }> = [];
  let matterSummaryMap = new Map<number, string>();
  let recentMeetingDecisions: Array<{
    id: number;
    summary: string;
    result: string;
  }> = [];
  let recentMeetingStats = {
    agendaItems: 0,
    totalMotions: 0,
    motionsPassed: 0,
    dividedVotes: 0,
    duration: null as number | null,
  };

  try {
    const batch2Promises: Promise<any>[] = [];

    // 5. Agenda preview for upcoming meeting (if it has an agenda)
    if (upcomingMeeting?.has_agenda) {
      batch2Promises.push(
        (async () => {
          const res = await supabase
            .from("agenda_items")
            .select("title, category, plain_english_summary")
            .eq("meeting_id", upcomingMeeting.id)
            .neq("category", "Procedural")
            .limit(5);
          if (res.error) complete = false;
          return { type: "agendaPreview" as const, data: res.data };
        })(),
      );
    }

    // 6. Matter summaries from agenda_items (for active matters)
    const matterIds = activeMattersRaw.map((m) => m.id);
    if (matterIds.length > 0) {
      batch2Promises.push(
        (async () => {
          const res = await supabase
            .from("agenda_items")
            .select("matter_id, plain_english_summary, created_at")
            .in("matter_id", matterIds)
            .not("plain_english_summary", "is", null)
            .order("created_at", { ascending: false });
          if (res.error) complete = false;
          return { type: "matterSummaries" as const, data: res.data };
        })(),
      );
    }

    // 7. Key decisions + stats for recent meeting
    if (recentMeeting?.id) {
      batch2Promises.push(
        (async () => {
          const res = await supabase
            .from("motions")
            .select(
              "id, text_content, plain_english_summary, result, disposition, agenda_items(category), votes(vote)",
            )
            .eq("meeting_id", recentMeeting.id)
            .not("result", "is", null);
          if (res.error) complete = false;
          return { type: "meetingMotions" as const, data: res.data };
        })(),
      );
      batch2Promises.push(
        (async () => {
          const res = await supabase
            .from("agenda_items")
            .select("*", { count: "exact", head: true })
            .eq("meeting_id", recentMeeting.id);
          if (res.error) complete = false;
          return { type: "agendaCount" as const, count: res.count };
        })(),
      );
    }

    const batch2Results = await Promise.all(batch2Promises);

    for (const result of batch2Results) {
      switch (result.type) {
        case "agendaPreview":
          agendaPreview = (result.data || []).map(
            (t: { title: string; category: string; plain_english_summary: string | null }) => ({
              title: t.title,
              category: t.category,
              summary: t.plain_english_summary,
            }),
          );
          break;

        case "matterSummaries":
          // Build map: for each matter_id, keep only the first (most recent) summary
          for (const s of result.data || []) {
            if (!matterSummaryMap.has(s.matter_id)) {
              matterSummaryMap.set(s.matter_id, s.plain_english_summary);
            }
          }
          break;

        case "meetingMotions": {
          const allMotions = result.data || [];
          const nonProcedural = allMotions.filter((m: any) => {
            if (m.disposition === "Procedural") return false;
            const category = (m.agenda_items as any)?.category;
            if (category === "Procedural") return false;
            return true;
          });

          recentMeetingDecisions = nonProcedural.slice(0, 3).map((m: any) => ({
            id: m.id,
            summary: m.plain_english_summary || m.text_content,
            result: m.result,
          }));

          // Count divided votes (motions where any vote is "No")
          const dividedCount = allMotions.filter((m: any) => {
            const votes = m.votes || [];
            return votes.some((v: { vote: string }) => v.vote === "No");
          }).length;

          recentMeetingStats = {
            agendaItems: 0, // filled below from agendaCount
            totalMotions: allMotions.length,
            motionsPassed: allMotions.filter(
              (m: any) => m.result === "CARRIED",
            ).length,
            dividedVotes: dividedCount,
            duration: recentMeeting?.video_duration_seconds
              ? Math.round(recentMeeting.video_duration_seconds / 60)
              : null,
          };
          break;
        }

        case "agendaCount":
          recentMeetingStats.agendaItems = result.count || 0;
          break;
      }
    }
  } catch (error) {
    complete = false;
    console.error("Error in home data batch 2:", error);
  }

  // ── Post-processing ──

  // Active matters: merge summaries from agenda_items
  const activeMatters = activeMattersRaw.map((m) => ({
    id: m.id,
    slug: m.slug,
    title: m.title,
    // Short pipeline title for display (matterTitle); full meta isn't needed here.
    meta: m.meta?.display_title ? { display_title: m.meta.display_title } : null,
    category: m.category,
    status: m.status,
    first_seen: m.first_seen,
    last_seen: m.last_seen,
    summary: m.plain_english_summary || matterSummaryMap.get(m.id) || null,
  }));

  // Decisions feed: process vote data from nested votes(vote)
  const recentDecisions = recentMotionsRaw.map((m: any) => {
    const votes = m.votes || [];
    const yesCount = votes.filter(
      (v: { vote: string }) => v.vote === "Yes",
    ).length;
    const noCount = votes.filter(
      (v: { vote: string }) => v.vote === "No",
    ).length;
    const isDivided = noCount > 0;
    return {
      id: m.id,
      summary: m.plain_english_summary || m.text_content,
      result: m.result,
      financialCost: m.financial_cost,
      meetingId: m.meeting_id,
      meetingSlug: (m.meetings as any)?.slug ?? null,
      meetingDate: (m.meetings as any)?.meeting_date,
      meetingTitle: (m.meetings as any)?.title,
      yesCount,
      noCount,
      voteCoverage: m.vote_coverage,
      isDivided,
    };
  });

  const attendanceInfo = upcomingMeeting && municipalityMeta
    ? getAttendanceInfo(municipalityMeta, upcomingMeeting.meta, upcomingMeeting.type)
    : null;

  const data = {
    upcomingMeeting: upcomingMeeting
      ? { ...upcomingMeeting, agendaPreview, attendanceInfo }
      : null,
    laterMeetings: laterMeetings.map(({ id, slug, title, meeting_date }) => ({ id, slug, title, meeting_date })),
    recentMeeting,
    earlierMeetings: earlierMeetings.map(({ id, slug, title, meeting_date, summary }) => ({ id, slug, title, meeting_date, summary })),
    recentMeetingStats,
    recentMeetingDecisions,
    activeMatters,
    recentDecisions,
  };
  return { data, complete };
}

export async function getHomeData(supabase: SupabaseClient, municipalityMeta?: any) {
  const { data } = await loadHomeData(supabase, municipalityMeta);
  return data;
}

/** Cache complete home summaries briefly using the anonymous public client. */
export async function getPublicHomeData(
  municipalityId: number,
  municipalityMeta: unknown,
) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Vancouver" });
  const key = `${municipalityId}:${today}:${JSON.stringify(municipalityMeta ?? null)}`;
  const result = await publicData(`home:${key}`, () => loadHomeData(getSupabasePublicClient(), municipalityMeta, municipalityId), (value) => value.complete);
  return result.data;
}
