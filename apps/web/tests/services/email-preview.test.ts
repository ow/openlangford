import { describe, expect, it } from "vitest";
import { renderedEmail } from "../../app/services/email-admin.server";

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  subject: "Council decisions: Regular Council",
  message_type: "meeting_digest",
  is_test: false,
  payload: {
    meeting: { id: 1, slug: "2026-11-02-regular-council", title: "Regular Council", date: "November 2, 2026", summary: "Council met." },
    decisions: [{ title: "Tree bylaw", summary: "Adopted the bylaw.", result: "Carried" }],
  },
};

describe("renderedEmail", () => {
  it("rebuilds the digest as sent, without any unsubscribe token", () => {
    const html = renderedEmail(row)!;
    expect(html).toContain("Regular Council");
    expect(html).toContain("Adopted the bylaw.");
    expect(html).toContain("/email/unsubscribe/(hidden)");
    expect(html).not.toMatch(/\/email\/unsubscribe\/[0-9a-f]{8}-/i);
  });
  it("gives nothing for staff emails or payloads it can't render", () => {
    expect(renderedEmail({ ...row, message_type: "staff_role" })).toBeNull();
    expect(renderedEmail({ ...row, payload: {} })).toBeNull();
  });
});
