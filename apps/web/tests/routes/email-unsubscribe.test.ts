import { beforeEach, expect, it, vi } from "vitest";
import { createStaticHandler } from "react-router";
import * as route from "~/routes/email-unsubscribe";
const mocks = vi.hoisted(() => ({ client: vi.fn(), rpc: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabaseAdminClient: mocks.client,
}));
const token = "11111111-1111-4111-8111-111111111111";
const handler = createStaticHandler([
  {
    id: "unsubscribe",
    path: "/email/unsubscribe/:token",
    loader: route.loader as any,
    action: route.action as any,
  },
]);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.client.mockReturnValue({ rpc: mocks.rpc });
});
it("GET links are scanner-safe, disclose no address and cannot change preferences", async () => {
  const result: any = await handler.query(
    new Request(`https://openlangford.ca/email/unsubscribe/${token}`),
  );
  expect(result.statusCode).toBe(200);
  expect(mocks.client).not.toHaveBeenCalled();
  expect(result.loaderData).toEqual({ unsubscribe: null });
  expect(route.headers()["Referrer-Policy"]).toBe("no-referrer");
});
it("accepts one-click provider POST without a session/Origin and returns an empty private response", async () => {
  const direct = (await route.action({
    request: new Request("https://openlangford.ca/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    }),
    params: { token },
  } as any)) as Response;
  expect(direct.status).toBe(200);
  expect(await direct.text()).toBe("");
  expect(direct.headers.get("Cache-Control")).toBe("private, no-store");
  expect(mocks.rpc).toHaveBeenCalledWith("unsubscribe_email_alerts", {
    p_token: token,
  });
});
it("rejects malformed tokens before privileged access and hides database diagnostics", async () => {
  const bad: any = await handler.query(
    new Request("https://openlangford.ca/email/unsubscribe/not-a-token", {
      method: "POST",
    }),
  );
  expect(bad.statusCode).toBe(400);
  expect(mocks.client).not.toHaveBeenCalled();
  mocks.rpc.mockResolvedValue({
    error: { message: "sensitive database diagnostic" },
  });
  const failed: any = await handler.query(
    new Request(`https://openlangford.ca/email/unsubscribe/${token}`, {
      method: "POST",
    }),
  );
  expect(failed.statusCode).toBe(503);
  expect(JSON.stringify(failed.errors)).not.toContain(
    "sensitive database diagnostic",
  );
});
