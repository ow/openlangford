import { describe, expect, it } from "vitest";
import { glossaryPromptBlock } from "../../app/services/ai/glossary-prompt";
import { GLOSSARY_TERMS, STAGE_LABELS } from "../../app/lib/glossary";

describe("glossary", () => {
  it("has unique ids and a meaning for every term", () => {
    const ids = GLOSSARY_TERMS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of GLOSSARY_TERMS) expect(t.means.length, t.id).toBeGreaterThan(10);
  });
  it("keeps the timeline's stage lines", () => {
    expect(STAGE_LABELS.adopted).toBe("Final approval.");
    expect(STAGE_LABELS.first).toMatch(/^Introduced/);
  });
  it("writes the resident register from we_write", () => {
    const block = glossaryPromptBlock("resident");
    expect(block).toContain("/how-council-works");
    expect(block).toContain("- Tabled:");
    expect(block).toContain("one step from final approval");
    expect(block).not.toContain("Motion CARRIED");
  });
  it("writes the record register from in_the_record, limited to the terms asked for", () => {
    const block = glossaryPromptBlock("record", ["carried", "tabled"]);
    expect(block).toContain("Motion CARRIED");
    expect(block).toContain("- Tabled:");
    expect(block).not.toContain("- Rezoning:");
  });
});
