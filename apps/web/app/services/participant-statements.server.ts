import type { SupabaseClient } from "@supabase/supabase-js";
import { civicToday } from "../lib/council-terms";
import { cachedCompute, HOURLY_SHARED } from "./computed-cache.server";
import { getPublicParticipantStats } from "./people";
import { getPublicParticipationHistories } from "./public-participation.server";
import { statementsByPerson, statementsFromItems, type ParticipantStatement, type StatementItemRow } from "../lib/participant-statements";

const ITEM_FIELDS = "id, title, meetings!inner(id, slug, title, meeting_date), matter:matters(id, slug, title)";
const SPOKEN_FIELDS = "speakers:meta->participation->speakers, source:meta->participation->source";
const WRITTEN_FIELDS = "written:meta->written_participation";

/**
 * Agenda items where the pipeline linked a public speaker
 * (`meta.participation.speakers[].person_id`) or a letter writer
 * (`meta.written_participation.documents[].letters[].person_id`) to this
 * person. Two JSONB containment queries run in parallel, each selecting only
 * its own list, so an item matching both contributes each entry once.
 */
export async function getParticipantStatements(supabase: SupabaseClient, municipalityId: number, personId: number): Promise<ParticipantStatement[]> {
  const today = civicToday();
  const query = (fields: string, contains: Record<string, unknown>) => supabase
    .from("agenda_items")
    .select(`${ITEM_FIELDS}, ${fields}`)
    .contains("meta", contains)
    .eq("meetings.municipality_id", municipalityId)
    .lte("meetings.meeting_date", today)
    .order("id");
  const [spoken, written] = await Promise.all([
    query(SPOKEN_FIELDS, { participation: { speakers: [{ person_id: personId }] } }),
    query(WRITTEN_FIELDS, { written_participation: { documents: [{ letters: [{ person_id: personId }] }] } }),
  ]);
  if (spoken.error) throw spoken.error;
  if (written.error) throw written.error;
  return statementsFromItems([...(spoken.data || []), ...(written.data || [])] as unknown as StatementItemRow[], personId, today);
}

/**
 * Every linked comment and letter in the municipality, by person: the
 * participants index and sitemap use it so people known only through linked
 * comments or letters are listed, with the same counts as their profiles.
 */
export async function getAllParticipantStatements(supabase: SupabaseClient, municipalityId: number): Promise<Map<number, ParticipantStatement[]>> {
  const today = civicToday();
  const rows: StatementItemRow[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("agenda_items")
      .select(`${ITEM_FIELDS}, ${SPOKEN_FIELDS}, ${WRITTEN_FIELDS}`)
      .or("meta->participation->speakers.not.is.null,meta->written_participation.not.is.null")
      .eq("meetings.municipality_id", municipalityId)
      .lte("meetings.meeting_date", today)
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...((data || []) as unknown as StatementItemRow[]));
    if (!data || data.length < pageSize) break;
  }
  return statementsByPerson(rows, today);
}

/**
 * The /participants list (also the sitemap's participant section): transcript
 * and minutes appearances plus people known only through linked comments or
 * letters. One shared cache entry; it changes only when the pipeline runs.
 */
export function getPublicParticipantsIndex(supabase: SupabaseClient, municipality: { id: number; slug: string }) {
  return cachedCompute(`public-participants-v2:${municipality.id}`, async () =>
    getPublicParticipantStats(supabase, municipality.id, getPublicParticipationHistories(municipality.slug), undefined,
      await getAllParticipantStatements(supabase, municipality.id)),
  HOURLY_SHARED);
}
