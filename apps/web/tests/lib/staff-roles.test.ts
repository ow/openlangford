import { afterEach, beforeEach, expect, it, vi } from "vitest";

const roles = vi.hoisted(() => ({ row: null as null | { role: string }, error: null as any }));
vi.mock("~/lib/supabase.server", () => ({
  createSupabaseServerClient: vi.fn(),
  getSupabaseAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: roles.row, error: roles.error }) }) }) }),
  }),
}));
import { getStaffRole, hasRole } from "~/lib/auth.server";

beforeEach(() => vi.stubEnv("ADMIN_EMAILS", "owner@example.test"));
afterEach(() => { vi.unstubAllEnvs(); roles.row = null; roles.error = null; });

const confirmed = (email: string) => ({ id: "u1", email, email_confirmed_at: "2026-01-01T00:00:00Z" });

it("ranks admins above moderators", () => {
  expect(hasRole("admin", "moderator")).toBe(true);
  expect(hasRole("moderator", "moderator")).toBe(true);
  expect(hasRole("moderator", "admin")).toBe(false);
  expect(hasRole(null, "moderator")).toBe(false);
});

it("makes allowlisted owners admins, and reads granted roles for everyone else", async () => {
  expect(await getStaffRole(confirmed("owner@example.test"))).toBe("admin");
  roles.row = { role: "moderator" };
  expect(await getStaffRole(confirmed("mod@example.test"))).toBe("moderator");
  roles.row = { role: "superuser" };
  expect(await getStaffRole(confirmed("mod@example.test"))).toBeNull();
  roles.row = { role: "admin" };
  expect(await getStaffRole({ ...confirmed("mod@example.test"), email_confirmed_at: null })).toBeNull();
  roles.error = { message: "down" };
  expect(await getStaffRole(confirmed("mod@example.test"))).toBeNull();
});
