import { describe, expect, it } from "vitest";
import * as policy from "../../app/lib/cache-policy";

describe("cache policies", () => {
  it("keeps each route's effective header values", () => {
    expect(policy.NO_STORE).toBe("no-store");
    expect(policy.PRIVATE).toBe("private, no-store");
    expect(policy.NO_CACHE).toBe("no-cache");
    expect(policy.PUBLIC_API).toBe("public, max-age=60");
    expect(policy.PUBLIC_SHORT).toBe("public, max-age=300, s-maxage=300");
    expect(policy.PUBLIC_SIGNED_LINK).toBe("public, max-age=3500");
    expect(policy.PUBLIC_DAY).toBe("public, max-age=86400");
    expect(policy.PUBLIC_EDGE_DAY).toBe("public, max-age=3600, s-maxage=86400");
    expect(policy.PUBLIC_IMMUTABLE).toBe("public, max-age=31536000, immutable");
  });

  it("never lets a private or uncached policy be stored by a shared cache", () => {
    for (const value of [policy.NO_STORE, policy.PRIVATE]) expect(value).toContain("no-store");
    for (const [name, value] of Object.entries(policy)) {
      if (typeof value === "string" && name.startsWith("PUBLIC_")) expect(value).toMatch(/^public, max-age=\d+/);
    }
  });

  it("publicMaxAge rounds up and never goes below one second", () => {
    expect(policy.publicMaxAge(300)).toBe("public, max-age=300");
    expect(policy.publicMaxAge(299.2)).toBe("public, max-age=300");
    expect(policy.publicMaxAge(0)).toBe("public, max-age=1");
    expect(policy.publicMaxAge(-40)).toBe("public, max-age=1");
  });
});
