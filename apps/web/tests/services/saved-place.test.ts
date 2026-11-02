import { beforeEach, expect, it, vi } from "vitest";
import { cleanLabel, roundedPoint, validPoint } from "~/lib/saved-place";

const geocode = vi.hoisted(() => ({ geocodeAddress: vi.fn() }));
vi.mock("~/services/geocode.server", () => geocode);
import { readPlaceUpdate, savePlace } from "~/services/saved-place.server";

beforeEach(() => vi.clearAllMocks());

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

it("rounds points to about a block and drops house numbers from labels", () => {
  expect(roundedPoint(48.449612, -123.504587)).toEqual({ lat: 48.45, lng: -123.505 });
  expect(validPoint("48.4496", "-123.5046")).toEqual({ lat: 48.45, lng: -123.505 });
  expect(validPoint("", "-123.5")).toBeNull();
  expect(validPoint("91", "0")).toBeNull();
  expect(cleanLabel("2750 Leigh Road")).toBe("Leigh Road");
  expect(cleanLabel("   ")).toBeNull();
});

it("rounds a posted point and cleans its label", async () => {
  const update = await readPlaceUpdate(form({ place_lat: "48.449612", place_lng: "-123.504587", place_label: "877 Goldstream Ave" }));
  expect(update).toEqual({ kind: "set", place: { lat: 48.45, lng: -123.505, label: "Goldstream Ave" } });
  expect(geocode.geocodeAddress).not.toHaveBeenCalled();
});

it("looks up a typed address on save and keeps only the result", async () => {
  geocode.geocodeAddress.mockResolvedValue({ lat: 48.45, lng: -123.505, label: "Goldstream Ave" });
  const update = await readPlaceUpdate(form({ place_lookup: "877 Goldstream Ave" }));
  expect(update).toEqual({ kind: "set", place: { lat: 48.45, lng: -123.505, label: "Goldstream Ave" } });
  expect(JSON.stringify(update)).not.toContain("877");
});

it("never writes an address to the profile", async () => {
  const writes: any[] = [];
  const query: any = new Proxy({}, {
    get: (_t, key) => {
      if (key === "then") return (resolve: any) => resolve({ data: [{ id: 1 }], error: null });
      return (...args: any[]) => {
        if (key === "upsert" || key === "update" || key === "insert") writes.push(args[0]);
        return query;
      };
    },
  });
  const supabase: any = { from: () => query };
  await savePlace(supabase, "user-1", { kind: "set", place: { lat: 48.45, lng: -123.505, label: "Goldstream Ave" } }, 500);
  expect(writes.length).toBeGreaterThan(0);
  for (const row of writes) expect(row).not.toHaveProperty("address");
  expect(writes[0]).toMatchObject({ location_lat: 48.45, location_lng: -123.505, location_label: "Goldstream Ave" });
});
