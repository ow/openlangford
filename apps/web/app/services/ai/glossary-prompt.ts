import { GLOSSARY, GLOSSARY_PATH, GLOSSARY_TERMS, GLOSSARY_VERSION, type GlossaryTerm } from "../../lib/glossary";

/** Which side of a term a prompt needs: how the minutes phrase it (for stages that read records) or the plain
 * words this site writes (for stages that write for residents). */
export type GlossaryRegister = "record" | "resident";

function line(t: GlossaryTerm, register: GlossaryRegister): string | null {
  if (register === "record") {
    if (!t.in_the_record) return null;
    return `- ${t.term}: ${t.in_the_record} ${t.means}`;
  }
  if (!t.we_write) return null;
  return `- ${t.term}: ${t.we_write}`;
}

/** A system-prompt block built from shared/glossary.json. Pass `only` to keep it to the terms a stage needs. */
export function glossaryPromptBlock(register: GlossaryRegister, only?: string[]): string {
  const terms = only ? GLOSSARY_TERMS.filter((t) => only.includes(t.id)) : GLOSSARY_TERMS;
  const lines = terms.map((t) => line(t, register)).filter((l): l is string => Boolean(l));
  const heading =
    register === "record"
      ? "How Langford's council records phrase things (glossary v" + GLOSSARY_VERSION + "):"
      : `Council terms and the plain words this site uses for them (the site explains them at ${GLOSSARY_PATH}; glossary v${GLOSSARY_VERSION}). Use the plain words, not the term:`;
  return [heading, ...lines].join("\n");
}

/** Term ids by group (meetings, decisions, bylaws, land, money, people), with ids added or removed. Mirrors
 * pipeline/ai/glossary.py `ids`. */
export function glossaryIds(groups?: string[], plus: string[] = [], minus: string[] = []): string[] {
  const out = GLOSSARY.groups.filter((g) => !groups || groups.includes(g.id)).flatMap((g) => g.terms.map((t) => t.id));
  for (const id of plus) if (!out.includes(id)) out.push(id);
  return out.filter((id) => !minus.includes(id));
}
