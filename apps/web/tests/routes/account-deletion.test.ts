import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  signOut: vi.fn(),
  rpc: vi.fn(),
  deleteUser: vi.fn(),
}));
vi.mock("~/lib/supabase.server", () => ({
  createSupabaseServerClient: () => ({
    supabase: { auth: { getUser: mocks.user, signOut: mocks.signOut } },
    headers: new Headers({ "Set-Cookie": "sb-test-auth-token=; Max-Age=0" }),
  }),
  getSupabaseAdminClient: () => ({ rpc: mocks.rpc, auth: { admin: { deleteUser: mocks.deleteUser } } }),
}));
vi.mock("~/services/subscriptions", () => ({
  upsertUserProfile: vi.fn(),
  getUserProfile: vi.fn(),
  getSubscriptions: vi.fn(),
  removeSubscription: vi.fn(),
}));
vi.mock("~/services/topics", () => ({ getTopics: vi.fn() }));

import { action } from "~/routes/settings";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "reader@example.test" };

function post(fields: Record<string, string>, origin = "https://openlangford.ca"): any {
  return {
    request: new Request("https://openlangford.ca/settings", { method: "POST", headers: { Origin: origin }, body: new URLSearchParams(fields) }),
    params: {},
    context: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMAIL_ALERTS_AVAILABLE", "false");
  mocks.user.mockResolvedValue({ data: { user: USER } });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.rpc.mockResolvedValue({ data: { profiles_deleted: 1 }, error: null });
  mocks.deleteUser.mockResolvedValue({ data: {}, error: null });
});
afterEach(() => vi.unstubAllEnvs());

it("deletes the signed-in account's data, then its sign-in, then clears the session and leaves", async () => {
  const response = await action(post({ intent: "delete_account", confirm: " Delete " })).catch((r) => r);
  expect(mocks.rpc).toHaveBeenCalledWith("delete_account_data", { p_user_id: USER.id });
  expect(mocks.deleteUser).toHaveBeenCalledWith(USER.id);
  expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteUser.mock.invocationCallOrder[0]);
  expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe("/");
  expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
});

it("only deletes the caller's own account, whatever the form says", async () => {
  await action(post({ intent: "delete_account", confirm: "delete", user_id: "22222222-2222-4222-8222-222222222222" })).catch((r) => r);
  expect(mocks.rpc).toHaveBeenCalledWith("delete_account_data", { p_user_id: USER.id });
  expect(mocks.deleteUser).toHaveBeenCalledWith(USER.id);
});

it("needs the typed confirmation", async () => {
  expect(await action(post({ intent: "delete_account", confirm: "yes" }))).toMatchObject({ deleteError: true });
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.deleteUser).not.toHaveBeenCalled();
});

it("refuses a cross-site form post", async () => {
  expect(await action(post({ intent: "delete_account", confirm: "delete" }, "https://evil.example"))).toMatchObject({ error: expect.any(String) });
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("sends signed-out visitors to sign in without deleting anything", async () => {
  mocks.user.mockResolvedValue({ data: { user: null } });
  const response = await action(post({ intent: "delete_account", confirm: "delete" })).catch((r) => r);
  expect(response.headers.get("Location")).toContain("/login");
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("keeps the sign-in and says so when deleting the data fails", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "offline" } });
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await action(post({ intent: "delete_account", confirm: "delete" }))).toMatchObject({ deleteError: true });
  expect(mocks.deleteUser).not.toHaveBeenCalled();
  expect(mocks.signOut).not.toHaveBeenCalled();
});
