import { publicData } from "./public-data-cache.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAttendanceInfo } from "../lib/attendance";
import { getSupabasePublicClient } from "../lib/supabase.server";
import { withDb, sqlPathAvailable, type SqlEnv } from "../db/index.server";
import { recentMotionsSql } from "./site-sql.server";

/** The Worker env and context, for the typed SQL path; absent in tests and scripts (supabase-js is used then). */
export type SqlContext = { env: SqlEnv; ctx?: { waitUntil(promise: Promise<unknown>): void } };


interface PublicNotice { title: string; link: string; date: string }
function assertQuerySucceeded(response: { error?: unknown }) {
  if (response.error) throw response.error;
}

/** The municipality's RSS notices: an external fetch (up to 3s), shared at the edge for half an hour. */
export async function getPublicNotices(rssUrl?: string): Promise<PublicNotice[]> {
  if (!rssUrl) return [];
  const result = await publicData(`notices:${rssUrl}`, () => fetchPublicNotices(rssUrl), (value) => value.ok, 1800, { shareWithSignedIn: true });
  return result.items;
}

async function fetchPublicNotices(rssUrl: string): Promise<{ items: PublicNotice[]; ok: boolean }> {
  try {
    const response = await fetch(rssUrl, { signal: AbortSignal.timeout(3000) });

    if (!response.ok) return { items: [], ok: false };
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

    return { items, ok: true };
  } catch (error) {
    console.error("Error fetching public notices:", error);
    return { items: [], ok: false };
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
        .is("merged_into", null)
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
  return publicData("about-stats:all-municipalities", () => getAboutStats(getSupabasePublicClient(), true), () => true, undefined, { shareWithSignedIn: true });
}

/**
 * The 15 most recent decided, non-procedural motions with their votes. Two steps: the ids first (ordering by the
 * meeting's date sorts every motion), then the full rows for just those 15, so votes are gathered for 15 motions
 * rather than for all of them before the sort.
 * NOTE: Do NOT use motions.yes_votes/no_votes (always 0) — use nested votes(vote).
 */
export async function recentMotions(supabase: SupabaseClient, municipalityId: number, sqlContext?: SqlContext) {
  // One SQL query only with a Hyperdrive binding (a warm pooled connection: a per-request connect costs more
  // than the PostgREST path); otherwise, or if it fails, PostgREST.
  if (sqlContext && sqlPathAvailable(sqlContext.env, { requireWarmPool: true })) {
    try {
      const data = await withDb(sqlContext.env, sqlContext.ctx, (db) => recentMotionsSql(db, municipalityId));
      return { data: data as any[], error: null };
    } catch (error) {
      console.error("recent motions over SQL failed; falling back to PostgREST:", error instanceof Error ? error.message : "failed");
    }
  }
  const latest = await supabase
    .from("motions")
    .select("id, meetings!inner(meeting_date)")
    .eq("meetings.municipality_id", municipalityId)
    .not("result", "is", null)
    .neq("disposition", "Procedural")
    // Order parent motions through the many-to-one meeting relationship.
    // referencedTable would only sort the embedded meeting rows.
    .order("meetings(meeting_date)", { ascending: false })
    .order("id", { ascending: false })
    .limit(15);
  if (latest.error) return { data: null, error: latest.error };
  const ids = (latest.data || []).map((m: any) => m.id as number);
  if (!ids.length) return { data: [] as any[], error: null };
  const full = await supabase
    .from("motions")
    .select(
      "id, plain_english_summary, text_content, result, disposition, financial_cost, meeting_id, vote_coverage:meta->>individual_vote_coverage, headline:meta->>headline, meetings!inner(slug, id, meeting_date, title), votes(vote)",
    )
    .in("id", ids);
  if (full.error) return { data: null, error: full.error };
  const order = new Map(ids.map((id, i) => [id, i]));
  return { data: (full.data || []).sort((a: any, b: any) => order.get(a.id)! - order.get(b.id)!), error: null };
}

async function loadHomeData(supabase: SupabaseClient, municipalityMeta?: any, municipalityId = 1, sqlContext?: SqlContext) {
  let complete = true;
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Vancouver",
  });

  // ── Batch 1: Independent queries in parallel ──

  let recentMeeting: any = null;
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
          "id, slug, title, type, meeting_date, summary, highlights:meta->highlights, video_duration_seconds, organizations(name)",
        )
        .eq("municipality_id", municipalityId)
        .eq("has_transcript", true)
        .not("summary", "is", null)
        .order("meeting_date", { ascending: false })
        .limit(1)
        .maybeSingle(),

      // 2. Next three upcoming meetings
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
        .limit(3),

      // 3. Active matters (6, ordered by last_seen)
      // NOTE: Do NOT select plain_english_summary from matters (always null)
      supabase
        .from("matters")
        .select("id, slug, title, category, status, first_seen, last_seen, meta, plain_english_summary")
        .eq("municipality_id", municipalityId)
        .eq("status", "Active")
        .is("merged_into", null)
        .is("meta->>hidden", null)
        .order("last_seen", { ascending: false, nullsFirst: false })
        .limit(6),

      // 4. Recent non-procedural motions with vote data (15)
      recentMotions(supabase, municipalityId, sqlContext),
    ]);

    for (const response of [recentMeetingRes, upcomingMeetingRes, activeMattersRes, recentMotionsRes]) {
      if (response.error) complete = false;
    }

    recentMeeting = recentMeetingRes.data;
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
      // Pledges from a speech at the meeting (agenda_items.meta.commitments), called out on the card.
      batch2Promises.push(
        (async () => {
          const res = await supabase
            .from("agenda_items")
            .select("id, title, commitments:meta->commitments")
            .eq("meeting_id", recentMeeting.id)
            .not("meta->commitments", "is", null)
            .limit(1);
          if (res.error) complete = false;
          return { type: "commitments" as const, data: res.data };
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

        case "commitments": {
          const item = (result.data || [])[0];
          const count = item?.commitments?.items?.length ?? 0;
          if (item && count > 0) {
            const key = (item.commitments.items as any[])
              .filter((c) => c.key)
              .map((c) => ({ text: c.short ?? c.text, start_time: c.start_time ?? null }));
            recentMeeting = { ...recentMeeting, commitments: { itemId: item.id, title: item.title, count, key } };
          }
          break;
        }
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
      headline: m.headline ?? null,
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
  sqlContext?: SqlContext,
) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Vancouver" });
  const key = `${municipalityId}:${today}:${JSON.stringify(municipalityMeta ?? null)}`;
  const result = await publicData(`home:${key}`, () => loadHomeData(getSupabasePublicClient(), municipalityMeta, municipalityId, sqlContext), (value) => value.complete,
    undefined, { shareWithSignedIn: true });
  return result.data;
}
