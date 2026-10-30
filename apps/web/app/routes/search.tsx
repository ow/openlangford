import { useSiteFlags } from "../lib/use-site-flags";
import { SITE_NAME } from "../lib/site-name";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import { getCouncilTerms } from "../services/council-terms";
import { getMunicipality } from "../services/municipality";
import { createSupabaseServerClient } from "../lib/supabase.server";
import { useState, useEffect, useRef } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/search";
import { useSearchParams, useNavigate, useRouteLoaderData, useRevalidator } from "react-router";
import { NativeSelect } from "../components/ui/native-select";
import { Search as SearchIcon, X, Send, Loader2 } from "lucide-react";
import { classifyIntent } from "../lib/intent";
import type { AgentEvent } from "../services/rag.server";
import type { UnifiedSearchResult } from "../services/hybrid-search.server";
import { SearchInput } from "../components/search/search-input";
import { AiAnswer } from "../components/search/ai-answer";
import { SearchResults } from "../components/search/search-results";
import { SearchFilters } from "../components/search/search-filters";
import { FollowUp } from "../components/search/follow-up";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { ogImageUrl, ogUrl } from "../lib/og";
import {
  parseSearchFilters,
  serializeSearchFilters,
  type ContentType,
} from "../lib/search-params";
import { trackEvent } from "../lib/analytics";
import { askUrl, shouldAutoAsk } from "../lib/search-ask";

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export const meta: Route.MetaFunction = ({ data }) => {
  const query = (data as any)?.query;
  if (query) {
    const title = `"${query}" — Search | ${SITE_NAME}`;
    return [
      { name: "robots", content: "noindex, follow" },
      { title },
      { name: "description", content: `AI-powered search result from ${DEFAULT_MUNICIPALITY.short_name} council records` },
      { property: "og:title", content: `"${query}" — ${DEFAULT_MUNICIPALITY.short_name} Council Search` },
      { property: "og:description", content: `AI-powered search result from ${DEFAULT_MUNICIPALITY.short_name} council records` },
      { property: "og:type", content: "website" },
      { property: "og:url", content: ogUrl("/search") },
      { property: "og:image", content: ogImageUrl(query, { subtitle: "AI-powered council search", type: "search" }) },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:card", content: "summary_large_image" },
    ];
  }
  return [
    { name: "robots", content: "noindex, follow" },
    { title: `Search | ${SITE_NAME}` },
    { name: "description", content: `Search ${DEFAULT_MUNICIPALITY.short_name} council meetings, motions, documents, and transcripts` },
    { property: "og:title", content: `Search | ${SITE_NAME}` },
    { property: "og:description", content: `Search ${DEFAULT_MUNICIPALITY.short_name} council meetings, motions, documents, and transcripts` },
    { property: "og:type", content: "website" },
    { property: "og:url", content: ogUrl("/search") },
    { property: "og:image", content: ogImageUrl("Search", { subtitle: "AI-powered council search", type: "search" }) },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
  ];
};

// ---------------------------------------------------------------------------
// Server loader
// ---------------------------------------------------------------------------

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const id = url.searchParams.get("id") || "";

  const { supabase } = createSupabaseServerClient(request);
  const municipality = await getMunicipality(supabase);
  const councilTerms = await getCouncilTerms(supabase, municipality.id);
  const mode = url.searchParams.get("mode");

  // If there's a cached result ID, fetch it from the API
  if (id && mode !== "keyword") {
    // We return the ID so the client can fetch the cached result
    return { query: q, cachedId: id, intent: "question" as const, results: null, councilTerms };
  }

  // Determine intent from query
  const intent = q ? mode === "keyword" ? "keyword" as const : mode === "ai" ? "question" as const : classifyIntent(q) : null;

  return { query: q, results: null, cachedId: null, intent, councilTerms };
}

// ---------------------------------------------------------------------------
// Example queries for empty state
// ---------------------------------------------------------------------------

const KEYWORD_EXAMPLES = ["bylaw 2299", "curbside garbage", "Goldstream Avenue", "rcmp"];
const QUESTION_EXAMPLES = [
  "What has council decided about housing?",
  "Who voted against the budget?",
  "Why is the city taking over garbage collection?",
];

