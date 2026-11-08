import { describe, expect, it } from "vitest";
import { addressPatterns } from "../../app/services/property-search.server";

describe("addressPatterns", () => {
  it("matches the address as the records write it: full type, abbreviation, hyphen or space, or no type", () => {
    const p = addressPatterns("3680", "Trans-Canada Highway");
    expect(p).toContain("%3680 Trans%Canada%highway%");
    expect(p).toContain("%3680 Trans%Canada%hwy%");
    expect(p).toContain("%3680 Trans%Canada%");
  });
  it("keeps a street with no known type whole, and refuses an empty address", () => {
    expect(addressPatterns("12", "Westhills Stadium")).toEqual(["%12 Westhills%Stadium%"]);
    expect(addressPatterns("", "Jacklin Road")).toEqual([]);
    expect(addressPatterns("3094", "Road")).toEqual([]);
  });
});
