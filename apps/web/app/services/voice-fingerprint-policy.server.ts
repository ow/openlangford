import type { SupabaseClient } from "@supabase/supabase-js";

/** Organization classifications whose members are officials (people who speak for the City). */
const OFFICIAL_ORGANIZATIONS = ["Council", "Staff"];

/**
 * Voice fingerprints are biometric: keep them only for officials, never residents. A person
 * qualifies if they are a councillor, have a Council or Staff membership, or are on this meeting's
 * attendance list (the minutes' roster of officials; the pipeline's speaker-names stage uses the
 * same roster). Anyone else can still be named on the transcript, without a stored voice.
 * Fails closed: a failed lookup means no fingerprint.
 */
export async function mayStoreVoiceFingerprint(admin: SupabaseClient, personId: number | string, meetingId: number | string): Promise<boolean> {
  const [person, memberships, attendance] = await Promise.all([
    admin.from("people").select("id, is_councillor").eq("id", personId).maybeSingle(),
    admin
      .from("memberships")
      .select("id, organizations!inner(classification)")
      .eq("person_id", personId)
      .in("organizations.classification", OFFICIAL_ORGANIZATIONS)
      .limit(1),
    admin.from("attendance").select("id").eq("person_id", personId).eq("meeting_id", meetingId).limit(1),
  ]);
  if (person.error || memberships.error || attendance.error || !person.data) return false;
  return !!person.data.is_councillor || (memberships.data?.length ?? 0) > 0 || (attendance.data?.length ?? 0) > 0;
}
