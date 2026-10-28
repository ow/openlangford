import { calculateAttendance, type AttendanceSummary } from "../lib/attendance-evidence";
export { calculateAttendance } from "../lib/attendance-evidence";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fillMeetingSlugs } from "../lib/meeting-slugs";
import { civicToday, membershipIsActiveOn } from "../lib/council-terms";
import type { ParticipationHistory } from "../components/profile/public-participation";
import { isNamedParticipant } from "../lib/participant-identity";
import { documentedCommitteeRole, documentedParticipantRole } from "../lib/participant-roles";
import type {
  Person,
  Membership,
  Attendance,
  Meeting,
  Vote,
} from "../lib/types";

const PUBLIC_READY_MEETING_FILTER =
  "has_agenda.eq.true,has_minutes.eq.true,has_transcript.eq.true,summary.not.is.null";

export interface PersonWithStats extends Person {
  memberships: Membership[];
  stats: AttendanceSummary;
}

export interface PublicParticipantStats {
  person: Person & { memberships?: Membership[] };
  totalSeconds: number;
  segmentCount: number;
  meetingCount: number;
  audioMeetingCount: number;
  documentedMeetingCount: number;
  agendaItemCount: number;
  firstSpokeAt: string | null;
  lastSpokeAt: string | null;
  topCategories: { category: string; seconds: number; count: number }[];
  recentAppearances: {
    meetingId: number;
    meetingSlug?: string | null;
    meetingTitle: string;
    meetingDate: string;
    agendaItemId: number | null;
    agendaTitle: string | null;
    category: string | null;
    seconds: number;
    segmentCount: number;
    firstStartTime: number;
    minutesUrl?: string;
    summary?: string;
  }[];
}


function membershipAppliesOnDate(membership: Membership, date?: string | null) {
  if (!date) return true;
  return membershipIsActiveOn(membership, date);
}

const EXCLUDED_PUBLIC_ROLE_TERMS = [
  "administrator",
  "assistant",
  "cao",
  "chief",
  "clerk",
  "coordinator",
  "deputy",
  "director",
  "engineer",
  "manager",
  "officer",
  "planner",
  "police",
  "rcmp",
  "staff",
  "superintendent",
  "supt",
];

function hasExcludedMembership(
  person: Person & { memberships?: Membership[] },
  date?: string | null,
  meetingOrganizationId?: number,
) {
  const councilMemberships = (person.memberships || []).filter((membership) =>
    membership.organization?.classification?.toLowerCase() === "council" ||
    /\b(mayor|councillor|council member)\b/i.test(membership.role || ""));
  // A global flag cannot establish office on an earlier meeting date. Retain
  // the conservative exclusion only when dated council history is missing.
  if (person.is_councillor && councilMemberships.length === 0) return true;
  if (councilMemberships.some(m => membershipAppliesOnDate(m, date))) return true;

  return (person.memberships || []).some((membership) => {
    if (!membershipAppliesOnDate(membership, date)) return false;
    const classification = membership.organization?.classification?.toLowerCase();
    const role = membership.role?.toLowerCase() || "";
    return (
      classification === "council" ||
      classification === "staff" ||
      (classification?.includes("committee") && membership.organization_id != null &&
        membership.organization_id === meetingOrganizationId) ||
      EXCLUDED_PUBLIC_ROLE_TERMS.some((term) => role.includes(term))
    );
  });
}

