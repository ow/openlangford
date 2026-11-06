import { describe, expect, it } from "vitest";
import { connectionString, sqlPathAvailable } from "../../app/db/index.server";

describe("connectionString", () => {
  it("prefers a Hyperdrive binding over the DATABASE_URL secret", () => {
    expect(connectionString({ DATABASE_URL: "postgres://secret", HYPERDRIVE: { connectionString: "postgres://hyperdrive" } })).toBe("postgres://hyperdrive");
    expect(connectionString({ DATABASE_URL: "postgres://secret" })).toBe("postgres://secret");
  });
  it("fails clearly without either", () => {
    expect(() => connectionString({})).toThrow(/DATABASE_URL/);
  });
});

describe("sqlPathAvailable", () => {
  const url = { DATABASE_URL: "postgres://secret" };
  const hyperdrive = { HYPERDRIVE: { connectionString: "postgres://hyperdrive" } };
  it("runs on either DATABASE_URL or Hyperdrive by default", () => {
    expect(sqlPathAvailable(url)).toBe(true);
    expect(sqlPathAvailable(hyperdrive)).toBe(true);
    expect(sqlPathAvailable({})).toBe(false);
    expect(sqlPathAvailable(undefined)).toBe(false);
  });
  it("requireWarmPool needs a Hyperdrive binding, never DATABASE_URL alone", () => {
    expect(sqlPathAvailable(url, { requireWarmPool: true })).toBe(false);
    expect(sqlPathAvailable({ ...url, ...hyperdrive }, { requireWarmPool: true })).toBe(true);
    expect(sqlPathAvailable(hyperdrive, { requireWarmPool: true })).toBe(true);
  });
});
