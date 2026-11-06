import { describe, expect, it } from "vitest";
import { connectionString } from "../../app/db/index.server";

describe("connectionString", () => {
  it("prefers a Hyperdrive binding over the DATABASE_URL secret", () => {
    expect(connectionString({ DATABASE_URL: "postgres://secret", HYPERDRIVE: { connectionString: "postgres://hyperdrive" } })).toBe("postgres://hyperdrive");
    expect(connectionString({ DATABASE_URL: "postgres://secret" })).toBe("postgres://secret");
  });
  it("fails clearly without either", () => {
    expect(() => connectionString({})).toThrow(/DATABASE_URL/);
  });
});
