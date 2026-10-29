import { describe, expect, it, vi } from "vitest";
import {
  MAX_ENQUEUE_CALLS_PER_RUN,
  candidateWindow,
  classifyResponse,
  enqueueEnabled,
  enqueueMeetingEmails,
  isCandidate,
  type CandidateMeeting,
  type Receipt,
} from "../../workers/email-enqueue";

const NOW = new Date("2026-11-10T18:00:00Z");
const KEY = "synthetic-runtime-only-key-000000000";
const ENV = {
  EMAIL_ALERT_DISPATCH_ENABLED: "true",
  ALERT_WORKER_KEY: KEY,
  EMAIL_ALERT_START_DATE: "2026-11-01",
  VITE_SUPABASE_URL: "https://project.supabase.co",
};

function meeting(id: number, over: Partial<CandidateMeeting> = {}): CandidateMeeting {
  return {
    id,
    meeting_date: "2026-11-09",
    status: "Completed",
    has_minutes: false,
    has_transcript: true,
    updated_at: "2026-11-09T12:00:00Z",
    municipalities: { slug: "langford" },
    ...over,
  };
}

/** Minimal chainable fake of the Supabase client. */
function fakeDb(opts: {
  meetings?: CandidateMeeting[];
  receipts?: Receipt[] | "missing";
  meetingsError?: boolean;
}) {
  const saved: Receipt[] = [];
  const filters: Array<[string, ...unknown[]]> = [];
  const db = {
    saved,
    filters,
    from(table: string) {
      const chain: any = {};
      for (const m of ["select", "eq", "in", "or", "gte", "lte", "order", "limit"])
        chain[m] = (...args: unknown[]) => {
          if (table === "meetings") filters.push([m, ...args]);
          return chain;
        };
      chain.upsert = async (row: Receipt) => {
        saved.push(row);
        return { error: null };
      };
      chain.then = (resolve: (v: unknown) => void) => {
        if (table === "meetings")
          return resolve(opts.meetingsError ? { data: null, error: { message: "x" } } : { data: opts.meetings ?? [], error: null });
        if (opts.receipts === "missing")
          return resolve({ data: null, error: { code: "PGRST205", message: "missing" } });
        return resolve({ data: opts.receipts ?? [], error: null });
      };
      return chain;
    },
  };
  return db;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("gating", () => {
  it("requires dispatch flag, worker key and a valid start date", () => {
    expect(enqueueEnabled(ENV)).toBe(true);
    expect(enqueueEnabled({ ...ENV, EMAIL_ALERT_DISPATCH_ENABLED: "false" })).toBe(false);
    expect(enqueueEnabled({ ...ENV, ALERT_WORKER_KEY: undefined })).toBe(false);
    expect(enqueueEnabled({ ...ENV, EMAIL_ALERT_START_DATE: "" })).toBe(false);
    expect(enqueueEnabled({ ...ENV, EMAIL_ALERT_START_DATE: "2026-02-30" })).toBe(false);
  });

  it("touches neither the database nor the network when any gate is off", async () => {
    for (const env of [
      { ...ENV, EMAIL_ALERT_DISPATCH_ENABLED: "false" },
      { ...ENV, ALERT_WORKER_KEY: "" },
      { ...ENV, EMAIL_ALERT_START_DATE: "" },
      { VITE_SUPABASE_URL: ENV.VITE_SUPABASE_URL },
    ]) {
      const db = { from: vi.fn() };
      const fetcher = vi.fn();
      const result = await enqueueMeetingEmails(env, db, fetcher, () => NOW);
      expect(result.ran).toBe(false);
      expect(db.from).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("does nothing before the start date arrives", async () => {
    const db = { from: vi.fn() };
    const fetcher = vi.fn();
    await enqueueMeetingEmails({ ...ENV, EMAIL_ALERT_START_DATE: "2026-12-01" }, db, fetcher, () => NOW);
    expect(db.from).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("candidate selection", () => {
  it("bounds the window by both the start date and the last 14 days", () => {
    expect(candidateWindow("2026-11-01", NOW)).toEqual({ from: "2026-11-01", to: "2026-11-10" });
    expect(candidateWindow("2026-01-01", NOW)).toEqual({ from: "2026-10-27", to: "2026-11-10" });
    expect(candidateWindow("2026-11-11", NOW)).toBeNull();
  });

  it("accepts only settled, held, published meetings in the window", () => {
    const w = { from: "2026-11-01", to: "2026-11-10" };
    expect(isCandidate(meeting(1), w, NOW)).toBe(true);
    expect(isCandidate(meeting(1, { status: "Occurred", has_transcript: false, has_minutes: true }), w, NOW)).toBe(true);
    expect(isCandidate(meeting(1, { meeting_date: "2026-10-31" }), w, NOW)).toBe(false);
    expect(isCandidate(meeting(1, { meeting_date: "2026-11-11" }), w, NOW)).toBe(false);
    expect(isCandidate(meeting(1, { status: "Planned" }), w, NOW)).toBe(false);
    expect(isCandidate(meeting(1, { status: "Cancelled" }), w, NOW)).toBe(false);
    expect(isCandidate(meeting(1, { has_transcript: false, has_minutes: false }), w, NOW)).toBe(false);
    expect(isCandidate(meeting(1, { municipalities: { slug: "view-royal" } }), w, NOW)).toBe(false);
    expect(isCandidate(meeting(1, { updated_at: "2026-11-10T17:50:00Z" }), w, NOW)).toBe(false);
  });

  it("queries the municipality, statuses, window and settle time; filters loose rows", async () => {
    const db = fakeDb({ meetings: [meeting(1), meeting(2, { status: "Planned" }), meeting(3, { meeting_date: "2026-10-01" })] });
    const fetcher = vi.fn().mockResolvedValue(json({ queued: 0 }));
    const result = await enqueueMeetingEmails(ENV, db, fetcher, () => NOW);
    expect(db.filters).toEqual(
      expect.arrayContaining([
        ["eq", "municipalities.slug", "langford"],
        ["in", "status", ["Completed", "Occurred"]],
        ["or", "has_minutes.eq.true,has_transcript.eq.true"],
        ["gte", "meeting_date", "2026-11-01"],
        ["lte", "meeting_date", "2026-11-10"],
        ["lte", "updated_at", "2026-11-10T17:30:00.000Z"],
      ]),
    );
    expect(result.candidates).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://project.supabase.co/functions/v1/send-alerts",
      expect.objectContaining({
        method: "POST",
        body: '{"action":"enqueue","meeting_id":1}',
        headers: { "Content-Type": "application/json", "X-Alert-Worker-Key": KEY },
      }),
    );
  });

  it("propagates a candidate query failure without calling enqueue", async () => {
    const fetcher = vi.fn();
    await expect(enqueueMeetingEmails(ENV, fakeDb({ meetingsError: true }), fetcher, () => NOW)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("response handling", () => {
  it("classifies responses like the former pipeline outbox", async () => {
    expect((await classifyResponse(json({ skipped: true }))).state).toBe("skipped");
    expect((await classifyResponse(json({ queued: 0 }))).state).toBe("done");
    expect((await classifyResponse(json({ queued: 3 }))).state).toBe("done");
    expect((await classifyResponse(json({ queued: -1 }))).state).toBe("retry");
    expect((await classifyResponse(new Response("not json"))).state).toBe("retry");
    // The Edge function reports the readiness error ("not ready") as 503.
    for (const s of [408, 425, 429, 500, 503]) expect((await classifyResponse(json({ error: "x" }, s))).state).toBe("retry");
    for (const s of [400, 401, 403, 404]) expect((await classifyResponse(json({ error: "x" }, s))).state).toBe("failed");
  });

  it("records terminal and retry receipts and skips them until due", async () => {
    const db = fakeDb({
      meetings: [meeting(1), meeting(2), meeting(3), meeting(4), meeting(5), meeting(6)],
      receipts: [
        { meeting_id: 4, state: "done", attempts: 1, first_attempt_at: "2026-11-10T10:00:00Z", next_attempt_at: "2026-11-10T10:01:00Z", last_error: null },
        { meeting_id: 5, state: "pending", attempts: 2, first_attempt_at: "2026-11-10T17:00:00Z", next_attempt_at: "2026-11-10T18:30:00Z", last_error: "HTTP 503" },
        { meeting_id: 6, state: "pending", attempts: 3, first_attempt_at: "2026-11-09T18:00:00Z", next_attempt_at: "2026-11-10T17:00:00Z", last_error: "HTTP 503" },
      ],
    });
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const id = JSON.parse(init.body as string).meeting_id;
      if (id === 1) return json({ skipped: true });
      if (id === 2) return json({ error: "Alert processing unavailable" }, 503);
      return json({ error: "Invalid" }, 400);
    });
    const result = await enqueueMeetingEmails(ENV, db, fetcher as any, () => NOW);
    expect(fetcher.mock.calls.map(([, i]) => JSON.parse(i.body as string).meeting_id)).toEqual([1, 2, 3]);
    const byId = Object.fromEntries(db.saved.map((r) => [r.meeting_id, r]));
    expect(byId[1]).toMatchObject({ state: "skipped", attempts: 1 });
    expect(byId[2]).toMatchObject({ state: "pending", attempts: 1, last_error: "HTTP 503", next_attempt_at: "2026-11-10T18:01:00.000Z" });
    expect(byId[3]).toMatchObject({ state: "failed", last_error: "HTTP 400" });
    expect(byId[4]).toBeUndefined();
    expect(byId[5]).toBeUndefined();
    // 23h from first attempt has passed: expired without another call.
    expect(byId[6]).toMatchObject({ state: "expired", attempts: 3 });
    expect(result.receipts).toBe(true);
  });

  it("retries a transport failure with backoff and expires at the attempt cap", async () => {
    const db = fakeDb({
      meetings: [meeting(1)],
      receipts: [{ meeting_id: 1, state: "pending", attempts: 11, first_attempt_at: "2026-11-10T10:00:00Z", next_attempt_at: "2026-11-10T17:00:00Z", last_error: "HTTP 503" }],
    });
    const fetcher = vi.fn().mockRejectedValue(new Error("network"));
    await enqueueMeetingEmails(ENV, db, fetcher, () => NOW);
    expect(db.saved[0]).toMatchObject({ state: "expired", attempts: 12, first_attempt_at: "2026-11-10T10:00:00Z" });
  });
});

describe("per-run bound and missing receipts table", () => {
  it("makes at most the per-run number of enqueue calls", async () => {
    const meetings = Array.from({ length: 12 }, (_, i) => meeting(i + 1));
    const fetcher = vi.fn().mockResolvedValue(json({ queued: 0 }));
    const result = await enqueueMeetingEmails(ENV, fakeDb({ meetings }), fetcher, () => NOW);
    expect(fetcher).toHaveBeenCalledTimes(MAX_ENQUEUE_CALLS_PER_RUN);
    expect(result.calls).toBe(MAX_ENQUEUE_CALLS_PER_RUN);
  });

  it("falls back to idempotent re-calls when the receipts table is absent", async () => {
    const db = fakeDb({ meetings: [meeting(1), meeting(2)], receipts: "missing" });
    const fetcher = vi.fn().mockResolvedValue(json({ queued: 0 }));
    const result = await enqueueMeetingEmails(ENV, db, fetcher, () => NOW);
    expect(result.receipts).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(db.saved).toEqual([]);
  });
});
