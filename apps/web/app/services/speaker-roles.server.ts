import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A linked public speaker's role on the day they spoke ("President, West Shore Developers Association"), from the
 * roles staff record on the people page. Only a role that covered that meeting's date is shown, so a 2016 appearance
 * isn't labelled with a role taken up in 2026; council and staff roles never apply (they are never linked speakers).
 * Sets `role` on each speaker in place, wherever loader data holds agenda items with meta.participation.speakers.
 */
type Speaker = { person_id?: number | null; role?: string };
type Found = { speakers: Speaker[]; date: string | null };

function collect(node: unknown, date: string | null, out: Found[], seen: Set<object>, depth = 0) {
  if (!node || typeof node !== "object" || seen.has(node) || depth > 8) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) collect(child, date, out, seen, depth + 1);
    return;
  }
  const record = node as Record<string, any>;
  const here = record.meetings?.meeting_date ?? record.meeting?.meeting_date ?? record.meeting_date ?? date;
  const speakers = record.meta?.participation?.speakers;
  if (Array.isArray(speakers)) out.push({ speakers, date: here ? String(here).slice(0, 10) : null });
  for (const value of Object.values(record)) if (value && typeof value === "object") collect(value, here, out, seen, depth + 1);
}

type RoleMembership = { person_id: number; role?: string | null; start_date?: string | null; end_date?: string | null; organization?: { name?: string | null; classification?: string | null } | null };

/** Person ids of every linked public speaker found under `roots`. */
export function speakerPersonIds(roots: unknown[]): number[] {
  const found: Found[] = [];
  collect(roots, null, found, new Set());
  return [...new Set(found.flatMap((f) => f.speakers.map((s) => s.person_id).filter((id): id is number => !!id)))];
}

/** The pure half of labelSpeakerRoles: sets `role` in place from memberships already in hand (council and staff never apply). */
export function applySpeakerRoles(roots: unknown[], memberships: RoleMembership[], date: string | null = null) {
  const found: Found[] = [];
  collect(roots, date, found, new Set());
  const roles = memberships.filter((m) => !/^(council|staff)$/i.test(m.organization?.classification || ""));
  for (const { speakers, date: day } of found) {
    for (const s of speakers) {
      if (!s.person_id || !day) continue;
      const m = roles.find((r) => r.person_id === s.person_id && (!r.start_date || r.start_date <= day) && (!r.end_date || r.end_date >= day));
      if (m) s.role = [m.role, m.organization?.name].filter(Boolean).join(", ");
    }
  }
}

/** Memberships out of a loader's people map ({ [id]: { id, memberships: [...] } }), for applySpeakerRoles. */
export function membershipsFromPeople(people: Record<string | number, { id: number; memberships?: Omit<RoleMembership, "person_id">[] | null } | undefined>): RoleMembership[] {
  return Object.values(people).flatMap((p) => (p?.memberships || []).map((m) => ({ ...m, person_id: p!.id })));
}

export async function labelSpeakerRoles(supabase: SupabaseClient, roots: unknown[], date: string | null = null) {
  const ids = speakerPersonIds(roots);
  if (!ids.length) return;
  const { data } = await supabase.from("memberships")
    .select("person_id, role, start_date, end_date, organization:organizations(name, classification)")
    .in("person_id", ids);
  applySpeakerRoles(roots, (data || []) as any[], date);
}
