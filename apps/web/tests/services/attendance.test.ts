import { describe, expect, it } from "vitest";
import { calculateAttendance } from "../../app/services/people";
import type { Attendance, Meeting, Membership } from "../../app/lib/types";

const membership = { organization_id: 1, start_date: "2018-11-05", end_date: "2022-11-06" } as Membership;
const person = { id: 143, memberships: [membership] };
const meeting = (id: number, status = "Completed") => ({ id, organization_id: 1, meeting_date: "2019-01-21", status }) as Meeting;
function record(meetingId: number, state?: "present" | "absent"): Attendance {
  return { id: meetingId, person_id: 143, meeting_id: meetingId, attendance_mode: "In Person", created_at: "",
    notes: state ? JSON.stringify({ schema: "council-attendance/v1", method: "original_roster", state,
      person_id: 143, meeting_id: meetingId, local_date: "2019-01-21", source_url: "https://langford.ca/minutes.pdf",
      source_sha256: "a".repeat(64), source_page: 1, source_quote: state === "present" ? "PRESENT Mayor Young" : "ABSENT Mayor Young" }) : undefined };
}

describe("council attendance evidence", () => {
  it("does not turn missing or legacy AI rows into absences or a historical attendance grade", () => {
    const meetings = Array.from({ length: 89 }, (_, n) => meeting(n + 1));
    expect(calculateAttendance(person, meetings, [record(1), record(2)], 1)).toEqual({
      rate: null, total: 89, attended: 0, absent: 0, unknown: 89, verified: 0, recorded: 0,
    });
  });

  it("excludes cancellations and meetings outside council service, then reports verified present/absent coverage", () => {
    const meetings = [meeting(1), meeting(2), meeting(3, "Cancelled"), { ...meeting(4), organization_id: 28 },
      { ...meeting(5), meeting_date: "2023-01-01" }];
    expect(calculateAttendance(person, meetings, [record(1, "present"), record(2, "absent")], 1)).toEqual({
      rate: 50, total: 2, attended: 1, absent: 1, unknown: 0, verified: 2, recorded: 2,
    });
  });

  it("accepts a documented later arrival as meeting presence without inventing a presence mode", () => {
    const arrival = record(1, "present");
    arrival.attendance_mode = "Unknown";
    arrival.notes = arrival.notes!.replace("original_roster", "original_minutes_attendance");
    expect(calculateAttendance(person, [meeting(1)], [arrival], 1)).toMatchObject({ attended: 1, absent: 0, unknown: 0 });
  });

  it("accepts a member's own oath on the video as presence, never as an absence", () => {
    // 2026-11-02: the inaugural meeting has no minutes; each member said "I, <name>, do solemnly affirm" on camera.
    const oath = (state: string, extra = {}) => ({ ...record(1), notes: JSON.stringify({ schema: "council-attendance/v1",
      method: "video_self_identification", state, person_id: 143, meeting_id: 1, local_date: "2019-01-21",
      source_url: "https://openlangford.ca/meetings/x#transcript=5", transcript_segment_id: 5, source_seconds: 1433,
      source_quote: "I Stew Young do solemnly affirm that.", ...extra }) });
    expect(calculateAttendance(person, [meeting(1)], [oath("present")], 1)).toMatchObject({ attended: 1, unknown: 0, verified: 1 });
    expect(calculateAttendance(person, [meeting(1)], [oath("absent")], 1)).toMatchObject({ attended: 0, absent: 0, unknown: 1 });
    expect(calculateAttendance(person, [meeting(1)], [oath("present", { source_seconds: undefined })], 1)).toMatchObject({ unknown: 1 });
  });

  it("keeps partial, conflicting, wrong-date and wrong-person evidence unresolved", () => {
    const wrongDate = record(3, "present");
    wrongDate.notes = wrongDate.notes!.replace("2019-01-21", "2019-02-04");
    const wrongPerson = record(4, "present");
    wrongPerson.notes = wrongPerson.notes!.replace('"person_id":143', '"person_id":2');
    expect(calculateAttendance(person, [meeting(1), meeting(2), meeting(3), meeting(4)], [
      record(1, "present"), record(2, "present"), record(2, "absent"), wrongDate, wrongPerson,
    ], 1)).toEqual({ rate: null, total: 4, attended: 1, absent: 0, unknown: 3, verified: 1, recorded: 1 });
  });
});


describe("2022–2026 recorded attendance compatibility", () => {
  const currentPerson = { id: 143, memberships: [{ ...membership, start_date: "2022-11-07", end_date: "2026-11-01" }] };
  const currentMeeting = (id: number) => ({ ...meeting(id), meeting_date: "2025-01-20" });

  it("restores recorded presence coverage without treating missing or unknown rows as absences or source-verified", () => {
    expect(calculateAttendance(currentPerson, [1, 2, 3, 4, 5].map(currentMeeting), [
      record(1), record(2), { ...record(3), attendance_mode: "Regrets" },
      { ...record(4), attendance_mode: "Unknown" },
    ], 1)).toEqual({ rate: 40, total: 5, attended: 2, absent: 1, unknown: 2, verified: 0, recorded: 3 });
  });

  it("keeps conflicting and invalid evidence unknown even for current-term legacy modes", () => {
    const invalid = { ...record(3, "present"), notes: "invalid evidence" };
    expect(calculateAttendance(currentPerson, [1, 2, 3].map(currentMeeting), [
      record(1), record(2), { ...record(2), attendance_mode: "Absent" }, invalid,
    ], 1)).toEqual({ rate: 33, total: 3, attended: 1, absent: 0, unknown: 2, verified: 0, recorded: 1 });
  });

  it("keeps pre-2022 legacy records unknown even for a continuing councillor", () => {
    const continuing = { ...currentPerson, memberships: [{ ...membership, end_date: undefined }] };
    expect(calculateAttendance(continuing, [meeting(1)], [record(1)], 1))
      .toEqual({ rate: null, total: 1, attended: 0, absent: 0, unknown: 1, verified: 0, recorded: 0 });
  });
});
