import type { SupabaseClient } from "@supabase/supabase-js";
import { isProceduralMotion } from "../lib/motion-utils";
import { contestedMotionIds, normalizeVote, type ContestedMotion, type MatrixVote } from "../lib/vote-matrix";

async function fetchAllVotesForAlignment(
  supabase: SupabaseClient,
): Promise<any[]> {
  const allData: any[] = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("votes")
      .select(
        "motion_id, person_id, vote, motions(vote_coverage:meta->>individual_vote_coverage, meeting_id, meetings(slug, meeting_date))",
      )
      .in("vote", ["Yes", "No", "Opposed", "In Favour"])
      .order("id", { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    // Named-dissent-only recoveries are not complete roll calls and would bias agreement rates.
    allData.push(...data.filter((vote: any) => vote.motions?.vote_coverage !== "named_only"));
    if (data.length < pageSize) break;
    page++;
  }

  return allData;
}

async function fetchAllMotionsForAlignment(
  supabase: SupabaseClient,
  municipalityId: number,
): Promise<any[]> {
  const allData: any[] = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("motions")
      .select("id, result, votes(id), meetings!inner(slug, meeting_date, municipality_id)")
      .eq("meetings.municipality_id", municipalityId)
      .order("id", { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    allData.push(...data);
    if (data.length < pageSize) break;
    page++;
  }

  return allData;
}

export async function getVotingAlignment(
  supabase: SupabaseClient,
  municipalityId = 1,
) {
  // 1. Get the 'Council' organization ID dynamically
  const { data: councilOrg } = await supabase
    .from("organizations")
    .select("id")
    .eq("classification", "Council")
    .eq("municipality_id", municipalityId)
    .single();

  const councilId = councilOrg?.id;
  if (!councilId) {
    return {
      people: [],
      votes: [],
      motions: [],
      memberships: [],
    };
  }

  const [peopleRes, votes, motions, membershipsRes] = await Promise.all([
    supabase.from("people").select("id, name, image_url, is_councillor"),
    fetchAllVotesForAlignment(supabase),
    fetchAllMotionsForAlignment(supabase, municipalityId),
    supabase
      .from("memberships")
      .select("*, people(id, name, image_url)")
      .eq("organization_id", councilId),
  ]);

  const municipalMotionIds = new Set(motions.map((motion: any) => motion.id));
  return {
    people: peopleRes.data || [],
    votes: (votes || []).filter((vote: any) => municipalMotionIds.has(vote.motion_id)),
    motions: motions || [],
    memberships: membershipsRes.data || [],
  };
}

/**
 * Split decisions for the vote matrix: motions where the alignment votes above include
 * both a Yes and a No, with every recorded choice (recusals too). Procedural motions
 * are dropped by the same rule as meeting pages.
 */
export async function getContestedMotions(
  supabase: SupabaseClient,
  alignmentVotes: { motion_id: number; vote: string }[],
): Promise<ContestedMotion[]> {
  const ids = contestedMotionIds(alignmentVotes);
  const rows: any[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("motions")
      .select("id, text_content, plain_english_summary, result, disposition, agenda_items(category), meetings(id, slug, meeting_date), votes(person_id, vote, recusal_reason)")
      .in("id", ids.slice(i, i + 200));
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows
    .filter((m) => m.meetings?.meeting_date && !isProceduralMotion(m, m.agenda_items))
    .map((m) => {
      const votes: Record<number, MatrixVote> = {};
      for (const v of m.votes || []) {
        const n = normalizeVote(v.vote, v.recusal_reason);
        if (n && v.person_id) votes[v.person_id] = n;
      }
      const text = String(m.plain_english_summary || m.text_content || "").replace(/\s+/g, " ").trim();
      return {
        id: m.id,
        date: String(m.meetings.meeting_date).slice(0, 10),
        meetingId: m.meetings.id,
        meetingSlug: m.meetings.slug || null,
        summary: text.length > 180 ? `${text.slice(0, 177).trim()}…` : text,
        result: m.result || null,
        votes,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
}
