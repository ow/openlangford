import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hourlyIncrease, parseServerMetrics } from "../../app/lib/server-metrics";
import { recordServerMetrics } from "../../workers/server-metrics";

const text = readFileSync(new URL("../fixtures/supabase-metrics.txt", import.meta.url), "utf8");

describe("parseServerMetrics", () => {
  it("reads memory, swap, disks, stalls, CPU, database size and connections from a real snapshot", () => {
    const s = parseServerMetrics(text);
    expect(s.mem_total_bytes).toBe(948191232);
    expect(s.mem_available_bytes).toBe(294617088);
    expect(s.swap_total_bytes! - s.swap_free_bytes!).toBe(528961536);
    expect(s.swap_in_pages).toBe(11131804);
    expect(s.root_read_bytes).toBe(374162022400);
    expect(s.data_read_bytes).toBe(49003439104);
    expect(s.io_stalled_seconds).toBeCloseTo(4956.83, 1);
    expect(s.database_bytes).toBe(830262419);
    expect(s.connections).toBe(11);
    expect(s.cpu_busy_seconds!).toBeLessThan(s.cpu_total_seconds!);
  });
});

describe("hourlyIncrease", () => {
  it("sums a counter's growth per hour and skips a reset", () => {
    const rows = [
      { sampled_at: "2026-11-04T05:00:00Z", swap_in_pages: 100 },
      { sampled_at: "2026-11-04T05:05:00Z", swap_in_pages: 150 },
      { sampled_at: "2026-11-04T05:10:00Z", swap_in_pages: 200 },
      { sampled_at: "2026-11-04T06:00:00Z", swap_in_pages: 20 }, // rebooted
      { sampled_at: "2026-11-04T06:05:00Z", swap_in_pages: 30 },
    ] as any;
    expect(hourlyIncrease(rows, "swap_in_pages")).toEqual([
      { day: "2026-11-04T05:00:00Z", value: 100 },
      { day: "2026-11-04T06:00:00Z", value: 10 },
    ]);
  });
});

describe("recordServerMetrics", () => {
  it("stores one parsed reading and trims old ones", async () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "secret");
    const insert = vi.fn(async () => ({ error: null }));
    const lt = vi.fn(async () => ({ error: null }));
    const supabase = { from: vi.fn(() => ({ insert, delete: () => ({ lt }) })) } as any;
    const fetcher = vi.fn(async () => new Response(text));
    expect(await recordServerMetrics(supabase, fetcher as any)).toEqual({ recorded: true });
    const [url, init] = fetcher.mock.calls[0] as any;
    expect(url).toBe("https://example.supabase.co/customer/v1/privileged/metrics");
    expect(init.headers.Authorization).toBe(`Basic ${btoa("service_role:secret")}`);
    expect((insert.mock.calls[0] as any)[0].database_bytes).toBe(830262419);
    expect(lt).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
