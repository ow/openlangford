import { describe, expect, it } from "vitest";
import { isGenericParticipationHeading, mergeParticipation, participationSummary, statementsFromItems, type StatementItemRow } from "../participant-statements";

const meeting = (id: number, date: string) => ({ id, slug: `${date}-regular-council`, title: "Regular Council", meeting_date: date });

const rows: StatementItemRow[] = [
  {
    id: 10, title: "PUBLIC PARTICIPATION", source: "minutes", meetings: meeting(1, "2022-09-06"), matter: null,
    speakers: [
      { who: "Tanya Sunshine (Langvista Drive)", position: "supports", topic: "Dust bylaw", point: "Supports the dust-control bylaw.", person_id: 19 },
      { who: "Someone Else", position: "opposes", topic: "Dust bylaw", point: "Opposes it.", person_id: 20 },
    ],
  },
  {
    id: 11, title: "Rezoning 123 Main", meetings: meeting(2, "2025-12-15"), matter: { id: 7, slug: "rezoning-123-main", title: "Rezoning" },
    speakers: [{ who: "Tanya Sunshine", position: "Opposes", topic: "Rezoning", point: "Opposes the height.", person_id: "19" }],
  },
  { id: 12, title: "Future", meetings: meeting(3, "2099-01-01"), speakers: [{ who: "Tanya Sunshine", position: "asks", topic: "x", point: "y", person_id: 19 }] },
  { id: 13, title: "Unlinked", meetings: meeting(4, "2024-01-01"), speakers: [{ who: "Tanya Sunshine", position: "asks", topic: "x", point: "y" }] },
];

describe("statementsFromItems", () => {
  const statements = statementsFromItems(rows, 19, "2026-10-29");

  it("keeps only this person's linked, past entries, newest first", () => {
    expect(statements.map((s) => s.agendaItemId)).toEqual([11, 10]);
    expect(statements[0]).toMatchObject({ position: "opposes", matter: { id: 7, slug: "rezoning-123-main" }, meetingSlug: "2025-12-15-regular-council", source: null });
    expect(statements[1]).toMatchObject({ source: "minutes", agendaTitle: "PUBLIC PARTICIPATION", point: "Supports the dust-control bylaw." });
  });

  it("never carries the speaker's name or street qualifier", () => {
    expect(JSON.stringify(statements)).not.toMatch(/Langvista|Tanya/);
  });

  it("tolerates malformed speakers", () => {
    expect(statementsFromItems([{ id: 1, title: null, speakers: null, meetings: meeting(1, "2020-01-01") }], 19, "2026-01-01")).toEqual([]);
    expect(statementsFromItems([{ id: 1, title: null, speakers: [null, { person_id: 19 }], meetings: meeting(1, "2020-01-01") }], 19, "2026-01-01")).toEqual([]);
  });
});

describe("mergeParticipation", () => {
  const statements = statementsFromItems(rows, 19, "2026-10-29");
  const audio = (meetingId: number, agendaItemId: number | null, date: string, segmentCount = 3) =>
    ({ meetingId, agendaItemId, meetingDate: date, seconds: 90, segmentCount, firstStartTime: 120.4 });

  it("folds audio for the same item into the statement instead of counting it twice", () => {
    const merged = mergeParticipation([audio(2, 11, "2025-12-15"), audio(5, 50, "2024-03-01")], statements);
    expect(merged.statements[0].audio).toEqual({ seconds: 90, firstStartTime: 120.4 });
    expect(merged.statements[1].audio).toBeNull();
    expect(merged.audioOnly.map((a) => a.agendaItemId)).toEqual([50]);
    expect(merged.meetingCount).toBe(3);
    expect(merged.agendaItemCount).toBe(3);
    expect(merged.firstDate).toBe("2022-09-06");
    expect(merged.lastDate).toBe("2025-12-15");
  });

  it("folds item-less audio into the meeting's only statement, but not when the meeting has several", () => {
    const merged = mergeParticipation([audio(1, null, "2022-09-06"), audio(1, null, "2022-09-06")], statements);
    expect(merged.statements[1].audio).toEqual({ seconds: 180, firstStartTime: 120.4 });
    expect(merged.audioOnly).toEqual([]);
    const two = [...statements, { ...statements[1], agendaItemId: 99 }];
    expect(mergeParticipation([audio(1, null, "2022-09-06")], two).audioOnly).toHaveLength(1);
  });

  it("keeps audio about a different item separate", () => {
    const merged = mergeParticipation([audio(1, 77, "2022-09-06")], statements);
    expect(merged.audioOnly.map((a) => a.agendaItemId)).toEqual([77]);
    expect(merged.agendaItemCount).toBe(3);
  });

  it("counts minutes-only history meetings but does not list them as audio", () => {
    const merged = mergeParticipation([audio(9, null, "2021-01-01", 0)], []);
    expect(merged.meetingCount).toBe(1);
    expect(merged.agendaItemCount).toBe(0);
    expect(merged.audioOnly).toEqual([]);
  });

  it("is empty with no records", () => {
    expect(mergeParticipation([], [])).toMatchObject({ meetingCount: 0, agendaItemCount: 0, firstDate: null, statements: [] });
  });
});

