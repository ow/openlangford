import { describe, expect, it } from "vitest";
import { publicAgendaItemMeta, transcriptStub } from "../meeting-payload";
import { activeMemberIdsOn } from "../../services/meetings";
import { applySpeakerRoles, membershipsFromPeople } from "../../services/speaker-roles.server";

describe("publicAgendaItemMeta", () => {
  it("keeps only the keys the page reads", () => {
    expect(publicAgendaItemMeta({ participation: { speakers: [] }, remarks: {}, commitments: { items: [] }, written_participation: {}, summary_version: 3, images: [1] }))
      .toEqual({ participation: { speakers: [] }, remarks: {}, commitments: { items: [] }, written_participation: {} });
  });
  it("handles null and drops null values", () => {
    expect(publicAgendaItemMeta(null)).toEqual({});
    expect(publicAgendaItemMeta({ remarks: null })).toEqual({});
  });
});

describe("transcriptStub", () => {
  it("drops fields the page never reads", () => {
    expect(transcriptStub({ id: 1, start_time: 0, end_time: 5, person_id: 2, speaker_name: "A", agenda_item_id: 9, motion_id: 3, speaker_role: "x" }))
      .toEqual({ id: 1, start_time: 0, end_time: 5, person_id: 2, speaker_name: "A" });
  });
});

describe("activeMemberIdsOn", () => {
  const rows = [
    { person_id: 1, start_date: "2022-11-01", end_date: null },
    { person_id: 2, start_date: "2018-11-01", end_date: "2022-10-31" },
    { person_id: 3, start_date: null, end_date: null },
  ];
  it("matches the SQL date window and open-ended terms", () => {
    expect(activeMemberIdsOn(rows, "2026-03-02")).toEqual([1]);
    expect(activeMemberIdsOn(rows, "2022-10-31")).toEqual([2]);
  });
});

describe("applySpeakerRoles", () => {
  it("labels a speaker from the people map's memberships on the meeting date", () => {
    const items = [{ meta: { participation: { speakers: [{ person_id: 7 }, { person_id: 8 }] } } }];
    const people = { 7: { id: 7, memberships: [
      { role: "President", start_date: "2020-01-01", end_date: null, organization: { name: "WSDA", classification: "Association" } },
      { role: "Mayor", start_date: "2020-01-01", end_date: null, organization: { name: "Council", classification: "Council" } },
    ] }, 8: { id: 8, memberships: [] } };
    applySpeakerRoles([items], membershipsFromPeople(people), "2026-03-02");
    expect((items[0].meta.participation.speakers[0] as any).role).toBe("President, WSDA");
    expect((items[0].meta.participation.speakers[1] as any).role).toBeUndefined();
  });
});