async function fetchAllIdentifiedTranscriptSegments(
  supabase: SupabaseClient,
  municipalityId?: number,
  personId?: number,
  today = civicToday(),
): Promise<any[]> {
  const allData: any[] = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    let query = supabase
      .from("transcript_segments")
      .select(
        "id, person_id, meeting_id, agenda_item_id, start_time, end_time, meetings!inner(slug, id, title, meeting_date, municipality_id, organization_id), agenda_items(id, title, category)",
      )
      .not("person_id", "is", null)
      .lte("meetings.meeting_date", today)
      .order("id", { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (municipalityId) query = query.eq("meetings.municipality_id", municipalityId);
    if (personId !== undefined) query = query.eq("person_id", personId);
    const { data, error } = await query;

    if (error) throw error;
    if (!data || data.length === 0) break;

    allData.push(...data);
    if (data.length < pageSize) break;
    page++;
  }

  return allData;
}

export async function getPublicParticipantStats(
  supabase: SupabaseClient,
  municipalityId?: number,
  documentedHistories: readonly (ParticipationHistory & { personId: number })[] = [],
  personId?: number,
): Promise<PublicParticipantStats[]> {
  const today = civicToday();
  if (personId !== undefined) documentedHistories = documentedHistories.filter(history => history.personId === personId);
  const segments = await fetchAllIdentifiedTranscriptSegments(supabase, municipalityId, personId, today);
  const scopedSegments = municipalityId
    ? segments.filter((segment) => segment.meetings?.municipality_id === municipalityId)
    : segments;

  const personIds = Array.from(
    new Set([...scopedSegments.map((segment) => segment.person_id).filter(Boolean),
      ...documentedHistories.map(history => history.personId)]),
  );
  if (personIds.length === 0) return [];

  const peopleById = new Map<number, Person & { memberships?: Membership[] }>();
  const rolesByMeeting = new Map<number, unknown>();
  const organizationByMeeting = new Map<number, number>();
  const meetingIds = [...new Set([...scopedSegments.map(s => s.meeting_id),
    ...documentedHistories.flatMap(history => history.records.map(record => record.meetingId))])];
  const chunkSize = 200;
  for (let i = 0; i < meetingIds.length; i += chunkSize) {
    const { data, error } = await supabase.from("meetings")
      .select("id, slug, organization_id, participant_roles:meta->participant_roles")
      .in("id", meetingIds.slice(i, i + chunkSize));
    if (error) throw error;
    for (const meeting of data || []) {
      rolesByMeeting.set(meeting.id, meeting.participant_roles);
      if (meeting.organization_id != null) organizationByMeeting.set(meeting.id, meeting.organization_id);
    }
  }
  for (let i = 0; i < personIds.length; i += chunkSize) {
    const { data, error } = await supabase
      .from("people")
      .select(
        "id, name, is_councillor, image_url, bio, memberships(id, organization_id, role, start_date, end_date, organization:organizations(id, name, classification))",
      )
      .in("id", personIds.slice(i, i + chunkSize));

    if (error) throw error;
    for (const person of data || []) {
      peopleById.set(person.id, person as unknown as Person & { memberships?: Membership[] });
    }
  }

  // Role checks are meeting/person facts, not segment facts. Cache them once
  // per appearance, and compute today's civil date once per request.
  const serviceByAppearance = new Map<string, boolean>();
  const isOfficialService = (person: Person, meetingId: number, date: string, organizationId?: number) => {
    const key = `${person.id}:${meetingId}:${date}:${organizationId ?? ""}`;
    if (!serviceByAppearance.has(key)) {
      const roles = rolesByMeeting.get(meetingId);
      serviceByAppearance.set(key, Boolean(hasExcludedMembership(person, date, organizationId) ||
        documentedParticipantRole(roles, person.id, date) || documentedCommitteeRole(roles, person.id, date)));
    }
    return serviceByAppearance.get(key)!;
  };

  const statsByPerson = new Map<
    number,
    PublicParticipantStats & {
      meetingIds: Set<number>;
      audioMeetingIds: Set<number>;
      documentedMeetingIds: Set<number>;
      agendaItemIds: Set<number>;
      categoryMap: Map<string, { category: string; seconds: number; count: number }>;
      appearanceMap: Map<string, PublicParticipantStats["recentAppearances"][number]>;
    }
  >();

  const getStats = (person: Person & { memberships?: Membership[] }, meetingDate: string) => {
    let stats = statsByPerson.get(person.id);
    if (!stats) {
      stats = {
        person,
        totalSeconds: 0,
        segmentCount: 0,
        meetingCount: 0,
        audioMeetingCount: 0,
        documentedMeetingCount: 0,
        agendaItemCount: 0,
        firstSpokeAt: meetingDate,
        lastSpokeAt: meetingDate,
        topCategories: [],
        recentAppearances: [],
        meetingIds: new Set<number>(),
        audioMeetingIds: new Set<number>(),
        documentedMeetingIds: new Set<number>(),
        agendaItemIds: new Set<number>(),
        categoryMap: new Map(),
        appearanceMap: new Map(),
      };
      statsByPerson.set(person.id, stats);
    }
    if (!stats.firstSpokeAt || meetingDate < stats.firstSpokeAt) stats.firstSpokeAt = meetingDate;
    if (!stats.lastSpokeAt || meetingDate > stats.lastSpokeAt) stats.lastSpokeAt = meetingDate;
    return stats;
  };

  for (const segment of scopedSegments) {
    const person = peopleById.get(segment.person_id);
    const meetingDate = segment.meetings?.meeting_date;
    const seconds = segment.end_time - segment.start_time;
    if (!person || !isNamedParticipant(person.name) || !meetingDate || meetingDate > today ||
      isOfficialService(person, segment.meeting_id, meetingDate, segment.meetings?.organization_id) ||
      !Number.isFinite(seconds) || seconds <= 0) continue;
    const stats = getStats(person, meetingDate);

    stats.totalSeconds += seconds;
    stats.segmentCount += 1;
    if (segment.meeting_id) {
      stats.meetingIds.add(segment.meeting_id);
      stats.audioMeetingIds.add(segment.meeting_id);
    }
    if (segment.agenda_item_id) stats.agendaItemIds.add(segment.agenda_item_id);
    if (meetingDate && (!stats.firstSpokeAt || meetingDate < stats.firstSpokeAt)) {
      stats.firstSpokeAt = meetingDate;
    }
    if (meetingDate && (!stats.lastSpokeAt || meetingDate > stats.lastSpokeAt)) {
      stats.lastSpokeAt = meetingDate;
    }

    const category = segment.agenda_items?.category || "Public";
    const categoryStats = stats.categoryMap.get(category) || {
      category,
      seconds: 0,
      count: 0,
    };
    categoryStats.seconds += seconds;
    categoryStats.count += 1;
    stats.categoryMap.set(category, categoryStats);

    const appearanceKey = `${segment.meeting_id}:${segment.agenda_item_id || "none"}`;
    const existingAppearance = stats.appearanceMap.get(appearanceKey);
    if (existingAppearance) {
      existingAppearance.seconds += seconds;
      existingAppearance.segmentCount += 1;
      existingAppearance.firstStartTime = Math.min(
        existingAppearance.firstStartTime,
        segment.start_time || 0,
      );
    } else {
      stats.appearanceMap.set(appearanceKey, {
        meetingId: segment.meeting_id,
        meetingSlug: segment.meetings?.slug || null,
        meetingTitle: segment.meetings?.title || "Untitled meeting",
        meetingDate: meetingDate || "",
        agendaItemId: segment.agenda_item_id || null,
        agendaTitle: segment.agenda_items?.title || null,
        category: segment.agenda_items?.category || "Public",
        seconds,
        segmentCount: 1,
        firstStartTime: segment.start_time || 0,
      });
    }
  }

  // Explicit person/municipality-bound inventories supply appearances, never
  // timestamps or durations. The caller selects inventories for this municipality.
  for (const history of documentedHistories) {
    const person = peopleById.get(history.personId);
    if (!person || !isNamedParticipant(person.name)) continue;
    for (const record of history.records) {
      if (record.date > today || isOfficialService(person, record.meetingId, record.date, organizationByMeeting.get(record.meetingId))) continue;
      const stats = getStats(person, record.date);
      stats.meetingIds.add(record.meetingId);
      stats.documentedMeetingIds.add(record.meetingId);
      const appearance = [...stats.appearanceMap.values()].find(a => a.meetingId === record.meetingId);
      if (appearance) {
        appearance.minutesUrl = record.minutesUrl;
        appearance.summary = record.summary;
      } else {
        stats.appearanceMap.set(`${record.meetingId}:minutes`, {
          meetingId: record.meetingId, meetingTitle: record.meetingType,
          meetingDate: record.date, agendaItemId: null, agendaTitle: null, category: null,
          seconds: 0, segmentCount: 0, firstStartTime: 0,
          minutesUrl: record.minutesUrl, summary: record.summary,
        });
      }
    }
  }

  const results = Array.from(statsByPerson.values())
    .map((stats) => ({
      person: stats.person,
      totalSeconds: stats.totalSeconds,
      segmentCount: stats.segmentCount,
      meetingCount: stats.meetingIds.size,
      audioMeetingCount: stats.audioMeetingIds.size,
      documentedMeetingCount: stats.documentedMeetingIds.size,
      agendaItemCount: stats.agendaItemIds.size,
      firstSpokeAt: stats.firstSpokeAt,
      lastSpokeAt: stats.lastSpokeAt,
      topCategories: Array.from(stats.categoryMap.values())
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, 5),
      recentAppearances: Array.from(stats.appearanceMap.values())
        .sort((a, b) => {
          const dateCompare = b.meetingDate.localeCompare(a.meetingDate);
          if (dateCompare !== 0) return dateCompare;
          return a.firstStartTime - b.firstStartTime;
        })
        .slice(0, personId === undefined ? 6 : undefined),
    }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds || b.meetingCount - a.meetingCount || a.person.name.localeCompare(b.person.name));
  // Minutes-documented appearances only carry a meeting id.
  await fillMeetingSlugs(supabase, results.flatMap((r) => r.recentAppearances));
  return results;
}

/** All speakers, including council and staff. Segment counts are not durations. */
export async function getParticipantIdentificationCoverage(supabase: SupabaseClient, municipalityId: number) {
  const count = (identified: boolean) => {
    let query = supabase.from("transcript_segments")
      .select("id, meetings!inner(slug, id)", { count: "exact", head: true })
      .eq("meetings.municipality_id", municipalityId)
      .lte("meetings.meeting_date", civicToday());
    if (identified) query = query.not("person_id", "is", null);
    return query;
  };
  const [total, linked] = await Promise.all([count(false), count(true)]);
  if (total.error) throw total.error;
  if (linked.error) throw linked.error;
  if (total.count == null || linked.count == null || linked.count > total.count) {
    throw new Error("Speaker identification coverage unavailable");
  }
  return { totalSegments: total.count, linkedSegments: linked.count };
}

async function fetchAllAttendance(
  supabase: SupabaseClient,
  councilId: number,
): Promise<Attendance[]> {
  const allData: Attendance[] = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("attendance")
      .select("meeting_id, person_id, attendance_mode, notes, meetings!inner(organization_id)")
      .eq("meetings.organization_id", councilId)
      .order("id")
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    allData.push(...(data as unknown as Attendance[]));
    if (data.length < pageSize) break;
    page++;
  }

  return allData;
}

