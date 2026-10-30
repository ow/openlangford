import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import {
  Loader2,
  Check,
  Search,
  ChevronDown,
  Copy,
} from "lucide-react";
import { cn } from "../../lib/utils";
import type { AgentEvent } from "../../services/rag.server";
import { processCitationsInChildren } from "./citation-badge";
import { SourceCards } from "./source-cards";

// ---------------------------------------------------------------------------
// Human-friendly labels for tool calls (migrated from ask.tsx)
// ---------------------------------------------------------------------------

const TOOL_LABELS: Record<string, string> = {
  search_council_records: "Searching council records",
  search_documents: "Searching documents",
  search_matters: "Looking up council matters",
  get_person_info: "Looking up person info",
};

function getToolLabel(name: string, args?: any): string {
  if (name === "get_person_info" && args?.person_name) {
    return `Looking up ${args.person_name}'s info`;
  }
  return TOOL_LABELS[name] || name;
}

function getObservationSummary(result: any): string {
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed)) return `Found ${parsed.length} results`;
      if (parsed.total !== undefined) return `Found ${parsed.total} records`;
      if (typeof parsed === "string" && parsed.length < 200) return parsed;
      return "Retrieved data";
    } catch {
      if (result.length < 200) return result;
      return "Retrieved data";
    }
  }
  if (Array.isArray(result)) return `Found ${result.length} results`;
  if (result?.total !== undefined) return `Found ${result.total} records`;
  return "Retrieved data";
}

// ---------------------------------------------------------------------------
// ResearchStep
// ---------------------------------------------------------------------------

function ResearchStep({ event }: { event: AgentEvent }) {
  if (event.type === "thought") {
    return (
      <div className="py-1 pl-6 text-sm text-zinc-400 italic leading-relaxed">
        {(event as any).thought}
      </div>
    );
  }
  if (event.type === "tool_call") {
    return (
      <div className="flex items-center gap-2.5 py-1.5 text-sm text-zinc-500">
        <Loader2 className="h-3.5 w-3.5 text-brand-500 animate-spin shrink-0" />
        <span>{getToolLabel(event.name, event.args)}...</span>
      </div>
    );
  }
  if (event.type === "tool_observation") {
    return (
      <div className="flex items-center gap-2.5 py-1.5 text-sm text-zinc-400">
        <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
        <span>
          {getToolLabel(event.name)} &mdash;{" "}
          {getObservationSummary(event.result)}
        </span>
      </div>
    );
  }
  if (event.type === "reranking") {
    return (
      <div className="flex items-center gap-2.5 py-1.5 text-sm text-zinc-400">
        <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
        <span>
          Ranked {(event as any).candidates} sources &rarr;{" "}
          {(event as any).selected} most relevant
        </span>
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Confidence indicator
// ---------------------------------------------------------------------------

function SourceBasis({ sources }: { sources: any[] }) {
  const meetings = new Set(sources.map((s) => s.meeting_id).filter(Boolean));
  if (sources.length === 0) return <span className="text-xs text-zinc-500">No sources found</span>;
  return (
    <span className="text-xs text-zinc-500">
      Based on {sources.length} {sources.length === 1 ? "source" : "sources"}
      {meetings.size > 0 && (
        <>
          {" "}from {meetings.size} {meetings.size === 1 ? "meeting" : "meetings"}
        </>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// AiAnswer main component
// ---------------------------------------------------------------------------

interface AiAnswerProps {
  answer: string;
  sources: any[];
  agentSteps: AgentEvent[];
  isStreaming: boolean;
  sourceCount: number;
  onCopy: () => void;
  copied: boolean;
  /** Set when the answer was reused from the cache. */
  cachedAt?: string | null;
  onRefresh?: () => void;
}

export function AiAnswer({
  answer,
  sources,
  agentSteps,
  isStreaming,
  sourceCount,
  onCopy,
  copied,
  cachedAt,
  onRefresh,
}: AiAnswerProps) {
  const [stepsOpen, setStepsOpen] = useState(true);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  // Reset sourcesOpen when a new answer starts streaming
  useEffect(() => {
    if (isStreaming) {
      setSourcesOpen(false);
    }
  }, [isStreaming]);

  const isResearching = isStreaming && !answer;
  const stepCount = agentSteps.filter((s) => s.type === "tool_call").length;

  // Auto-collapse steps once answer starts streaming
  const hasAnswer = answer.length > 0;

  // Custom ReactMarkdown components with inline citations
  const markdownComponents = useMemo<Components>(
    () => ({
      p: ({ children }) => (
        <p>{processCitationsInChildren(children, sources)}</p>
      ),
      li: ({ children }) => (
        <li>{processCitationsInChildren(children, sources)}</li>
      ),
    }),
    [sources],
  );

  return (
    <div className="space-y-4">
      {/* Research Steps -- collapsible */}
      {agentSteps.length > 0 && (
        <div>
          <button
            onClick={() => setStepsOpen(!stepsOpen)}
            className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-600 transition-colors mb-1"
          >
            <Search className="h-3.5 w-3.5" />
            <span>
              Research{stepCount > 0 ? ` (${stepCount} steps)` : ""}
            </span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-200",
                stepsOpen && !hasAnswer && "rotate-180",
                !stepsOpen && "rotate-0",
                stepsOpen && hasAnswer && "rotate-180",
              )}
            />
          </button>
          <div
            className={cn(
              "grid transition-all duration-200 ease-in-out",
              stepsOpen && !hasAnswer
                ? "grid-rows-[1fr]"
                : hasAnswer
                  ? "grid-rows-[0fr]"
                  : "grid-rows-[0fr]",
            )}
          >
            <div className="overflow-hidden">
              <div className="pl-1 border-l-2 border-zinc-200 ml-1.5">
                {agentSteps.map((step, i) => (
                  <ResearchStep key={i} event={step} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Researching indicator */}
      {isResearching && agentSteps.length === 0 && (
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin text-brand-500" />
          <span>Starting research...</span>
        </div>
      )}

      {/* Answer card */}
      <div
        className={cn(
          "p-6 bg-surface border rounded-2xl shadow-sm transition-all duration-300",
          isStreaming && answer
            ? "border-brand-200 ring-1 ring-brand-100"
            : "border-zinc-200",
        )}
      >
        <div>
          <div className="min-w-0">
            <div className="prose prose-base prose-zinc prose-blue max-w-none prose-a:text-brand-600 prose-a:no-underline hover:prose-a:underline">
              <ReactMarkdown components={markdownComponents}>
                {answer}
              </ReactMarkdown>
            </div>
            {isResearching && (
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Researching your question...</span>
              </div>
            )}
          </div>
        </div>

        {/* Confidence + copy actions after streaming completes */}
        {answer && !isStreaming && (
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-zinc-100">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <SourceBasis sources={sources} />
              {cachedAt && (
                <span className="text-xs text-zinc-400">
                  · Saved answer from{" "}
                  {new Date(cachedAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}
                  {onRefresh && (
                    <>
                      {" "}·{" "}
                      <button onClick={onRefresh} className="font-medium text-brand-700 hover:underline">
                        Get a fresh answer
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={onCopy}
                className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-green-500" />
                    <span className="text-green-600">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>Copy answer</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Source cards below answer */}
      {sources.length > 0 && !isStreaming && (
        <SourceCards
          sources={sources}
          isOpen={sourcesOpen}
          onToggle={() => setSourcesOpen(!sourcesOpen)}
        />
      )}
    </div>
  );
}
