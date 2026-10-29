import type { SupabaseClient } from "@supabase/supabase-js";
import { civicToday } from "../lib/council-terms";
import { statementsFromItems, type ParticipantStatement, type StatementItemRow } from "../lib/participant-statements";

/**
 * Agenda items where the pipeline linked a public speaker to this person
 * (`meta.participation.speakers[].person_id`), filtered in the database with
 * JSONB containment (`meta @> {"participation":{"speakers":[{"person_id":N}]}}`).
 */
export async function getParticipantStatements(supabase: SupabaseClient, municipalityId: number, personId: number): Promise<ParticipantStatement[]> {
  const today = civicToday();
  const { data, error } = await supabase
    .from("agenda_items")
    .select("id, title, speakers:meta->participation->speakers, source:meta->participation->source, meetings!inner(id, slug, title, meeting_date), matter:matters(id, slug, title)")
    .contains("meta", { participation: { speakers: [{ person_id: personId }] } })
    .eq("meetings.municipality_id", municipalityId)
    .lte("meetings.meeting_date", today)
    .order("id");
  if (error) throw error;
  return statementsFromItems((data || []) as unknown as StatementItemRow[], personId, today);
}