export async function getPeopleWithStats(
  supabase: SupabaseClient,
  municipalityId = 1,
): Promise<PersonWithStats[]> {
  // 1. Get the 'Council' organization ID
  const { data: councilOrg } = await supabase
    .from("organizations")
    .select("id")
    .eq("classification", "Council")
    .eq("municipality_id", municipalityId)
    .single();

  const councilId = councilOrg?.id;
  if (!councilId) return [];

  // 2. Fetch all people who have or had a membership in the Council
  const [peopleRes, meetingsRes, attendanceRes] = await Promise.all([
    supabase
      .from("people")
      .select(
        "id, name, slug, is_councillor, image_url, bio, created_at, memberships(id, organization_id, role, start_date, end_date, organization:organizations(id, name, classification))",
      )
      .eq("memberships.organization_id", councilId),
    supabase
      .from("meetings")
      .select("id, slug, organization_id, meeting_date, status")
      .eq("organization_id", councilId)
      .or(PUBLIC_READY_MEETING_FILTER)
      .order("meeting_date", { ascending: false }),
    fetchAllAttendance(supabase, councilId),
  ]);

  if (peopleRes.error) throw new Error(peopleRes.error.message);

  // Filter people who actually have council memberships (inner join simulation)
  const councilMembers = (peopleRes.data || []).filter(
    (p) =>
      p.memberships &&
      p.memberships.some((m: any) => m.organization_id === councilId),
  ) as unknown as (Person & { memberships: Membership[] })[];

  const allMeetings = (meetingsRes.data || []) as Meeting[];
  const allAttendance = attendanceRes as Attendance[];

  // Calculate stats
  const peopleWithStats = councilMembers
    .map((person) => ({
      ...person,
      stats: calculateAttendance(person, allMeetings, allAttendance, councilId),
    }))
    .sort((a, b) => {
      // Sort by active status first, then name
      if (a.is_councillor && !b.is_councillor) return -1;
      if (!a.is_councillor && b.is_councillor) return 1;
      return a.name.localeCompare(b.name);
    });

  return peopleWithStats;
}

