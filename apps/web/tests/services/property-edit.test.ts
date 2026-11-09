import { describe, expect, it } from "vitest";
import { confirmPropertyEdit, propertyEditState, resetPropertyLead, savePropertyLead } from "../../app/services/property-edit.server";

/** One property row and its link ids; every update to the property is recorded. */
function fake(meta: Record<string, any>, links: number[] = [1, 2]) {
  const updates: any[] = [];
  const client: any = { from: (table: string) => table === "properties" ? {
    select: () => ({ eq: () => ({ single: async () => ({ data: { id: 5, address: "3680 Trans-Canada Highway", meta }, error: null }) }) }),
    update: (patch: any) => ({ eq: async () => { updates.push(patch); meta = patch.meta; return { error: null }; } }),
  } : {
    select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: links.map((id) => ({ id })), error: null }) }) }) }),
  } };
  return { client, updates };
}
const auto = "The City says it spent $6.19M. Mentioned in council meetings 26 times since 2019.";

describe("an address's edited lead", () => {
  it("shows the lead without its closing line, unlocked until someone edits it", async () => {
    const { client } = fake({ summary: auto });
    expect(await propertyEditState(client, 5)).toMatchObject({ noun: "address", fields: ["summary"], summary: "The City says it spent $6.19M.", locked: [], newEntries: 0 });
  });

  it("saves a hand edit with the closing line kept, locks it, and remembers the automatic lead and the links", async () => {
    const { client, updates } = fake({ summary: auto });
    expect(await savePropertyLead(client, 5, "  Bought for $2.2M in 2019.\n  Over $6M spent since. ", "user-1")).toEqual({ changed: true });
    const meta = updates[0].meta;
    expect(meta.summary).toBe("Bought for $2.2M in 2019. Over $6M spent since. Mentioned in council meetings 26 times since 2019.");
    expect(meta.summary_locked).toMatchObject({ by: "user-1", auto, hand: true, links: [1, 2] });
  });

  it("keeps the first automatic lead across later edits, and says nothing changed for the same text", async () => {
    const { client, updates } = fake({ summary: auto });
    await savePropertyLead(client, 5, "First edit.", "u");
    await savePropertyLead(client, 5, "Second edit.", "u");
    expect(updates[1].meta.summary_locked.auto).toBe(auto);
    expect(await savePropertyLead(client, 5, "Second edit.", "u")).toEqual({ changed: false });
    await expect(savePropertyLead(client, 5, "   ", "u")).rejects.toThrow(/empty/);
  });

  it("counts links added since the edit, and a confirm starts the count again", async () => {
    const edited = { summary: "Mine.", summary_locked: { by: "u", at: "2026-11-08T00:00:00Z", auto, hand: true, links: [1] } };
    const { client, updates } = fake(edited, [1, 2, 3]);
    expect(await propertyEditState(client, 5)).toMatchObject({ locked: ["summary"], newEntries: 2, editedAt: "2026-11-08T00:00:00Z" });
    await confirmPropertyEdit(client, 5);
    expect(updates[0].meta.summary_locked.links).toEqual([1, 2, 3]);
  });

  it("resets to the automatic lead and unlocks it, or clears it when there was none to go back to", async () => {
    const withAuto = fake({ summary: "Mine.", summary_locked: { by: "u", auto, hand: true } });
    await resetPropertyLead(withAuto.client, 5);
    expect(withAuto.updates[0].meta).toEqual({ summary: auto });
    const noAuto = fake({ summary: "Mine.", summary_inputs: "h", summary_locked: { by: "u", auto: null, hand: true } });
    await resetPropertyLead(noAuto.client, 5);
    expect(noAuto.updates[0].meta).toEqual({});
  });
});
