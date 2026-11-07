import type { ReactNode } from "react";
import { Link } from "react-router";
import { Tooltip as T } from "radix-ui";
import { HINT_TERMS, glossaryHref, glossaryTerm, splitTerms, type GlossaryTerm } from "../lib/glossary";

/**
 * Inline council-term hints: a dashed underline, the definition on hover or focus, and a link to
 * /how-council-works#<id>. Pure: what gets marked depends only on props, so server and client render the same.
 * A list that shows many texts computes `hintPlan` (lib/glossary.ts) once and passes each text its share, so the
 * page marks each term once.
 */
function Hint({ term, children }: { term: GlossaryTerm; children: ReactNode }) {
  return (
    <T.Provider delayDuration={200}>
      <T.Root>
        <T.Trigger asChild>
          <Link
            to={glossaryHref(term.id)}
            className="underline decoration-dashed decoration-zinc-400 underline-offset-[3px] hover:decoration-brand-600 hover:text-brand-800"
          >
            {children}
          </Link>
        </T.Trigger>
        <T.Portal>
          <T.Content side="top" sideOffset={6} className="z-50 max-w-72 rounded-md bg-zinc-900 px-3 py-2 text-xs leading-snug text-pretty text-white shadow-md">
            <span className="font-semibold">{term.term}.</span> {term.short ?? term.means}
            <T.Arrow className="fill-zinc-900" />
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}

/** Mark a known term in hand-written copy: <Term id="carried">carried</Term>. */
export function Term({ id, children }: { id: string; children: ReactNode }) {
  const term = glossaryTerm(id);
  return term ? <Hint term={term}>{children}</Hint> : <>{children}</>;
}

const ALL_TERMS: ReadonlySet<string> = new Set(HINT_TERMS.map((h) => h.term.id));

/** Text from the records or a model (a motion, a status line). Marks the first occurrence of each hinted term
 * in it, or only the terms in `only` when the page planned them (an empty set means none). */
export function TermText({ text, only }: { text: string | null | undefined; only?: ReadonlySet<string> }) {
  if (!text) return null;
  const allowed = only ?? ALL_TERMS;
  if (allowed.size === 0) return <>{text}</>;
  const skip = new Set(HINT_TERMS.map((h) => h.term.id).filter((id) => !allowed.has(id)));
  return (
    <>
      {splitTerms(text, skip).map((s, i) => (s.term ? <Hint key={i} term={s.term}>{s.text}</Hint> : s.text))}
    </>
  );
}
