import { describe, expect, it } from "vitest";
import { accountEmailFor, redactEmail } from "../redact-email";

describe("redactEmail", () => {
  it("keeps the first three characters before the @ and the whole domain", () => {
    expect(redactEmail("jane.doe@example.com")).toBe("jan…@example.com");
  });
  it("never shows a whole short name", () => {
    expect(redactEmail("abc@example.com")).toBe("ab…@example.com");
    expect(redactEmail("ab@example.com")).toBe("a…@example.com");
    expect(redactEmail("a@example.com")).toBe("…@example.com");
  });
  it("handles missing and malformed values", () => {
    expect(redactEmail(null)).toBeNull();
    expect(redactEmail("")).toBe("");
    expect(redactEmail("not-an-email")).toBe("…");
  });
  it("redacts for moderators only", () => {
    expect(accountEmailFor("admin")("jane.doe@example.com")).toBe("jane.doe@example.com");
    expect(accountEmailFor("moderator")("jane.doe@example.com")).toBe("jan…@example.com");
  });
});
