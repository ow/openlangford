import { describe, expect, it } from "vitest";
import { zonedMidnightIso } from "../../app/lib/civic-time";
import { eventVenue, serializeEventDetail, serializeEventSummary } from "../../app/api/ocd/serializers/event";

describe("zonedMidnightIso", () => {
  it("uses the offset in force on each date in Vancouver (DST-aware)", () => {
    // Offsets come from the runtime's tz database, so these dates avoid BC's 2026 move to
    // permanent UTC-7 (tzdata 2026c) and pass on older and newer tzdata alike.
    expect(zonedMidnightIso("2025-01-13", "America/Vancouver")).toBe("2025-01-13T00:00:00-08:00");
    expect(zonedMidnightIso("2025-07-14", "America/Vancouver")).toBe("2025-07-14T00:00:00-07:00");
    // Transition days: midnight is still on the old offset (changes happen at 2am).
    expect(zonedMidnightIso("2025-03-09", "America/Vancouver")).toBe("2025-03-09T00:00:00-08:00");
    expect(zonedMidnightIso("2025-11-02", "America/Vancouver")).toBe("2025-11-02T00:00:00-07:00");
    expect(zonedMidnightIso("2025-11-03", "America/Vancouver")).toBe("2025-11-03T00:00:00-08:00");
    expect(zonedMidnightIso("2026-01-12", "America/Vancouver")).toBe("2026-01-12T00:00:00-08:00");
  });
  it("accepts timestamps and other zones", () => {
    expect(zonedMidnightIso("2026-07-14T19:00:00", "America/Vancouver")).toBe("2026-07-14T00:00:00-07:00");
    expect(zonedMidnightIso("2026-07-14", "America/Toronto")).toBe("2026-07-14T00:00:00-04:00");
    expect(zonedMidnightIso("2026-07-14", "UTC")).toBe("2026-07-14T00:00:00+00:00");
  });
});

describe("OCD events", () => {
  const meeting = { id: 1, title: "Regular Council", meeting_date: "2026-07-14", type: "Regular Council" };

  it("place Langford meetings at Langford City Hall with the offset for each date", () => {
    const summary = serializeEventSummary(meeting, "ocd-event/x");
    expect(summary.location.name).toBe("Langford City Hall, 877 Goldstream Avenue");
    expect(summary.timezone).toBe("America/Vancouver");
    expect(summary.start_time).toBe("2026-07-14T00:00:00-07:00");
    const detail = serializeEventDetail({ ...meeting, meeting_date: "2025-12-01" }, "ocd-event/x", { agendaItems: [], attendance: [], attendeeOcdIds: new Map() });
    expect(detail.location.name).toBe("Langford City Hall, 877 Goldstream Avenue");
    expect(detail.start_time).toBe("2025-12-01T00:00:00-08:00");
    expect(JSON.stringify([summary, detail])).not.toMatch(/View Royal/);
  });

  it("use the municipality's own venue and time zone when its row sets them", () => {
    const venue = eventVenue({ meta: { city_hall: { name: "Town Hall", address: "1 Main St" }, timezone: "America/Toronto" } });
    expect(venue).toEqual({ name: "Town Hall, 1 Main St", timezone: "America/Toronto" });
    expect(serializeEventSummary(meeting, "x", venue).start_time).toBe("2026-07-14T00:00:00-04:00");
    expect(eventVenue({ meta: {} }).name).toBe("Langford City Hall, 877 Goldstream Avenue");
  });
});
