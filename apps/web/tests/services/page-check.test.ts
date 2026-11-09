import { describe, expect, it } from "vitest";
import { agreedStillOpen, checkPrompt, combineReadings, readPage } from "../../app/services/page-check.server";

const html = `<html><head><title>Flight Cannabis | Open Langford</title>
<meta name="description" content="A store&#x27;s permit, renewed twice."></head><body><main>
<h1>Flight Cannabis at <span>977 Langford Parkway</span></h1>
<ol>
<li id="timeline-agenda-1" class="relative"><div><a>July 17, 2023</a><p>Public Hearings</p><blockquote>&ldquo;TUP20-0002 Purpose&rdquo;</blockquote></div></li>
<li id="timeline-background-2"><div><span>Part of <a>Renewal</a></span><p>Minutes &amp; more</p><svg><text>icon</text></svg></div></li>
</ol></main></body></html>`;

describe("readPage on a timeline with years", () => {
  const page = (rows: string) => `<html><head><title>T</title></head><body><main><h1>A topic</h1><div>
    <section aria-label="2026"><h3>2026</h3><ol>${rows}</ol></section></div></main></body></html>`;

  it("ends a year's last row where its list ends, so the next year's heading is not part of it", () => {
    const html = `<html><head><title>T</title></head><body><main><h1>A topic</h1>
      <section aria-label="2026"><h3>2026</h3><ol><li id="timeline-source-1" class="x">First row about the site</li><li id="timeline-source-2">Second row</li></ol></section>
      <section aria-label="2024"><h3>2024</h3><ol><li id="timeline-source-3">Third row</li></ol></section></main></body></html>`;
    const entries = readPage(html).entries;
    expect(entries.map((e) => e.key)).toEqual(["source-1", "source-2", "source-3"]);
    expect(entries[1].text).toBe("Second row");
    expect(entries[0].text).toBe("First row about the site");
  });

  it("still reads a page with no years", () => {
    expect(readPage(page('<li id="timeline-agenda-4">Only row</li>')).entries).toEqual([{ key: "agenda-4", text: "Only row" }]);
  });
});

describe("readPage", () => {
  it("reads the title, heading, description and each timeline entry by its key", () => {
    const page = readPage(html);
    expect(page.title).toBe("Flight Cannabis | Open Langford");
    expect(page.heading).toBe("Flight Cannabis at 977 Langford Parkway");
    expect(page.description).toBe("A store's permit, renewed twice.");
    expect(page.entries.map(e => e.key)).toEqual(["agenda-1", "background-2"]);
    expect(page.entries[0].text).toBe("July 17, 2023 Public Hearings · “TUP20-0002 Purpose”");
    expect(page.entries[1].text).toBe("Part of Renewal Minutes & more");
    expect(page.body).toBe("Flight Cannabis at 977 Langford Parkway");  // what comes before the entries
  });

  it("falls back to the main text on pages without a timeline", () => {
    const page = readPage("<main><h1>About</h1><p>We made this.</p></main>");
    expect(page.entries).toEqual([]);
    expect(page.body).toBe("About · We made this.");
  });
});

describe("readPage on a meeting", () => {
  it("reads marked agenda items, and the attendance before them, but not the footer", () => {
    const meeting = `<main><h1>Regular Council</h1><p>Present: Mayor Goodmanson, Councillor Wagner</p>
<div id="item-1" data-review-entry="item-1"><button>Rezoning</button><p>Carried 7–0</p></div>
<div id="item-2" data-review-entry="item-2"><p>Adjournment</p></div></main><footer>About · Contact</footer>`;
    const page = readPage(meeting);
    expect(page.entries.map(e => e.key)).toEqual(["item-1", "item-2"]);
    expect(page.entries[1].text).toBe("Adjournment");
    expect(page.body).toContain("Present: Mayor Goodmanson, Councillor Wagner");
  });
});

describe("checkPrompt", () => {
  it("lists entries by key and carries rated flags as calibration", () => {
    const prompt = checkPrompt(readPage(html), [
      { problem: "generic_text", reason: "Says nothing about the store.", entry_text: "Public Hearings", verdict: "agree" },
      { problem: "unclear_why", reason: "Minutes adoption.", entry_text: "Minutes", verdict: "disagree" },
    ]);
    expect(prompt).toContain("[agenda-1] July 17, 2023");
    expect(prompt).toContain("AGREED generic_text: Says nothing about the store.");
    expect(prompt).toContain("REJECTED unclear_why: Minutes adoption.");
  });
});

import { removableKey } from "../../app/services/page-links.server";

