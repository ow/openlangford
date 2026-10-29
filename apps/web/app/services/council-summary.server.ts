import { getSupabaseAdminClient } from "../lib/supabase.server";
import { civicToday } from "../lib/council-terms";
import type { AttendanceSummary } from "../lib/attendance-evidence";
import type { Person, Membership } from "../lib/types";
import type { PersonWithStats } from "./people";
import { getCouncilTerms } from "./council-terms";
import { publicData } from "./public-data-cache.server";

/** One complete public roster/count DTO reused by council, comparison and profiles. */
function getPublicCouncilData(municipalityId: number) {
  const today = civicToday();
  return publicData(`council-summary:${municipalityId}:${today}`, async () => {
    const supabase = getSupabaseAdminClient();
    const { data: council, error: councilError } = await supabase.from("organizations")
      .select("id").eq("classification", "Council").eq("municipality_id", municipalityId).single();
    if (councilError) throw councilError;
    if (!council) throw new Error("Council org not found");
    const [roster, summaries, terms] = await Promise.all([
      supabase.from("people").select("id, name, slug, is_councillor, image_url, council_service_history:meta->council_service_history, in_memoriam:meta->in_memoriam, memberships(id, organization_id, role, start_date, end_date, organization:organizations(name, classification))")
        .eq("memberships.organization_id", council.id),
      supabase.rpc("council_attendance_summaries", { p_municipality_id: municipalityId, p_as_of: today }),
      getCouncilTerms(supabase, municipalityId),
    ]);
    if (roster.error) throw roster.error;
    if (summaries.error) throw summaries.error;
    const people = (roster.data || []).filter(person => person.memberships?.some((membership: any) => membership.organization_id === council.id)) as unknown as (Person & { memberships: Membership[] })[];
    const stats: Record<string, Record<number, AttendanceSummary>> = {};
    for (const row of summaries.data || []) {
      const { person_id, term_key, total, attended, absent, unknown, verified, recorded, rate } = row;
      if (!Number.isSafeInteger(person_id) || person_id <= 0 || typeof term_key !== "string" || !/^(all|[1-9][0-9]*)$/.test(term_key)
        || ![total, attended, absent, unknown, verified, recorded].every(value => Number.isSafeInteger(value) && value >= 0)
        || total !== attended + absent + unknown || recorded !== attended + absent || verified > recorded
        || !(rate === null || Number.isInteger(rate) && rate >= 0 && rate <= 100)
        || stats[term_key]?.[person_id]) throw new Error("Invalid council attendance summary");
      (stats[term_key] ||= {})[person_id] = { total, attended, absent, unknown, verified, recorded, rate };
    }
    // Check the full member/term matrix BEFORE this result can enter shared storage.
    for (const key of ["all", ...terms.map(term => String(term.id))]) for (const person of people) {
      if (!stats[key]?.[person.id]) throw new Error("Incomplete council attendance summary");
    }
    if (!stats.all) throw new Error("Incomplete council attendance summary");
    return { people, terms, today, stats };
  }, () => true, undefined, { shareWithSignedIn: true });
}

export async function getPublicCouncilSummary(municipalityId: number) {
  const data = await getPublicCouncilData(municipalityId);
  const keys = data.terms.length ? data.terms.map(term => ({ key: String(term.id), sqlKey: String(term.id) })) : [{ key: "current", sqlKey: "all" }];
  return { ...data, stats: Object.fromEntries(keys.map(term => [term.key, data.stats[term.sqlKey]])) };
}

/** Comparison keeps its existing all-service counts and roster order. */
export async function getPublicCouncilComparisonPeople(municipalityId: number): Promise<PersonWithStats[]> {
  const data = await getPublicCouncilData(municipalityId);
  return data.people.map(person => ({ ...person, stats: data.stats.all[person.id] }))
    .sort((a, b) => Number(!!b.is_councillor) - Number(!!a.is_councillor) || a.name.localeCompare(b.name));
}

export async function getPublicPersonAttendance(municipalityId: number, personId: number, termId?: number) {
  const data = await getPublicCouncilData(municipalityId);
  const summary = data.stats[termId == null ? "all" : String(termId)]?.[personId];
  if (!summary) throw new Error("Incomplete council attendance summary");
  return summary;
}
