import { describe, expect, it } from "vitest";
import { formatCost, formatTokens, summarizeJobUsage } from "../job-usage";

const row = (stage: string, model: string, operation: string, input: number, output: number, calls = 1) => ({
  pipeline_job_id: 7, stage, model, operation, calls, failed: 0, input_tokens: input, output_tokens: output,
});

describe("summarizeJobUsage", () => {
  it("totals tokens and estimates cost per stage", () => {
    const usage = summarizeJobUsage([
      row("extraction", "gpt-6-luna", "json", 1_000_000, 200_000, 3),
      row("decisions", "gpt-6-luna", "decide", 2_000_000, 0, 10),
    ])!;
    expect(usage.calls).toBe(13);
    expect(usage.inputTokens).toBe(3_000_000);
    // 1M in × $0.10 + 0.2M out × $0.50 = $0.20; decisions bill input only: 2M × $0.10 = $0.20
    expect(usage.costUsd).toBeCloseTo(0.4);
    expect(usage.partialCost).toBe(false);
    expect(usage.byStage.map((s) => s.stage)).toEqual(["decisions", "extraction"]); // equal cost; more tokens first
  });

  it("flags a lower bound when a model has no price, and returns null for no usage", () => {
    const usage = summarizeJobUsage([row("x", "gpt-6-luna", "text", 1000, 0), row("y", "unknown-model", "text", 1000, 0)])!;
    expect(usage.partialCost).toBe(true);
    expect(summarizeJobUsage([])).toBeNull();
  });

  it("formats", () => {
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0.4)).toBe("≈$0.40");
    expect(formatCost(null)).toBe("—");
    expect(formatTokens(1_234_567)).toBe("1.2M tokens");
  });
});
