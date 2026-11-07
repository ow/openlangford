import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { Tooltip as T } from "radix-ui";
import { glossaryHref, glossaryTerm, splitTerms, type GlossaryTerm } from "../lib/glossary";

/**
 * Inline council-term hints. The first time a hinted term (shared/glossary.json `match`) appears on a page it
 * gets a dashed underline, its definition on hover or focus, and a link to /how-council-works#<id>. Later
 * occurrences stay plain. "First on the page" is tracked in render order through a per-page set, so SSR and
 * hydration mark the same occurrence.
 */
const Seen = createContext<Set<string> | null>(null);

export function TermHintsProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const seen = useMemo(() => new Set<string>(), [pathname]);
  return <Seen.Provider value={seen}>{children}</Seen.Provider>;
}

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
          <T.Content side="top" sideOffset={6} className="z-50 max-w-72 rounded-md bg-zinc-900 px-3 py-2 text-xs leading-snug text-white shadow-md">
            <span className="font-semibold">{term.term}.</span> {term.means}
            <T.Arrow className="fill-zinc-900" />
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}

/** Mark a known term in hand-written copy: <Term id="carried">carried</Term>. Plain text after the page's first use. */
export function Term({ id, children }: { id: string; children: ReactNode }) {
  const seen = useContext(Seen);
  const term = glossaryTerm(id);
  if (!term || !seen || seen.has(id)) return <>{children}</>;
  seen.add(id);
  return <Hint term={term}>{children}</Hint>;
}

/** Text from the records or a model (a motion, a status line): hinted terms in it get the treatment. */
export function TermText({ text }: { text: string | null | undefined }) {
  const seen = useContext(Seen);
  if (!text) return null;
  if (!seen) return <>{text}</>;
  const segments = splitTerms(text, seen);
  return (
    <>
      {segments.map((s, i) => {
        if (!s.term) return s.text;
        seen.add(s.term.id);
        return <Hint key={i} term={s.term}>{s.text}</Hint>;
      })}
    </>
  );
}
