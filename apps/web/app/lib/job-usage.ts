import { estimateCostUsd } from "../services/ai/pricing";

/** Rows of the ai_usage_by_job view: one per (job, stage, model, operation). */
export type JobUsageRow = {
  pipeline_job_id: number;
  stage: string;
  model: string;
  operation: string | null;
  calls: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
};

export type JobUsage = {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated from token counts and pricing.ts; null when no model in the job has a price. */
  costUsd: number | null;
  /** True when some calls used a model without a price, so the cost is a lower bound. */
  partialCost: boolean;
  byStage: { stage: string; calls: number; tokens: number; costUsd: number | null }[];
};

export function summarizeJobUsage(rows: JobUsageRow[]): JobUsage | null {
  if (!rows.length) return null;
  let cost = 0;
  let priced = false;
  let partialCost = false;
  const stages = new Map<string, { stage: string; calls: number; tokens: number; costUsd: number | null }>();
  for (const row of rows) {
    const rowCost = estimateCostUsd(row.model, row.operation, Number(row.input_tokens), Number(row.output_tokens));
    if (rowCost == null) partialCost = true;
    else {
      cost += rowCost;
      priced = true;
    }
    const stage = stages.get(row.stage) || { stage: row.stage, calls: 0, tokens: 0, costUsd: null };
    stage.calls += row.calls;
    stage.tokens += Number(row.input_tokens) + Number(row.output_tokens);
    if (rowCost != null) stage.costUsd = (stage.costUsd ?? 0) + rowCost;
    stages.set(row.stage, stage);
  }
  return {
    calls: rows.reduce((n, r) => n + r.calls, 0),
    failed: rows.reduce((n, r) => n + r.failed, 0),
    inputTokens: rows.reduce((n, r) => n + Number(r.input_tokens), 0),
    outputTokens: rows.reduce((n, r) => n + Number(r.output_tokens), 0),
    costUsd: priced ? cost : null,
    partialCost: partialCost && priced,
    byStage: [...stages.values()].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.tokens - a.tokens),
  };
}

/** "≈$0.42", "<$0.01", "≈$12" */
export function formatCost(usd: number | null) {
  if (usd == null) return "—";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `≈$${usd >= 10 ? usd.toFixed(0) : usd.toFixed(2)}`;
}

/** "830 tokens", "12.4K tokens", "1.2M tokens" */
export function formatTokens(n: number) {
  const value = n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
  return `${value} tokens`;
}
