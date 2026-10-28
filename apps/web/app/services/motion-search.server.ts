import type { SupabaseClient } from "@supabase/supabase-js";
import { completeVoteCounts } from "~/lib/vote-coverage";
import { embedQuery } from "./ai/index.server";

/** Only source-backed provenance labels are promoted into the compact evidence record. */
function choiceBasis(meta: any, choice: any): "explicit" | "inferred" | "unknown" {
  if (!Number.isSafeInteger(choice.person_id) || choice.person_id <= 0 || !["Yes", "No"].includes(choice.vote)) return "unknown";
  const proof = meta?.ballot_reconstruction;
  const mapped = proof?.choice_provenance?.[`person_${choice.person_id}`];
  const recorded = Array.isArray(proof?.votes)
    ? proof.votes.filter((row: any) => row.person_id === choice.person_id)
    : [];
  // A conflicting/duplicated proof row cannot establish this observed choice's origin.
  if (recorded.length > 1 || (recorded.length === 1 && recorded[0].vote !== choice.vote)) return "unknown";
  const evidence = mapped ?? recorded[0]?.evidence;
  if (mapped && recorded[0]?.evidence && mapped !== recorded[0].evidence) return "unknown";
  if (evidence === "explicit_named") return "explicit";
  if (["inferred_explicit_unanimity", "inferred_unique_tally_constraint", "inferred_recorded_dissent_deemed_affirmative", "inferred_official_dissent_recording_rule"].includes(evidence)) return "inferred";
  return "unknown";
}

/** Evidence for RAG: hybrid recall, with keyword-only retrieval if embedding fails. */
export async function searchMotionContext(
  supabase: SupabaseClient,
  { query, after_date }: { query: string; after_date?: string },
): Promise<any[]> {
  let embedding: number[] | null = null;
  try {
    embedding = await embedQuery(query);
  } catch (error) {
    console.error("Motion query embedding unavailable; using keyword search:", error);
  }
  try {
    const { data, error } = await supabase.rpc("hybrid_search_motions", {
      query_text: query,
      query_embedding: embedding ? JSON.stringify(embedding) : null,
      match_count: after_date ? 30 : 15,
      full_text_weight: 1,
      semantic_weight: embedding ? 1 : 0,
      rrf_k: 50,
      date_from: after_date || null,
      date_to: null,
      // The RAG tool currently has no municipality-ID scope.
      filter_municipality_id: null,
    });
    if (error) throw error;
    // The existing RPC can emit zero-score semantic rows for a NULL query vector.
    // Keep only positive finite relevance and preserve RPC order through enrichment.
    const ranked = new Map<number, number>();
    for (const match of data || []) {
      if (Number.isFinite(match.rank_score) && match.rank_score > 0 && !ranked.has(match.id)) {
        ranked.set(match.id, match.rank_score);
      }
    }
    if (!ranked.size) return [];
    let enrich = supabase.from("motions").select(`
      id, meeting_id, text_content, plain_english_summary, result, mover, seconder, meta,
      meetings!inner(id, meeting_date), votes(vote, person_id, people(name))
    `).in("id", [...ranked.keys()]);
    if (after_date) enrich = enrich.gte("meetings.meeting_date", after_date);
    const { data: enriched, error: enrichError } = await enrich;
    if (enrichError) throw enrichError;
    const byId = new Map((enriched || []).map((motion: any) => [motion.id, motion]));
    return [...ranked].flatMap(([id, rank_score]) => {
      const motion = byId.get(id);
      if (!motion) return [];
      const counts = completeVoteCounts(motion);
      const coverage = motion.meta?.individual_vote_coverage;
      const meeting = (row: any) => ({ id: row.id, meeting_date: row.meeting_date });
      const person = (row: any) => ({ name: row.name });
      // Explicit projection: meta is needed locally, but raw audit/history never enters model context.
      return [{
        id: motion.id, meeting_id: motion.meeting_id, text_content: motion.text_content,
        plain_english_summary: motion.plain_english_summary, result: motion.result,
        mover: motion.mover, seconder: motion.seconder, rank_score,
        meetings: Array.isArray(motion.meetings) ? motion.meetings.map(meeting)
          : motion.meetings ? meeting(motion.meetings) : null,
        vote_coverage: coverage === "reconstructed_complete" && !counts ? "unknown"
          : ["reconstructed_complete", "named_only", "not_recorded"].includes(coverage) ? coverage : "unknown",
        votes: (motion.votes || []).map((choice: any) => ({
          person_id: choice.person_id, vote: choice.vote,
          people: Array.isArray(choice.people) ? choice.people.map(person)
            : choice.people ? person(choice.people) : null,
          choice_basis: choiceBasis(motion.meta, choice),
        })),
        yes_votes: counts?.yes ?? null, no_votes: counts?.no ?? null,
        vote_count_basis: counts ? "complete_individual_vote_rows" : "incomplete_or_invalid_individual_vote_rows",
      }];
    });
  } catch (error) {
    console.error("Hybrid search for motions failed:", error);
    return [];
  }
}