export async function getElections(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("elections")
    .select("*")
    .order("election_date", { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

async function fetchAllVotesForPerson(
  supabase: SupabaseClient,
  personId: string | number,
): Promise<any[]> {
  const allData: any[] = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("votes")
      .select(
        "id, motion_id, person_id, vote, recusal_reason, created_at, motions(id, text_content, result, meeting_id, meetings(slug, id, title, meeting_date))",
      )
      .eq("person_id", personId)
      .order("created_at", { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    allData.push(...data);
    if (data.length < pageSize) break;
    page++;
  }

  return allData;
}

async function fetchAllAttendanceForPerson(
  supabase: SupabaseClient,
  personId: string | number,
  page = 0,
  pageSize = 20,
  period?: ProfilePeriod,
): Promise<{ data: any[]; total: number }> {
  const query = supabase
    .from("attendance")
    .select(
      "id, meeting_id, person_id, attendance_mode, notes, created_at, meetings!inner(slug, id, title, meeting_date, organizations(name))",
      { count: "exact" },
    )
    .eq("person_id", personId)
    .order("meetings(meeting_date)", { ascending: false }) // Sort by meeting date descending
    .range(page * pageSize, (page + 1) * pageSize - 1);
  const { data, count, error } = await applyProfilePeriod(query, period, "meetings");
  if (error) throw error;
  return { data: data || [], total: count || 0 };
}

async function fetchAllAttendanceSimple(
  supabase: SupabaseClient,
  personId: string | number,
  period?: ProfilePeriod,
): Promise<Attendance[]> {
  const allData: Attendance[] = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const query = supabase
      .from("attendance")
      .select("meeting_id, person_id, attendance_mode, notes, meetings!inner(slug, meeting_date)")
      .eq("person_id", personId)
      .range(page * pageSize, (page + 1) * pageSize - 1);

    const { data, error } = await applyProfilePeriod(query, period, "meetings");
    if (error) throw error;
    if (!data || data.length === 0) break;

    allData.push(...(data as Attendance[]));
    if (data.length < pageSize) break;
    page++;
  }

  return allData;
}

export async function fetchRelevantVotesForAlignment(
  supabase: SupabaseClient,
  personId: string | number,
  municipalityId?: number,
): Promise<any[]> {
  // 1. Get all motion IDs this person voted on
  const targetVotes: { motion_id: number }[] = [];
  const pageSize = 1000;
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("votes")
      .select("motion_id")
      .eq("person_id", personId)
      .order("id", { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw error;
    targetVotes.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  if (targetVotes.length === 0) return [];

  const motionIds = targetVotes.map((v) => v.motion_id);
  const uniqueMotionIds = Array.from(new Set(motionIds));

  const chunkSize = 50;
  const chunks = [];
  for (let i = 0; i < uniqueMotionIds.length; i += chunkSize) {
    chunks.push(uniqueMotionIds.slice(i, i + chunkSize));
  }

  const results = await Promise.all(
    chunks.map((chunk) =>
      supabase
        .from("votes")
        .select(
          "motion_id, person_id, vote, motions!inner(vote_coverage:meta->>individual_vote_coverage, meeting_id, meetings!inner(slug, meeting_date, municipality_id))",
        )
        .in("motion_id", chunk)
        .in("vote", ["Yes", "No", "Opposed", "In Favour"]),
    ),
  );

  const allData: any[] = [];

  for (const { data, error } of results) {
    if (error) throw error;
    if (data) {
      allData.push(...data.filter((vote: any) => vote.motions?.vote_coverage !== "named_only"
        && (!municipalityId || vote.motions?.meetings?.municipality_id === municipalityId)));
    }
  }

  return allData;
}

import {
  calculateAlignmentForPerson,
  parseAlignmentDate,
} from "../lib/alignment-utils";

interface ProfilePeriod {
  start?: string;
  end: string;
  intervals?: { start_date?: string; end_date?: string }[];
}

function applyProfilePeriod(query: any, period?: ProfilePeriod, table?: string) {
  if (!period) return query;
  const prefix = table ? `${table}.` : "";
  query = query.lte(`${prefix}meeting_date`, period.end);
  if (period.start) query = query.gte(`${prefix}meeting_date`, period.start);
  if (period.intervals) {
    const intervals = period.intervals.map((membership) => {
      const start = membership.start_date && membership.start_date > (period.start || "0001-01-01") ? membership.start_date : period.start || "0001-01-01";
      const end = membership.end_date && membership.end_date < period.end ? membership.end_date : period.end;
      return { start, end };
    }).filter((range) => range.start <= range.end);
    const clause = intervals.map((range) => `and(meeting_date.gte.${range.start},meeting_date.lte.${range.end})`).join(",");
    query = query.or(clause || "meeting_date.eq.0001-01-01", table ? { referencedTable: table } : undefined);
  }
  return query;
}

/**
 * Optimized profile loader that only fetches counts for heavy data
 */
export async function getPersonProfile(
  supabase: SupabaseClient,
  id: string,
  attendancePage = 0,
  municipalityId?: number,
  requestedPeriod?: { start: string; end: string },
  compactAttendance?: AttendanceSummary,
) {
  const councilOrgQuery = supabase.from("organizations").select("id").eq("classification", "Council");
  if (municipalityId) councilOrgQuery.eq("municipality_id", municipalityId);
  const { data: councilOrg } = await councilOrgQuery.single();
  const personRes = await supabase.from("people").select(
    "id, name, is_councillor, email, image_url, bio, created_at, council_service_history:meta->council_service_history, in_memoriam:meta->in_memoriam, memberships(id, organization_id, role, start_date, end_date, organization:organizations(id, name, classification))",
  ).eq("id", id).single();
  if (personRes.error) throw personRes.error.code === "PGRST116" ? new Error("Person Not Found") : personRes.error;
  const serviceIntervals = (personRes.data.memberships || []).filter((m: any) => m.organization_id === councilOrg?.id);
  const period: ProfilePeriod = { ...requestedPeriod, end: requestedPeriod?.end || civicToday(), intervals: requestedPeriod ? serviceIntervals : undefined };
  const votesCount = (filter?: string) => {
    let query = supabase.from("votes").select("id, motions!inner(meetings!inner(slug, meeting_date))", { count: "exact", head: true }).eq("person_id", id);
    if (filter) query = query.or(filter);
    return applyProfilePeriod(query, period, "motions.meetings");
  };
  const motionsCount = (role: string) => applyProfilePeriod(supabase.from("motions").select("id, meetings!inner(slug, meeting_date)", { count: "exact", head: true }).eq(role, id), period, "meetings");
  const [attendanceRes, attendanceAllRes, voteCountRes, allMeetingsRes, candidaciesRes, transcriptRes, movedCountRes, secondedCountRes, yesVotesRes, noVotesRes, abstainVotesRes, allVotesForAlignment, membershipsRes] = await Promise.all([
    fetchAllAttendanceForPerson(supabase, id, attendancePage, 20, period),
    compactAttendance ? Promise.resolve([]) : fetchAllAttendanceSimple(supabase, id, period),
    votesCount(),
    compactAttendance ? Promise.resolve({ data: [], error: null }) : applyProfilePeriod(supabase.from("meetings").select("id, slug, organization_id, title, meeting_date, status, organizations(name)").eq("organization_id", councilOrg?.id || -1).or(PUBLIC_READY_MEETING_FILTER).order("meeting_date", { ascending: false }), { ...period, intervals: undefined }),
    supabase
      .from("candidacies")
      .select(
        "id, is_elected, votes_received, election_offices(office, elections(id, slug, name, election_date))",
      )
      .eq("person_id", id)
      .order("election_offices(elections(election_date))", {
        ascending: false,
      }),
    applyProfilePeriod(supabase.from("transcript_segments").select("id, agenda_items(category), meetings!inner(slug, meeting_date)").eq("person_id", id).not("agenda_item_id", "is", null), period, "meetings"),
    motionsCount("mover_id"),
    motionsCount("seconder_id"),
    votesCount("vote.eq.Yes,vote.eq.In Favour"),
    votesCount("vote.eq.No,vote.eq.Opposed"),
    votesCount("vote.eq.Abstain,vote.eq.Recused"),
    fetchRelevantVotesForAlignment(supabase, id, municipalityId),
    supabase
      .from("memberships")
      .select("*, people(id, name, image_url)")
      .eq("organization_id", councilOrg?.id || -1),
  ]);

  for (const result of [voteCountRes, allMeetingsRes, transcriptRes, movedCountRes, secondedCountRes, yesVotesRes, noVotesRes, abstainVotesRes, membershipsRes]) {
    if (result.error) throw result.error;
  }

  // Calculate Alignment (Over entire history)
  const alignmentResults = calculateAlignmentForPerson(
    parseInt(id, 10),
    allVotesForAlignment,
    membershipsRes.data || [],
    requestedPeriod ? new Date(`${requestedPeriod.start}T00:00:00`) : new Date(0),
    new Date(`${period.end}T00:00:00`),
  );

  return {
    person: personRes.data as unknown as Person,
    attendance: attendanceRes.data as (Attendance & {
      meetings: any;
    })[],
    attendanceTotal: attendanceRes.total,
    attendanceSummary: compactAttendance ?? calculateAttendance(personRes.data as unknown as Person, allMeetingsRes.data || [], attendanceAllRes, councilOrg?.id || -1),
    candidacies: (candidaciesRes.data || []) as any[],
    segments: (transcriptRes.data || []) as any[],
    alignmentResults,
    stats: {
      totalVotes: voteCountRes.count || 0,
      totalMoved: movedCountRes.count || 0,
      totalSeconded: secondedCountRes.count || 0,
      votesBreakdown: {
        yes: yesVotesRes.count || 0,
        no: noVotesRes.count || 0,
        abstain: abstainVotesRes.count || 0,
      },
    },
  };
}

/**
 * Fetch detailed motions (moved/seconded) for a person
 */
export async function getPersonProposals(
  supabase: SupabaseClient,
  personId: string,
  role: "mover" | "seconder",
  page = 0,
  pageSize = 50,
) {
  const column = role === "mover" ? "mover_id" : "seconder_id";
  const { data, count, error } = await supabase
    .from("motions")
    .select(
      "id, text_content, result, meeting_id, meetings(slug, id, title, meeting_date)",
      { count: "exact" },
    )
    .eq(column, personId)
    .order("meeting_id", { ascending: false })
    .range(page * pageSize, (page + 1) * pageSize - 1);

  if (error) throw error;
  return { data, total: count || 0 };
}

export async function getActiveCouncilMembers(
  supabase: SupabaseClient,
  date: string,
) {
  const { data: councilOrg } = await supabase
    .from("organizations")
    .select("id")
    .eq("classification", "Council")
    .single();

  if (!councilOrg) return [];

  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("person:people(*)")
    .eq("organization_id", councilOrg.id)
    .lte("start_date", date)
    .or(`end_date.is.null,end_date.gte.${date}`);

  if (error) throw error;
  return (memberships?.map((m: any) => m.person) || []) as unknown as Person[];
}

/**
 * Gets a simple list of all people's names from the database.
 * This is useful for checking if a search query is about a person.
 */
export async function getPeopleNames(
  supabase: SupabaseClient,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("people")
    .select("name")
    .order("name", { ascending: true });

  if (error) {
    console.error("Error fetching people names:", error);
    return [];
  }
  return (data || []).map((p: { name: string }) => p.name);
}

/**
 * A tool to find the name of the person currently holding a specific role (e.g., "Mayor").
 * @param role The role to search for.
 * @returns The name of the person, or a string indicating the role was not found.
 */
export async function get_person_by_role(
  supabase: SupabaseClient,
  {
    role,
  }: {
    role: string;
  },
): Promise<string> {
  const { data: councilOrg } = await supabase
    .from("organizations")
    .select("id")
    .eq("classification", "Council")
    .single();

  if (!councilOrg) {
    return `Error: Council organization not found.`;
  }

  const today = new Date().toISOString().split("T")[0];

  const { data: membership, error } = await supabase
    .from("memberships")
    .select("person:people(name)")
    .eq("organization_id", councilOrg.id)
    .eq("role", role)
    .lte("start_date", today)
    .or(`end_date.is.null,end_date.gte.${today}`)
    .maybeSingle();

  if (error) {
    console.error(`Error fetching person for role "${role}":`, error);
    return `Error: An error occurred while fetching the role: ${role}.`;
  }

  if (!membership) {
    return `Error: No person found currently holding the role: ${role}.`;
  }

  const person = (membership as any).person;
  return person?.name || `Error: No person found for role: ${role}.`;
}
