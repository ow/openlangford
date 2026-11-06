import type { SupabaseClient } from "@supabase/supabase-js";
import type { Person, Membership, Organization } from "../lib/types";

export async function getAllPeople(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("people")
    .select(
      "id, name, is_councillor, image_url, bio, created_at, name_variants:meta->name_variants, memberships(id, role, start_date, end_date, organization:organizations(name))",
    )
    .order("name");

  if (error) throw error;
  return data || [];
}

export async function getPerson(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase
    .from("people")
    .select(
      "id, name, is_councillor, image_url, bio, memberships(id, organization_id, role, start_date, end_date, organization:organizations(id, name, classification))",
    )
    .eq("id", id)
    .single();

  if (error) throw error;
  return data;
}

export async function updatePerson(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Person>,
) {
  const { error } = await supabase.from("people").update(updates).eq("id", id);

  if (error) throw error;
}

export async function createPerson(supabase: SupabaseClient, name: string) {
  const { data, error } = await supabase
    .from("people")
    .insert({ name })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Other spellings the minutes use for this person; the pipeline links speakers by them (exactly as written). */
export async function setNameVariants(supabase: SupabaseClient, id: string, variants: string[]) {
  const { data, error } = await supabase.from("people").select("meta").eq("id", id).single();
  if (error) throw error;
  const meta = { ...((data?.meta as Record<string, unknown>) || {}) };
  if (variants.length) meta.name_variants = variants; else delete meta.name_variants;
  const saved = await supabase.from("people").update({ meta }).eq("id", id);
  if (saved.error) throw saved.error;
}

/** Ask the quick worker to link speakers and letter writers to people again (after spellings change). */
export async function requestParticipantLinks(supabase: SupabaseClient, userId: string) {
  const { data: municipality } = await supabase.from("municipalities").select("id").order("id").limit(1).maybeSingle();
  const { error } = await supabase.from("pipeline_jobs").insert({
    municipality_id: municipality?.id ?? 1, job_type: "link_participants", args: {}, requested_by: userId, max_attempts: 1, priority: 10,
  });
  if (error) throw error;
}

/** An organization a person can hold a role in (an industry group, a company, a society). */
export async function createOrganization(supabase: SupabaseClient, name: string, classification = "Other") {
  const { data, error } = await supabase.from("organizations").insert({ name, classification }).select("id").single();
  if (error) throw error;
  return data.id as number;
}

export async function getAllOrganizations(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, classification")
    .order("classification")
    .order("name");

  if (error) throw error;
  return data || [];
}

export async function addMembership(
  supabase: SupabaseClient,
  membership: Partial<Membership>,
) {
  const { error } = await supabase.from("memberships").insert(membership);

  if (error) throw error;
}

export async function updateMembership(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Membership>,
) {
  const { error } = await supabase
    .from("memberships")
    .update(updates)
    .eq("id", id);

  if (error) throw error;
}

export async function deleteMembership(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("memberships").delete().eq("id", id);

  if (error) throw error;
}
