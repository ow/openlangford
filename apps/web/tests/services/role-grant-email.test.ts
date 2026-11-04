import { describe, expect, it, vi } from "vitest";
import { buildRoleGrantEmail, sendRoleGrantEmail } from "../../app/services/staff.server";

describe("role grant email", () => {
  it("welcomes a moderator with the admin link and says activity is logged", () => {
    const email = buildRoleGrantEmail("moderator", "new.mod@example.com");
    expect(email.to).toEqual(["new.mod@example.com"]);
    expect(email.subject).toBe("You're now a moderator on Open Langford");
    expect(email.text).toContain("You have been granted moderator powers on OpenLangford.ca.");
    expect(email.text).toContain("All activity is logged.");
    expect(email.html).toContain('<a href="https://openlangford.ca/admin">');
    expect(email.html).toContain("<em>All activity is logged.</em>");
  });
  it("says admin for admins", () => {
    expect(buildRoleGrantEmail("admin", "a@example.com").text).toContain("granted admin powers");
  });
  it("sends once through Resend, and skips without a key or a confirmed address", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await sendRoleGrantEmail({ apiKey: "k", to: "m@example.com", role: "moderator", userId: "u1", fetcher: fetcher as any })).toBe("sent");
    const [, init] = fetcher.mock.calls[0] as any;
    expect(init.headers["Idempotency-Key"]).toMatch(/^role-grant-u1-moderator-\d{4}-\d{2}-\d{2}$/);
    expect(await sendRoleGrantEmail({ apiKey: undefined, to: "m@example.com", role: "moderator", userId: "u1", fetcher: fetcher as any })).toBe("skipped");
    expect(await sendRoleGrantEmail({ apiKey: "k", to: null, role: "moderator", userId: "u1", fetcher: fetcher as any })).toBe("skipped");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
