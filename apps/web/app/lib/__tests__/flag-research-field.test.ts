import { describe, expect, it } from "vitest";
import { researchLine } from "../flag-research";
import type { PageFlag } from "../page-review-types";

// A flag the check created carries its research; an editor's issue has none and is researched by the fix agent.
describe("flag research field", () => {
  it("is used when stored and absent for an editor issue", () => {
    const checked: PageFlag = { key: null, problem: "unsupported", reason: "Not in the record: x", excerpt: "Summary: y", verdict: "agree",
      research: { verdict: "not_found", explanation: "x", quote: null, ref: null } };
    const issue: PageFlag = { key: null, problem: "editor_issue", reason: "z", excerpt: "Whole page", verdict: "agree" };
    expect(researchLine(checked.excerpt, checked.research)).toContain("not_found");
    expect(issue.research).toBeUndefined();
  });
});
