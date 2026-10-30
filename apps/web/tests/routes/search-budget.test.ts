import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader as search } from "~/routes/api.search";
import { loader as askGet, action as askPost } from "~/routes/api.ask";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), agent: vi.fn(), findCached: vi.fn(), getCached: vi.fn(),
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabaseAdminClient: () => ({ rpc: mocks.rpc }),
  createSupabaseServerClient: vi.fn(() => { throw new Error("Unexpected generation setup"); }),
}));
vi.mock("~/services/rag.server", () => ({ runQuestionAgent: mocks.agent }));
vi.mock("~/services/hybrid-search.server", () => ({
  findCachedAnswer: mocks.findCached, getSearchResultCache: mocks.getCached,
  saveSearchResultCache: vi.fn(), hybridSearchAll: vi.fn(),
}));
vi.mock("~/lib/analytics.server", () => ({ captureServerEvent: vi.fn() }));

const context = { cloudflare: { env: { AI_SEARCH_DAILY_LIMIT: "50" }, ctx: {} } };
function args(request: Request): any { return { request, context, params: {} }; }

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findCached.mockResolvedValue(null);
  mocks.rpc.mockResolvedValue({ data: [{ allowed: false, remaining: 0, resets_at: "2026-10-20T07:00:00Z" }], error: null });
});

describe("public AI search budget", () => {
  it.each([
    ["normal search", () => search(args(new Request("https://example.com/api/search?q=What+changed&mode=ai")))],
    ["cache bypass", () => search(args(new Request("https://example.com/api/search?q=What+changed&mode=ai&fresh=1")))],
    ["follow-up", () => search(args(new Request("https://example.com/api/search?q=What+changed&mode=ai&context=Previous+answer")))],
  ])("stops %s before any model work when the shared budget is exhausted", async (_, run) => {
    const response = await run();
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const events = (await response.text()).split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.replace(/^data: /, "")));
    expect(events).toEqual([{ type: "budget_exhausted", resetsAt: "2026-10-20T07:00:00Z" }, { type: "done" }]);
    expect(mocks.agent).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("search_daily_budget", { p_limit: 50, p_reserve: true });
  });

  it("serves a cached answer without reserving daily capacity", async () => {
    mocks.findCached.mockResolvedValue({ id: "saved", answer: "A saved answer", sources: [], created_at: "2026-10-19T00:00:00Z" });
    const response = await search(args(new Request("https://example.com/api/search?q=What+changed&mode=ai")));
    expect(await response.text()).toContain("A saved answer");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.agent).not.toHaveBeenCalled();
  });

  it("fails closed when the quota database is unavailable", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "offline" } });
    const response = await search(args(new Request("https://example.com/api/search?q=What+changed&mode=ai")));
    expect(await response.text()).toContain('"type":"budget_exhausted"');
    expect(mocks.agent).not.toHaveBeenCalled();
  });

  it("retired /api/ask answers 410 without model work, budget or logging", async () => {
    for (const response of [askGet(), askPost()]) {
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("/search?mode=ai") });
    }
    expect(mocks.agent).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("allows the deployment to disable generation with a zero limit", async () => {
    const input = args(new Request("https://example.com/api/search?q=What+changed&mode=ai"));
    input.context = { cloudflare: { env: { AI_SEARCH_DAILY_LIMIT: "0" }, ctx: {} } };
    const response = await search(input);
    expect(await response.text()).toContain('"type":"budget_exhausted"');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