type QuickMatch = {
  type: "person" | "matter" | "meeting" | "bylaw" | "property";
  id: number;
  title: string;
  subtitle?: string;
  href: string;
  exact: boolean;
};

const MATCH_LABEL: Record<QuickMatch["type"], string> = {
  person: "Person",
  matter: "Matter",
  meeting: "Meeting",
  bylaw: "Bylaw",
  property: "Address",
};

function isTopicChange(newQuery: string, history: { question: string }[]): boolean {
  if (history.length === 0) return false;
  const lastWords = new Set(history[history.length - 1].question.toLowerCase().split(/\s+/).filter((w) => w.length >= 3));
  return newQuery.toLowerCase().split(/\s+/).filter((w) => w.length >= 3).every((w) => !lastWords.has(w));
}

// ---------------------------------------------------------------------------
// Route: remount per query so arriving at /search?q=… from anywhere (⌘K,
// profile pages, links) always runs the new search.
// ---------------------------------------------------------------------------

export default function SearchRoute(props: Route.ComponentProps) {
  const [params] = useSearchParams();
  const key = `${params.get("q") || ""}|${params.get("mode") === "ai" ? "ai" : ""}`;
  return <SearchPage key={key} {...props} />;
}

function SearchPage({ loaderData }: Route.ComponentProps) {
  const revalidator = useRevalidator();
  const { aiSearchAvailable: siteAiAvailable } = useSiteFlags();
  const [budgetExhausted, setBudgetExhausted] = useState(false);
  const aiSearchAvailable = siteAiAvailable && !budgetExhausted;
  const shortName =
    (useRouteLoaderData("root") as { municipality?: { short_name?: string } } | undefined)
      ?.municipality?.short_name || DEFAULT_MUNICIPALITY.short_name;
  const { query: initialQuery, cachedId, councilTerms } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [localQuery, setLocalQuery] = useState(initialQuery || "");
  const activeQuery = initialQuery || "";

  // AI answer state
  const [showAnswer, setShowAnswer] = useState(Boolean(cachedId));
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<any[]>([]);
  const [agentSteps, setAgentSteps] = useState<AgentEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [suggestedFollowups, setSuggestedFollowups] = useState<string[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const conversationRef = useRef<{ question: string; answer: string }[]>([]);
  const [conversation, setConversation] = useState<{ question: string; answer: string; sources: any[] }[]>([]);
  const [followUpQuery, setFollowUpQuery] = useState("");

  // Results state
  const [matches, setMatches] = useState<QuickMatch[]>([]);
  const [searchResults, setSearchResults] = useState<UnifiedSearchResult[]>([]);
  const [isLoadingResults, setIsLoadingResults] = useState(Boolean(initialQuery));
  const keywordRequest = useRef(0);

  useEffect(() => () => eventSourceRef.current?.close(), []);

  useEffect(() => {
    if (!activeQuery) return;
    fetchMatches(activeQuery);
    fetchKeywordResults(activeQuery);
    if (cachedId) fetchCachedResult(cachedId);
    // AI generation starts only when explicitly asked for: the "Ask" link below, or
    // arriving via an Ask entry point (?mode=ai). Never for crawlers or on SSR.
    else if (
      shouldAutoAsk({
        query: activeQuery,
        mode: searchParams.get("mode"),
        cachedId,
        aiSearchAvailable,
        userAgent: typeof navigator === "undefined" ? null : navigator.userAgent,
      })
    ) {
      startAiStream(activeQuery);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  async function fetchMatches(query: string) {
    try {
      const res = await fetch(`/api/quick-search?q=${encodeURIComponent(query)}`);
      if (res.ok) setMatches(((await res.json()) as { matches: QuickMatch[] }).matches || []);
    } catch {
      setMatches([]);
    }
  }

  async function fetchKeywordResults(query: string) {
    setIsLoadingResults(true);
    const requestId = ++keywordRequest.current;
    try {
      const params = new URLSearchParams(searchParams);
      params.set("q", query);
      params.set("mode", "keyword");
      params.delete("id");
      const res = await fetch(`/api/search?${params.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as { results?: UnifiedSearchResult[] };
        if (requestId === keywordRequest.current) setSearchResults(data.results || []);
      }
    } catch (err) {
      console.error("Keyword search error:", err);
    } finally {
      if (requestId === keywordRequest.current) setIsLoadingResults(false);
    }
  }

  async function fetchCachedResult(id: string) {
    try {
      const res = await fetch(`/api/search?id=${encodeURIComponent(id)}`);
      if (!res.ok) {
        setShowAnswer(false);
        return;
      }
      const data = (await res.json()) as { answer?: string; sources?: any[]; suggested_followups?: string[] };
      setAnswer(data.answer || "");
      setSources(data.sources || []);
      setSuggestedFollowups(data.suggested_followups || []);
      setShowAnswer(true);
    } catch (err) {
      console.error("Failed to fetch cached result:", err);
    }
  }

  function buildConversationContext(): string | undefined {
    const recent = conversationRef.current.slice(-5);
    return recent.length ? recent.map((t) => `Q: ${t.question}\nA: ${t.answer}`).join("\n\n") : undefined;
  }

  function startAiStream(query: string, opts: { fresh?: boolean; followUp?: boolean } = {}) {
    eventSourceRef.current?.close();
    setShowAnswer(true);
    setIsStreaming(true);
    setAnswer("");
    setSources([]);
    setAgentSteps([]);
    setCopied(false);
    setSuggestedFollowups([]);
    setCachedAt(null);

    const context = opts.followUp ? buildConversationContext() : undefined;
    const params = new URLSearchParams({ q: query, mode: "ai" });
    if (context) params.set("context", context);
    if (opts.fresh) params.set("fresh", "1");

    let answerCacheId: string | null = null;
    let fullAnswer = "";
    let collectedSources: any[] = [];
    const started = Date.now();
    const eventSource = new EventSource(`/api/search?${params}`);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data) as any;
      switch (data.type) {
        case "thought":
        case "tool_call":
        case "reranking":
          setAgentSteps((prev) => [...prev, data]);
          break;
        case "tool_observation":
          setAgentSteps((prev) => [...prev.slice(0, -1), data]);
          break;
        case "final_answer_chunk":
          fullAnswer += data.chunk;
          setAnswer((prev) => prev + data.chunk);
          break;
        case "sources":
          collectedSources = data.sources || [];
          setSources(collectedSources);
          break;
        case "suggested_followups":
          setSuggestedFollowups(data.followups || []);
          break;
        case "cached":
          setCachedAt(data.created_at);
          break;
        case "budget_exhausted":
          revalidator.revalidate();
          setBudgetExhausted(true);
          setShowAnswer(false);
          break;
        case "cache_id":
          answerCacheId = data.id;
          if (!opts.followUp) {
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.set("id", data.id);
              if (next.get("mode") === "keyword") next.delete("mode");
              return next;
            }, { replace: true, preventScrollReset: true });
          }
          break;
        case "done":
          if (opts.followUp && answerCacheId) {
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.set("q", query);
              next.set("id", answerCacheId!);
              next.delete("mode");
              return next;
            }, { replace: true, preventScrollReset: true });
          }
          setIsStreaming(false);
          trackEvent("ai answer completed", {
            query,
            duration_ms: Date.now() - started,
            source_count: collectedSources.length,
            conversation_turn: conversationRef.current.length + 1,
          });
          conversationRef.current = [...conversationRef.current, { question: query, answer: fullAnswer }].slice(-5);
          eventSource.close();
          eventSourceRef.current = null;
          break;
      }
    };
    eventSource.onerror = () => {
      setIsStreaming(false);
      eventSource.close();
      eventSourceRef.current = null;
    };
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function handleSubmit(query: string) {
    const q = query.trim();
    if (q.length < 2) return;
    // An exact jump-to match wins: "bylaw 2299", a councillor's name, a meeting date.
    // Questions always get the search page.
    if (classifyIntent(q) !== "question") {
      let candidates = q === activeQuery ? matches : [];
      if (q !== activeQuery) {
        try {
          const res = await fetch(`/api/quick-search?q=${encodeURIComponent(q)}`);
          if (res.ok) candidates = ((await res.json()) as { matches: QuickMatch[] }).matches || [];
        } catch {
          candidates = [];
        }
      }
      const exact = candidates[0]?.exact ? candidates[0] : undefined;
      if (exact) {
        trackEvent("search jumped", { query: q, type: exact.type });
        navigate(exact.href);
        return;
      }
    }
    trackEvent("search submitted", { query: q, intent: classifyIntent(q) });
    const next = new URLSearchParams(searchParams);
    next.set("q", q);
    next.delete("id");
    next.delete("mode");
    navigate(`/search?${next}`);
  }

  function askFollowUp(q: string) {
    if (q.length < 2 || isStreaming) return;
    if (isTopicChange(q, conversationRef.current)) {
      conversationRef.current = [];
      setConversation([]);
    } else if (answer) {
      setConversation((prev) => [...prev, { question: activeAnswerQuestion.current, answer, sources }]);
    }
    activeAnswerQuestion.current = q;
    startAiStream(q, { followUp: conversationRef.current.length > 0 });
  }
  const activeAnswerQuestion = useRef(activeQuery);

  async function handleCopy() {
    await navigator.clipboard.writeText(answer);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Filters (URL-driven) re-run results only.
  const filters = parseSearchFilters(searchParams);
  const filterSignature = `${filters.time}|${filters.types.join(",")}|${filters.sort}|${searchParams.get("term") || ""}`;
  const prevFilterSignature = useRef(filterSignature);
  useEffect(() => {
    if (prevFilterSignature.current !== filterSignature) {
      prevFilterSignature.current = filterSignature;
      if (activeQuery) fetchKeywordResults(activeQuery);
    }
  }, [filterSignature]);

  function setParam(key: string, values: string[] | string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(key);
      for (const v of Array.isArray(values) ? values : [values]) if (v) next.append(key, v);
      next.delete("id");
      return next;
    }, { replace: true, preventScrollReset: true });
  }

  const hasQuery = activeQuery.length > 0;
  const topMatches = matches.slice(0, 4);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!hasQuery) {
    return (
      <div className="min-h-screen bg-zinc-50">
        <div className="container mx-auto max-w-3xl px-4 py-20 text-center">
          <h1 className="mb-3 text-4xl font-extrabold tracking-tight text-zinc-900">
            Search {shortName} council records
          </h1>
          <p className="mx-auto mb-8 max-w-lg text-zinc-500">
            Jump to a councillor, matter, bylaw or meeting, search everything, or ask a question.
          </p>
          <div className="mx-auto mb-10 max-w-2xl">
            <SearchInput query={localQuery} onChange={setLocalQuery} onSubmit={handleSubmit} isStreaming={false} />
          </div>
          <div className="mx-auto max-w-xl space-y-4">
            {aiSearchAvailable && <div>
              <p className="mb-2 text-sm font-medium text-zinc-500">Ask a question</p>
              <div className="flex flex-wrap justify-center gap-2">
                {QUESTION_EXAMPLES.map((q) => (
                  <button key={q} onClick={() => navigate(askUrl(q))} className="rounded-full bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 transition-colors hover:bg-brand-100">
                    {q}
                  </button>
                ))}
              </div>
            </div>}
            <div>
              <p className="mb-2 text-sm font-medium text-zinc-500">Search records</p>
              <div className="flex flex-wrap justify-center gap-2">
                {KEYWORD_EXAMPLES.map((q) => (
                  <button key={q} onClick={() => handleSubmit(q)} className="rounded-full bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-200">
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <h1 className="sr-only">Results for {activeQuery}</h1>
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <SearchInput query={localQuery} onChange={setLocalQuery} onSubmit={handleSubmit} isStreaming={isStreaming} placeholder="Search or ask a question..." />
          </div>
          <button
            onClick={() => navigate("/search")}
            className="h-14 shrink-0 rounded-xl border border-zinc-200 bg-surface px-3 text-xs font-medium text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-700"
            title="Start a new search"
            aria-label="Start a new search"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Best matches: direct jumps */}
        {topMatches.length > 0 && (
          <section className="mt-5" aria-label="Best matches">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Best matches</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {topMatches.map((m) => (
                <li key={`${m.type}-${m.id}`}>
                  <Link
                    to={m.href}
                    className={`flex h-full items-start justify-between gap-3 rounded-xl border bg-surface px-4 py-3 transition-colors hover:border-brand-300 ${m.exact ? "border-brand-300 ring-1 ring-brand-100" : "border-zinc-200"}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-zinc-900">{m.title}</span>
                      {m.subtitle && <span className="block truncate text-xs text-zinc-500">{m.subtitle}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-zinc-400">{MATCH_LABEL[m.type]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* AI answer: only for questions, or when asked for */}
        {showAnswer ? (
          <section className="mt-6" aria-label="Answer">
            {conversation.map((turn, i) => (
              <div key={i} className="mb-4 rounded-2xl border border-zinc-200 bg-surface/70 p-5 text-sm text-zinc-600">
                <p className="mb-1 font-semibold text-zinc-900">{turn.question}</p>
                <p className="line-clamp-3">{turn.answer}</p>
              </div>
            ))}
            {conversation.length > 0 && <p className="mb-2 font-semibold text-zinc-900">{activeAnswerQuestion.current}</p>}
            <AiAnswer
              answer={answer}
              sources={sources}
              agentSteps={agentSteps}
              isStreaming={isStreaming}
              sourceCount={sources.length}
              onCopy={handleCopy}
              copied={copied}
              cachedAt={cachedAt}
              onRefresh={aiSearchAvailable ? () => startAiStream(activeAnswerQuestion.current, { fresh: true }) : undefined}
            />
            {aiSearchAvailable && !isStreaming && suggestedFollowups.length > 0 && (
              <FollowUp suggestions={suggestedFollowups} onSelect={(q) => askFollowUp(q)} disabled={isStreaming} />
            )}
            {aiSearchAvailable && answer && !isStreaming && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const q = followUpQuery.trim();
                  setFollowUpQuery("");
                  askFollowUp(q);
                }}
                className="relative mt-4"
              >
                <Input
                  value={followUpQuery}
                  onChange={(e) => setFollowUpQuery(e.target.value)}
                  placeholder="Ask a follow-up..."
                  className="h-12 rounded-2xl border-zinc-200 bg-surface pl-5 pr-12 text-base shadow-sm"
                />
                <Button type="submit" disabled={!followUpQuery.trim()} size="icon" aria-label="Ask" className="absolute right-2 top-1/2 h-8 w-8 -translate-y-1/2 rounded-full">
                  <Send className="h-4 w-4" />
                </Button>
              </form>
            )}
          </section>
        ) : aiSearchAvailable ? (
          <p className="mt-5 text-sm text-zinc-500">
            Looking for an explanation?{" "}
            <button onClick={() => startAiStream(activeQuery)} className="font-medium text-brand-700 hover:underline">
              Ask a question about “{activeQuery}”
            </button>
          </p>
        ) : null}

        {/* Results */}
        <section className="mt-8" aria-label="Results">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {isLoadingResults ? "Searching records…" : `${searchResults.length} ${searchResults.length === 1 ? "record" : "records"}`}
            </p>
            <NativeSelect
              id="keyword-council-term"
              aria-label="Council term"
              className="w-full sm:w-56"
              value={searchParams.get("term") || ""}
              onChange={(event) => setParam("term", event.target.value)}
            >
              <option value="">All council terms</option>
              {councilTerms.map((term) => <option key={term.id} value={term.id}>{term.name}</option>)}
            </NativeSelect>
          </div>
          <SearchFilters
            time={filters.time}
            types={filters.types}
            sort={filters.sort}
            onTimeChange={(v) => setParam("time", v)}
            onTypesChange={(types: ContentType[]) => setParam("type", types)}
            onSortChange={(v) => setParam("sort", v)}
            results={searchResults}
          />
          <SearchResults results={searchResults} query={activeQuery} isLoading={isLoadingResults} activeTypes={filters.types} />
        </section>
      </div>
    </div>
  );
}
