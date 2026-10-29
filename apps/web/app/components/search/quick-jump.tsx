import { useSiteFlags } from "../../lib/use-site-flags";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { classifyIntent } from "../../lib/intent";
import { askUrl, searchUrl } from "../../lib/search-ask";
import { cn } from "../../lib/utils";

type QuickMatch = {
  type: "person" | "matter" | "meeting" | "bylaw" | "property";
  id: number;
  title: string;
  subtitle?: string;
  href: string;
  exact: boolean;
};

type Row =
  | { kind: "match"; match: QuickMatch }
  | { kind: "ask"; query: string }
  | { kind: "search"; query: string };

const TYPE_LABEL: Record<QuickMatch["type"], string> = {
  person: "Person",
  matter: "Matter",
  meeting: "Meeting",
  bylaw: "Bylaw",
  property: "Address",
};

function isTypingTarget(el: EventTarget | null) {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

/**
 * Global quick-jump (⌘K / Ctrl-K / "/"). Instant matches from
 * /api/quick-search; Enter opens the highlighted row, falling back to the
 * full search page (or an AI answer for questions).
 */
export function QuickJump() {
  const { aiSearchAvailable } = useSiteFlags();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<QuickMatch[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !isTypingTarget(e.target)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setMatches([]);
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setMatches([]);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/quick-search?q=${encodeURIComponent(q)}`);
        const data = (await res.json()) as { matches: QuickMatch[] };
        if (id === requestId.current) {
          setMatches(data.matches || []);
          setActive(0);
        }
      } catch {
        if (id === requestId.current) setMatches([]);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [query]);

  const rows: Row[] = useMemo(() => {
    const q = query.trim();
    if (q.length < 2) return [];
    const isQuestion = classifyIntent(q) === "question";
    const out: Row[] = matches.map((match) => ({ kind: "match" as const, match }));
    const search: Row = { kind: "search", query: q };
    const ask: Row = { kind: "ask", query: q };
    // Questions lead with the AI answer unless there's an exact match.
    if (!aiSearchAvailable) return [...out, search];
    if (isQuestion && !matches[0]?.exact) return [ask, ...out, search];
    return [...out, search, ask];
  }, [matches, query, aiSearchAvailable]);

  const go = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      setOpen(false);
      if (row.kind === "match") navigate(row.match.href);
      else if (row.kind === "ask") navigate(askUrl(row.query));
      else navigate(searchUrl(row.query));
    },
    [navigate],
  );

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(rows[active] ?? (query.trim().length >= 2 ? { kind: "search", query: query.trim() } : undefined));
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden h-9 w-56 items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-500 transition-colors hover:border-zinc-300 hover:bg-surface lg:flex"
      >
        <Search className="h-4 w-4 text-zinc-400" aria-hidden="true" />
        <span className="flex-1 text-left">Search</span>
        <kbd className="rounded border border-zinc-200 bg-surface px-1.5 font-sans text-[11px] text-zinc-500">⌘K</kbd>
      </button>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search"
        className="rounded-full p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 lg:hidden"
      >
        <Search className="h-5 w-5" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="top-[12vh] translate-y-0 gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-xl"
        >
          <DialogTitle className="sr-only">Search</DialogTitle>
          <div className="flex items-center gap-2 border-b border-zinc-100 px-4">
            <Search className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKey}
              placeholder="People, matters, bylaw numbers, addresses, meeting dates…"
              aria-label="Search"
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls="quick-jump-results"
              aria-activedescendant={rows.length ? `quick-jump-${active}` : undefined}
              className="h-12 w-full bg-transparent text-[15px] text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
            />
            {loading && <span className="text-xs text-zinc-400">…</span>}
          </div>

          {rows.length > 0 ? (
            <ul id="quick-jump-results" ref={listRef} role="listbox" className="max-h-[60vh] overflow-y-auto py-2">
              {rows.map((row, i) => {
                const selected = i === active;
                const key = row.kind === "match" ? `${row.match.type}-${row.match.id}` : row.kind;
                return (
                  <li
                    key={key}
                    id={`quick-jump-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      go(row);
                    }}
                    className={cn(
                      "mx-2 flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5",
                      selected ? "bg-brand-50" : "hover:bg-zinc-50",
                    )}
                  >
                    {row.kind === "match" ? (
                      <>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-zinc-900">{row.match.title}</span>
                          {row.match.subtitle && (
                            <span className="block truncate text-xs text-zinc-500">{row.match.subtitle}</span>
                          )}
                        </span>
                        <span className="shrink-0 text-xs text-zinc-400">{TYPE_LABEL[row.match.type]}</span>
                      </>
                    ) : row.kind === "ask" ? (
                      <span className="text-sm text-zinc-700">
                        Ask: <span className="font-medium text-zinc-900">{row.query}</span>
                      </span>
                    ) : (
                      <span className="text-sm text-zinc-700">
                        Search everything for <span className="font-medium text-zinc-900">“{row.query}”</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-4 py-6 text-sm text-zinc-500">
              {query.trim().length < 2
                ? "Jump to a councillor, matter, bylaw number, address or meeting date — or ask a question."
                : loading
                  ? "Searching…"
                  : "No direct matches."}
            </p>
          )}

          <div className="flex items-center gap-4 border-t border-zinc-100 bg-zinc-50 px-4 py-2 text-[11px] text-zinc-500">
            <span><kbd className="font-sans">↑↓</kbd> move</span>
            <span><kbd className="font-sans">Enter</kbd> open</span>
            <span><kbd className="font-sans">Esc</kbd> close</span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
