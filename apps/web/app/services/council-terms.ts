import type { SupabaseClient } from "@supabase/supabase-js";
import type { CouncilTerm } from "../lib/types";
import { civicToday, councilTermLabel } from "../lib/council-terms";
import { publicData } from "./public-data-cache.server";

// Public roster data, identical for every visitor: shared through publicData (content stamp + TTL).
const SHARED = { shareWithSignedIn: true };
const UNVERIFIED = "Council term dates have not been verified. Do not guess who currently serves.";

export async function getCouncilTerms(supabase: SupabaseClient, municipalityId: number): Promise<CouncilTerm[]> {
  const { terms } = await publicData(`council-terms:${municipalityId}`, () => loadCouncilTerms(supabase, municipalityId),
    (value) => value.ok, undefined, SHARED);
  return terms;
}

async function loadCouncilTerms(supabase: SupabaseClient, municipalityId: number): Promise<{ terms: CouncilTerm[]; ok: boolean }> {
  const { data, error } = await supabase.from("council_terms")
    .select("id,municipality_id,election_id,name,start_date,end_date")
    .eq("municipality_id", municipalityId)
    .order("start_date", { ascending: false });
  if (error) {
    // A staged code deployment can precede the additive migration. Do not invent terms.
    if (error.code === "PGRST205" || error.code === "42P01") return { terms: [], ok: false };
    throw error;
  }
  return { terms: data || [], ok: true };
}

/** Small, dated roster context for questions about who serves, not policy evidence. */
export async function getCouncilGovernanceContext(supabase: SupabaseClient, municipalityId: number): Promise<string> {
  const today = civicToday();
  return publicData(`council-governance:${municipalityId}:${today}`, () => loadGovernanceContext(supabase, municipalityId, today),
    (value) => value !== UNVERIFIED, undefined, SHARED);
}

async function loadGovernanceContext(supabase: SupabaseClient, municipalityId: number, today: string): Promise<string> {
  const terms = await getCouncilTerms(supabase, municipalityId);
  if (!terms.length) return UNVERIFIED;
  const { data, error } = await supabase.from("memberships")
    .select("role,start_date,end_date,council_term_id,person:people(name),organization:organizations!inner(municipality_id,classification)")
    .eq("organization.municipality_id", municipalityId)
    .eq("organization.classification", "Council")
    .in("council_term_id", terms.map((term) => term.id));
  if (error) throw error;
  const context = `Recorded council roster as of ${today} (America/Vancouver). Election winners are council-elect until taking office. Election results may still be preliminary; do not call them certified without checking the election source. Membership and term end dates are inclusive. These are roster facts only, not proof of policy decisions. See /people and /elections.\n` + terms.map((term) => {
    const rows = (data || []).filter((row) => row.council_term_id === term.id);
    return `${councilTermLabel(term, today)}: ${term.start_date} through ${term.end_date || "end not yet recorded"}.\n` + rows.map((row) => {
      const person = row.person as unknown as { name: string } | null;
      return `${person?.name || "Unknown person"}: ${row.role}, served/scheduled ${row.start_date || "start unknown"} through ${row.end_date || "end unknown"}.`;
    }).join("\n");
  }).join("\n");
  return context;
}
