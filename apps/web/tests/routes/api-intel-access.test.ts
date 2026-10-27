import { beforeEach, expect, it, vi } from "vitest";
import { action } from "~/routes/api.intel";

const mocks = vi.hoisted(() => ({ user: vi.fn(), adminClient: vi.fn(), json: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({
  createSupabaseServerClient: () => ({ supabase: { auth: { getUser: mocks.user } }, headers: new Headers() }),
  getSupabaseAdminClient: mocks.adminClient,
}));
vi.mock("~/services/ai/index.server", () => ({
  getAiClient: () => ({ isConfigured: () => true, providerName: "test", json: mocks.json }),
}));

const call = () =>
  action({
    request: new Request("https://openlangford.ca/api/intel/1", { method: "POST" }),
    params: { id: "1" },
    context: {},
  } as any) as Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ADMIN_EMAILS", "admin@example.com");
  vi.stubEnv("ADMIN_EMAIL", "");
  mocks.adminClient.mockImplementation(() => {
    throw new Error("Unexpected privileged database access");
  });
});

it("rejects signed-out requests before any AI or database work", async () => {
  mocks.user.mockResolvedValue({ data: { user: null } });
  const res = await call();
  expect(res.status).toBe(401);
  expect(mocks.adminClient).not.toHaveBeenCalled();
  expect(mocks.json).not.toHaveBeenCalled();
});

it("rejects signed-in non-admin users before any AI or database work", async () => {
  mocks.user.mockResolvedValue({ data: { user: { id: "u", email: "reader@example.com" } } });
  const res = await call();
  expect(res.status).toBe(403);
  expect(mocks.adminClient).not.toHaveBeenCalled();
  expect(mocks.json).not.toHaveBeenCalled();
});

it("lets an allowlisted admin through to privileged work", async () => {
  mocks.user.mockResolvedValue({ data: { user: { id: "a", email: "admin@example.com" } } });
  await expect(call()).rejects.toThrow("Unexpected privileged database access");
  expect(mocks.adminClient).toHaveBeenCalled();
});
