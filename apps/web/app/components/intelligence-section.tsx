import { useState, useEffect } from "react";
import { useFetcher, useRouteLoaderData } from "react-router";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";

interface IntelligenceSectionProps {
  itemId: number;
  initialIntelligence?: any;
  resolveSpeakerName: (seg: { speaker_name?: string | null }) => string;
}

function ArgumentList({
  title,
  tone,
  items,
  resolveSpeakerName,
}: {
  title: string;
  tone: "pro" | "con";
  items: any[];
  resolveSpeakerName: IntelligenceSectionProps["resolveSpeakerName"];
}) {
  return (
    <div>
      <h5 className="mb-2 text-sm font-semibold text-zinc-900">{title}</h5>
      {items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((arg: any, idx: number) => (
            <li
              key={idx}
              className={cn(
                "border-l-2 pl-3 text-sm leading-relaxed text-zinc-700",
                tone === "pro" ? "border-emerald-300" : "border-amber-300",
              )}
            >
              {arg.point}
              {arg.speaker && (
                <span className="block text-xs text-zinc-500">
                  {resolveSpeakerName({ speaker_name: arg.speaker })}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-500">None noted.</p>
      )}
    </div>
  );
}

/**
 * On-demand AI analysis of an agenda item's discussion (arguments,
 * questions, tone). Generated via /api/intel/:id and cached on the item.
 */
export function IntelligenceSection({
  itemId,
  initialIntelligence,
  resolveSpeakerName,
}: IntelligenceSectionProps) {
  const fetcher = useFetcher();
  // Per-request root loader data (never in the public data cache). Generation is admin-only.
  const isAdmin = !!(useRouteLoaderData("root") as { isAdmin?: boolean } | undefined)?.isAdmin;
  const [intelligence, setIntelligence] = useState(initialIntelligence);
  const [isExpanded, setIsExpanded] = useState(false);

  const loading = fetcher.state !== "idle";
  const error = (fetcher.data as any)?.error;

  useEffect(() => {
    const data = fetcher.data as any;
    if (data?.intelligence) {
      setIntelligence(data.intelligence);
      setIsExpanded(true);
    }
  }, [fetcher.data]);

  const generateIntelligence = () => {
    fetcher.submit({}, { method: "post", action: `/api/intel/${itemId}` });
  };

  const args: any[] = intelligence?.arguments || [];
  const questions: any[] = intelligence?.questions || [];
  const score: number | undefined = intelligence?.sentiment_score;

  return (
    <div>
      {!intelligence && !isAdmin ? null : !intelligence ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={generateIntelligence}
            disabled={loading}
            className="rounded-full border border-zinc-200 bg-surface px-3 py-1 text-sm font-medium text-zinc-700 transition-colors hover:border-brand-300 hover:text-brand-700 disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? "Analyzing discussion…" : "Analyze the discussion"}
          </button>
          {!loading && (
            <span className="text-xs text-zinc-500">
              AI summary of arguments, questions and tone
            </span>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
          className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:text-brand-800"
        >
          {isExpanded ? "Hide discussion analysis" : "Show discussion analysis"}
          <ChevronDown className={cn("h-4 w-4 transition-transform", isExpanded && "rotate-180")} />
        </button>
      )}

      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}

      {isExpanded && intelligence && (
        <div className="mt-4 space-y-5 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4">
          {intelligence.detailed_analysis && (
            <div>
              <h5 className="mb-1 text-sm font-semibold text-zinc-900">Analysis</h5>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-700">
                {intelligence.detailed_analysis}
              </p>
            </div>
          )}

          {args.length > 0 && (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <ArgumentList
                title="Supporting points"
                tone="pro"
                items={args.filter((a) => a.side === "Pro")}
                resolveSpeakerName={resolveSpeakerName}
              />
              <ArgumentList
                title="Concerns raised"
                tone="con"
                items={args.filter((a) => a.side === "Con")}
                resolveSpeakerName={resolveSpeakerName}
              />
            </div>
          )}

          {questions.length > 0 && (
            <div>
              <h5 className="mb-2 text-sm font-semibold text-zinc-900">Questions asked</h5>
              <ul className="divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 bg-surface">
                {questions.map((q: any, idx: number) => (
                  <li key={idx} className="px-3 py-2.5 text-sm">
                    <p className="font-medium text-zinc-900">{q.question}</p>
                    <p className="text-xs text-zinc-500">
                      Asked by {resolveSpeakerName({ speaker_name: q.asked_by })}
                    </p>
                    {q.answer && q.answer !== "N/A" && (
                      <p className="mt-1.5 leading-relaxed text-zinc-700">
                        {q.answer}
                        {q.answered_by && (
                          <span className="block text-xs text-zinc-500">
                            Answered by {resolveSpeakerName({ speaker_name: q.answered_by })}
                          </span>
                        )}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {score !== undefined && score !== null && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-zinc-500">Tone</span>
              <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200">
                <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-300" />
                <div
                  className={cn(
                    "absolute inset-y-0",
                    score > 0 ? "bg-emerald-500" : score < 0 ? "bg-red-500" : "bg-zinc-400",
                  )}
                  style={{
                    left: score >= 0 ? "50%" : `${50 - Math.abs(score) * 50}%`,
                    width: `${Math.max(Math.abs(score) * 50, 1)}%`,
                  }}
                />
              </div>
              <span className="font-medium text-zinc-700">
                {score > 0.2 ? "Positive" : score < -0.2 ? "Critical" : "Neutral"}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
