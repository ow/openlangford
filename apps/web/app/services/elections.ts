import type { SupabaseClient } from "@supabase/supabase-js";
import type { Election } from "../lib/types";
import { getMunicipality } from "./municipality";

async function municipalityElectionIds(supabase: SupabaseClient): Promise<number[]> {
  const municipality = await getMunicipality(supabase);
  const { data, error } = await supabase
    .from("council_terms")
    .select("election_id")
    .eq("municipality_id", municipality.id)
    .not("election_id", "is", null);
  if (error) throw error;
  return [...new Set((data || []).map((term) => term.election_id as number))];
}

export async function getElections(supabase: SupabaseClient) {
  const electionIds = await municipalityElectionIds(supabase);
  if (electionIds.length === 0) return [];
  const { data, error } = await supabase
    .from("elections")
    .select("*, election_offices(id, office, candidacies(id, is_elected))")
    .in("id", electionIds)
    .order("election_date", { ascending: false });

  if (error) throw error;
  return data as any[]; // Type needs more detail for nested relations if strictly needed
}

export async function getElectionById(supabase: SupabaseClient, id: string) {
  const electionIds = await municipalityElectionIds(supabase);
  if (!electionIds.includes(Number(id))) throw new Error("Election Not Found");
  const { data: election, error } = await supabase
    .from("elections")
    .select(
      `
      *,
      election_offices (
        *,
        candidacies (
          *,
          people (*)
        )
      )
    `,
    )
    .eq("id", id)
    .single();

  if (error) throw error;
  return election as any;
}
