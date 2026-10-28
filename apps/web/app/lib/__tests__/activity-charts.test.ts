import { describe, expect, it } from "vitest";
import { heatLevel, monthTotals, recordsPerYear, yearGrid } from "../activity-charts";

const meeting = (id: number, meeting_date: string, items: number, seconds: number | null = null) => ({ id, title: `M${id}`, meeting_date, items, seconds });

describe("yearGrid", () => {
  it("lays out every day Monday-first, one column per week", () => {
    // 2024-01-01 is a Monday; 2024 is a leap year ending on a Tuesday.
    const { days, weeks, months } = yearGrid(2024, []);
    expect(days).toHaveLength(366);
    expect(days[0]).toMatchObject({ date: "2024-01-01", col: 0, row: 0, level: 0 });
    expect(days[6]).toMatchObject({ date: "2024-01-07", col: 0, row: 6 });
    expect(days[7]).toMatchObject({ date: "2024-01-08", col: 1, row: 0 });
    expect(days.at(-1)).toMatchObject({ date: "2024-12-31", col: 52, row: 1 });
    expect(weeks).toBe(53);
    expect(months).toHaveLength(12);
    expect(months[1]).toEqual({ label: "Feb", col: 4 });
  });

  it("offsets the first week when Jan 1 is not a Monday", () => {
    // 2015-01-01 is a Thursday; 2017-01-01 a Sunday, alone in its first column.
    expect(yearGrid(2015, []).days[0]).toMatchObject({ col: 0, row: 3 });
    const y2017 = yearGrid(2017, []);
    expect(y2017.days[0]).toMatchObject({ col: 0, row: 6 });
    expect(y2017.days[1]).toMatchObject({ date: "2017-01-02", col: 1, row: 0 });
    expect(y2017.weeks).toBe(53);
  });

  it("combines meetings on one day and ignores other years", () => {
    const { days } = yearGrid(2025, [
      meeting(1, "2025-03-04", 10, 3600),
      meeting(2, "2025-03-04", 25),
      meeting(3, "2024-03-04", 50),
    ]);
    const day = days.find((d) => d.date === "2025-03-04")!;
    expect(day.meetings.map((m) => m.id)).toEqual([1, 2]);
    expect(day.items).toBe(35);
    expect(day.seconds).toBe(3600);
    expect(day.level).toBe(4);
    expect(days.filter((d) => d.meetings.length)).toHaveLength(1);
  });

  it("totals meetings and items per month", () => {
    const totals = monthTotals(yearGrid(2025, [meeting(1, "2025-03-04", 10), meeting(2, "2025-03-18", 5)]).days);
    expect(totals[2]).toEqual({ label: "Mar", meetings: 2, items: 15 });
    expect(totals[0].meetings).toBe(0);
  });
});

describe("heatLevel", () => {
  it("buckets agenda item counts, keeping item-less meetings visible", () => {
    expect(heatLevel(0, false)).toBe(0);
    expect(heatLevel(0, true)).toBe(1);
    expect(heatLevel(7, true)).toBe(1);
    expect(heatLevel(8, true)).toBe(2);
    expect(heatLevel(16, true)).toBe(3);
    expect(heatLevel(99, true)).toBe(4);
  });
});

describe("recordsPerYear", () => {
  it("counts distinct records per year with gap years filled", () => {
    expect(
      recordsPerYear([
        { key: "m1", date: "2019-02-01" },
        { key: "m1", date: "2019-06-01" },
        { key: "m1", date: "2021-01-10" },
        { key: "i7", date: "2019-03-03" },
        { key: "i8", date: null },
      ]),
    ).toEqual([
      { year: 2019, count: 2 },
      { year: 2020, count: 0 },
      { year: 2021, count: 1 },
    ]);
  });

  it("is empty without dated records", () => {
    expect(recordsPerYear([{ key: "m1", date: undefined }])).toEqual([]);
  });
});
