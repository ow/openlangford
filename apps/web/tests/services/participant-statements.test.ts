import { describe, expect, it } from "vitest";
import { getAllParticipantStatements, getParticipantStatements } from "../../app/services/participant-statements.server";

/** A query builder that records calls and answers each query from `respond(calls of that query)`. */
function fakeSupabase(respond: (calls: [string, ...unknown[]][]) => unknown[]) {
  const calls: [string, ...unknown[]][][] = [];
  const builder = (own: [string, ...unknown[]][]): any => new Proxy({}, {
    get(_target, prop: string) {
      if (prop === "then") return (resolve: (value: unknown) => void) => resolve({ data: respond(own), error: null });
      return (...args: unknown[]) => { own.push([prop, ...args]); return builder(own); };
    },
  });
  return {
    client: { from: (table: string) => { const own: [string, ...unknown[]][] = [["from", table]]; calls.push(own); return builder(own); } } as any,
    calls,
  };
}

const meetings = { id: 1, slug: "2024-01-01-council", title: "Council", meeting_date: "2024-01-01" };
const spokenRow = {
  id: 5, title: "Public participation", speakers: [{ who: "Jo Doe (Main Street)", position: "supports", topic: "Parks", point: "Wants more parks.", person_id: 3 }],
  source: "transcript", meetings, matter: null,
};
const writtenRow = {
  id: 5, title: "Public participation", meetings, matter: null,
  written: { version: "3", documents: [{ extracted_document_id: 44, document_id: 9, letters: [
    { who: "Jo Doe (Main Street)", position: "opposes", topic: "Parking", point: "Opposes the parking lot.", person_id: 3 },
    { who: "Someone Else", position: "supports", topic: "Parking", point: "Supports it." },
  ] }] },
};

describe("getParticipantStatements", () => {
  it("runs one containment query for comments and one for letters, filtered by municipality", async () => {
    const { client, calls } = fakeSupabase((own) => {
      const contains = own.find((c) => c[0] === "contains")?.[2] as Record<string, unknown>;
      return "participation" in contains ? [spokenRow] : [writtenRow];
    });
    const statements = await getParticipantStatements(client, 1, 3);
    expect(calls).toHaveLength(2);
    const flat = calls.flat();
    expect(flat).toContainEqual(["contains", "meta", { participation: { speakers: [{ person_id: 3 }] } }]);
    expect(flat).toContainEqual(["contains", "meta", { written_participation: { documents: [{ letters: [{ person_id: 3 }] }] } }]);
    expect(flat.filter((c) => c[0] === "eq" && c[1] === "meetings.municipality_id")).toHaveLength(2);
    for (const own of calls) expect(own.find((c) => c[0] === "select")?.[1] as string).not.toMatch(/\bmeta\b(?!->)/);
    // The same item answers both queries: one comment and one letter, never doubled.
    expect(statements.map((s) => [s.kind, s.topic, s.documentId])).toEqual([["spoken", "Parks", null], ["written", "Parking", 44]]);
    expect(statements[1].source).toBeNull();
    expect(JSON.stringify(statements)).not.toMatch(/Main Street|Jo Doe/);
  });
});

describe("getAllParticipantStatements", () => {
  it("groups every linked comment and letter by person", async () => {
    const { client, calls } = fakeSupabase(() => [{ ...spokenRow, written: writtenRow.written }]);
    const byPerson = await getAllParticipantStatements(client, 1);
    expect([...byPerson.keys()]).toEqual([3]);
    expect(byPerson.get(3)!.map((s) => s.kind)).toEqual(["spoken", "written"]);
    expect(calls[0]).toContainEqual(["or", "meta->participation->speakers.not.is.null,meta->written_participation.not.is.null"]);
    expect(calls[0]).toContainEqual(["eq", "meetings.municipality_id", 1]);
  });
});
