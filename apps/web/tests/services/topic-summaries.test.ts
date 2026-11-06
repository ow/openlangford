import { describe, expect, it } from "vitest";
import shared from "../../../../shared/prompts/topic-summaries.json";
import { keepTextEdits } from "../../app/services/topic-summaries.server";

const stored = (row: Record<string, unknown>) => ({
  from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: row }) }) }) }),
}) as any;

describe("keepTextEdits", () => {
  it("keeps hand-edited fields and stores the writer's version as auto", async () => {
    const supabase = stored({ plain_english_summary: "Staff wrote this.", meta: {
      display_title: "Staff title", status_line: "Old line", manual: { summary: { by: "u" }, title: { by: "u" } } } });
    const out = await keepTextEdits(supabase, 1, { plain_english_summary: "Writer's summary.", meta: { display_title: "Writer title", status_line: "New line" } });
    expect(out.plain_english_summary).toBe("Staff wrote this.");
    expect(out.meta!.display_title).toBe("Staff title");
    expect(out.meta!.status_line).toBe("New line");
    expect(out.meta!.manual).toEqual({ summary: { by: "u", auto: "Writer's summary." }, title: { by: "u", auto: "Writer title" } });
  });

  it("leaves an update alone when nothing was edited by hand", async () => {
    const update = { plain_english_summary: "x", meta: { display_title: "y" } };
    expect(await keepTextEdits(stored({ meta: {} }), 1, update)).toBe(update);
  });
});

describe("shared prompts", () => {
  it("are the pipeline's writer prompts, with every topic and status listed", () => {
    expect(shared.system).toContain(shared.topics.join(", "));
    expect(shared.system).toContain(shared.statuses.join(", "));
    expect(shared.check_prompt).toContain("not_in_record");
  });
});
