import { getSupabaseAdminClient } from "../lib/supabase.server";
import { historicalPublicDate, HISTORICAL_PUBLIC_TTL, RECENT_PUBLIC_TTL } from "../lib/public-content-cache";
import { publicData } from "./public-data-cache.server";
import { getSpeakingTimeStats, getSpeakingTimeByMeeting, getSpeakingTimeByTopic } from "./profiling";

// Only public aggregates from a fixed server client enter shared storage. Never
// accept a request/session client here. The deployment/content namespace also
// supplies the existing explicit correction-refresh mechanism.
function summary<T>(kind: string, personId: number | null, startDate: string | undefined, endDate: string | undefined, municipalityId: number, compute: () => Promise<T>) {
  // The council-wide ranking is the heavy RPC and changes only when a meeting is ingested.
  const ttl = historicalPublicDate(endDate) ? HISTORICAL_PUBLIC_TTL : personId === null ? 3600 : RECENT_PUBLIC_TTL;
  return publicData(JSON.stringify(["speaking-v1", kind, municipalityId, personId, startDate ?? null, endDate ?? null]), compute, () => true,
    ttl, { shareWithSignedIn: true });
}

export function getPublicSpeakingTimeStats(startDate?: string, endDate?: string, municipalityId = 1) {
  return summary("ranking", null, startDate, endDate, municipalityId, async () =>
    (await getSpeakingTimeStats(getSupabaseAdminClient(), startDate, endDate, municipalityId)).map(
      ({ person_id, person_name, image_url, total_seconds, meeting_count, segment_count }) =>
        ({ person_id, person_name, image_url, total_seconds, meeting_count, segment_count })));
}

export function getPublicSpeakingTimeByMeeting(personId: number, startDate?: string, endDate?: string, municipalityId = 1) {
  return summary("meetings", personId, startDate, endDate, municipalityId, async () =>
    (await getSpeakingTimeByMeeting(getSupabaseAdminClient(), personId, startDate, endDate, municipalityId)).map(
      ({ meeting_id, meeting_date, seconds_spoken, segment_count }) =>
        ({ meeting_id, meeting_date, seconds_spoken, segment_count })));
}

export function getPublicSpeakingTimeByTopic(personId: number, startDate?: string, endDate?: string, municipalityId = 1) {
  return summary("topics", personId, startDate, endDate, municipalityId, async () =>
    (await getSpeakingTimeByTopic(getSupabaseAdminClient(), personId, startDate, endDate, municipalityId)).map(
      ({ topic, total_seconds, segment_count }) => ({ topic, total_seconds, segment_count })));
}
