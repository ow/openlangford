import { describe, expect, it } from "vitest";
import { getParticipantStatements } from "../../app/services/participant-statements.server";

function fakeSupabase(data: unknown[]) {
  const calls: [string, ...unknown[]][] = [];
  const builder: any = new Proxy({}, {
    get(_target, prop: string) {
      if (prop === "then") return (resolve: (value: unknown) => void) => resolve({ data, error: null });
      return (...args: unknown[]) => { calls.push([prop, ...args]); return builder; };
    },
  });
  return { client: { from: (table: string) => { calls.push(["from", table]); return builder; } } as any, calls };
}

describe("getParticipantStatements", () => {
  it("filters server-side by JSONB containment and municipality", async () => {
    const { client, calls } = fakeSupabase([{
      id: 5, title: "Public participation", speakers: [{ who: "Jo Doe (Main Street)", position: "supports", topic: "Parks", point: "Wants more parks.", person_id: 3 }],
      source: "transcript", meetings: { id: 1, slug: "2024-01-01-council", title: "Council", meeting_date: "2024-01-01" }, matter: null,
    }]);
    const statements = await getParticipantStatements(client, 1, 3);
    expect(calls).toContainEqual(["from", "agenda_items"]);
    expect(calls).toContainEqual(["contains", "meta", { participation: { speakers: [{ person_id: 3 }] } }]);
    expect(calls).toContainEqual(["eq", "meetings.municipality_id", 1]);
    const select = calls.find((c) => c[0] === "select")?.[1] as string;
    expect(select).not.toMatch(/\bmeta\b(?!->)/);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ agendaItemId: 5, topic: "Parks", source: "transcript" });
  });
});
