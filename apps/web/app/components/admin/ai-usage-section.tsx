import { useState } from "react";
import type {
  AiUsageDashboard,
  AiUsageWindow,
} from "../../services/ai-usage";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ButtonGroup } from "../ui/button-group";
import { cn, formatRelativeTime } from "../../lib/utils";

const card = "rounded-2xl border border-zinc-200 bg-white shadow-sm";

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return n.toLocaleString();
}

function formatCost(usd: number | null, partial = false) {
  if (usd == null) return "—";
  const text = usd < 0.01 && usd > 0 ? "<$0.01" : `$${usd.toFixed(2)}`;
  return partial ? `${text}+` : text;
}

function formatMs(ms: number | null) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function UsageTable({ window }: { window: AiUsageWindow }) {
  if (window.stages.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-5 text-sm text-zinc-500">
        No model calls recorded in the last {window.days} days.
      </div>
    );
  }
  return (
    <div className={cn(card, "overflow-hidden")}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-100 bg-zinc-50/60 text-left text-xs text-zinc-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Stage</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Calls</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Failures</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Tokens in / out</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Est. cost</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">p50</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">p95</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 tabular-nums">
            {window.stages.map((s) => (
              <tr key={`${s.source}:${s.stage}`}>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-zinc-900">{s.stage}</span>
                    <Badge variant={s.source === "web" ? "brand" : "muted"}>{s.source}</Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">{s.models.join(", ")}</div>
                </td>
                <td className="px-4 py-2.5 text-right text-zinc-700">{s.calls.toLocaleString()}</td>
                <td
                  className={cn(
                    "px-4 py-2.5 text-right",
                    s.failures > 0 ? "font-medium text-red-700" : "text-zinc-500",
                  )}
                >
                  {s.failures.toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-right text-zinc-700">
                  {formatTokens(s.inputTokens)} / {formatTokens(s.outputTokens)}
                </td>
                <td className="px-4 py-2.5 text-right text-zinc-900">
                  {formatCost(s.costUsd, s.costPartial)}
                </td>
                <td className="px-4 py-2.5 text-right text-zinc-600">{formatMs(s.p50Ms)}</td>
                <td className="px-4 py-2.5 text-right text-zinc-600">{formatMs(s.p95Ms)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-zinc-200 bg-zinc-50/60 tabular-nums">
            <tr>
              <td className="px-4 py-2 text-xs font-medium text-zinc-500">Total</td>
              <td className="px-4 py-2 text-right font-medium text-zinc-900">
                {window.totals.calls.toLocaleString()}
              </td>
              <td className="px-4 py-2 text-right font-medium text-zinc-900">
                {window.totals.failures.toLocaleString()}
              </td>
              <td className="px-4 py-2 text-right font-medium text-zinc-900">
                {formatTokens(window.totals.inputTokens)} / {formatTokens(window.totals.outputTokens)}
              </td>
              <td className="px-4 py-2 text-right font-medium text-zinc-900">
                {formatCost(window.totals.costUsd)}
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

export function AiUsageSection({ usage }: { usage: AiUsageDashboard }) {
  const [days, setDays] = useState(usage.windows[0]?.days ?? 7);
  const window = usage.windows.find((w) => w.days === days) ?? usage.windows[0];

  return (
    <section aria-labelledby="ai-usage-heading" className="mt-10">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 id="ai-usage-heading" className="text-lg font-semibold text-zinc-900">
            AI usage
          </h2>
          <p className="text-sm text-zinc-500">
            Model calls from the pipeline and the web app. Cost is an estimate from list prices.
          </p>
        </div>
        {usage.available && usage.windows.length > 1 && (
          <ButtonGroup aria-label="Usage window">
            {usage.windows.map((w) => (
              <Button
                key={w.days}
                type="button"
                size="sm"
                variant={w.days === days ? "default" : "outline"}
                aria-pressed={w.days === days}
                onClick={() => setDays(w.days)}
              >
                {w.days} days
              </Button>
            ))}
          </ButtonGroup>
        )}
      </div>

      {!usage.available ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-5 text-sm text-zinc-500">
          AI usage isn't available{usage.error ? `: ${usage.error}` : "."}
        </div>
      ) : (
        <>
          {window && <UsageTable window={window} />}

          {usage.failures.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">No failed model calls recorded.</p>
          ) : (
            <>
              <h3 className="mb-3 mt-8 text-base font-semibold text-zinc-900">Recent failures</h3>
              <ul className={cn(card, "divide-y divide-zinc-100")}>
                {usage.failures.map((f) => (
                  <li key={f.id} className="px-4 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-zinc-900">{f.stage}</span>
                      <Badge variant={f.source === "web" ? "brand" : "muted"}>{f.source}</Badge>
                      {f.job && <span className="text-xs text-zinc-500">{f.job}</span>}
                      {f.meeting_id != null && (
                        <span className="text-xs tabular-nums text-zinc-500">meeting {f.meeting_id}</span>
                      )}
                      <span className="ml-auto text-xs text-zinc-500">
                        {formatRelativeTime(f.created_at)}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-3 break-words font-mono text-xs text-red-700">
                      {f.error || "Unknown error"}
                    </p>
                    <div className="mt-0.5 text-xs text-zinc-400">{f.model}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
