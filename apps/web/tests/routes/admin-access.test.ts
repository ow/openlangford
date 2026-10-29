import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStaticHandler } from "react-router";
import routes from "../../app/routes";
import * as users from "~/routes/admin-users";
import * as user from "~/routes/admin-user";
import * as emails from "~/routes/admin-emails";
import * as email from "~/routes/admin-email";
import * as hub from "~/routes/admin";
import * as legacy from "~/routes/admin-legacy";
import * as people from "~/routes/admin-people";
import * as profiles from "~/routes/admin-profiles";
import * as matters from "~/routes/admin-matters";
import * as pipeline from "~/routes/admin-pipeline";
import * as job from "~/routes/admin-pipeline-job";
import * as speakers from "~/routes/speaker-alias";
import * as contact from "~/routes/admin-contact";

const mocks = vi.hoisted(() => ({ user: vi.fn(), adminClient: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({
  createSupabaseServerClient: () => ({ supabase: { auth: { getUser: mocks.user } }, headers: new Headers() }),
  getSupabaseAdminClient: mocks.adminClient,
}));
const modules: Record<string, any> = {
  "routes/admin-users.tsx": users, "routes/admin-user.tsx": user,
  "routes/admin-emails.tsx": emails, "routes/admin-email.tsx": email,
  "routes/admin.tsx": hub, "routes/admin-legacy.ts": legacy,
  "routes/admin-people.tsx": people, "routes/admin-profiles.tsx": profiles,
  "routes/admin-matters.tsx": matters, "routes/admin-pipeline.tsx": pipeline,
  "routes/admin-pipeline-job.tsx": job, "routes/speaker-alias.tsx": speakers,
  "routes/admin-contact.tsx": contact,
};
const handler = createStaticHandler(routes.map(route => ({
  id: route.id ?? route.file, path: route.path ?? undefined, index: route.index,
  loader: modules[route.file]?.loader, action: modules[route.file]?.action,
})));
const paths = ["/admin/users", "/admin/users/11111111-1111-4111-8111-111111111111", "/admin/emails", "/admin/emails/22222222-2222-4222-8222-222222222222", "/admin", "/admin/pipeline", "/admin/pipeline/jobs/123", "/admin/matters", "/admin/profiles", "/admin/people", "/speaker-alias", "/admin/contact", "/admin-pipeline", "/admin-matters"];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ADMIN_EMAILS", "admin@example.com");
  vi.stubEnv("ADMIN_EMAIL", "");
  mocks.adminClient.mockImplementation(() => { throw new Error("Unexpected privileged database access"); });
  mocks.user.mockResolvedValue({ data: { user: { id: "reader", email: "reader@example.com", user_metadata: { role: "admin", is_admin: true } } } });
});
afterEach(() => vi.unstubAllEnvs());

it.each(paths)("denies ordinary users both read and write access at registered route %s before privileged work", async path => {
  for (const method of ["GET", "POST"]) {
    const result = await handler.query(new Request(`https://openlangford.ca${path}`, {
      method, ...(method === "POST" ? { body: new URLSearchParams({ intent: "not-a-job" }) } : {}),
    }));
    expect(result).not.toBeInstanceOf(Response);
    expect((result as any).statusCode).toBe(403);
    expect(mocks.adminClient).not.toHaveBeenCalled();
  }
});

it("redirects signed-out visitors to login with the canonical review destination", async () => {
  mocks.user.mockResolvedValue({ data: { user: null } });
  const result = await handler.query(new Request("https://openlangford.ca/admin/matters")) as Response;
  expect(result.status).toBe(302);
  expect(result.headers.get("Location")).toBe("/login?redirectTo=%2Fadmin%2Fmatters");
  expect(mocks.adminClient).not.toHaveBeenCalled();
});

it.each([
  ["/admin-pipeline?page=2&q=parks", "/admin/pipeline?page=2&q=parks"],
  ["/admin-matters", "/admin/matters"],
])("recovers the registered legacy destination %s for an explicitly allowlisted admin", async (path, expected) => {
  mocks.user.mockResolvedValue({ data: { user: { id: "admin", email: "ADMIN@example.com" } } });
  const response = await handler.query(new Request(`https://openlangford.ca${path}`)) as Response;
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe(expected);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(mocks.adminClient).not.toHaveBeenCalled();
});

it("opens the registered admin directory for an existing admin without running any processing", async () => {
  mocks.user.mockResolvedValue({ data: { user: { id: "admin", email: "admin@example.com" } } });
  const page = await handler.query(new Request("https://openlangford.ca/admin"));
  expect((page as any).statusCode).toBe(200);
  expect(mocks.adminClient).not.toHaveBeenCalled();
});
