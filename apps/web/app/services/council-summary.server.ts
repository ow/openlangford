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

export interface CouncilTermStats {
  meetings: number;
  regularCouncil: number;
  specialCouncil: number;
  committeeOfTheWhole: number;
  committees: number;
  motionsCarried: number;
  motionsDefeated: number;
  bylawsAdopted: number;
  /** One date per bylaw adopted (YYYY-MM-DD), oldest first. */
  bylawAdoptionDates: string[];
  /** Motions decided per month (YYYY-MM). */
  motionsByMonth: { month: string; carried: number; defeated: number }[];
  topics: { title: string; slug: string; meetings: number }[];
  meetingsByMonth: { month: string; meetings: number }[];
  /** Residents' comments at meetings and letters in agenda packages, as the pipeline recorded them. */
  spokenComments: number;
  letters: number;
  publicSupports: number;
  publicOpposes: number;
  publicTopics: { title: string; slug: string; comments: number }[];
}

const count = (n: unknown) => (Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : 0);

/** Public input fields; zero/empty when the deployed function predates them. */
function publicInput(row: any) {
  return {
    spokenComments: count(row.spoken_comments), letters: count(row.letters),
    publicSupports: count(row.public_supports), publicOpposes: count(row.public_opposes),
    publicTopics: (Array.isArray(row.public_topics) ? row.public_topics : [])
      .filter((t: any) => typeof t?.title === "string" && typeof t?.slug === "string" && Number.isSafeInteger(t?.comments))
      .map((t: any) => ({ title: t.title, slug: t.slug, comments: t.comments })),
  };
}

/** Each term's totals (council_term_stats), keyed by term id. Counts only what the minutes record. */
export function getCouncilTermStats(municipalityId: number) {
  const today = civicToday();
  return publicData(`council-term-stats:${municipalityId}:${today}`, async () => {
    const { data, error } = await getSupabaseAdminClient().rpc("council_term_stats", { p_municipality_id: municipalityId, p_as_of: today });
    if (error) throw error;
    const stats: Record<string, CouncilTermStats> = {};
    for (const row of data || []) {
      const counts = [row.meetings, row.regular_council, row.special_council, row.committee_of_the_whole, row.committees, row.motions_carried, row.motions_defeated, row.bylaws_adopted];
      if (!Number.isSafeInteger(row.term_id) || !counts.every((n) => Number.isSafeInteger(n) && n >= 0) || !Array.isArray(row.topics) || !Array.isArray(row.bylaw_adoption_dates)) {
        throw new Error("Invalid council term stats");
      }
      stats[String(row.term_id)] = {
        meetings: row.meetings, regularCouncil: row.regular_council, specialCouncil: row.special_council,
        committeeOfTheWhole: row.committee_of_the_whole, committees: row.committees,
        motionsCarried: row.motions_carried, motionsDefeated: row.motions_defeated, bylawsAdopted: row.bylaws_adopted,
        // Older deployments of the function have no monthly counts: the chart is left out.
        motionsByMonth: (Array.isArray(row.motions_by_month) ? row.motions_by_month : [])
          .filter((m: any) => typeof m?.month === "string" && /^\d{4}-\d{2}$/.test(m.month) && Number.isSafeInteger(m.carried) && Number.isSafeInteger(m.defeated))
          .map((m: any) => ({ month: m.month, carried: m.carried, defeated: m.defeated })),
        meetingsByMonth: (Array.isArray(row.meetings_by_month) ? row.meetings_by_month : [])
          .filter((m: any) => typeof m?.month === "string" && /^\d{4}-\d{2}$/.test(m.month) && Number.isSafeInteger(m.meetings))
          .map((m: any) => ({ month: m.month, meetings: m.meetings })),
        ...publicInput(row),
        bylawAdoptionDates: row.bylaw_adoption_dates.filter((d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)),
        topics: row.topics.filter((t: any) => typeof t?.title === "string" && typeof t?.slug === "string" && Number.isSafeInteger(t?.meetings))
          .map((t: any) => ({ title: t.title, slug: t.slug, meetings: t.meetings })),
      };
    }
    return stats;
  }, () => true, undefined, { shareWithSignedIn: true });
}