describe("removableKey", () => {
  it("allows entries found for the topic, not items filed under it", () => {
    expect(removableKey("mention-13234")).toBe(true);
    expect(removableKey("background-5189")).toBe(true);
    expect(removableKey("report-12")).toBe(true);
    expect(removableKey("agenda-2558")).toBe(false);
    expect(removableKey("evidence-9")).toBe(true);
    expect(removableKey("mention-1; drop")).toBe(false);
    expect(removableKey(null)).toBe(false);
  });
});

import { unresolvedFlags, type PageFlag } from "../../app/lib/page-review-types";

describe("unresolvedFlags", () => {
  it("keeps a page open until every flag is rated fine, or agreed and fixed", () => {
    const flag = (verdict: "agree" | "disagree" | null, fixed?: boolean) =>
      ({ key: "mention-1", problem: "unclear_why" as const, reason: "", excerpt: "", verdict, fixed });
    expect(unresolvedFlags([flag(null)])).toHaveLength(1);
    expect(unresolvedFlags([flag("agree")])).toHaveLength(1);
    expect(unresolvedFlags([flag("agree", true), flag("disagree")])).toHaveLength(0);
    expect(unresolvedFlags(null)).toHaveLength(0);
  });
});

describe("combineReadings", () => {
  const flag = (key: string | null, problem: any, reason = "r") => ({ key, problem, reason, fix: "f" });
  it("keeps every distinct flag from both readings, once", () => {
    const combined = combineReadings([
      { summary: "first", page_issue: null, flags: [flag("agenda-1", "duplicate"), flag("mention-2", "unclear_why")] },
      { summary: "second", page_issue: "lumps two subjects", flags: [flag("agenda-1", "duplicate", "again"), flag("agenda-3", "generic_text")] },
    ]);
    expect(combined.summary).toBe("first");
    expect(combined.page_issue).toBe("lumps two subjects");
    expect(combined.flags.map((f) => `${f.key}:${f.problem}`)).toEqual(["agenda-1:duplicate", "mention-2:unclear_why", "agenda-3:generic_text"]);
    expect(combined.flags[0].reason).toBe("r");
  });
});

describe("agreedStillOpen", () => {
  const flag = (over: Partial<PageFlag>): PageFlag => ({ key: "agenda-10608", problem: "unsupported", reason: "r", excerpt: "e", verdict: null, ...over });
  it("keeps an agreed, unfixed flag a new check didn't raise again", () => {
    // The fix agent's re-check reopened it; the next check happened not to raise it.
    const reopened = flag({ verdict: "agree", fixed: false, recheck: { holds: false, checked: true, at: "t", reason: "r" } });
    expect(agreedStillOpen([reopened], [])).toEqual([reopened]);
    expect(agreedStillOpen([reopened], [], () => "changed since")).toEqual([reopened]);
  });
  it("drops fixed, unrated, disagreed and re-raised flags, and leaves staff's own issues to their own rule", () => {
    expect(agreedStillOpen([flag({ verdict: "agree", fixed: true }), flag({}), flag({ verdict: "disagree" }),
      flag({ verdict: "agree", problem: "editor_issue" })], [])).toEqual([]);
    expect(agreedStillOpen([flag({ verdict: "agree" })], [flag({})])).toEqual([]);
  });
  it("resolves an agreed flag whose entry has changed since, when the check no longer raises it", () => {
    const agreed = flag({ verdict: "agree", excerpt: "Matter: Solid Waste Bylaw (FIRST, SECOND AND THIRD READINGS)" });
    const unchanged = agreedStillOpen([agreed], [], () => agreed.excerpt);
    expect(unchanged).toEqual([agreed]);
    const [resolved] = agreedStillOpen([agreed], [], () => "Matter: Solid waste collection bylaw");
    expect(resolved.fixed).toBe(true);
    expect(resolved.recheck).toMatchObject({ holds: true, checked: false });
    // A page-level flag has no entry to compare: not raised again, it is resolved.
    const page = flag({ key: null, verdict: "agree" });
    expect(agreedStillOpen([page], [], () => "anything")[0]).toMatchObject({ fixed: true, recheck: { holds: true } });
    // Unless the fix agent's re-check reopened it: then it stays until fixed.
    const reopenedPage = flag({ key: null, verdict: "agree", recheck: { holds: false, checked: true, at: "t", reason: "r" } });
    expect(agreedStillOpen([reopenedPage], [], () => "anything")).toEqual([reopenedPage]);
    // Re-raised on the same text: not this function's business (the fresh flag carries the rating).
    expect(agreedStillOpen([agreed], [flag({ excerpt: agreed.excerpt })], () => agreed.excerpt)).toEqual([]);
    // Raised again on a changed entry: a different flag, so the old one is resolved, not duplicated.
    expect(agreedStillOpen([agreed], [flag({ excerpt: "new text" })], () => "new text")[0].fixed).toBe(true);
  });
});
