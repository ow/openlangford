/**
 * Agenda items where residents spoke or wrote to Council (public participation, delegations,
 * letters, petitions). The addresses in them are often residents' homes. Same rule as the
 * pipeline's property_summaries.is_public_input.
 */
export const PUBLIC_INPUT = /public\s+(?:participation|input|comment|hearing\s+submission)|correspondence|delegation|written\s+submission|petition/i;

export function isPublicInput(item: { title?: string | null; category?: string | null } | null | undefined): boolean {
  if (!item) return false;
  return String(item.category || "").trim().toLowerCase() === "public input" || PUBLIC_INPUT.test(item.title || "");
}

/** A lot known only because residents gave it as their address: every link comes from public input. */
export function residentOnly(links: { agenda_items?: { title?: string | null; category?: string | null } | null }[]): boolean {
  return links.length > 0 && links.every((l) => isPublicInput(l.agenda_items));
}