describe("letters", () => {
  const letterRows: StatementItemRow[] = [
    {
      id: 11, title: "Rezoning 123 Main", meetings: meeting(2, "2025-12-15"), matter: null,
      written: { version: "3", documents: [
        { extracted_document_id: 44, document_id: 9, letters: [
          { who: "Tanya Sunshine (Langvista Drive)", position: "opposes", topic: "Height", point: "Opposes the height.", person_id: 19 },
          { who: "A resident", position: "supports", topic: "Height", point: "Supports it." },
        ] },
        null,
        { extracted_document_id: 45, letters: [{ who: "Tanya Sunshine", position: "asks", topic: "Parking", point: "Asks about parking.", person_id: 19 }] },
      ] },
    },
    { id: 14, title: "Old shape", meetings: meeting(6, "2023-05-01"), written: { letters: [{ who: "Tanya Sunshine", position: "supports", topic: "Trail", point: "Supports the trail.", person_id: 19 }] } },
  ];
  const statements = statementsFromItems([...rows, ...letterRows], 19, "2026-10-29");

  it("reads letters in both stored shapes, marked as written, with their source document", () => {
    expect(statements.map((s) => [s.agendaItemId, s.kind, s.documentId])).toEqual([
      [11, "spoken", null], [11, "written", 44], [11, "written", 45], [14, "written", null], [10, "spoken", null],
    ]);
    expect(statements.filter((s) => s.kind === "written").every((s) => s.source === null)).toBe(true);
    expect(JSON.stringify(statements)).not.toMatch(/Langvista|Tanya/);
  });

  it("never folds audio into a letter, counts letters, and counts a shared item once", () => {
    const merged = mergeParticipation([{ meetingId: 2, agendaItemId: 11, meetingDate: "2025-12-15", seconds: 30, segmentCount: 2, firstStartTime: 5 }], statements);
    expect(merged.statements.filter((s) => s.audio).map((s) => s.kind)).toEqual(["spoken"]);
    expect(merged).toMatchObject({ letterCount: 3, lettersOnly: false, meetingCount: 3, agendaItemCount: 3 });
    const lettersOnly = mergeParticipation([], statementsFromItems(letterRows, 19, "2026-10-29"));
    expect(lettersOnly).toMatchObject({ letterCount: 3, lettersOnly: true, meetingCount: 2, agendaItemCount: 2, audioOnly: [] });
  });
});

describe("participationSummary", () => {
  it("mentions letters", () => {
    expect(participationSummary("A B", 2, 2, "2023-05-01", "2025-12-15", 3, true)).toBe(
      "A B wrote to Langford council as a member of the public: 3 letters for 2 meetings, 2023–2025, on 2 agenda items. Read what they wrote.",
    );
    expect(participationSummary("A B", 3, 3, "2022-01-01", "2025-01-01", 1)).toBe(
      "A B addressed Langford council as a member of the public at 3 meetings, 2022–2025, on 3 agenda items, including 1 letter. Read what they said and wrote.",
    );
  });
});

describe("participationSummary (spoken)", () => {
  it("describes counts and span", () => {
    expect(participationSummary("Tanya Sunshine", 12, 10, "2022-02-07", "2026-10-05")).toBe(
      "Tanya Sunshine addressed Langford council as a member of the public at 12 meetings, 2022–2026, on 10 agenda items. Read what they said.",
    );
    expect(participationSummary("A B", 1, 1, "2024-01-01", "2024-01-01")).toContain("at 1 meeting in 2024, on 1 agenda item.");
  });
  it("falls back when nothing is recorded", () => {
    expect(participationSummary("A B", 0, 0, null, null)).toContain("recorded participation");
  });
});

describe("isGenericParticipationHeading", () => {
  it.each(["PUBLIC PARTICIPATION", "Public Input", "4. Public Participation", "Delegations", "Question Period", null])("%s is generic", (t) => {
    expect(isGenericParticipationHeading(t)).toBe(true);
  });
  it("keeps specific titles", () => {
    expect(isGenericParticipationHeading("Public Hearing: Zoning Bylaw 2100")).toBe(false);
  });
});
