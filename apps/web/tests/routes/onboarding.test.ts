import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { action as onboard } from "~/routes/onboarding";
import { action as settings } from "~/routes/settings";
import { loader as home } from "~/routes/home";

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  subscribe: vi.fn(),
  legacyUpdate: vi.fn(),
  user: vi.fn(),
  consent: vi.fn(),
}));
vi.mock("~/lib/supabase.server", () => ({
  createSupabaseServerClient: () => ({
    supabase: {
      auth: { getUser: mocks.user },
      rpc: mocks.consent,
      from: () => ({ update: () => ({ eq: mocks.legacyUpdate }) }),
    },
    headers: new Headers({ "Set-Cookie": "session=test; HttpOnly" }),
  }),
  getSupabasePublicClient: () => ({}),
}));
vi.mock("~/services/subscriptions", () => ({
  upsertUserProfile: mocks.profile,
  addSubscription: mocks.subscribe,
  getUserProfile: vi.fn(),
  getSubscriptions: vi.fn(),
  removeSubscription: vi.fn(),
}));
vi.mock("~/services/topics", () => ({ getTopics: vi.fn() }));
vi.mock("~/services/ai/index.server", () => ({ embedQuery: vi.fn() }));
vi.mock("~/services/site", () => ({
  getPublicHomeData: async () => ({ activeMatters: [], recentDecisions: [] }),
  getPublicNotices: async () => [],
}));
vi.mock("~/services/municipality", () => ({
  getMunicipality: async () => ({ id: 1, name: "Langford" }),
}));
vi.mock("~/services/incoming-council", () => ({
  getIncomingCouncil: async () => null,
}));
vi.mock("~/services/public-data-cache.server", () => ({
  publicData: (_: unknown, compute: () => any) => compute(),
}));

function args(fields: Record<string, string> = {}): any {
  return {
    request: new Request("https://openlangford.ca/onboarding", {
      method: "POST",
      headers: { Origin: "https://openlangford.ca" },
      body: new URLSearchParams(fields),
    }),
    params: {},
    context: {},
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMAIL_ALERTS_AVAILABLE", "false");
  mocks.profile.mockResolvedValue({ id: "reader", onboarding_completed: true });
  mocks.consent.mockResolvedValue({ error: null });
  mocks.legacyUpdate.mockResolvedValue({ error: null });
  mocks.user.mockResolvedValue({ data: { user: { id: "reader" } } });
});
afterEach(() => vi.unstubAllEnvs());

it.each(["true", "false"])(
  "preserves existing delivery choices when onboarding submits digest=%s while delivery is unavailable",
  async (digest) => {
    const response = await onboard(
      args({ topic_id: "4", digest_enabled: digest }),
    );
    expect(response).toBeInstanceOf(Response);
    const saved = mocks.profile.mock.calls[0][2];
    expect(saved).not.toHaveProperty("digest_enabled");
    expect(saved).not.toHaveProperty("digest_frequency");
    expect(saved.onboarding_completed).toBe(true);
    expect(mocks.subscribe).toHaveBeenCalledWith(
      expect.anything(),
      "reader",
      "topic",
      { topic_id: 4 },
    );
    expect(mocks.subscribe).not.toHaveBeenCalledWith(
      expect.anything(),
      "reader",
      "digest",
      expect.anything(),
    );
  },
);

it("does not erase a saved digest opt-in or weekly frequency when saving other settings", async () => {
  await settings(args({ intent: "update_profile", display_name: "Reader" }));
  const saved = mocks.profile.mock.calls[0][2];
  expect(saved.display_name).toBe("Reader");
  expect(saved).not.toHaveProperty("digest_enabled");
  expect(saved).not.toHaveProperty("digest_frequency");
});

it("retains the normal opt-in flow once delivery has been verified available", async () => {
  vi.stubEnv("EMAIL_ALERTS_AVAILABLE", "true");
  await onboard(args({ digest_enabled: "true" }));
  expect(mocks.consent).toHaveBeenCalledWith("set_email_alert_consent", {
    p_enabled: true,
    p_complete_onboarding: true,
  });
  expect(mocks.subscribe).toHaveBeenCalledWith(
    expect.anything(),
    "reader",
    "digest",
    {},
  );
  expect(mocks.profile).toHaveBeenCalledWith(expect.anything(), "reader", {
    onboarding_completed: false,
    digest_enabled: true,
    digest_frequency: "each_meeting",
  });
});

it("only issues success after the completion write succeeds", async () => {
  mocks.profile.mockRejectedValue(new Error("Save failed"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await onboard(args())).toEqual({ error: "Save failed" });
  vi.restoreAllMocks();
});

it("carries success to the homepage once, retains auth cookies, and prevents caching the notice", async () => {
  const response = (await onboard(args())) as Response;
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe("/");
  const cookies = response.headers.getSetCookie();
  expect(cookies).toContain("session=test; HttpOnly");
  const flash = cookies.find((value) =>
    value.startsWith("onboarding_notice="),
  )!;
  expect(flash).toContain("HttpOnly");
  expect(flash).toContain("Secure");
  expect(flash).toContain("SameSite=Lax");
  const page: any = await home({
    request: new Request("https://openlangford.ca/", {
      headers: { Cookie: flash.split(";")[0] },
    }),
  });
  expect(page.data.onboardingComplete).toBe(true);
  const headers = new Headers(page.init.headers);
  expect(headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect(headers.get("Cache-Control")).toBe("private, no-store");
  const ordinary: any = await home({
    request: new Request("https://openlangford.ca/"),
  });
  expect(ordinary.data.onboardingComplete).toBe(false);
});
