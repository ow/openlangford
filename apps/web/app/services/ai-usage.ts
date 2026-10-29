/**
 * AI usage rollups for the admin page: shapes ai_usage_summary() rows and
 * prices them (services/ai/pricing.ts). Client-safe; the query lives in
 * ai-usage-admin.server.ts.
 */
import { estimateCostUsd } from "./ai/pricing";

/** One row of `ai_usage_summary(since)` (supabase/migrations/20261019163911_47_11_ai_usage.sql). */
export interface AiUsageSummaryRow {
  source: string;
  stage: string;
  calls: number;
  failures: number;
  input_tokens: number;
  output_tokens: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  by_model: Array<{
    model: string;
    operation: string | null;
    calls: number;
    input_tokens: number;
    output_tokens: number;
  }> | null;
}

export interface AiUsageStageStats {
  source: string;
  stage: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Estimated USD over priced models; null when nothing could be priced. */
  costUsd: number | null;
  /** Some tokens came from a model with no price, so costUsd is a lower bound. */
  costPartial: boolean;
  models: string[];
}

export interface AiUsageWindow {
  days: number;
  stages: AiUsageStageStats[];
  totals: { calls: number; failures: number; inputTokens: number; outputTokens: number; costUsd: number };
}

export interface AiUsageFailure {
  id: number;
  created_at: string;
  source: string;
  stage: string;
  model: string;
  job: string | null;
  meeting_id: number | null;
  error: string | null;
}

export interface AiUsageDashboard {
  available: boolean;
  error?: string;
  windows: AiUsageWindow[];
  failures: AiUsageFailure[];
}

const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

export function summarizeUsage(days: number, rows: AiUsageSummaryRow[]): AiUsageWindow {
  const stages = rows.map((row): AiUsageStageStats => {
    let cost = 0;
    let priced = false;
    let partial = false;
    for (const m of row.by_model ?? []) {
      const c = estimateCostUsd(m.model, m.operation, num(m.input_tokens), num(m.output_tokens));
      if (c == null) {
        if (num(m.input_tokens) + num(m.output_tokens) > 0) partial = true;
      } else {
        cost += c;
        priced = true;
      }
    }
    return {
      source: row.source,
      stage: row.stage,
      calls: num(row.calls),
      failures: num(row.failures),
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      p50Ms: numOrNull(row.p50_latency_ms),
      p95Ms: numOrNull(row.p95_latency_ms),
      costUsd: priced ? cost : null,
      costPartial: partial,
      models: [...new Set((row.by_model ?? []).map((m) => m.model))].sort(),
    };
  });
  stages.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.calls - a.calls);
  const totals = stages.reduce(
    (t, s) => ({
      calls: t.calls + s.calls,
      failures: t.failures + s.failures,
      inputTokens: t.inputTokens + s.inputTokens,
      outputTokens: t.outputTokens + s.outputTokens,
      costUsd: t.costUsd + (s.costUsd ?? 0),
    }),
    { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
  return { days, stages, totals };
}
