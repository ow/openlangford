import { describe, expect, it } from "vitest";
import { checkPrompt, readPage } from "../../app/services/page-check.server";

const html = `<html><head><title>Flight Cannabis | Open Langford</title>
<meta name="description" content="A store&#x27;s permit, renewed twice."></head><body><main>
<h1>Flight Cannabis at <span>977 Langford Parkway</span></h1>
<ol>
<li id="timeline-agenda-1" class="relative"><div><a>July 17, 2023</a><p>Public Hearings</p><blockquote>&ldquo;TUP20-0002 Purpose&rdquo;</blockquote></div></li>
<li id="timeline-background-2"><div><span>Part of <a>Renewal</a></span><p>Minutes &amp; more</p><svg><text>icon</text></svg></div></li>
</ol></main></body></html>`;

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

import { unresolvedFlags } from "../../app/lib/page-review-types";

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
