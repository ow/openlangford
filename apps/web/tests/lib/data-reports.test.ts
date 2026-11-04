import { describe, expect, it } from "vitest";
import { parseReport } from "../../app/lib/data-reports";

const base = { path: "/matters/12-oak-street", category: "wrong_fact", note: "The vote was 5-2, not 6-1." };

describe("parseReport", () => {
  it("cleans a report", () => {
    const result = parseReport({ ...base, path: "/matters/12-oak-street?x=1#timeline-agenda-4", entryKey: "agenda-4", quote: "  carried 6-1 " });
    expect(result).toEqual({
      report: {
        path: "/matters/12-oak-street", entryKey: "agenda-4", quote: "carried 6-1", category: "wrong_fact",
        note: "The vote was 5-2, not 6-1.", suggestion: null, sourceUrl: null, notify: true,
      },
    });
  });

  it("refuses staff, API and off-site paths", () => {
    for (const path of ["/admin/reviews", "/api/search", "//evil.example", "matters/1", ""]) {
      expect(parseReport({ ...base, path })).toEqual({ error: "This page can't be reported." });
    }
  });

  it("needs a known category and something to go on", () => {
    expect(parseReport({ ...base, category: "spam" })).toEqual({ error: "Choose what's wrong." });
    expect(parseReport({ ...base, note: "  " })).toEqual({ error: "Tell us what's wrong." });
    expect("report" in parseReport({ ...base, note: "", quote: "6-1" })).toBe(true);
  });

  it("only accepts web links as sources and drops unknown entry keys", () => {
    expect(parseReport({ ...base, sourceUrl: "javascript:alert(1)" })).toEqual({ error: "The source should be a web link." });
    const result = parseReport({ ...base, sourceUrl: "https://langford.ca/minutes.pdf", entryKey: "<script>", notify: false });
    expect(result).toMatchObject({ report: { sourceUrl: "https://langford.ca/minutes.pdf", entryKey: null, notify: false } });
  });
});
